/**
 * Standalone Spare Parts Tracking Engine for Servier Egypt Maintenance Unified PWA
 * Fully decoupled from Work Orders (jd_cmms.js).
 * Reads warehouse records from spare_parts_data.json and merges live field spare parts
 * from local WorkLog storage (wl.v1), whether or not linked to a WO#.
 */

(function () {
  const SP_STATE = {
    meta: null,
    baseParts: [],
    allParts: [],
    filtered: [],
    page: 1,
    pageSize: 20,
    source: "ALL",
    site: "ALL",
    dept: "ALL",
    machine: "ALL",
    q: "",
    initialized: false,
    loaded: false,
  };

  const SPARE_CATS = ["Warehouse Issue", "Spare Parts Used", "Spare Parts Needed"];

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function mapBuildingToSite(building) {
    const b = String(building || "").toLowerCase();
    if (b.includes("acacia") || b.includes("s01") || b.includes("spw01")) {
      return { code: "S01", name: "Acacia (SPW01)" };
    }
    if (b.includes("palmier") || b.includes("s02") || b.includes("spw02")) {
      return { code: "S02", name: "Palmier (SPW02)" };
    }
    return { code: "GEN", name: "Utilities & Shared" };
  }

  function getWorkLogEntries() {
    try {
      const raw = localStorage.getItem("wl.v1");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.entries)) {
          return parsed.entries;
        }
      }
    } catch (e) {
      console.warn("Failed to read wl.v1 for field spare parts:", e);
    }
    return [];
  }

  function extractFieldPartsFromWorkLog() {
    const entries = getWorkLogEntries();
    if (!entries.length) return [];

    const woRegex = /(?:(?:WO|أمر\s*شغل)\s*[-#:.]?\s*|#)(\d{4,6})\b/i;
    const fieldRecords = [];

    entries.forEach((rec, recIdx) => {
      const isSpareCat = SPARE_CATS.includes(rec.category);
      const rawParts = (rec.parts || "").trim();
      const partsSourceText = rawParts || (isSpareCat ? (rec.title || rec.desc || "").trim() : "");
      if (!partsSourceText) return;

      const haystack = [rec.evidence, rec.title, rec.desc].filter(Boolean).join(" ");
      const woMatch = haystack.match(woRegex);
      const linkedWo = woMatch ? woMatch[1] : "";

      const siteInfo = mapBuildingToSite(rec.building);
      const deptLabel = (rec.area || "Field").trim();
      const deptCode = deptLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "field";
      const machineLabel = (rec.machine || "General / No machine").trim();

      let sourceLabel = "WorkLog (Field)";
      if (rec.category === "Spare Parts Needed") {
        sourceLabel = "WorkLog (Needed)";
      } else if (rec.category === "Warehouse Issue") {
        sourceLabel = "WorkLog (Warehouse)";
      }

      const items = partsSourceText.split(/[,،;\n]+/).map(s => s.trim()).filter(Boolean);
      items.forEach((rawItem, itemIdx) => {
        let qty = 1;
        const qtyMatch = rawItem.match(/(?:عدد\s*)?(\d+)\s*(?:pcs|قطعة|قطع|set)?\b/i);
        if (qtyMatch) {
          const parsedQty = parseInt(qtyMatch[1], 10);
          if (parsedQty > 0 && parsedQty < 10000) qty = parsedQty;
        }

        const codeMatch = rawItem.match(/\b([A-Z0-9]{4,14}(?:-[A-Z0-9]{1,8})*)\b/i);
        let code = "FIELD-PART";
        if (codeMatch && (!qtyMatch || codeMatch[1] !== qtyMatch[1])) {
          code = codeMatch[1].toUpperCase();
        } else if (rec.category === "Spare Parts Needed") {
          code = "REQUEST";
        }

        let cleanName = rawItem;
        if (codeMatch && code !== "FIELD-PART" && code !== "REQUEST") {
          cleanName = cleanName.replace(codeMatch[0], "").trim();
        }
        cleanName = cleanName.replace(/^[-:() ]+|[-:() ]+$/g, "").trim() || rawItem;

        fieldRecords.push({
          id: `WL-${rec.id || recIdx}-${itemIdx}`,
          code: code,
          name: cleanName,
          qty: qty,
          unit: "PCS",
          date: rec.date || new Date().toISOString().slice(0, 10),
          source: sourceLabel,
          isField: true,
          isNeeded: rec.category === "Spare Parts Needed",
          wo: linkedWo,
          woDesc: rec.title || "",
          woStatus: rec.status || "",
          asset: "",
          label: machineLabel,
          site: siteInfo.code,
          siteName: siteInfo.name,
          dept: deptCode,
          deptName: deptLabel,
        });
      });
    });

    return fieldRecords;
  }

  function mergeAllParts() {
    const fieldParts = extractFieldPartsFromWorkLog();
    const seen = new Set();
    const merged = [];

    const addIfUnique = (p) => {
      const key = `${p.wo || ""}|${(p.code || "").toUpperCase()}|${(p.name || "").toLowerCase()}|${p.date || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(p);
    };

    // Field entries first if newer, then warehouse records; sort all by date descending
    fieldParts.forEach(addIfUnique);
    SP_STATE.baseParts.forEach(addIfUnique);

    merged.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    SP_STATE.allParts = merged;
    updateSparePartsKpis();
  }

  async function loadSparePartsData(forceRefresh) {
    if (SP_STATE.loaded && !forceRefresh) {
      mergeAllParts();
      applySparePartsFilters();
      return SP_STATE.allParts;
    }

    try {
      const res = await fetch("spare_parts_data.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      SP_STATE.meta = data;
      SP_STATE.baseParts = (Array.isArray(data.parts) ? data.parts : [])
        .filter(p => !/prj-?14/i.test(String(p.source || "")));
      SP_STATE.loaded = true;
      window.SPARE_PARTS_DATA = data;
      mergeAllParts();
      populateSparePartsHierarchyFilters();
      applySparePartsFilters();
      return SP_STATE.allParts;
    } catch (err) {
      console.warn("Local spare_parts_data.json fetch failed, trying API:", err);
      try {
        const res = await fetch("/api/spare_parts");
        if (!res.ok) throw new Error("API HTTP " + res.status);
        const apiData = await res.json();
        SP_STATE.meta = apiData;
        SP_STATE.baseParts = (Array.isArray(apiData.parts) ? apiData.parts : [])
          .filter(p => !/prj-?14/i.test(String(p.source || "")));
        SP_STATE.loaded = true;
        window.SPARE_PARTS_DATA = apiData;
        mergeAllParts();
        populateSparePartsHierarchyFilters();
        applySparePartsFilters();
        return SP_STATE.allParts;
      } catch (apiErr) {
        console.error("Failed to load spare parts data:", apiErr);
        // Still show any local WorkLog field parts even if static file failed
        SP_STATE.baseParts = [];
        mergeAllParts();
        populateSparePartsHierarchyFilters();
        applySparePartsFilters();
      }
    }
  }

  function updateSparePartsKpis() {
    const all = SP_STATE.allParts || [];
    const uniqueCodes = new Set(
      all
        .map(p => (p.code || "").trim().toUpperCase())
        .filter(c => c && c !== "N/A" && c !== "FIELD-PART" && c !== "REQUEST")
    );
    const warehouseCount = all.filter(p => !p.isField).length;
    const fieldCount = all.filter(p => p.isField).length;

    const elTotal = document.getElementById("sp-kpi-total");
    const elCodes = document.getElementById("sp-kpi-codes");
    const elWh = document.getElementById("sp-kpi-warehouse");
    const elField = document.getElementById("sp-kpi-field");

    if (elTotal) elTotal.textContent = all.length.toLocaleString();
    if (elCodes) elCodes.textContent = uniqueCodes.size.toLocaleString();
    if (elWh) elWh.textContent = warehouseCount.toLocaleString();
    if (elField) elField.textContent = fieldCount.toLocaleString();
  }

  function populateSparePartsHierarchyFilters() {
    const siteSel = document.getElementById("sp-filter-site");
    const deptSel = document.getElementById("sp-filter-dept");
    const machSel = document.getElementById("sp-filter-machine");
    if (!siteSel || !deptSel || !machSel) return;

    const sites = (SP_STATE.meta && SP_STATE.meta.sites) || [
      { code: "S01", name: "Acacia (SPW01)" },
      { code: "S02", name: "Palmier (SPW02)" },
      { code: "GEN", name: "Utilities & Shared" },
    ];

    siteSel.innerHTML = '<option value="ALL">All Sites</option>' +
      sites.map(s => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name)}</option>`).join("");

    updateSpDeptFilter();
    updateSpMachineFilter();
    if (typeof initCustomSelectPickers === "function") initCustomSelectPickers();
    if (typeof updateCustomSelectTrigger === "function") {
      updateCustomSelectTrigger(siteSel);
      updateCustomSelectTrigger(deptSel);
      updateCustomSelectTrigger(machSel);
    }
  }

  function updateSpDeptFilter() {
    const deptSel = document.getElementById("sp-filter-dept");
    if (!deptSel) return;

    const deptsMap = new Map();
    SP_STATE.allParts.forEach(p => {
      if (SP_STATE.site === "ALL" || p.site === SP_STATE.site) {
        if (p.dept && !deptsMap.has(p.dept)) {
          deptsMap.set(p.dept, p.deptName || p.dept);
        }
      }
    });

    let html = '<option value="ALL">All Departments</option>';
    deptsMap.forEach((name, code) => {
      html += `<option value="${escapeHtml(code)}">${escapeHtml(name)}</option>`;
    });
    deptSel.innerHTML = html;
    deptSel.value = "ALL";
    SP_STATE.dept = "ALL";
    updateSpMachineFilter();
    if (typeof initCustomSelectPickers === "function") initCustomSelectPickers();
    if (typeof updateCustomSelectTrigger === "function") updateCustomSelectTrigger(deptSel);
  }

  function updateSpMachineFilter() {
    const machSel = document.getElementById("sp-filter-machine");
    if (!machSel) return;

    const machineMap = new Map();
    SP_STATE.allParts.forEach(p => {
      const matchSite = SP_STATE.site === "ALL" || p.site === SP_STATE.site;
      const matchDept = SP_STATE.dept === "ALL" || p.dept === SP_STATE.dept;
      const key = p.asset || p.label;
      if (matchSite && matchDept && key && p.label) {
        if (!machineMap.has(key)) {
          machineMap.set(key, p.label);
        }
      }
    });

    let html = '<option value="ALL">All Machines</option>';
    machineMap.forEach((label, key) => {
      html += `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`;
    });
    machSel.innerHTML = html;
    machSel.value = "ALL";
    SP_STATE.machine = "ALL";
    if (typeof initCustomSelectPickers === "function") initCustomSelectPickers();
    if (typeof updateCustomSelectTrigger === "function") updateCustomSelectTrigger(machSel);
  }

  function applySparePartsFilters() {
    const q = SP_STATE.q.trim().toLowerCase();

    SP_STATE.filtered = SP_STATE.allParts.filter(p => {
      if (SP_STATE.source === "WAREHOUSE" && p.isField) return false;
      if (SP_STATE.source === "FIELD" && !p.isField) return false;
      if (SP_STATE.source === "WITH_WO" && !p.wo) return false;
      if (SP_STATE.source === "NO_WO" && p.wo) return false;

      if (SP_STATE.site !== "ALL" && p.site !== SP_STATE.site) return false;
      if (SP_STATE.dept !== "ALL" && p.dept !== SP_STATE.dept) return false;
      if (SP_STATE.machine !== "ALL" && p.asset !== SP_STATE.machine && p.label !== SP_STATE.machine) return false;

      if (q) {
        const text = [
          p.code,
          p.name,
          p.label,
          p.asset,
          p.wo,
          p.siteName,
          p.deptName,
          p.source,
          p.date,
        ].join(" ").toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    SP_STATE.page = 1;
    renderSpareParts();
  }

  function getCardAccent(p) {
    if (p.isNeeded) return { border: "#FDC300", badgeBg: "#FFF4C2", badgeFg: "#5b4a00" };
    if (p.isField) return { border: "#91C361", badgeBg: "#eaf5e3", badgeFg: "#4F6228" };
    return { border: "#242269", badgeBg: "#D3DEF2", badgeFg: "#242269" };
  }

  function renderSpareParts() {
    const container = document.getElementById("sp-parts-list");
    const loadMoreBtn = document.getElementById("sp-btn-load-more");
    if (!container) return;

    const totalFiltered = SP_STATE.filtered.length;
    const currentLimit = SP_STATE.page * SP_STATE.pageSize;
    const slice = SP_STATE.filtered.slice(0, currentLimit);

    if (totalFiltered === 0) {
      container.innerHTML = `
        <div class="card center muted" style="padding:24px 16px;">
          <div style="font-size:28px; margin-bottom:8px;">📦</div>
          <b style="color:var(--navy); font-size:15px;">لا توجد قطع غيار مطابقة</b>
          <p style="font-size:12px; margin:4px 0 0;">جرّب تعديل كلمة البحث أو فلاتر المصدر والموقع والماكينة.</p>
        </div>
      `;
      if (loadMoreBtn) loadMoreBtn.style.display = "none";
      return;
    }

    container.innerHTML = slice.map((p, idx) => {
      const accent = getCardAccent(p);
      const safeCode = escapeHtml(p.code || "N/A");
      const safeName = escapeHtml(p.name || "Unnamed Part");
      const safeQty = escapeHtml(String(p.qty || 1));
      const safeUnit = escapeHtml(p.unit || "PCS");
      const safeDate = escapeHtml(p.date || "N/A");
      const safeSource = escapeHtml(p.source || "Warehouse");
      const safeLabel = escapeHtml(p.label || "General");
      const safeAsset = p.asset ? ` <span style="font-weight:400; color:var(--muted); font-size:12px;">(Asset: ${escapeHtml(p.asset)})</span>` : "";
      const safeSite = escapeHtml(p.siteName || p.site || "General");
      const safeDept = escapeHtml(p.deptName || p.dept || "General");
      const safeWo = escapeHtml(p.wo || "");

      const woRefHtml = safeWo
        ? `<button type="button" class="chip btn-jump-wo" data-wo="${safeWo}" style="border:1px solid #b8cbef; background:var(--alt); color:var(--navy); cursor:pointer; font-weight:700;" title="Open Work Order #${safeWo}">🔗 WO #${safeWo} ↗</button>`
        : `<span class="chip" style="background:var(--alt); color:var(--muted); font-weight:500;">Standalone (No WO)</span>`;

      return `
        <div class="card sp-part-card" data-sp-idx="${idx}" style="border-inline-start: 5px solid ${accent.border}; margin-bottom:10px; padding:12px 14px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
              <span class="chip" style="background:var(--navy); color:#fff; font-weight:700; font-family:monospace;">${safeCode}</span>
              <span class="chip" style="background:#fde1db; color:var(--coral); font-weight:700;">Qty: ${safeQty} ${safeUnit}</span>
              <span class="chip" style="background:${accent.badgeBg}; color:${accent.badgeFg}; font-weight:700;">${safeSource}</span>
            </div>
            <span style="font-size:11px; color:var(--muted); white-space:nowrap;">${safeDate}</span>
          </div>

          <!-- Spare Part Name -->
          <div style="background:var(--alt); border-radius:8px; padding:8px 10px; font-size:13.5px; font-weight:700; color:var(--ink); margin:8px 0 6px; line-height:1.4; word-break:break-word;">
            ${safeName}
          </div>

          <!-- Machine & Location -->
          <div style="font-weight:700; color:var(--navy); font-size:13px; margin-bottom:3px;">
            ⚙️ ${safeLabel}${safeAsset}
          </div>
          <div style="font-size:11px; color:var(--muted); margin-bottom:8px;">
            <span>${safeSite}</span> &bull; <span>${safeDept}</span>
          </div>

          <!-- Optional Reference + Actions -->
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-top:8px; border-top:1px solid var(--line); padding-top:8px;">
            <div>${woRefHtml}</div>
            <div style="display:flex; gap:6px;">
              <button type="button" class="btn ghost btn-copy-part" data-code="${safeCode}" style="padding:6px 10px; font-size:12px;">
                📋 نسخ الكود
              </button>
              <button type="button" class="btn main btn-bridge-part" data-sp-idx="${idx}" style="padding:6px 11px; font-size:12px; background:var(--coral); color:#fff;">
                📝 تسجيل بالشغل
              </button>
            </div>
          </div>
        </div>
      `;
    }).join("");

    // Copy part code
    container.querySelectorAll(".btn-copy-part").forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const code = btn.dataset.code;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(() => {
            if (typeof toast === "function") toast("تم نسخ كود القطعة: " + code);
          });
        }
      };
    });

    // Optional jump to WO tab
    container.querySelectorAll(".btn-jump-wo").forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const woNum = btn.dataset.wo;
        if (typeof window.openWorkOrderInCmms === "function") {
          window.openWorkOrderInCmms(woNum);
        }
      };
    });

    // Bridge part to WorkLog
    container.querySelectorAll(".btn-bridge-part").forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const part = slice[parseInt(btn.dataset.spIdx, 10)];
        if (part && typeof window.bridgeSparePartToLog === "function") {
          window.bridgeSparePartToLog(part);
        }
      };
    });

    if (loadMoreBtn) {
      if (currentLimit < totalFiltered) {
        loadMoreBtn.style.display = "block";
        loadMoreBtn.textContent = `عرض المزيد (${totalFiltered - currentLimit} متبقي)`;
      } else {
        loadMoreBtn.style.display = "none";
      }
    }
  }

  function initSparePartsEvents() {
    if (SP_STATE.initialized) return;
    SP_STATE.initialized = true;

    const searchInput = document.getElementById("sp-search-input");
    if (searchInput) {
      searchInput.oninput = () => {
        SP_STATE.q = searchInput.value;
        applySparePartsFilters();
      };
    }

    const sourceFilters = document.getElementById("sp-source-filters");
    if (sourceFilters) {
      sourceFilters.querySelectorAll("button[data-source]").forEach(btn => {
        btn.onclick = () => {
          sourceFilters.querySelectorAll("button").forEach(b => b.classList.remove("on"));
          btn.classList.add("on");
          SP_STATE.source = btn.dataset.source;
          applySparePartsFilters();
        };
      });
    }

    const siteSel = document.getElementById("sp-filter-site");
    if (siteSel) {
      siteSel.onchange = () => {
        SP_STATE.site = siteSel.value;
        updateSpDeptFilter();
        applySparePartsFilters();
      };
    }

    const deptSel = document.getElementById("sp-filter-dept");
    if (deptSel) {
      deptSel.onchange = () => {
        SP_STATE.dept = deptSel.value;
        updateSpMachineFilter();
        applySparePartsFilters();
      };
    }

    const machSel = document.getElementById("sp-filter-machine");
    if (machSel) {
      machSel.onchange = () => {
        SP_STATE.machine = machSel.value;
        applySparePartsFilters();
      };
    }

    const loadMoreBtn = document.getElementById("sp-btn-load-more");
    if (loadMoreBtn) {
      loadMoreBtn.onclick = () => {
        SP_STATE.page += 1;
        renderSpareParts();
      };
    }
  }

  function refreshSparePartsView() {
    initSparePartsEvents();
    loadSparePartsData(false);
  }

  window.loadSparePartsData = loadSparePartsData;
  window.refreshSparePartsView = refreshSparePartsView;
  window.initSparePartsTab = refreshSparePartsView;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initSparePartsEvents();
      loadSparePartsData(false);
    });
  } else {
    initSparePartsEvents();
    loadSparePartsData(false);
  }
})();

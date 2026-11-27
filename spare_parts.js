/**
 * Standalone Warehouse Spare Parts Inventory Engine
 * Servier Egypt Maintenance Unified PWA (Decoupled from Work Orders)
 *
 * Data sources:
 * 1. Official JD Edwards Daily Inventory (spare_parts_data.json — SPW01..SPW05)
 * 2. Local field spare parts logged in WorkLog (localStorage "wl.v1")
 */

(function () {
  const SP_STATE = {
    meta: null,
    baseParts: [],
    allParts: [],
    filtered: [],
    page: 1,
    pageSize: 20,
    status: "ALL",
    warehouse: "ALL",
    group: "ALL",
    bin: "ALL",
    q: "",
    initialized: false,
    loaded: false,
  };

  const WAREHOUSE_LABELS = {
    SPW01: "SPW01 — Acacia",
    SPW02: "SPW02 — Palmier",
    SPW03: "SPW03 — Store 03",
    SPW04: "SPW04 — Store 04",
    SPW05: "SPW05 — Store 05",
    FIELD: "Field (WorkLog)",
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

  function mapBuildingToWarehouse(building) {
    const b = String(building || "").toLowerCase();
    if (b.includes("acacia") || b.includes("spw01") || b.includes("s01")) return "SPW01";
    if (b.includes("palmier") || b.includes("spw02") || b.includes("s02")) return "SPW02";
    return "FIELD";
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

      const bu = mapBuildingToWarehouse(rec.building);
      const grp = (rec.machine || rec.area || "Field Log").trim();

      let sourceLabel = "Field (Used)";
      if (rec.category === "Spare Parts Needed") {
        sourceLabel = "Field (Needed)";
      } else if (rec.category === "Warehouse Issue") {
        sourceLabel = "Field (Issued)";
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
        let code = "FIELD-LOG";
        if (codeMatch && (!qtyMatch || codeMatch[1] !== qtyMatch[1])) {
          code = codeMatch[1].toUpperCase();
        } else if (rec.category === "Spare Parts Needed") {
          code = "REQUEST";
        }

        let cleanName = rawItem;
        if (codeMatch && code !== "FIELD-LOG" && code !== "REQUEST") {
          cleanName = cleanName.replace(codeMatch[0], "").trim();
        }
        cleanName = cleanName.replace(/^[-:() ]+|[-:() ]+$/g, "").trim() || rawItem;

        fieldRecords.push({
          id: `WL-${rec.id || recIdx}-${itemIdx}`,
          code: code,
          name: cleanName,
          qty: qty,
          bu: bu,
          loc: (rec.area || "Field").trim(),
          grp: grp,
          dt: rec.date || new Date().toISOString().slice(0, 10),
          wo: linkedWo,
          isField: true,
          isNeeded: rec.category === "Spare Parts Needed",
          fieldSource: sourceLabel,
        });
      });
    });

    return fieldRecords;
  }

  function mergeAllParts() {
    const fieldParts = extractFieldPartsFromWorkLog();
    SP_STATE.allParts = [...SP_STATE.baseParts, ...fieldParts];
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

      const syncEl = document.getElementById("sp-sync-date");
      if (syncEl) {
        const dtStr = (data.exported_at || "").slice(0, 10);
        syncEl.textContent = dtStr ? `Updated ${dtStr}` : "Offline Cached";
      }

      mergeAllParts();
      populateSparePartsFilters();
      applySparePartsFilters();
      return SP_STATE.allParts;
    } catch (err) {
      console.warn("Local spare_parts_data.json fetch failed:", err);
      SP_STATE.baseParts = [];
      mergeAllParts();
      populateSparePartsFilters();
      applySparePartsFilters();
    }
  }

  function updateSparePartsKpis() {
    const whParts = SP_STATE.baseParts || [];
    const totalSkus = whParts.length;
    const inStock = whParts.filter(p => Number(p.qty || 0) > 0).length;
    const lowStock = whParts.filter(p => {
      const q = Number(p.qty || 0);
      return q >= 1 && q <= 2;
    }).length;
    const zeroStock = whParts.filter(p => Number(p.qty || 0) <= 0).length;

    const elTotal = document.getElementById("sp-kpi-total");
    const elIn = document.getElementById("sp-kpi-instock");
    const elLow = document.getElementById("sp-kpi-low");
    const elZero = document.getElementById("sp-kpi-zero");
    const elChg = document.getElementById("sp-chg-count");

    const changedCount = whParts.filter(p => !!p.chg).length;

    if (elTotal) elTotal.textContent = totalSkus.toLocaleString();
    if (elIn) elIn.textContent = inStock.toLocaleString();
    if (elLow) elLow.textContent = lowStock.toLocaleString();
    if (elZero) elZero.textContent = zeroStock.toLocaleString();
    if (elChg) elChg.textContent = changedCount.toLocaleString();
  }

  function populateSparePartsFilters() {
    const whSel = document.getElementById("sp-filter-warehouse");
    const grpSel = document.getElementById("sp-filter-group");
    const binSel = document.getElementById("sp-filter-bin");
    if (!whSel || !grpSel || !binSel) return;

    const warehouses = (SP_STATE.meta && SP_STATE.meta.warehouses) || [
      { code: "SPW01", name: "SPW01 — Acacia" },
      { code: "SPW02", name: "SPW02 — Palmier" },
      { code: "SPW03", name: "SPW03 — Store 03" },
      { code: "SPW04", name: "SPW04 — Store 04" },
      { code: "SPW05", name: "SPW05 — Store 05" },
    ];

    whSel.innerHTML = '<option value="ALL">All Warehouses</option>' +
      warehouses.map(w => `<option value="${escapeHtml(w.code)}">${escapeHtml(w.name)}</option>`).join("");

    updateSpGroupFilter();
    updateSpBinFilter();
    if (typeof initCustomSelectPickers === "function") initCustomSelectPickers();
    if (typeof updateCustomSelectTrigger === "function") {
      updateCustomSelectTrigger(whSel);
      updateCustomSelectTrigger(grpSel);
      updateCustomSelectTrigger(binSel);
    }
  }

  function matchesWarehouse(p, selectedWh) {
    if (selectedWh === "ALL") return true;
    if (p.bu === selectedWh) return true;
    if (Array.isArray(p.bins) && p.bins.some(b => b.bu === selectedWh)) return true;
    return false;
  }

  function updateSpGroupFilter() {
    const grpSel = document.getElementById("sp-filter-group");
    if (!grpSel) return;

    const counts = new Map();
    SP_STATE.allParts.forEach(p => {
      if (matchesWarehouse(p, SP_STATE.warehouse) && p.grp) {
        counts.set(p.grp, (counts.get(p.grp) || 0) + 1);
      }
    });

    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    grpSel.innerHTML = '<option value="ALL">All Equipment / Lines</option>' +
      sorted.map(([g, c]) => `<option value="${escapeHtml(g)}">${escapeHtml(g)} (${c})</option>`).join("");
    grpSel.value = "ALL";
    SP_STATE.group = "ALL";
    updateSpBinFilter();
    if (typeof initCustomSelectPickers === "function") initCustomSelectPickers();
    if (typeof updateCustomSelectTrigger === "function") updateCustomSelectTrigger(grpSel);
  }

  function updateSpBinFilter() {
    const binSel = document.getElementById("sp-filter-bin");
    if (!binSel) return;

    const bins = new Map();
    SP_STATE.allParts.forEach(p => {
      const okWh = matchesWarehouse(p, SP_STATE.warehouse);
      const okGrp = SP_STATE.group === "ALL" || p.grp === SP_STATE.group;
      if (okWh && okGrp && p.loc) {
        bins.set(p.loc, (bins.get(p.loc) || 0) + 1);
      }
    });

    const sorted = Array.from(bins.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    binSel.innerHTML = '<option value="ALL">All Bins / Shelves</option>' +
      sorted.map(([loc, c]) => `<option value="${escapeHtml(loc)}">${escapeHtml(loc)} (${c})</option>`).join("");
    binSel.value = "ALL";
    SP_STATE.bin = "ALL";
    if (typeof initCustomSelectPickers === "function") initCustomSelectPickers();
    if (typeof updateCustomSelectTrigger === "function") updateCustomSelectTrigger(binSel);
  }

  function applySparePartsFilters() {
    const q = SP_STATE.q.trim().toLowerCase();

    SP_STATE.filtered = SP_STATE.allParts.filter(p => {
      const qty = Number(p.qty || 0);

      if (SP_STATE.status === "IN_STOCK" && (p.isField || qty <= 0)) return false;
      if (SP_STATE.status === "LOW_STOCK" && (p.isField || qty < 1 || qty > 2)) return false;
      if (SP_STATE.status === "ZERO_STOCK" && (p.isField || qty > 0)) return false;
      if (SP_STATE.status === "CHANGED" && !p.chg) return false;
      if (SP_STATE.status === "FIELD" && !p.isField) return false;

      if (!matchesWarehouse(p, SP_STATE.warehouse)) return false;
      if (SP_STATE.group !== "ALL" && p.grp !== SP_STATE.group) return false;
      if (SP_STATE.bin !== "ALL" && p.loc !== SP_STATE.bin) return false;

      if (q) {
        const binsText = Array.isArray(p.bins) ? p.bins.map(b => `${b.bu} ${b.loc}`).join(" ") : "";
        const text = [
          p.code,
          p.name,
          p.ref,
          p.loc,
          p.grp,
          p.bu,
          WAREHOUSE_LABELS[p.bu] || "",
          p.dt,
          p.wo,
          binsText,
        ].join(" ").toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    if (SP_STATE.status === "CHANGED") {
      const order = { out: 0, new: 1, up: 2, down: 3 };
      SP_STATE.filtered.sort((a, b) => (order[a.chg] ?? 9) - (order[b.chg] ?? 9));
    }

    SP_STATE.page = 1;
    renderSpareParts();
  }

  function getChangeBadgeHtml(p) {
    if (!p.chg) return "";
    const qty = Number(p.qty || 0);
    const prev = Number(p.prev ?? 0);
    if (p.chg === "new") {
      return `<span class="chip" style="background:#e8edf8; color:var(--navy); border:1px solid #b8cbef; font-weight:700;">🆕 New</span>`;
    }
    if (p.chg === "up") {
      return `<span class="chip" style="background:#eaf5e3; color:#4F6228; border:1px solid #c4d9a0; font-weight:700;">📈 +${qty - prev} (${prev}→${qty})</span>`;
    }
    if (p.chg === "out") {
      return `<span class="chip" style="background:#fde1db; color:#D9534F; border:1px solid #f5b5a8; font-weight:700;">🚨 Out (${prev}→0)</span>`;
    }
    if (p.chg === "down") {
      return `<span class="chip" style="background:#FFF4C2; color:#5b4a00; border:1px solid #f0d47a; font-weight:700;">📉 -${prev - qty} (${prev}→${qty})</span>`;
    }
    return "";
  }

  function getStockVisual(p) {
    if (p.isField) {
      if (p.isNeeded) {
        return {
          border: "#FDC300",
          badgeBg: "#FFF4C2",
          badgeFg: "#5b4a00",
          badgeText: `🛒 ${p.fieldSource || "Field (Needed)"}`,
        };
      }
      return {
        border: "#323C8E",
        badgeBg: "#e8edf8",
        badgeFg: "#242269",
        badgeText: `📝 ${p.fieldSource || "Field (WorkLog)"}`,
      };
    }

    const qty = Number(p.qty || 0);
    if (qty <= 0) {
      return {
        border: "#D9534F",
        badgeBg: "#fde1db",
        badgeFg: "#D9534F",
        badgeText: "🔴 Out of Stock (0)",
      };
    }
    if (qty <= 2) {
      return {
        border: "#FDC300",
        badgeBg: "#FFF4C2",
        badgeFg: "#5b4a00",
        badgeText: `🟡 Low Stock (${qty})`,
      };
    }
    return {
      border: "#91C361",
      badgeBg: "#eaf5e3",
      badgeFg: "#4F6228",
      badgeText: `🟢 In Stock (${qty})`,
    };
  }

  function renderSpareParts() {
    const container = document.getElementById("sp-parts-list");
    const loadMoreBtn = document.getElementById("sp-btn-load-more");
    const countEl = document.getElementById("sp-result-count");
    if (!container) return;

    const totalFiltered = SP_STATE.filtered.length;
    const currentLimit = SP_STATE.page * SP_STATE.pageSize;
    const slice = SP_STATE.filtered.slice(0, currentLimit);

    if (countEl) {
      countEl.textContent = totalFiltered > 0
        ? `عرض ${slice.length.toLocaleString()} من ${totalFiltered.toLocaleString()} قطعة`
        : `0 نتائج مطابقة`;
    }

    if (totalFiltered === 0) {
      container.innerHTML = `
        <div class="card center muted" style="padding:24px 16px;">
          <div style="font-size:28px; margin-bottom:8px;">📦</div>
          <b style="color:var(--navy); font-size:15px;">لا توجد قطع غيار مطابقة</b>
          <p style="font-size:12px; margin:4px 0 0;">جرّب تعديل كلمة البحث أو فلاتر الحالة والمخزن والماكينة.</p>
        </div>
      `;
      if (loadMoreBtn) loadMoreBtn.style.display = "none";
      return;
    }

    container.innerHTML = slice.map((p, idx) => {
      const vis = getStockVisual(p);
      const qty = Number(p.qty || 0);
      const safeCode = escapeHtml(p.code || "N/A");
      const safeName = escapeHtml(p.name || "Unnamed Part");
      const safeBu = escapeHtml(p.bu || "SPW01");
      const safeWhName = escapeHtml(WAREHOUSE_LABELS[p.bu] || p.bu || "Warehouse");
      const safeGrp = escapeHtml(p.grp || "General Store");
      const safeLoc = escapeHtml(p.loc || "Unassigned Bin");
      const safeDate = escapeHtml(p.dt || "N/A");
      const safeRef = p.ref
        ? ` &bull; <span style="font-family:monospace; color:var(--navy); font-weight:700;">Ref: ${escapeHtml(p.ref)}</span>`
        : "";

      const multiBinsHtml = (Array.isArray(p.bins) && p.bins.length > 1)
        ? `<div style="display:flex; flex-wrap:wrap; gap:4px; margin:6px 0;">
            ${p.bins.map(b => `<span class="chip" style="background:var(--alt); color:var(--navy); border:1px solid var(--line); font-size:10.5px;">${escapeHtml(b.bu)} • ${escapeHtml(b.loc)}: <b>${escapeHtml(String(b.qty))}</b></span>`).join("")}
          </div>`
        : "";

      const woJumpHtml = p.wo
        ? `<button type="button" class="chip btn-jump-wo" data-wo="${escapeHtml(p.wo)}" style="border:1px solid #b8cbef; background:var(--alt); color:var(--navy); cursor:pointer; font-weight:700;">🔗 WO #${escapeHtml(p.wo)} ↗</button>`
        : "";

      const changeBadgeHtml = getChangeBadgeHtml(p);

      const isOut = !p.isField && qty <= 0;
      const actionBtnHtml = isOut
        ? `<button type="button" class="btn navy btn-bridge-part" data-sp-idx="${idx}" style="padding:6px 12px; font-size:12px; display:flex; align-items:center; gap:4px;"><span>🛒</span> طلب شراء</button>`
        : `<button type="button" class="btn main btn-bridge-part" data-sp-idx="${idx}" style="padding:6px 12px; font-size:12px; background:var(--coral); color:#fff; display:flex; align-items:center; gap:4px;"><span>📝</span> صرف / استخدام</button>`;

      return `
        <div class="card sp-part-card" data-code="${safeCode}" style="border-inline-start: 5px solid ${vis.border}; margin-bottom:10px; padding:12px 14px;">
          <!-- Header Chips & Date (Servier Card Identity) -->
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
              <span class="chip" style="background:var(--navy); color:#fff; font-weight:700; font-family:monospace;">#${safeCode}</span>
              <span class="chip" style="background:${vis.badgeBg}; color:${vis.badgeFg}; font-weight:700;">${vis.badgeText}</span>
              ${changeBadgeHtml}
              <span class="chip" style="background:var(--lblue); color:var(--navy); font-weight:700;">${safeBu}</span>
            </div>
            <span style="font-size:11px; color:var(--muted); white-space:nowrap;">${safeDate}</span>
          </div>

          <!-- Equipment Group & Bin Location -->
          <div style="margin:8px 0 4px; font-weight:700; color:var(--navy); font-size:14px;">
            ${safeGrp} <span style="font-weight:700; color:var(--coral); font-size:12px; font-family:monospace;">(Bin: ${safeLoc})</span>
          </div>
          <div style="font-size:11px; color:var(--muted); margin-bottom:6px;">
            <span>${safeWhName}</span>${safeRef}
          </div>

          <!-- Part Description Box -->
          <div style="background:var(--alt); border-radius:8px; padding:8px 10px; font-size:13px; color:var(--ink); margin:6px 0; font-family:monospace; line-height:1.4; word-break:break-word;">
            ${safeName}
          </div>

          ${multiBinsHtml}

          <!-- Metadata Grid (2-Column Servier Pattern) -->
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:11px; color:var(--muted); margin:6px 0;">
            <div>Qty on Hand: <b style="color:${isOut ? 'var(--red)' : 'var(--navy)'};">${qty.toLocaleString()}</b></div>
            <div>Last Receipt: <b style="color:var(--ink);">${safeDate}</b></div>
          </div>

          <!-- Actions Footer -->
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-top:10px; border-top:1px solid var(--line); padding-top:8px;">
            <div>${woJumpHtml}</div>
            <div style="display:flex; gap:8px;">
              <button type="button" class="btn ghost btn-copy-part" data-code="${safeCode}" style="padding:6px 10px; font-size:12px;">
                📋 نسخ الكود
              </button>
              ${actionBtnHtml}
            </div>
          </div>
        </div>
      `;
    }).join("");

    // Copy JDE code
    container.querySelectorAll(".btn-copy-part").forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const code = btn.dataset.code;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(() => {
            if (typeof toast === "function") toast("تم نسخ كود القطعة #" + code);
          });
        }
      };
    });

    // Optional jump to WO (for field-logged entries that reference a WO)
    container.querySelectorAll(".btn-jump-wo").forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const woNum = btn.dataset.wo;
        if (typeof window.openWorkOrderInCmms === "function") {
          window.openWorkOrderInCmms(woNum);
        }
      };
    });

    // Bridge to WorkLog
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
        loadMoreBtn.textContent = `عرض المزيد (${(totalFiltered - currentLimit).toLocaleString()} متبقي)`;
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
      let timer = null;
      searchInput.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          SP_STATE.q = searchInput.value;
          applySparePartsFilters();
        }, 120);
      };
    }

    const statusFilters = document.getElementById("sp-status-filters");
    if (statusFilters) {
      statusFilters.querySelectorAll("button[data-sp-status]").forEach(btn => {
        btn.onclick = () => {
          statusFilters.querySelectorAll("button").forEach(b => b.classList.remove("on"));
          btn.classList.add("on");
          SP_STATE.status = btn.dataset.spStatus;
          applySparePartsFilters();
        };
      });
    }

    const whSel = document.getElementById("sp-filter-warehouse");
    if (whSel) {
      whSel.onchange = () => {
        SP_STATE.warehouse = whSel.value;
        updateSpGroupFilter();
        applySparePartsFilters();
      };
    }

    const grpSel = document.getElementById("sp-filter-group");
    if (grpSel) {
      grpSel.onchange = () => {
        SP_STATE.group = grpSel.value;
        updateSpBinFilter();
        applySparePartsFilters();
      };
    }

    const binSel = document.getElementById("sp-filter-bin");
    if (binSel) {
      binSel.onchange = () => {
        SP_STATE.bin = binSel.value;
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

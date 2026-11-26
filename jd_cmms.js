/**
 * JD Edwards CMMS Integration Engine for Servier Egypt Maintenance Unified PWA
 * Decision D-032 / Stage 37 (INV-1 to INV-6)
 */

(function () {
  const STATE = {
    data: null,
    filtered: [],
    page: 1,
    pageSize: 20,
    status: "ALL",
    site: "ALL",
    dept: "ALL",
    machine: "ALL",
    q: "",
    initialized: false,
  };

  const STATUS_COLORS = {
    OVERDUE: { bg: "#fde1db", fg: "#D9534F", border: "#D9534F" },
    OPEN_CM: { bg: "#fde1db", fg: "#F55B41", border: "#F55B41" },
    OPEN_PM: { bg: "#e8edf8", fg: "#242269", border: "#242269" },
    CLOSED: { bg: "#eaf5e3", fg: "#4F6228", border: "#91C361" },
  };

  function getStatusStyle(wo) {
    if (wo.is_closed === 1) return STATUS_COLORS.CLOSED;
    if (wo.is_overdue === 1) return STATUS_COLORS.OVERDUE;
    if (wo.type === "1") return STATUS_COLORS.OPEN_CM;
    return STATUS_COLORS.OPEN_PM;
  }

  function getTypeStyle(wo) {
    if (wo.type === "6" || wo.type === "M") {
      return { bg: "#e8edf8", fg: "#242269" };
    }
    if (wo.type === "1" || wo.type === "5") {
      return { bg: "#fde1db", fg: "#F55B41" };
    }
    return { bg: "#f4f5fa", fg: "#6b6f86" };
  }

  function syncFieldPartsFromWorkLog(workOrders) {
    if (!workOrders || !Array.isArray(workOrders)) return;

    let entries = [];
    try {
      if (window.S && Array.isArray(window.S.entries)) {
        entries = window.S.entries;
      } else {
        const raw = localStorage.getItem("wl.data");
        if (raw) {
          const parsed = JSON.parse(raw);
          entries = parsed.entries || [];
        }
      }
    } catch (e) {
      console.warn("Failed to load local worklog entries for parts sync:", e);
    }

    if (!entries || entries.length === 0) return;

    const woMap = new Map();
    workOrders.forEach(w => woMap.set(String(w.wo), w));

    const woRegex = /(?:(?:WO|أمر\s*شغل)\s*#?\s*|#)(\d{4,6})\b|\b(4\d{4})\b/i;

    entries.forEach(rec => {
      const partsText = (rec.parts || "").trim();
      if (!partsText) return;

      const haystack = [rec.evidence, rec.title, rec.desc].filter(Boolean).join(" ");
      const m = haystack.match(woRegex);
      if (!m) return;
      const matchedWo = m[1] || m[2];
      if (!matchedWo || !woMap.has(matchedWo)) return;

      const wo = woMap.get(matchedWo);
      if (!wo.parts_issued) wo.parts_issued = [];

      const items = partsText.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
      items.forEach(rawItem => {
        let qty = 1;
        const qtyMatch = rawItem.match(/\b(\d+)\s*(?:pcs|قطعة|set)?\b/i);
        if (qtyMatch) {
          qty = parseInt(qtyMatch[1], 10) || 1;
        }

        const codeMatch = rawItem.match(/\b([A-Z0-9]{5,12})\b/i);
        const code = codeMatch ? codeMatch[1].toUpperCase() : "FIELD-PART";
        let cleanName = rawItem;
        if (codeMatch) {
          cleanName = cleanName.replace(codeMatch[0], "").trim();
        }
        if (qtyMatch) {
          cleanName = cleanName.replace(qtyMatch[0], "").trim();
        }
        cleanName = cleanName.replace(/^[-:() ]+|[-:() ]+$/g, "").trim();
        if (!cleanName) cleanName = rawItem;

        const alreadyExists = wo.parts_issued.some(p => p.code === code && p.name === cleanName);
        if (!alreadyExists) {
          wo.parts_issued.push({
            code: code,
            name: cleanName,
            qty: qty,
            unit: "PCS",
            date: rec.date || new Date().toISOString().slice(0, 10),
            source: "WorkLog (Field)",
          });
          wo.has_parts = true;
        }
      });
    });
  }

  async function loadJdCmmsData() {
    if (STATE.data) return STATE.data;
    try {
      const res = await fetch("jd_cmms_data.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      STATE.data = data;
      window.JD_CMMS_DATA = data;
      syncFieldPartsFromWorkLog(data.work_orders);
      updateKpis(data.stats);
      populateHierarchyFilters(data);
      applyFilters();
      return data;
    } catch (err) {
      console.warn("Local jd_cmms_data.json fetch failed, trying API:", err);
      try {
        const res = await fetch("/api/jd_cmms/work_orders");
        if (!res.ok) throw new Error("API HTTP " + res.status);
        const apiData = await res.json();
        const fullData = {
          version: "1.0",
          stats: { total: apiData.total || (apiData.work_orders || []).length },
          work_orders: apiData.work_orders || [],
        };
        STATE.data = fullData;
        window.JD_CMMS_DATA = fullData;
        applyFilters();
        return fullData;
      } catch (apiErr) {
        console.error("Failed to load JD CMMS data:", apiErr);
        const container = document.getElementById("jd-wo-list");
        if (container) {
          container.innerHTML = '<div class="card center" style="color:var(--coral);">⚠️ يتعذر تحميل أوامر الشغل حالياً</div>';
        }
      }
    }
  }

  function updateKpis(stats) {
    if (!stats) return;
    const elTotal = document.getElementById("jd-kpi-total");
    const elPm = document.getElementById("jd-kpi-open-pm");
    const elCm = document.getElementById("jd-kpi-open-cm");
    const elOverdue = document.getElementById("jd-kpi-overdue");

    if (elTotal) elTotal.textContent = (stats.total || 0).toLocaleString();
    if (elPm) elPm.textContent = (stats.open_pm || 0).toLocaleString();
    if (elCm) elCm.textContent = (stats.open_cm || 0).toLocaleString();
    if (elOverdue) elOverdue.textContent = (stats.overdue || 0).toLocaleString();
  }

  function populateHierarchyFilters(data) {
    const siteSel = document.getElementById("jd-filter-site");
    const deptSel = document.getElementById("jd-filter-dept");
    const machSel = document.getElementById("jd-filter-machine");

    if (!siteSel || !deptSel || !machSel) return;

    // Build unique sites
    const sites = data.sites || [
      { code: "S01", name: "Acacia (SPW01)" },
      { code: "S02", name: "Palmier (SPW02)" },
      { code: "GEN", name: "Utilities & Shared" },
    ];
    siteSel.innerHTML = '<option value="ALL">All Sites</option>' +
      sites.map(s => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name)}</option>`).join("");

    updateDeptFilter();
    updateMachineFilter();
    if (typeof initCustomSelectPickers === "function") initCustomSelectPickers();
    if (typeof updateCustomSelectTrigger === "function") {
      updateCustomSelectTrigger(siteSel);
      updateCustomSelectTrigger(deptSel);
      updateCustomSelectTrigger(machSel);
    }
  }

  function updateDeptFilter() {
    const deptSel = document.getElementById("jd-filter-dept");
    if (!deptSel || !STATE.data) return;

    const selectedSite = STATE.site;
    const allWos = STATE.data.work_orders || [];
    const deptsSet = new Map();

    allWos.forEach(w => {
      if (selectedSite === "ALL" || w.site === selectedSite) {
        if (w.dept && !deptsSet.has(w.dept)) {
          deptsSet.set(w.dept, w.deptName || w.dept);
        }
      }
    });

    let html = '<option value="ALL">All Departments</option>';
    deptsSet.forEach((name, code) => {
      html += `<option value="${escapeHtml(code)}">${escapeHtml(name)}</option>`;
    });
    deptSel.innerHTML = html;
    deptSel.value = "ALL";
    STATE.dept = "ALL";
    updateMachineFilter();
    if (typeof initCustomSelectPickers === "function") initCustomSelectPickers();
    if (typeof updateCustomSelectTrigger === "function") updateCustomSelectTrigger(deptSel);
  }

  function updateMachineFilter() {
    const machSel = document.getElementById("jd-filter-machine");
    if (!machSel || !STATE.data) return;

    const allWos = STATE.data.work_orders || [];
    const machineMap = new Map();

    allWos.forEach(w => {
      const matchSite = STATE.site === "ALL" || w.site === STATE.site;
      const matchDept = STATE.dept === "ALL" || w.dept === STATE.dept;
      if (matchSite && matchDept && w.asset && w.label) {
        if (!machineMap.has(w.asset)) {
          machineMap.set(w.asset, w.label);
        }
      }
    });

    let html = '<option value="ALL">All Machines</option>';
    machineMap.forEach((label, asset) => {
      html += `<option value="${escapeHtml(asset)}">${escapeHtml(label)}</option>`;
    });
    machSel.innerHTML = html;
    machSel.value = "ALL";
    STATE.machine = "ALL";
    if (typeof initCustomSelectPickers === "function") initCustomSelectPickers();
    if (typeof updateCustomSelectTrigger === "function") updateCustomSelectTrigger(machSel);
  }

  function applyFilters() {
    if (!STATE.data || !STATE.data.work_orders) return;
    syncFieldPartsFromWorkLog(STATE.data.work_orders);
    const all = STATE.data.work_orders;
    const q = STATE.q.trim().toLowerCase();

    STATE.filtered = all.filter(wo => {
      // Status filter
      if (STATE.status !== "ALL") {
        if (STATE.status === "OPEN_PM" && (wo.is_closed === 1 || (wo.type !== "6" && wo.type !== "M"))) return false;
        if (STATE.status === "OPEN_CM" && (wo.is_closed === 1 || wo.type !== "1")) return false;
        if (STATE.status === "OVERDUE" && (wo.is_closed === 1 || wo.is_overdue !== 1)) return false;
        if (STATE.status === "CLOSED" && wo.is_closed !== 1) return false;
        if (STATE.status === "WITH_PARTS") {
          if (!wo.has_parts || !wo.parts_issued || wo.parts_issued.length === 0) return false;
        }
      }

      // Hierarchy filters
      if (STATE.site !== "ALL" && wo.site !== STATE.site) return false;
      if (STATE.dept !== "ALL" && wo.dept !== STATE.dept) return false;
      if (STATE.machine !== "ALL" && wo.asset !== STATE.machine && wo.label !== STATE.machine) return false;

      // Search query
      if (q) {
        const text = [
          wo.wo,
          wo.asset,
          wo.label,
          wo.desc,
          wo.siteName,
          wo.deptName,
          wo.typeLabel,
          wo.statusLabel,
        ].join(" ").toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    STATE.page = 1;
    renderWorkOrders();
  }

  function renderWorkOrders() {
    const container = document.getElementById("jd-wo-list");
    const loadMoreBtn = document.getElementById("jd-btn-load-more");
    if (!container) return;

    const totalFiltered = STATE.filtered.length;
    const currentLimit = STATE.page * STATE.pageSize;
    const slice = STATE.filtered.slice(0, currentLimit);

    if (totalFiltered === 0) {
      container.innerHTML = `
        <div class="card center muted" style="padding:24px 16px;">
          <div style="font-size:28px; margin-bottom:8px;">🔍</div>
          <b style="color:var(--navy); font-size:15px;">No matching work orders found</b>
          <p style="font-size:12px; margin:4px 0 0;">Try adjusting your status, search query, or hierarchy filters.</p>
        </div>
      `;
      if (loadMoreBtn) loadMoreBtn.style.display = "none";
      return;
    }

    const cardsHtml = slice.map(wo => {
      const statusStyle = getStatusStyle(wo);
      const typeStyle = getTypeStyle(wo);
      const safeWo = escapeHtml(wo.wo || "");
      const safeAsset = escapeHtml(wo.asset || '0');
      const safeDesc = escapeHtml(wo.desc || "");
      const safeLabel = escapeHtml(wo.label || "Unassigned");
      const safeSite = escapeHtml(wo.siteName || wo.site || "General");
      const safeDept = escapeHtml(wo.deptName || wo.dept || "General");
      const safeDate = escapeHtml(wo.date || "N/A");
      const safePlan = escapeHtml(wo.plan || "Not Specified");
      const safeAct = escapeHtml(wo.act || (wo.is_closed ? "Closed" : "Open"));

      const partsCount = (wo.parts_issued && Array.isArray(wo.parts_issued)) ? wo.parts_issued.length : 0;
      const partsBadgeHtml = (wo.has_parts && partsCount > 0)
        ? `<span class="chip jd-parts-badge" style="background:var(--lblue); color:var(--navy); font-weight:700; border:1px solid #b8cbef;">📦 Parts Issued (${partsCount})</span>`
        : `<span class="chip jd-no-parts-badge" style="background:var(--alt); color:var(--muted); font-weight:500;">📦 No Parts</span>`;

      const partsBoxHtml = (wo.has_parts && partsCount > 0) ? `
        <div class="jd-parts-box" style="margin:8px 0; background:#ffffff; border:1px solid var(--line); border-radius:10px; overflow:hidden;">
          <div style="background:var(--alt); padding:6px 10px; display:flex; justify-content:space-between; align-items:center; font-size:12px; font-weight:700; color:var(--navy); border-bottom:1px solid var(--line);">
            <span style="display:flex; align-items:center; gap:5px;">
              <span>📦</span> Issued Spare Parts (${partsCount})
            </span>
            <span style="font-size:10px; font-weight:600; color:var(--coral); text-transform:uppercase; letter-spacing:0.5px;">Audited &amp; Tracked</span>
          </div>
          <div style="padding:4px 6px; overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:11px; text-align:left;">
              <thead>
                <tr style="color:var(--muted); border-bottom:1px solid var(--line); font-size:10px; text-transform:uppercase;">
                  <th style="padding:4px 6px;">Code</th>
                  <th style="padding:4px 6px;">Description</th>
                  <th style="padding:4px 6px; text-align:center;">Qty</th>
                  <th style="padding:4px 6px; text-align:right;">Source / Date</th>
                </tr>
              </thead>
              <tbody>
                ${wo.parts_issued.map(p => `
                  <tr style="border-bottom:1px solid var(--alt);">
                    <td style="padding:5px 6px; font-weight:700; font-family:monospace; color:var(--navy);">${escapeHtml(p.code || "N/A")}</td>
                    <td style="padding:5px 6px; color:var(--ink);">${escapeHtml(p.name || "")}</td>
                    <td style="padding:5px 6px; text-align:center; font-weight:700; color:var(--coral);">${escapeHtml(String(p.qty || 1))} <span style="font-size:9px; font-weight:normal; color:var(--muted);">${escapeHtml(p.unit || "")}</span></td>
                    <td style="padding:5px 6px; text-align:right; font-size:10px; color:var(--muted); white-space:nowrap;">
                      <span class="chip" style="font-size:9px; padding:2px 5px; background:${p.source && p.source.includes('Field') ? '#eaf5e3' : 'var(--alt)'}; color:${p.source && p.source.includes('Field') ? '#4F6228' : 'var(--navy)'};">${escapeHtml(p.source || "Warehouse")}</span>
                      <div style="font-size:9px; margin-top:2px;">${escapeHtml(p.date || "")}</div>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      ` : "";

      return `
        <div class="card jd-wo-card" data-wo="${safeWo}" style="border-inline-start: 5px solid ${statusStyle.border}; margin-bottom:10px; padding:12px 14px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
              <span class="chip" style="background:var(--navy); color:#fff; font-weight:700;">#WO ${safeWo}</span>
              <span class="chip" style="background:${typeStyle.bg}; color:${typeStyle.fg}; font-weight:700;">${escapeHtml(wo.typeLabel)}</span>
              <span class="chip" style="background:${statusStyle.bg}; color:${statusStyle.fg}; font-weight:700;">${escapeHtml(wo.statusLabel)}</span>
              ${partsBadgeHtml}
            </div>
            <span style="font-size:11px; color:var(--muted); white-space:nowrap;">${safeDate}</span>
          </div>

          <!-- Machine & Asset Information (Strict English) -->
          <div style="margin:8px 0 4px; font-weight:700; color:var(--navy); font-size:14px;">
            ${safeLabel} <span style="font-weight:400; color:var(--muted); font-size:12px;">(Asset: ${safeAsset})</span>
          </div>
          <div style="font-size:11px; color:var(--muted); margin-bottom:6px;">
            <span>${safeSite}</span> &bull; <span>${safeDept}</span>
          </div>

          <!-- Work Order Description (English) -->
          <div style="background:var(--alt); border-radius:8px; padding:8px 10px; font-size:13px; color:var(--ink); margin:6px 0; font-family:monospace; line-height:1.4; word-break:break-word;">
            ${safeDesc}
          </div>

          <!-- Dates Grid -->
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:11px; color:var(--muted); margin:6px 0;">
            <div>Planned: <b style="color:var(--ink);">${safePlan}</b></div>
            <div>Actual: <b style="color:var(--ink);">${safeAct}</b></div>
          </div>

          <!-- Issued Parts Box -->
          ${partsBoxHtml}

          <!-- Actions -->
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px; border-top:1px solid var(--line); padding-top:8px;">
            <button class="btn ghost btn-copy-wo" data-wo="${safeWo}" style="padding:6px 10px; font-size:12px;">
              📋 نسخ الرقم
            </button>
            <button class="btn main btn-bridge-wo" data-wo="${safeWo}" onclick="bridgeWorkOrderToLog('${safeWo}')" style="padding:6px 12px; font-size:12px; background:var(--coral); color:#fff; display:flex; align-items:center; gap:4px;">
              <span>📝</span> ترحيل للسجل (Log WO)
            </button>
          </div>
        </div>
      `;
    }).join("");

    container.innerHTML = cardsHtml;

    // Attach copy buttons
    container.querySelectorAll(".btn-copy-wo").forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const woNum = btn.dataset.wo;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(woNum).then(() => {
            if (typeof toast === "function") toast("تم نسخ رقم أمر الشغل #" + woNum);
          });
        }
      };
    });

    // Attach bridge buttons (Security hardening)
    container.querySelectorAll(".btn-bridge-wo").forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const woNum = btn.dataset.wo;
        if (typeof window.bridgeWorkOrderToLog === "function") {
          window.bridgeWorkOrderToLog(woNum);
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

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function initJdCmmsEvents() {
    if (STATE.initialized) return;
    STATE.initialized = true;

    // Search input
    const searchInput = document.getElementById("jd-search-input");
    if (searchInput) {
      searchInput.oninput = () => {
        STATE.q = searchInput.value;
        applyFilters();
      };
    }

    // Status filter chips
    const statusFilters = document.getElementById("jd-status-filters");
    if (statusFilters) {
      statusFilters.querySelectorAll("button[data-status]").forEach(btn => {
        btn.onclick = () => {
          statusFilters.querySelectorAll("button").forEach(b => b.classList.remove("on"));
          btn.classList.add("on");
          STATE.status = btn.dataset.status;
          applyFilters();
        };
      });
    }

    // Hierarchy selects
    const siteSel = document.getElementById("jd-filter-site");
    if (siteSel) {
      siteSel.onchange = () => {
        STATE.site = siteSel.value;
        updateDeptFilter();
        applyFilters();
      };
    }

    const deptSel = document.getElementById("jd-filter-dept");
    if (deptSel) {
      deptSel.onchange = () => {
        STATE.dept = deptSel.value;
        updateMachineFilter();
        applyFilters();
      };
    }

    const machSel = document.getElementById("jd-filter-machine");
    if (machSel) {
      machSel.onchange = () => {
        STATE.machine = machSel.value;
        applyFilters();
      };
    }

    // Load more button
    const loadMoreBtn = document.getElementById("jd-btn-load-more");
    if (loadMoreBtn) {
      loadMoreBtn.onclick = () => {
        STATE.page += 1;
        renderWorkOrders();
      };
    }
  }

  function initJdCmmsTab() {
    initJdCmmsEvents();
    loadJdCmmsData();
  }

  // Export functions to window
  window.loadJdCmmsData = loadJdCmmsData;
  window.renderJdWorkOrders = renderWorkOrders;
  window.syncFieldPartsFromWorkLog = syncFieldPartsFromWorkLog;
  window.initJdCmmsTab = initJdCmmsTab;

  // Auto-init on DOMContentLoaded or immediate
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initJdCmmsTab();
    });
  } else {
    initJdCmmsTab();
  }
})();

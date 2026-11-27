/**
 * JD Edwards CMMS Work Orders Engine for Servier Egypt Maintenance Unified PWA
 * Pure Work Orders module (decoupled from Spare Parts module: spare_parts.js)
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

  async function loadJdCmmsData(forceRefresh) {
    if (typeof window.isAppUnlocked === "function" && !window.isAppUnlocked()) {
      return null;
    }
    if (STATE.data && !forceRefresh) return STATE.data;
    try {
      let data = null;
      if (typeof window.fetchProtectedData === "function") {
        data = await window.fetchProtectedData("/v1/data/work_orders", "cairo_cache_wo");
      }
      if (!data) throw new Error("No authenticated work orders data");
      STATE.data = data;
      window.JD_CMMS_DATA = data;
      updateKpis(data.stats);
      populateHierarchyFilters(data);
      applyFilters();
      return data;
    } catch (err) {
      console.warn("Protected Work Orders fetch failed:", err);
      const container = document.getElementById("jd-wo-list");
      if (container) {
        container.innerHTML = '<div class="card center" style="color:var(--coral);">🔒 يتطلب اتصال بالخادم وكود تفعيل ساري لتحميل أوامر الشغل</div>';
      }
      return null;
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
    const all = STATE.data.work_orders;
    const q = STATE.q.trim().toLowerCase();

    STATE.filtered = all.filter(wo => {
      // Status filter
      if (STATE.status !== "ALL") {
        if (STATE.status === "OPEN_PM" && (wo.is_closed === 1 || (wo.type !== "6" && wo.type !== "M"))) return false;
        if (STATE.status === "OPEN_CM" && (wo.is_closed === 1 || wo.type !== "1")) return false;
        if (STATE.status === "OVERDUE" && (wo.is_closed === 1 || wo.is_overdue !== 1)) return false;
        if (STATE.status === "CLOSED" && wo.is_closed !== 1) return false;
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
      const safeAsset = escapeHtml(wo.asset || "0");
      const safeDesc = escapeHtml(wo.desc || "");
      const safeLabel = escapeHtml(wo.label || "Unassigned");
      const safeSite = escapeHtml(wo.siteName || wo.site || "General");
      const safeDept = escapeHtml(wo.deptName || wo.dept || "General");
      const safeDate = escapeHtml(wo.date || "N/A");
      const safePlan = escapeHtml(wo.plan || "Not Specified");
      const safeAct = escapeHtml(wo.act || (wo.is_closed ? "Closed" : "Open"));

      return `
        <div class="card jd-wo-card" data-wo="${safeWo}" style="border-inline-start: 5px solid ${statusStyle.border}; margin-bottom:10px; padding:12px 14px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
              <span class="chip" style="background:var(--navy); color:#fff; font-weight:700;">#WO ${safeWo}</span>
              <span class="chip" style="background:${typeStyle.bg}; color:${typeStyle.fg}; font-weight:700;">${escapeHtml(wo.typeLabel)}</span>
              <span class="chip" style="background:${statusStyle.bg}; color:${statusStyle.fg}; font-weight:700;">${escapeHtml(wo.statusLabel)}</span>
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

          <!-- Actions -->
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px; border-top:1px solid var(--line); padding-top:8px;">
            <button class="btn ghost btn-copy-wo" data-wo="${safeWo}" style="padding:6px 10px; font-size:12px;">
              📋 نسخ الرقم
            </button>
            <button class="btn main btn-bridge-wo" data-wo="${safeWo}" style="padding:6px 12px; font-size:12px; background:var(--coral); color:#fff; display:flex; align-items:center; gap:4px;">
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

    // Attach bridge buttons
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

  async function openWorkOrderInCmms(woNumber) {
    const woStr = String(woNumber || "").trim();
    if (!woStr) return;

    if (typeof window.switchTab === "function") {
      window.switchTab("jd");
    }
    if (typeof window.switchCmmsSubtab === "function") {
      window.switchCmmsSubtab("wo");
    }

    initJdCmmsEvents();
    await loadJdCmmsData();

    // Reset filters so the target WO is guaranteed visible
    STATE.status = "ALL";
    STATE.site = "ALL";
    STATE.dept = "ALL";
    STATE.machine = "ALL";
    STATE.q = woStr;

    const statusFilters = document.getElementById("jd-status-filters");
    if (statusFilters) {
      statusFilters.querySelectorAll("button").forEach(b => {
        b.classList.toggle("on", b.dataset.status === "ALL");
      });
    }
    const siteSel = document.getElementById("jd-filter-site");
    if (siteSel) {
      siteSel.value = "ALL";
      updateDeptFilter();
      if (typeof updateCustomSelectTrigger === "function") updateCustomSelectTrigger(siteSel);
    }
    const searchInput = document.getElementById("jd-search-input");
    if (searchInput) searchInput.value = woStr;

    applyFilters();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function initJdCmmsEvents() {
    if (STATE.initialized) return;
    STATE.initialized = true;

    const searchInput = document.getElementById("jd-search-input");
    if (searchInput) {
      searchInput.oninput = () => {
        STATE.q = searchInput.value;
        applyFilters();
      };
    }

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
  window.openWorkOrderInCmms = openWorkOrderInCmms;
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

/**
 * Google Apps Script — Daily Automatic Spare Parts Sync (Gmail -> GitHub Pages)
 *
 * Setup (one-time, 2 minutes):
 * 1. Go to https://script.google.com -> New Project -> Paste this file.
 * 2. In Project Settings -> Script Properties, add:
 *      GITHUB_TOKEN = <Personal Access Token with Contents: Read & Write on cairo-worklog-pwa>
 * 3. Run syncDailySparePartsFromGmail() once to grant Gmail & UrlFetch permissions.
 * 4. Add a Time-Driven Trigger (Clock icon): Daily, ~10 minutes after the "super pates" email arrives.
 */

const CONFIG = {
  GMAIL_QUERY: 'subject:("super pates" OR "spare parts" OR "spars parts") has:attachment newer_than:3d',
  GITHUB_OWNER: "Amr518",
  GITHUB_REPO: "cairo-worklog-pwa",
  GITHUB_BRANCH: "main",
  TARGET_FILE: "spare_parts_data.json",
};

const WAREHOUSE_NAMES = {
  SPW01: "SPW01 — Acacia",
  SPW02: "SPW02 — Palmier",
  SPW03: "SPW03 — Store 03",
  SPW04: "SPW04 — Store 04",
  SPW05: "SPW05 — Store 05",
};

const EQUIP_GROUP_MAP = {
  CAM: "CAM Packaging", FE: "Fette Compression", GEASP: "GEA Granulation",
  BLISTER: "Blister Lines", MANESTY: "Manesty Coating", GUK: "GUK Folder",
  QC: "QC Lab", BUNDLING: "Bundling", HVAC: "HVAC & AHU",
  FORKLIFT: "Forklift", IMAFLEXA: "IMA Flexa Cartoner", BMS: "BMS / EMS",
  STEAMBOI: "Steam Boiler", BOILER: "Steam Boiler", PWP: "Purified Water (PW)",
  DMXTHEM: "DMX / Thermoforming", GS: "GS Coating", CHILLER: "Chillers",
  LABELING: "Labeling", AIRBOXER: "Airboxer", COUNTING: "Counting (PPS)",
  MG: "MG2 Capsule Filling", ATLASCOP: "Compressed Air", COMAIRL: "Compressed Air",
  KARLVILE: "Karlville", PRODIECO: "Prodieco", NERI: "Neri",
  PUC: "PUC", SEAV: "Sea Vision", SEAVSION: "Sea Vision",
  STANDGEN: "Standby Generator", LIGHTING: "Lighting", SVIAC: "Sviac Compression",
  FILTERS: "Filters", BOHLE: "Bohle Blender", CLEANTEK: "CleanTek",
  ELECTRIC: "Electrical Distribution", POWERFAC: "Electrical Distribution",
  FIREFITG: "Fire Fighting", CHEMICAL: "Chemicals", SAMPBOTH: "Sampling Booth",
  WEIGHING: "Weighing", BATTERY: "Batteries",
};

function syncDailySparePartsFromGmail() {
  const token = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  if (!token) throw new Error("Missing Script Property: GITHUB_TOKEN");

  const threads = GmailApp.search(CONFIG.GMAIL_QUERY, 0, 5);
  if (!threads.length) {
    Logger.log("No matching email found.");
    return;
  }

  let csvText = null;
  let emailDate = null;

  for (const thread of threads) {
    const msgs = thread.getMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      for (const att of msg.getAttachments()) {
        if (/\.csv$/i.test(att.getName())) {
          csvText = att.getDataAsString("UTF-8");
          emailDate = msg.getDate();
          break;
        }
      }
      if (csvText) break;
    }
    if (csvText) break;
  }

  if (!csvText) {
    Logger.log("No CSV attachment found in recent matching emails.");
    return;
  }

  const payload = parseJdeSparesCsv_(csvText, emailDate);
  const jsonContent = JSON.stringify(payload);
  pushToGitHub_(token, jsonContent, emailDate);
  Logger.log("Synced " + payload.stats.total_skus + " SKUs to GitHub.");
}

function mergeDesc_(rawD1, rawD2) {
  const d1 = (rawD1 || "").trim();
  const d2 = (rawD2 || "").trim();
  if (!d2 || d2.toLowerCase() === d1.toLowerCase()) return { name: d1, ref: "" };
  if (d1.length < 24 && /^[A-Z0-9][A-Z0-9\-\.\/]{4,}$/.test(d2)) {
    return { name: d1, ref: d2 };
  }
  const joinNoSpace =
    rawD1.length >= 25 &&
    !rawD1.endsWith(" ") &&
    !rawD2.startsWith(" ") &&
    (/^[a-z.\-\/)]/.test(d2) || /[\-.\/(]$/.test(rawD1));
  return { name: (joinNoSpace ? d1 + d2 : d1 + " " + d2).replace(/\s+/g, " ").trim(), ref: "" };
}

function parseLotDate_(lot) {
  const m = /^(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/.exec((lot || "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function resolveGroup_(loc) {
  const m = /^([A-Za-z]+)/.exec(loc || "");
  return m ? (EQUIP_GROUP_MAP[m[1].toUpperCase()] || "General Store") : "General Store";
}

function parseJdeSparesCsv_(csvText, emailDate) {
  const rows = Utilities.parseCsv(csvText.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("Empty CSV");

  const header = rows[0].map(h => String(h || "").trim());
  const idx = {
    loc: header.indexOf("[Location]"),
    bu: header.indexOf("[Business Unit]"),
    code: header.indexOf("[Item Number]"),
    d1: header.indexOf("[Description]"),
    d2: header.indexOf("[Description - Line 2]"),
    qty: header.indexOf("[Quantity on Hand - Primary units]"),
    lot: header.indexOf("[Lot/Serial Number]"),
    ps: header.indexOf("[Primary Location (P/S)]"),
  };

  const map = {};
  let anomalies = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const code = String(r[idx.code] || "").trim();
    if (!code) continue;

    const bu = String(r[idx.bu] || "").trim();
    const loc = String(r[idx.loc] || "").trim().replace(/\s+/g, " ");
    const rawD1 = String(r[idx.d1] || "");
    const rawD2 = String(r[idx.d2] || "");
    const lot = String(r[idx.lot] || "").trim();
    const ps = String(r[idx.ps] || "").trim();
    const qf = parseFloat(String(r[idx.qty] || "0").replace(/,/g, "").trim()) || 0;
    const qty = Number.isInteger(qf) ? qf : Math.round(qf * 100) / 100;

    if (qty < 0) anomalies++;

    if (!map[code]) {
      const merged = mergeDesc_(rawD1, rawD2);
      map[code] = {
        code, name: merged.name, ref: merged.ref, qty: 0,
        primaryLoc: "", allLocs: new Set(), buQty: {}, binQty: {}, lastDate: "", allDates: []
      };
    }

    const it = map[code];
    it.qty += qty;
    if (loc) {
      it.allLocs.add(loc);
      if (!it.primaryLoc && ps === "P") it.primaryLoc = loc;
    }
    const dt = parseLotDate_(lot);
    if (dt) it.allDates.push(dt);

    if (qty > 0) {
      if (bu) it.buQty[bu] = (it.buQty[bu] || 0) + qty;
      const bKey = bu + "||" + loc;
      it.binQty[bKey] = (it.binQty[bKey] || 0) + qty;
      if (dt && dt > it.lastDate) it.lastDate = dt;
    }
  }

  const parts = [];
  const grpCounts = {};
  let inStock = 0, lowStock = 0, zeroStock = 0, totalUnits = 0;

  Object.keys(map).forEach(code => {
    const it = map[code];
    const qty = Math.max(0, it.qty);
    if (qty > 0) {
      inStock++;
      totalUnits += qty;
      if (qty <= 2) lowStock++;
    } else {
      zeroStock++;
    }

    const buEntries = Object.entries(it.buQty).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    let mainBu = buEntries.length ? buEntries[0][0] : "SPW01";

    const binEntries = Object.entries(it.binQty)
      .map(([k, q]) => { const [b, l] = k.split("||"); return { bu: b, loc: l, qty: q }; })
      .sort((a, b) => b.qty - a.qty || a.bu.localeCompare(b.bu) || a.loc.localeCompare(b.loc));

    let loc = it.primaryLoc || Array.from(it.allLocs).sort()[0] || "";
    if (binEntries.length) {
      if (binEntries[0].bu) mainBu = binEntries[0].bu;
      if (binEntries[0].loc) loc = binEntries[0].loc;
    }

    const grp = resolveGroup_(loc);
    grpCounts[grp] = (grpCounts[grp] || 0) + 1;

    const lastDate = it.lastDate || (it.allDates.length ? it.allDates.sort().pop() : "");
    const rec = { code, name: it.name || code, qty, bu: mainBu, loc, grp };
    if (it.ref) rec.ref = it.ref;
    if (lastDate) rec.dt = lastDate;
    if (binEntries.length > 1) rec.bins = binEntries;
    parts.push(rec);
  });

  parts.sort((a, b) => (a.qty > 0 ? 0 : 1) - (b.qty > 0 ? 0 : 1) || b.qty - a.qty || a.grp.localeCompare(b.grp) || a.code.localeCompare(b.code));

  return {
    version: "2.0",
    source: "JDE Daily Inventory Report",
    exported_at: Utilities.formatDate(emailDate || new Date(), "UTC", "yyyy-MM-dd'T'HH:mm:ss'Z'"),
    stats: { total_skus: parts.length, in_stock: inStock, low_stock: lowStock, zero_stock: zeroStock, total_units: totalUnits, anomalies },
    warehouses: Object.keys(WAREHOUSE_NAMES).map(code => ({ code, name: WAREHOUSE_NAMES[code] })),
    groups: Object.entries(grpCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
    parts,
  };
}

function pushToGitHub_(token, content, emailDate) {
  const url = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/contents/${CONFIG.TARGET_FILE}`;
  const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };

  let sha = null;
  const getRes = UrlFetchApp.fetch(url + "?ref=" + CONFIG.GITHUB_BRANCH, { headers, muteHttpExceptions: true });
  if (getRes.getResponseCode() === 200) {
    sha = JSON.parse(getRes.getContentText()).sha;
  }

  const dateTag = Utilities.formatDate(emailDate || new Date(), "Africa/Cairo", "yyyy-MM-dd");
  const body = {
    message: `chore(spares): daily automatic JDE warehouse inventory sync (${dateTag})`,
    content: Utilities.base64Encode(Utilities.newBlob(content, "application/json").getBytes()),
    branch: CONFIG.GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const putRes = UrlFetchApp.fetch(url, {
    method: "put",
    contentType: "application/json",
    headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  if (putRes.getResponseCode() >= 300) {
    throw new Error("GitHub push failed (" + putRes.getResponseCode() + "): " + putRes.getContentText());
  }
}

/* ═══════════════════════════════════════════════════════════════
   QMaps Audit BB – Frontend Application v2
   Census | Audit | Reports – with improved UX
   ═══════════════════════════════════════════════════════════════ */

/* ── State ── */
let allClients = [];
let censusFiltered = [];
let auditFiltered = [];
let auditClients = [];
let matrixData = {};
let currentUsername = "";
let currentDisplayName = "";
let currentRole = "";
let currentSalesRep = "";
let currentTab = "vizite";
let _csrfToken = "";
try { _csrfToken = sessionStorage.getItem("csrf_token") || ""; } catch(e) {}

/* ── CSRF-aware fetch wrapper ── */
const _origFetch = window.fetch;
window.fetch = function(url, opts = {}) {
  if (_csrfToken && opts.method && ["POST","PUT","DELETE"].includes(opts.method.toUpperCase())) {
    opts.headers = opts.headers || {};
    if (opts.headers instanceof Headers) {
      opts.headers.set("X-CSRF-Token", _csrfToken);
    } else {
      opts.headers["X-CSRF-Token"] = _csrfToken;
    }
  }
  return _origFetch.call(this, url, opts);
};
let currentVisitClientId = null;
let currentVisitId = null;
let currentVisitProducts = [];
let auditStatusFilter = "all"; // all | unvisited | open | done

/* Purchase data (from client_deliveries) */
let purchaseMap = {}; // client code → { valoare, cantHL, skuCount }

/* Route mode state */
let routeMode = false;
let routeClients = []; // [{id, lat, lon, name}]

/* Nearby clients state */
let nearbyMarkerGroup = null;
let nearbyCircle = null;
let nearbyUserMarker = null;

/* Filter selections per tab */
const censusSel = { sr: new Set(), agent: new Set(), city: new Set(), canal: new Set(), format: new Set(), stare: new Set(), munic: new Set(), activ: new Set(), achizitii: new Set() };
const auditSel = { sr: new Set(), agent: new Set(), city: new Set(), canal: new Set(), format: new Set(), achizitii: new Set() };

/* ── Toast notifications ── */
function toast(msg, type = "info", duration = 3000) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 300); }, duration);
}

/* ── Map setup ── */
let map, markers;

function initMap() {
  const isMobile = window.innerWidth <= 768;
  map = L.map("map", { zoomControl: false }).setView([47.16, 27.58], 11);
  if (!isMobile) L.control.zoom({ position: "topleft" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap", maxZoom: 19
  }).addTo(map);
  markers = L.markerClusterGroup({ maxClusterRadius: 40 });
  map.addLayer(markers);
}

/* ── Home Grid Menu ── */
function showHomeGrid() {
  document.getElementById('homeGrid').style.display = 'flex';
  document.getElementById('mainLayout').style.display = 'none';
  // Update user label on home
  const ul = document.getElementById('userLabel');
  const hl = document.getElementById('homeUserLabel');
  if (ul && hl) hl.textContent = ul.textContent;
}
function openFromGrid(tab, label) {
  document.getElementById('homeGrid').style.display = 'none';
  document.getElementById('mainLayout').style.display = 'flex';
  selectTab(tab, label);
}

/* ── Tab dropdown menu ── */
const tabLabels = { census: "CENSUS", audit: "AUDIT", obiective: "OBIECTIVE", incasari: "ÎNCASĂRI", vizite: "VIZITE", reports: "RAPOARTE", comunicare: "COMUNICARE", taskuri: "TASKURI", gps: "GPS TRACKING", competitie: "COMPETIȚIE", frigider: "FRIGIDER", promotii: "PROMOȚII", calendar: "CALENDAR", expirari: "EXPIRĂRI", solduri: "SCADENȚAR", escaladari: "ESCALADĂRI SPV", alertaClient: "ALERTĂ CLIENT", riscFinanciar: "RISC FINANCIAR", cuiVerify: "VERIFICARE CUI", perfTargete: "PERFORMANȚĂ TARGETE", ranking: "RANKING AGENȚI", discounturi: "CONTROL DISCOUNTURI", contracte: "CONTRACTE B2B", contracteB2C: "CONTRACTE B2C", smartTargets: "OBIECTIVE LUNARE", promoBudgets: "BUGETE PROMO", dashboardAll: "DASHBOARD VÂNZĂRI", uploadRapoarte: "ÎNCĂRCARE RAPOARTE", bugetGt: "BUGET GT" };

function toggleTabMenu() {
  const menu = document.getElementById("tabDropdownMenu");
  menu.classList.toggle("open");
}

function selectTab(tab, label) {
  document.getElementById("tabDropdownMenu").classList.remove("open");
  document.getElementById("tabDropdownBtn").textContent = label + " ▾";
  document.querySelectorAll(".tab-menu-item").forEach(b => b.classList.remove("active"));
  document.getElementById("tab" + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add("active");
  switchTab(tab);
}

// Close dropdown when clicking outside
document.addEventListener("click", function(e) {
  const wrap = document.querySelector(".tab-dropdown-wrap");
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById("tabDropdownMenu").classList.remove("open");
  }
});

/* ── Tab switching ── */
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab-panel").forEach(p => p.style.display = "none");
  document.getElementById("panel" + tab.charAt(0).toUpperCase() + tab.slice(1)).style.display = "";

  // Update dropdown button text
  const btn = document.getElementById("tabDropdownBtn");
  if (btn && tabLabels[tab]) btn.textContent = tabLabels[tab] + " ▾";

  if (tab === "census") renderCensusMap();
  else if (tab === "audit") renderAuditMap();
  else if (tab === "obiective") loadObiective();
  else if (tab === "incasari") loadIncasari();
  else if (tab === "vizite") loadVizite();
  else if (tab === "comunicare") loadComunicare();
  else if (tab === "taskuri") loadTaskuri();
  else if (tab === "gps") loadGps();
  else if (tab === "competitie") loadCompetition();
  else if (tab === "frigider") loadFridge();
  else if (tab === "promotii") loadPromotions();
  else if (tab === "calendar") loadCalendar();
  else if (tab === "expirari") loadExpiry();
  else if (tab === "solduri") loadSolduri();
  else if (tab === "escaladari") loadEscalations();
  else if (tab === "alertaClient") loadClientAlerts();
  else if (tab === "riscFinanciar") loadFinancialRisk();
  else if (tab === "cuiVerify") loadCuiVerifications();
  else if (tab === "perfTargete") loadPerfTargete();
  else if (tab === "ranking") loadRankings();
  else if (tab === "discounturi") loadDiscounts();
  else if (tab === "contracte") loadContracts();
  else if (tab === "contracteB2C") loadContractsB2C();
  else if (tab === "smartTargets") loadSmartTargets();
  else if (tab === "promoBudgets") loadPromoBudgets();
  else if (tab === "dashboardAll") loadDashboardAll();
  else if (tab === "bugetGt") loadGtCentralizator();

  /* Hide map for full-width tabs */
  const mapWrap = document.querySelector(".map-wrap");
  const sidebar = document.querySelector(".sidebar");
  if (mapWrap) {
    const isFullWidth = tab === "uploadRapoarte" || tab === "bugetGt" || tab === "obiective" || tab === "dashboardAll";
    mapWrap.style.display = isFullWidth ? "none" : "";
    if (sidebar) sidebar.style.maxWidth = isFullWidth ? "100%" : "";
    if (sidebar) sidebar.style.flex = isFullWidth ? "1" : "";
  }
  if (tab !== "uploadRapoarte" && tab !== "obiective" && tab !== "dashboardAll") setTimeout(() => map.invalidateSize(), 100);
}

/* ── Auth check ── */
async function checkAuth() {
  try {
    const r = await fetch("/api/me");
    if (!r.ok) throw new Error();
    const d = await r.json();
    currentUsername = d.username;
    currentDisplayName = d.display_name || d.username;
    currentRole = d.role || "agent";
    currentSalesRep = d.sales_rep || "";
    if (d.csrf_token) _csrfToken = d.csrf_token;
    const roleLabel = currentRole === "admin" ? "ADMIN" : currentRole === "spv" ? "SPV" : currentRole === "upload" ? "UPLOAD" : "AGENT";
    document.getElementById("userLabel").textContent = `${currentDisplayName} (${roleLabel})`;

    /* ── UPLOAD ROLE: only show "Încărcare Rapoarte" tab ── */
    if (currentRole === "upload") {
      // Hide ALL regular tabs
      document.querySelectorAll(".tab-menu-item").forEach(btn => {
        btn.style.display = "none";
      });
      // Hide dividers
      const tabMenu = document.getElementById("tabDropdownMenu");
      if (tabMenu) tabMenu.querySelectorAll("div[style*='border-top']").forEach(div => div.style.display = "none");
      // Show only upload tab
      const uploadTab = document.getElementById("tabUploadRapoarte");
      if (uploadTab) uploadTab.style.display = "";
      // Hide route/proposals buttons
      const routeBtn = document.getElementById("routeToggleBtn");
      if (routeBtn) routeBtn.style.display = "none";
      const propBtn = document.getElementById("proposalsBtn");
      if (propBtn) propBtn.style.display = "none";
      // Set default months
      const now = new Date().toISOString().slice(0,7);
      ["uploadRapTargetMonth","uploadRapDiscountMonth","uploadRapPromoBudgetMonth"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = now;
      });
      // Auto-select upload tab
      selectTab("uploadRapoarte", "ÎNCĂRCARE RAPOARTE");
      return true;
    }

    // Show/hide role-specific elements
    if (currentRole === "admin") {
      const gpsTab = document.getElementById("tabGps");
      if (gpsTab) gpsTab.style.display = "";
      const gpsAdmin = document.getElementById("gpsAdminView");
      if (gpsAdmin) gpsAdmin.style.display = "";
      const cleanupBtn = document.getElementById("btnCleanup");
      if (cleanupBtn) cleanupBtn.style.display = "";
    }
    if (currentRole !== "agent") {
      const annForm = document.getElementById("annCreateForm");
      if (annForm) annForm.style.display = "";
      const taskForm = document.getElementById("taskCreateForm");
      if (taskForm) taskForm.style.display = "";
      const taskFilter = document.getElementById("taskFilterBar");
      if (taskFilter) taskFilter.style.display = "";
      const promoForm = document.getElementById("promoCreateForm");
      if (promoForm) promoForm.style.display = "";
      const calAdmin = document.getElementById("calAdminFilter");
      if (calAdmin) calAdmin.style.display = "";
      // Show upload forms for SPV/Admin
      const solduriUpload = document.getElementById("solduriUploadForm");
      if (solduriUpload) solduriUpload.style.display = "";
      const scadentarUpload = document.getElementById("scadentarUploadForm");
      if (scadentarUpload) scadentarUpload.style.display = "";
      const riscUpload = document.getElementById("riscUploadForm");
      if (riscUpload) riscUpload.style.display = "";
      // Performanță upload forms
      const perfUpload = document.getElementById("perfTargeteUploadForm");
      if (perfUpload) perfUpload.style.display = "";
      const discUpload = document.getElementById("discountUploadForm");
      if (discUpload) discUpload.style.display = "";
      const rankAdmin = document.getElementById("rankingAdminView");
      if (rankAdmin) rankAdmin.style.display = "";
      const smartAdmin = document.getElementById("smartAdminView");
      if (smartAdmin) smartAdmin.style.display = "";
      const pbUpload = document.getElementById("promoBudgetUploadForm");
      if (pbUpload) pbUpload.style.display = "";
    } else {
      const gpsAgent = document.getElementById("gpsAgentView");
      if (gpsAgent) gpsAgent.style.display = "";
      // Start GPS tracking for agents
      startGpsTracking();
    }
    // Show agent-specific views for escalations and alerts
    if (currentRole === "agent") {
      const escAgent = document.getElementById("escAgentView");
      if (escAgent) escAgent.style.display = "";
      const alertAgent = document.getElementById("alertAgentView");
      if (alertAgent) alertAgent.style.display = "";
    }

    /* ── Show nearby clients section for all roles (except upload) ── */
    const nearbySection = document.getElementById("nearbySection");
    if (nearbySection) nearbySection.style.display = "";

    return true;
  } catch {
    window.location.href = "/login.html";
    return false;
  }
}

/* ── Data loading ── */
async function loadData() {
  try {
    const [r1, r2, r3, r4] = await Promise.all([
      fetch("/api/clients"),
      fetch("/api/audit/clients"),
      fetch("/api/bootstrap"),
      fetch("/api/purchases/summary")
    ]);

    if (!r1.ok) { window.location.href = "/login.html"; return; }
    allClients = await r1.json();
    if (r2.ok) auditClients = await r2.json();
    if (r3.ok) {
      const d = await r3.json();
      matrixData = d.matrix || {};
    }
    if (r4.ok) {
      const pData = await r4.json();
      purchaseMap = pData.clients || {};
    }

    buildCensusFilters();
    buildAuditFilters();
    applyCensusFilters();
    applyAuditFilters();

    document.getElementById("loadingOverlay").style.display = "none";
    document.getElementById("reportDate").value = new Date().toISOString().slice(0, 10);
    toast(`${allClients.length} clienți încărcați`, "success");
  } catch (ex) {
    toast("Eroare la încărcarea datelor: " + ex.message, "error", 5000);
    document.getElementById("loadingOverlay").style.display = "none";
  }
}

/* ── Refresh data ── */
async function refreshData() {
  toast("Se reîncarcă datele...", "info", 2000);
  try {
    const [r1, r2, r4] = await Promise.all([
      fetch("/api/clients"),
      fetch("/api/audit/clients"),
      fetch("/api/purchases/summary")
    ]);
    if (r1.ok) allClients = await r1.json();
    if (r2.ok) auditClients = await r2.json();
    if (r4 && r4.ok) { const pData = await r4.json(); purchaseMap = pData.clients || {}; }
    buildCensusFilters();
    buildAuditFilters();
    applyCensusFilters();
    applyAuditFilters();
    toast(`Date reîncărcate: ${allClients.length} clienți`, "success");
  } catch (ex) {
    toast("Eroare la reîncărcare: " + ex.message, "error", 5000);
  }
}

/* ═══════════════════════════════════════════
   CENSUS TAB
   ═══════════════════════════════════════════ */

function groupBy(arr, key) {
  const m = {};
  for (const item of arr) {
    const v = item[key] || "NECUNOSCUT";
    m[v] = (m[v] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0], "ro"));
}

function renderFilterChecklist(containerId, items, selectedSet, searchId) {
  const container = document.getElementById(containerId);
  container.innerHTML = items.map(([val, cnt]) => `
    <label class="check-item">
      <input type="checkbox" data-val="${esc(val)}" ${selectedSet.has(val) ? "checked" : ""}>
      <span>${esc(val)}</span>
      <em>${cnt}</em>
    </label>
  `).join("");

  container.querySelectorAll("input").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) selectedSet.add(cb.dataset.val);
      else selectedSet.delete(cb.dataset.val);
    });
  });

  if (searchId) {
    const searchEl = document.getElementById(searchId);
    if (searchEl && !searchEl.dataset.bound) {
      searchEl.dataset.bound = "1";
      searchEl.addEventListener("input", e => {
        const q = e.target.value.toLowerCase();
        container.querySelectorAll(".check-item").forEach(el => {
          el.style.display = el.textContent.toLowerCase().includes(q) ? "" : "none";
        });
      });
    }
  }
}

function buildCensusFilters() {
  renderFilterChecklist("censusSrFilter", groupBy(allClients, "sales_rep"), censusSel.sr, "censusSrSearch");
  renderFilterChecklist("censusAgentFilter", groupBy(allClients, "agent"), censusSel.agent, "censusAgentSearch");
  renderFilterChecklist("censusCityFilter", groupBy(allClients, "oras"), censusSel.city, "censusCitySearch");
  renderFilterChecklist("censusCanalFilter", groupBy(allClients, "canal"), censusSel.canal);
  renderFilterChecklist("censusFormatFilter", groupBy(allClients, "format"), censusSel.format);
  renderFilterChecklist("censusStareFilter", groupBy(allClients, "stare_poc"), censusSel.stare);
  renderFilterChecklist("censusMunicFilter", groupBy(allClients, "municipality"), censusSel.munic);
  // Build activ filter manually
  const activCounts = [["Activ Quatro", allClients.filter(c => c.client_activ_quatro).length], ["Neactiv Quatro", allClients.filter(c => !c.client_activ_quatro).length]];
  renderFilterChecklist("censusActivFilter", activCounts, censusSel.activ);
  // Build achizitii filter
  const achDa = allClients.filter(c => purchaseMap[c.code]).length;
  const achNu = allClients.length - achDa;
  renderFilterChecklist("censusAchizitiiFilter", [["Da - Achiziție luna", achDa], ["Nu - Fără achiziție", achNu]], censusSel.achizitii);
}

function applyCensusFilters() {
  const q = (document.getElementById("censusSearch").value || "").toLowerCase().trim();
  censusFiltered = allClients.filter(c => {
    if (censusSel.sr.size && !censusSel.sr.has(c.sales_rep)) return false;
    if (censusSel.agent.size && !censusSel.agent.has(c.agent)) return false;
    if (censusSel.city.size && !censusSel.city.has(c.oras)) return false;
    if (censusSel.canal.size && !censusSel.canal.has(c.canal)) return false;
    if (censusSel.format.size && !censusSel.format.has(c.format)) return false;
    if (censusSel.stare.size && !censusSel.stare.has(c.stare_poc)) return false;
    if (censusSel.munic.size && !censusSel.munic.has(c.municipality)) return false;
    if (censusSel.activ.size) {
      const label = c.client_activ_quatro ? "Activ Quatro" : "Neactiv Quatro";
      if (!censusSel.activ.has(label)) return false;
    }
    if (censusSel.achizitii.size) {
      const label = purchaseMap[c.code] ? "Da - Achiziție luna" : "Nu - Fără achiziție";
      if (!censusSel.achizitii.has(label)) return false;
    }
    if (q) {
      const hay = `${c.code} ${c.firma} ${c.nume_poc} ${c.oras} ${c.cif} ${c.adresa} ${c.agent} ${c.sales_rep}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  renderCensusMap();
  renderCensusClientList();
  document.getElementById("censusStats").textContent = `Clienți: ${censusFiltered.length} / ${allClients.length}`;
}

function resetCensusFilters() {
  for (const k of Object.keys(censusSel)) censusSel[k].clear();
  document.getElementById("censusSearch").value = "";
  document.querySelectorAll("#panelCensus .checklist input[type=checkbox]").forEach(cb => cb.checked = false);
  document.querySelectorAll("#panelCensus input[type=search]").forEach(inp => inp.value = "");
  applyCensusFilters();
}

function validGPS(lat, lon) { return lat && lon && Math.abs(lat) <= 90 && Math.abs(lon) <= 180; }

function renderCensusMap() {
  if (currentTab !== "census") return;
  markers.clearLayers();
  for (const c of censusFiltered) {
    if (!validGPS(c.lat, c.lon)) continue;
    const color = c.stare_poc === "Deschis" ? "#27ae60" : c.stare_poc === "Pre-Closed" ? "#f39c12" : "#e74c3c";
    const m = L.marker([c.lat, c.lon], { icon: createIcon(color) });
    m.bindPopup(censusPopup(c), { maxWidth: 300 });
    m.bindTooltip(`<b>${esc((c.firma||'').toUpperCase())}</b><br>${esc(c.nume_poc)}<br><span style="color:${color}">${c.stare_poc}</span>`, { direction: "top", offset: [0, -8] });
    m._clientId = c.id;
    m._clientData = c;
    m.on("click", () => { if (routeMode) toggleRouteClient(c, m); });
    markers.addLayer(m);
  }
  fitBounds(censusFiltered);
}

function censusPopup(c) {
  const stareColor = c.stare_poc === "Deschis" ? "ok" : c.stare_poc === "Pre-Closed" ? "warn" : "bad";
  const activTag = c.client_activ_quatro ? '<span class="chip ok">Client Activ Quatro</span>' : '<span class="chip bad">Neactiv Quatro</span>';
  const purch = purchaseMap[c.code];
  const purchBadge = purch
    ? `<span class="chip ok">🛒 ${purch.valoare.toLocaleString("ro-RO",{minimumFractionDigits:0,maximumFractionDigits:0})} lei · ${purch.cantHL} HL</span>`
    : `<span class="chip bad">Fără achiziție</span>`;
  return `
    <strong>${esc((c.firma||'').toUpperCase())}</strong><br>
    <small>${esc(c.nume_poc)} • Cod: ${c.code}</small><br>
    <small>${esc(c.oras)} • ${esc(c.municipality)}</small><br>
    <small>${c.canal} • ${c.format}</small><br>
    <small>Agent: ${esc(c.agent)} • SR: ${esc(c.sales_rep)}</small><br>
    <span class="chip ${stareColor}">${c.stare_poc}</span> ${activTag}<br>
    Achiziții luna: ${purchBadge}<br>
    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
      <button class="chip-btn" onclick="navigateTo(${c.lat},${c.lon})">🧭 Navighează</button>
      <button class="chip-btn" onclick="showClientDetail(${c.id})">📋 Detalii</button>
      <button class="chip-btn" onclick="openProposeDialog(${c.id})" style="background:#e74c3c;color:#fff">Propune inactiv</button>
      <button class="chip-btn" onclick="openRenameDialog(${c.id})" style="background:var(--primary);color:#fff">✏️ Redenumire</button>
      <button class="chip-btn" onclick="addToRoute(${c.id})" style="background:#00b894;color:#fff" id="routeBtn_${c.id}">
        ${routeClients.some(rc => rc.id === c.id) ? '✓ În traseu' : '+ Traseu'}
      </button>
    </div>
  `;
}

function renderCensusClientList() {
  const list = document.getElementById("censusClientList");
  if (censusFiltered.length === 0) {
    list.innerHTML = '<li style="padding:1rem;color:var(--muted);text-align:center">Niciun client găsit</li>';
    return;
  }
  const shown = censusFiltered.slice(0, 200);
  list.innerHTML = shown.map(c => {
    const stareChip = c.stare_poc === "Deschis" ? "ok" : c.stare_poc === "Pre-Closed" ? "warn" : "bad";
    const purch = purchaseMap[c.code];
    const purchBadge = purch
      ? `<span class="chip ok" style="font-size:.7rem">🛒 ${purch.valoare.toLocaleString("ro-RO",{minimumFractionDigits:0,maximumFractionDigits:0})} lei · ${purch.cantHL} HL</span>`
      : `<span class="chip bad" style="font-size:.7rem">Fără achiziție</span>`;
    return `
      <li class="client-item" data-id="${parseInt(c.id)||0}">
        <p class="client-title">${esc((c.firma||'').toUpperCase())} <span class="chip ${esc(stareChip)}">${esc(c.stare_poc)}</span></p>
        <p class="client-meta">${esc(c.nume_poc)} • Cod: ${esc(c.code)}</p>
        <p class="client-meta">${esc(c.oras)} • ${esc(c.canal)} • ${esc(c.format)}</p>
        <p class="client-meta">Agent: ${esc(c.agent)} • SR: ${esc(c.sales_rep)}</p>
        <p class="client-meta">Achiziții luna: ${purchBadge}</p>
        <div class="tiny-actions">
          <button class="chip-btn" onclick="focusOnMap(${c.id},'census')">Pe hartă</button>
          <button class="chip-btn" onclick="navigateTo(${c.lat},${c.lon})">Navighează</button>
          <button class="chip-btn" onclick="showClientDetail(${c.id})">Detalii</button>
        </div>
      </li>
    `;
  }).join("");
  if (censusFiltered.length > 200) {
    list.innerHTML += `<li style="padding:.5rem;text-align:center;color:var(--muted);font-size:.8rem">Se afișează primii 200 din ${censusFiltered.length}. Folosește filtrele.</li>`;
  }
}

function showClientDetail(id) {
  const c = allClients.find(cl => cl.id === id);
  if (!c) return;
  document.getElementById("clientDetailTitle").textContent = c.nume_poc;
  document.getElementById("clientDetailBody").innerHTML = `
    <table style="width:100%;font-size:.85rem">
      <tr><td style="font-weight:600;padding:4px 8px">Cod SBO</td><td>${esc(c.code||'')}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Firmă</td><td>${esc((c.firma||'').toUpperCase())}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">CIF</td><td>${esc(c.cif||'')}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Adresă</td><td>${esc(c.adresa)}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Oraș</td><td>${esc(c.oras)}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Județ</td><td>${esc(c.judet || "IASI")}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Municipality</td><td>${esc(c.municipality)}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Canal</td><td>${esc(c.canal||'')}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Format</td><td>${esc(c.format||'')}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">SubFormat</td><td>${esc(c.subformat)}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Agent DTR</td><td>${esc(c.agent)}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Stare POC</td><td>${esc(c.stare_poc||'')}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">On Component</td><td>${esc(c.on_component||'—')}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Nr. Vitrine</td><td>${c.numar_vitrine||0}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Nr. Dozatoare</td><td>${c.numar_dozatoare||0}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Client Activ Quatro</td><td><span class="chip ${c.client_activ_quatro ? 'ok' : 'bad'}">${c.client_activ_quatro ? 'DA - Cumpără Ursus' : 'NU - Fără vânzări 2025'}</span></td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">Coordonate</td><td>${c.lat}, ${c.lon}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">👤 Persoană contact</td><td>${esc(c.contact_person||'—')}</td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">📧 Email</td><td><input id="detailEmail" value="${esc(c.email||'')}" placeholder="adaugă email..." style="width:100%;padding:4px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--fg);font-size:.85rem"></td></tr>
      <tr><td style="font-weight:600;padding:4px 8px">📱 Telefon</td><td><input id="detailTelefon" value="${esc(c.telefon||'')}" placeholder="adaugă telefon..." style="width:100%;padding:4px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--fg);font-size:.85rem"></td></tr>
    </table>
    <div style="margin-top:.8rem;text-align:center">
      <button class="btn primary small" onclick="saveClientContact(${c.id})">💾 Salvează contact</button>
      <button class="btn primary small" onclick="navigateTo(${c.lat},${c.lon})">Navighează Google Maps</button>
      <button class="btn ghost small" onclick="focusOnMap(${c.id},'census');clientDetailDialog.close()">Vezi pe hartă</button>
      <button class="btn warning small" onclick="clientDetailDialog.close();openProposeDialog(${c.id})">Propune inactiv</button>
      <button class="btn primary small" onclick="clientDetailDialog.close();openRenameDialog(${c.id})">✏️ Propune redenumire</button>
    </div>
  `;
  document.getElementById("clientDetailDialog").showModal();
}

async function saveClientContact(id) {
  const email = document.getElementById("detailEmail").value.trim();
  const telefon = document.getElementById("detailTelefon").value.trim();
  try {
    const r = await fetch(`/api/clients/${id}/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, telefon })
    });
    if (r.ok) {
      // Update local data
      const c = allClients.find(cl => cl.id === id);
      if (c) { c.email = email; c.telefon = telefon; }
      const ac = auditClients.find(cl => cl.id === id);
      if (ac) { ac.email = email; ac.telefon = telefon; }
      toast("Contact salvat!", "success");
    } else {
      toast("Eroare la salvare", "error");
    }
  } catch (e) {
    toast("Eroare la salvare", "error");
  }
}

/* ═══════════════════════════════════════════
   AUDIT TAB
   ═══════════════════════════════════════════ */

function buildAuditFilters() {
  renderFilterChecklist("auditSrFilter", groupBy(auditClients, "sales_rep"), auditSel.sr, "auditSrSearch");
  renderFilterChecklist("auditAgentFilter", groupBy(auditClients, "agent"), auditSel.agent, "auditAgentSearch");
  renderFilterChecklist("auditCityFilter", groupBy(auditClients, "oras"), auditSel.city, "auditCitySearch");
  renderFilterChecklist("auditCanalFilter", groupBy(auditClients, "canal"), auditSel.canal);
  renderFilterChecklist("auditFormatFilter", groupBy(auditClients, "format"), auditSel.format);
  // Achizitii filter
  const achDa = auditClients.filter(c => purchaseMap[c.code]).length;
  const achNu = auditClients.length - achDa;
  renderFilterChecklist("auditAchizitiiFilter", [["Da - Achiziție luna", achDa], ["Nu - Fără achiziție", achNu]], auditSel.achizitii);
}

function applyAuditFilters() {
  const q = (document.getElementById("auditSearch").value || "").toLowerCase().trim();
  auditFiltered = auditClients.filter(c => {
    if (auditSel.sr.size && !auditSel.sr.has(c.sales_rep)) return false;
    if (auditSel.agent.size && !auditSel.agent.has(c.agent)) return false;
    if (auditSel.city.size && !auditSel.city.has(c.oras)) return false;
    if (auditSel.canal.size && !auditSel.canal.has(c.canal)) return false;
    if (auditSel.format.size && !auditSel.format.has(c.format)) return false;
    if (auditSel.achizitii.size) {
      const label = purchaseMap[c.code] ? "Da - Achiziție luna" : "Nu - Fără achiziție";
      if (!auditSel.achizitii.has(label)) return false;
    }
    if (q) {
      const hay = `${c.code} ${c.firma} ${c.nume_poc} ${c.oras} ${c.cif} ${c.adresa} ${c.agent}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    // Audit status filter
    if (auditStatusFilter === "unvisited" && c.today_visit) return false;
    if (auditStatusFilter === "open" && (!c.today_visit || c.today_visit.closed_at)) return false;
    if (auditStatusFilter === "done" && (!c.today_visit || !c.today_visit.closed_at)) return false;
    return true;
  });
  renderAuditMap();
  renderAuditClientList();
  updateAuditStats();
}

function resetAuditFilters() {
  for (const k of Object.keys(auditSel)) auditSel[k].clear();
  document.getElementById("auditSearch").value = "";
  document.querySelectorAll("#panelAudit .checklist input[type=checkbox]").forEach(cb => cb.checked = false);
  document.querySelectorAll("#panelAudit input[type=search]").forEach(inp => inp.value = "");
  auditStatusFilter = "all";
  document.querySelectorAll(".status-chip").forEach(c => c.classList.toggle("active", c.dataset.status === "all"));
  applyAuditFilters();
}

function setAuditStatus(status) {
  auditStatusFilter = status;
  document.querySelectorAll(".status-chip").forEach(c => c.classList.toggle("active", c.dataset.status === status));
  applyAuditFilters();
}

function auditClientColor(c) {
  if (!c.today_visit) return "#e74c3c";
  if (!c.today_visit.photo_path) return "#f39c12";
  if (!c.today_visit.closed_at) return "#3498db";
  if (c.today_visit.score >= 100) return "#27ae60";
  if (c.today_visit.score >= 80) return "#f39c12";
  return "#e67e22";
}

function renderAuditMap() {
  if (currentTab !== "audit") return;
  markers.clearLayers();
  for (const c of auditFiltered) {
    if (!validGPS(c.lat, c.lon)) continue;
    const color = auditClientColor(c);
    const m = L.marker([c.lat, c.lon], { icon: createIcon(color) });
    m.bindPopup(auditPopup(c), { maxWidth: 300 });
    // Tooltip with audit status
    const visit = c.today_visit;
    let statusTxt, statusCls;
    if (visit && visit.closed_at) { statusTxt = `Auditat ✓ ${visit.score}%`; statusCls = "tooltip-audited"; }
    else if (visit) { statusTxt = "Vizită deschisă"; statusCls = "tooltip-not-audited"; }
    else { statusTxt = "Neauditat"; statusCls = "tooltip-not-audited"; }
    m.bindTooltip(`<b>${esc((c.firma||'').toUpperCase())}</b><br>${esc(c.nume_poc)}<br><span class="${statusCls}">${statusTxt}</span>`, { direction: "top", offset: [0, -8] });
    m._clientId = c.id;
    m._clientData = c;
    m.on("click", () => { if (routeMode) toggleRouteClient(c, m); });
    markers.addLayer(m);
  }
  fitBounds(auditFiltered);
}

function auditPopup(c) {
  const visit = c.today_visit;
  let status = '<span class="chip bad">Nevizitat</span>';
  if (visit) {
    if (visit.closed_at) {
      const sc = visit.score;
      const cls = sc >= 100 ? "ok" : sc >= 80 ? "warn" : "bad";
      status = `<span class="chip ${cls}">Scor: ${sc}%</span>`;
    } else if (visit.photo_path) {
      status = '<span class="chip warn">Vizită deschisă</span>';
    } else {
      status = '<span class="chip warn">Fără poză</span>';
    }
  }
  const reqCount = c.required_products_count || 0;
  const purch = purchaseMap[c.code];
  const purchBadge = purch
    ? `<span class="chip ok">🛒 ${purch.valoare.toLocaleString("ro-RO",{minimumFractionDigits:0,maximumFractionDigits:0})} lei · ${purch.cantHL} HL</span>`
    : `<span class="chip bad">Fără achiziție</span>`;
  const visitBtnLabel = visit && visit.closed_at ? '✓ Audit completat' : visit ? 'Continuă vizita' : 'Vizită + poză';
  const visitBtnStyle = visit && visit.closed_at ? 'background:var(--success);color:#fff' : 'background:#8e44ad;color:#fff';
  const photoBtn = visit && visit.photo_path ? `<button class="chip-btn" onclick="viewPhoto('${visit.photo_path}','${visit.photo_time}')">📷 Vezi poză</button>` : '';
  return `
    <strong>${esc((c.firma||'').toUpperCase())}</strong><br>
    <small>${esc(c.nume_poc)} • Cod: ${c.code}</small><br>
    <small>${esc(c.oras)} • ${c.format} • ${c.canal}</small><br>
    <small>Agent: ${esc(c.agent)} • SR: ${esc(c.sales_rep)}</small><br>
    <small>Produse necesare: ${reqCount} • Vizite luna: ${c.visits_month || 0}</small><br>
    ${status} Achiziții: ${purchBadge}<br>
    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
      <button class="chip-btn" onclick="navigateTo(${c.lat},${c.lon})">🧭 Navighează</button>
      <button class="chip-btn" onclick="openVisitDialog(${c.id})" style="${visitBtnStyle}">${visitBtnLabel}</button>
      ${photoBtn}
      <button class="chip-btn" onclick="showClientDetail(${c.id})">📋 Detalii</button>
      <button class="chip-btn" onclick="addToRoute(${c.id})" style="background:#00b894;color:#fff" id="routeBtn_${c.id}">
        ${routeClients.some(rc => rc.id === c.id) ? '✓ În traseu' : '+ Traseu'}
      </button>
    </div>
  `;
}

function renderAuditClientList() {
  const list = document.getElementById("auditClientList");
  if (auditFiltered.length === 0) {
    list.innerHTML = '<li style="padding:1rem;color:var(--muted);text-align:center">Niciun client găsit</li>';
    return;
  }
  const shown = auditFiltered.slice(0, 200);
  list.innerHTML = shown.map(c => {
    const visit = c.today_visit;
    let visitStatus = "Nevizitat";
    let visitChip = "bad";
    if (visit) {
      if (visit.closed_at) {
        visitStatus = `Scor: ${visit.score}%`;
        visitChip = visit.score >= 100 ? "ok" : visit.score >= 80 ? "warn" : "bad";
      } else if (visit.photo_path) {
        visitStatus = "Vizită deschisă"; visitChip = "warn";
      } else {
        visitStatus = "Fără poză"; visitChip = "warn";
      }
    }
    const reqCount = c.required_products_count || 0;
    const openClass = visit && !visit.closed_at ? " pulse" : "";
    const purch = purchaseMap[c.code];
    const purchBadge = purch
      ? `<span class="chip ok" style="font-size:.7rem">🛒 ${purch.valoare.toLocaleString("ro-RO",{minimumFractionDigits:0,maximumFractionDigits:0})} lei · ${purch.cantHL} HL</span>`
      : `<span class="chip bad" style="font-size:.7rem">Fără achiziție</span>`;
    return `
      <li class="client-item${openClass}" data-id="${parseInt(c.id)||0}">
        <p class="client-title">${esc((c.firma||'').toUpperCase())} <span class="chip ${esc(visitChip)}">${esc(visitStatus)}</span></p>
        <p class="client-meta">${esc(c.nume_poc)} • Cod: ${esc(c.code)}</p>
        <p class="client-meta">${esc(c.oras)} • ${esc(c.canal)} • ${esc(c.format)} • Produse: ${parseInt(reqCount)||0}</p>
        <p class="client-meta">Agent: ${esc(c.agent)} • SR: ${esc(c.sales_rep)} • Luna: ${parseInt(c.visits_month)||0} viz.</p>
        <p class="client-meta">Achiziții luna: ${purchBadge}</p>
        <div class="tiny-actions">
          <button class="chip-btn" onclick="focusOnMap(${c.id},'audit')">Pe hartă</button>
          <button class="chip-btn" onclick="navigateTo(${c.lat},${c.lon})">Navighează</button>
          <button class="chip-btn ${visit && visit.closed_at ? 'active' : 'photo'}" onclick="openVisitDialog(${c.id})">
            ${visit && visit.closed_at ? '✓ Audit completat' : visit ? 'Continuă vizita' : 'Vizită + poză'}
          </button>
          ${visit && visit.photo_path ? `<button class="chip-btn" onclick="viewPhoto('${visit.photo_path}','${visit.photo_time}')">Vezi poză</button>` : ''}
        </div>
      </li>
    `;
  }).join("");
  if (auditFiltered.length > 200) {
    list.innerHTML += `<li style="padding:.5rem;text-align:center;color:var(--muted);font-size:.8rem">Se afișează primii 200 din ${auditFiltered.length}.</li>`;
  }
}

function updateAuditStats() {
  const total = auditFiltered.length;
  const visited = auditFiltered.filter(c => c.today_visit).length;
  const closed = auditFiltered.filter(c => c.today_visit && c.today_visit.closed_at).length;
  const scores = auditFiltered.filter(c => c.today_visit && c.today_visit.closed_at).map(c => c.today_visit.score);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  document.getElementById("auditStats").textContent = `Clienți: ${total} | Vizitați: ${visited} | Audit: ${closed}`;
  document.getElementById("scoreStats").textContent = scores.length ? `Scor mediu: ${avg}%` : "";
}

/* ═══════════════════════════════════════════
   SHARED HELPERS
   ═══════════════════════════════════════════ */

function esc(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function createIcon(color) {
  return L.divIcon({
    className: "",
    html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>`,
    iconSize: [20, 20], iconAnchor: [10, 10]
  });
}

function fitBounds(clients) {
  const valid = clients.filter(c => validGPS(c.lat, c.lon));
  if (valid.length) {
    const bounds = L.latLngBounds(valid.map(c => [c.lat, c.lon]));
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function focusOnMap(id, tab) {
  const source = tab === "audit" ? auditClients : allClients;
  const c = source.find(cl => cl.id === id);
  if (c && c.lat && c.lon) {
    map.setView([c.lat, c.lon], 17);
    markers.eachLayer(m => {
      if (m._clientId === id) m.openPopup();
    });
  }
}

function navigateTo(lat, lon) {
  if (!lat || !lon) { toast("Coordonate lipsă", "warning"); return; }
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`, "_blank");
}

function showOnlyMapVisible(tab) {
  const bounds = map.getBounds();
  if (tab === "census") {
    censusFiltered = censusFiltered.filter(c => c.lat && c.lon && bounds.contains([c.lat, c.lon]));
    renderCensusClientList();
    document.getElementById("censusStats").textContent = `Clienți: ${censusFiltered.length} (pe hartă)`;
  } else {
    auditFiltered = auditFiltered.filter(c => c.lat && c.lon && bounds.contains([c.lat, c.lon]));
    renderAuditClientList();
    updateAuditStats();
  }
}

function viewPhoto(filename, time) {
  document.getElementById("viewPhotoImg").src = `/api/photos/${filename}`;
  document.getElementById("viewPhotoInfo").textContent = time ? `Făcută la: ${time}` : "";
  document.getElementById("photoViewDialog").showModal();
}

/* ═══════════════════════════════════════════
   VISIT DIALOG (Audit)
   ═══════════════════════════════════════════ */

const visitDialog = document.getElementById("visitDialog");
const photoViewDialog = document.getElementById("photoViewDialog");
const clientDetailDialog = document.getElementById("clientDetailDialog");

function openVisitDialog(clientId) {
  currentVisitClientId = clientId;
  currentVisitId = null;
  const c = auditClients.find(cl => cl.id === clientId);
  if (!c) return;

  document.getElementById("visitTitle").textContent = `Vizită: ${(c.firma||'').toUpperCase()} — ${c.nume_poc}`;
  document.getElementById("visitPhoto").value = "";
  document.getElementById("photoPreview").style.display = "none";
  document.getElementById("startVisitBtn").disabled = true;
  document.getElementById("startVisitBtn").textContent = "Începe vizita + Încarcă poza";

  if (c.today_visit) {
    currentVisitId = c.today_visit.id;
    if (c.today_visit.closed_at) {
      // Read-only view of completed audit
      document.getElementById("visitStep1").style.display = "none";
      document.getElementById("visitStep2").style.display = "block";
      document.getElementById("closeVisitBtn").style.display = "none";
      loadProductChecklist(clientId, JSON.parse(c.today_visit.products_json || "[]"), true);
    } else {
      // Continue open visit
      document.getElementById("visitStep1").style.display = "none";
      document.getElementById("visitStep2").style.display = "block";
      document.getElementById("closeVisitBtn").style.display = "block";
      loadProductChecklist(clientId, [], false);
    }
  } else {
    // New visit - photo required for agents, optional for admin
    document.getElementById("visitStep1").style.display = "block";
    document.getElementById("visitStep2").style.display = "none";
    document.getElementById("closeVisitBtn").style.display = "none";
    if (currentRole === "admin") {
      document.getElementById("startVisitBtn").disabled = false;
      document.getElementById("startVisitBtn").textContent = "Începe vizita (poza opțională)";
      document.querySelector("#visitStep1 p:first-of-type").innerHTML = "<strong>Pasul 1:</strong> Fă o poză (opțional pentru admin)";
    }
  }

  visitDialog.showModal();
}

/* Photo preview */
document.getElementById("visitPhoto").addEventListener("change", function () {
  if (this.files && this.files[0]) {
    const file = this.files[0];
    if (file.size > 10 * 1024 * 1024) {
      toast("Poza este prea mare (max 10MB)", "error");
      this.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      document.getElementById("photoImg").src = e.target.result;
      document.getElementById("photoPreview").style.display = "block";
      document.getElementById("startVisitBtn").disabled = false;
    };
    reader.readAsDataURL(file);
  }
});

/* Start visit with photo */
async function submitStartVisit() {
  const btn = document.getElementById("startVisitBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Se trimite...';

  const file = document.getElementById("visitPhoto").files[0];
  if (!file && currentRole !== "admin") { toast("Selectează o poză!", "warning"); btn.disabled = false; btn.textContent = "Începe vizita + Încarcă poza"; return; }

  const fd = new FormData();
  fd.append("client_id", currentVisitClientId);
  if (file) fd.append("photo", file);

  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
    });
    fd.append("lat", pos.coords.latitude);
    fd.append("lon", pos.coords.longitude);
  } catch { /* GPS unavailable */ }

  try {
    const r = await fetch("/api/audit/start-visit", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);

    currentVisitId = d.visit_id;
    document.getElementById("visitStep1").style.display = "none";
    document.getElementById("visitStep2").style.display = "block";
    document.getElementById("closeVisitBtn").style.display = "block";
    loadProductChecklist(currentVisitClientId, [], false);
    toast("Vizită pornită cu succes!", "success");
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
    btn.disabled = false;
    btn.textContent = "Începe vizita + Încarcă poza";
  }
}

/* Load product checklist */
async function loadProductChecklist(clientId, preChecked, readOnly) {
  const container = document.getElementById("productChecklist");
  container.innerHTML = '<div class="spinner"></div>';

  try {
    const r = await fetch(`/api/audit/products/${clientId}`);
    const data = await r.json();
    currentVisitProducts = data.products || [];
    const deliveries = data.deliveries || {};
    const hasDeliveryData = data.hasDeliveryData || false;
    document.getElementById("visitNote").textContent = data.note || "";

    if (currentVisitProducts.length === 0) {
      container.innerHTML = '<p style="color:var(--muted);font-size:.85rem;padding:.5rem">Nu există produse obligatorii pentru acest SubFormat.</p>';
      return;
    }

    // Show delivery legend if we have data
    let deliveryLegend = "";
    if (hasDeliveryData) {
      deliveryLegend = `<div class="delivery-legend">
        <span class="delivery-badge delivered">📦 Livrat</span> = livrat clientului în luna curentă
        <span class="delivery-badge not-delivered">⚠ Nelivrat</span> = nu apare în raportul de vânzări
      </div>`;
    }

    const preSet = new Set(preChecked);
    const own = currentVisitProducts.filter(p => p.requirement.toUpperCase() !== "X");
    const comp = currentVisitProducts.filter(p => p.requirement.toUpperCase() === "X");
    const mandatory = own.filter(p => p.requirement === "M");
    const mandOpt = own.filter(p => p.requirement === "M/O" || p.requirement.includes("M/O"));
    const minim = own.filter(p => p.requirement.toUpperCase().includes("MINIM"));

    let html = deliveryLegend;
    function renderGroup(title, products, color) {
      if (products.length === 0) return "";
      let h = `<div class="product-group"><div class="product-group-title" style="border-left:3px solid ${color};padding-left:8px">${title} (${products.length})</div>`;
      for (const p of products) {
        const checked = preSet.has(p.product) ? "checked" : "";
        const disabled = readOnly ? "disabled" : "";
        const rc = p.requirement === "M" ? "req-m" : p.requirement.includes("M/O") ? "req-mo" : p.requirement.includes("MINIM") ? "req-minim" : "req-x";

        // Delivery status
        let deliveryTag = "";
        if (hasDeliveryData && deliveries[p.product]) {
          const del = deliveries[p.product];
          if (del.delivered) {
            const salesTip = del.salesNames.length > 0 ? ` title="${esc(del.salesNames[0])}"` : "";
            deliveryTag = `<span class="delivery-badge delivered"${salesTip}>📦</span>`;
          } else {
            deliveryTag = `<span class="delivery-badge not-delivered" title="Nu a fost livrat în luna curentă">⚠</span>`;
          }
        }

        h += `<div class="product-item">
          <input type="checkbox" class="prod-check" value="${esc(p.product)}" ${checked} ${disabled}>
          <label>${esc(p.product)}</label>
          ${deliveryTag}
          <span class="req-badge ${rc}">${p.requirement}</span>
        </div>`;
      }
      h += "</div>";
      return h;
    }

    html += renderGroup("Obligatoriu (M)", mandatory, "#27ae60");
    html += renderGroup("Obligatoriu/Optional (M/O)", mandOpt, "#f39c12");
    html += renderGroup("Grup minim", minim, "#e67e22");
    if (comp.length > 0) html += renderGroup("Competitor monitorizat (X)", comp, "#e74c3c");

    container.innerHTML = html;
    container.querySelectorAll(".prod-check").forEach(cb => cb.addEventListener("change", updateLiveScore));
    updateLiveScore();
  } catch (ex) {
    container.innerHTML = `<p style="color:var(--danger);font-size:.85rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

function updateLiveScore() {
  const own = currentVisitProducts.filter(p => p.requirement.toUpperCase() !== "X");
  const total = own.length;
  const allChecked = document.querySelectorAll(".prod-check:checked");
  let ownChecked = 0;
  const ownNames = new Set(own.map(p => p.product));
  allChecked.forEach(cb => { if (ownNames.has(cb.value)) ownChecked++; });
  const score = total > 0 ? Math.round((ownChecked / total) * 100) : 0;
  document.getElementById("liveScore").textContent = score + "%";
  document.getElementById("liveScore").className = score >= 100 ? "score-100" : score >= 80 ? "" : "score-low";
  document.getElementById("liveCount").textContent = `${ownChecked} / ${total}`;
}

/* Close visit */
async function submitCloseVisit() {
  if (!currentVisitId) { toast("Vizita nu a fost pornită", "warning"); return; }
  const checkedProducts = [];
  document.querySelectorAll(".prod-check:checked").forEach(cb => checkedProducts.push(cb.value));

  const btn = document.getElementById("closeVisitBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Se salvează...';

  try {
    const r = await fetch("/api/audit/close-visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visit_id: currentVisitId, products_present: checkedProducts })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);

    toast(`Vizită închisă! Scor: ${d.score}% (${d.total_present}/${d.total_required})`, d.score >= 100 ? "success" : "warning");
    visitDialog.close();
    // Refresh audit data
    const r2 = await fetch("/api/audit/clients");
    if (r2.ok) {
      auditClients = await r2.json();
      buildAuditFilters();
      applyAuditFilters();
    }
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
    btn.disabled = false;
    btn.textContent = "Închide vizita";
  }
}

/* ═══════════════════════════════════════════
   REPORTS TAB
   ═══════════════════════════════════════════ */

async function loadDailyReport() {
  const date = document.getElementById("reportDate").value;
  if (!date) { toast("Selectează o dată", "warning"); return; }
  const container = document.getElementById("reportContent");
  container.innerHTML = '<div style="text-align:center;padding:2rem"><div class="spinner" style="width:30px;height:30px"></div></div>';

  try {
    const r = await fetch(`/api/reports/daily?date=${date}`);
    const d = await r.json();

    const agentRows = Object.entries(d.by_agent).map(([ag, s]) => `
      <tr>
        <td style="font-weight:600">${esc(ag)}</td>
        <td>${s.visits}</td>
        <td>${s.with_photo}</td>
        <td>${s.closed}</td>
        <td><span class="score-badge ${s.avg_score >= 100 ? 'score-100' : s.avg_score >= 80 ? 'score-80' : 'score-low'}">${s.avg_score}%</span></td>
      </tr>
    `).join("");

    container.innerHTML = `
      <div class="report-card">
        <h4>Raport zilnic: ${d.date}</h4>
        <div class="report-stat"><span>Total vizite:</span><span class="val">${d.total_visits}</span></div>
        <div class="report-stat"><span>Cu poză:</span><span class="val">${d.with_photo}</span></div>
        <div class="report-stat"><span>Audit completat:</span><span class="val">${d.closed_visits}</span></div>
        <div class="report-stat"><span>Scor mediu:</span><span class="val ${d.avg_score >= 100 ? 'score-100' : ''}">${d.avg_score}%</span></div>
        <div class="report-stat"><span>Acoperire:</span><span class="val">${d.coverage_pct}%</span></div>
      </div>
      ${agentRows ? `
      <div class="report-card">
        <h4>Per Agent DTR</h4>
        <table class="missing-table">
          <tr><th>Agent DTR</th><th>Vizite</th><th>Poze</th><th>Audit</th><th>Scor</th></tr>
          ${agentRows}
        </table>
      </div>` : ''}
    `;
  } catch (ex) {
    container.innerHTML = `<p style="color:var(--danger);padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

async function loadMonthlyReport() {
  const month = document.getElementById("reportDate").value.slice(0, 7);
  if (!month) { toast("Selectează o dată", "warning"); return; }
  const container = document.getElementById("reportContent");
  container.innerHTML = '<div style="text-align:center;padding:2rem"><div class="spinner" style="width:30px;height:30px"></div></div>';

  try {
    const r = await fetch(`/api/reports/monthly?month=${month}`);
    const d = await r.json();

    let missingHtml = "";
    if (d.missing_products && d.missing_products.length > 0) {
      missingHtml = `
        <div class="report-card">
          <h4>Produse lipsă (${d.missing_products.length} clienți)</h4>
          <table class="missing-table">
            <tr><th>POC</th><th>Oraș</th><th>Agent DTR</th><th>Scor</th><th>Produse lipsă</th></tr>
            ${d.missing_products.slice(0, 50).map(m => `
              <tr>
                <td>${esc(m.nume_poc)}</td>
                <td>${esc(m.oras)}</td>
                <td>${esc(m.agent)}</td>
                <td><span class="score-badge ${m.score >= 100 ? 'score-100' : m.score >= 80 ? 'score-80' : 'score-low'}">${m.score}%</span></td>
                <td style="font-size:.75rem">${esc(m.missing_products.join(", "))}</td>
              </tr>
            `).join("")}
          </table>
          ${d.missing_products.length > 50 ? `<p style="font-size:.8rem;color:var(--muted)">... și încă ${d.missing_products.length - 50} clienți</p>` : ""}
        </div>
      `;
    }

    container.innerHTML = `
      <div class="report-card">
        <h4>Raport lunar: ${d.month}</h4>
        <div class="report-stat"><span>Clienți vizitați:</span><span class="val">${d.visited_clients} / ${d.total_clients} (${d.coverage_pct}%)</span></div>
        <div class="report-stat"><span>Total vizite:</span><span class="val">${d.total_visits}</span></div>
        <div class="report-stat"><span>Audit completat:</span><span class="val">${d.closed_visits}</span></div>
        <div class="report-stat"><span>Scor mediu:</span><span class="val">${d.avg_score}%</span></div>
        <div class="report-stat"><span>Clienți 100%:</span><span class="val" style="color:var(--success)">${d.clients_100pct}</span></div>
        <div class="report-stat"><span>Clienți sub 100%:</span><span class="val" style="color:var(--danger)">${d.clients_below_100}</span></div>
      </div>
      ${missingHtml}
    `;
  } catch (ex) {
    container.innerHTML = `<p style="color:var(--danger);padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

async function exportExcel() {
  const date = document.getElementById("reportDate").value;
  if (!date) { toast("Selectează o dată", "warning"); return; }
  window.open(`/api/reports/export-excel?date=${date}`, "_blank");
}

/* ── Sidebar & Logout ── */
function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  sb.style.display = sb.style.display === "none" ? "" : "none";
  setTimeout(() => map.invalidateSize(), 100);
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  sessionStorage.clear();
  window.location.href = "/login.html";
}

/* ── Keyboard shortcuts for search ── */
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.matches("input[type=search]")) {
    e.preventDefault();
    if (currentTab === "census") applyCensusFilters();
    else if (currentTab === "audit") applyAuditFilters();
  }
});

/* ═══════════════════════════════════════════
   EMAIL REPORTS (Admin only)
   ═══════════════════════════════════════════ */

async function testSendDaily() {
  const date = document.getElementById("reportDate").value;
  if (!date) { toast("Selecteaza o data", "warning"); return; }
  const el = document.getElementById("emailStatus");
  el.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Se trimite...';
  try {
    const r = await fetch("/api/email/test-daily", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ date })
    });
    const d = await r.json();
    if (d.sent) {
      el.innerHTML = `<span style="color:var(--success)">Trimis cu succes la: ${esc(d.recipients.join(", "))}</span>`;
      toast("Raport zilnic trimis pe email!", "success");
    } else {
      el.innerHTML = `<span style="color:var(--danger)">Nu s-a trimis: ${esc(d.reason)}</span>`;
      toast("Eroare: " + d.reason, "error");
    }
  } catch (ex) {
    el.innerHTML = `<span style="color:var(--danger)">Eroare: ${esc(ex.message)}</span>`;
    toast("Eroare trimitere: " + ex.message, "error");
  }
}

async function testSendMonthly() {
  const date = document.getElementById("reportDate").value;
  const month = date ? date.slice(0, 7) : new Date().toISOString().slice(0, 7);
  const el = document.getElementById("emailStatus");
  el.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Se trimite...';
  try {
    const r = await fetch("/api/email/test-monthly", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ month })
    });
    const d = await r.json();
    if (d.sent) {
      el.innerHTML = `<span style="color:var(--success)">Raport lunar trimis la: ${esc(d.recipients.join(", "))}</span>`;
      toast("Raport lunar trimis pe email!", "success");
    } else {
      el.innerHTML = `<span style="color:var(--danger)">Nu s-a trimis: ${esc(d.reason)}</span>`;
    }
  } catch (ex) {
    el.innerHTML = `<span style="color:var(--danger)">Eroare: ${esc(ex.message)}</span>`;
  }
}

async function showEmailConfig() {
  try {
    const r = await fetch("/api/email/config");
    const d = await r.json();
    const el = document.getElementById("emailStatus");
    el.innerHTML = `
      <div style="font-size:.78rem;color:var(--text);margin-top:.3rem">
        <strong>SMTP:</strong> ${d.smtpHost}:${d.smtpPort} ${d.smtpConfigured ? '<span style="color:var(--success)">OK</span>' : '<span style="color:var(--danger)">NECONFIGURAT</span>'}<br>
        <strong>De la:</strong> ${d.emailFrom || '-'}<br>
        <strong>Catre:</strong> ${d.emailTo.join(", ") || '-'}<br>
        <strong>Auto zilnic:</strong> ${d.enabled ? 'DA, ora ' + d.targetHour + ':00' : 'NU'} (${d.timezone})<br>
        <strong>Auto lunar:</strong> ${d.monthlyEnabled ? 'DA, ultima zi, ora ' + d.monthlyHour + ':00' : 'NU'}
      </div>
    `;
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
  }
}

/* ═══════════════════════════════════════════
   PROPOSE INACTIVE – Agent → SPV workflow
   ═══════════════════════════════════════════ */

let proposeClientId = null;
const proposeDialog = document.getElementById("proposeDialog");
const proposalsDialog = document.getElementById("proposalsDialog");

function openProposeDialog(clientId) {
  const c = allClients.find(cl => cl.id === clientId);
  if (!c) return;
  proposeClientId = clientId;
  document.getElementById("proposeTitle").textContent = `Propune inactiv: ${c.nume_poc}`;
  document.getElementById("proposeReason").value = "";
  document.getElementById("proposeSubmitBtn").disabled = false;
  document.getElementById("proposeSubmitBtn").textContent = "Trimite propunerea";
  proposeDialog.showModal();
}

async function submitProposal() {
  const reason = document.getElementById("proposeReason").value.trim();
  if (!reason) { toast("Scrie un motiv!", "warning"); return; }
  const btn = document.getElementById("proposeSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Se trimite...';
  try {
    const r = await fetch(`/api/clients/${proposeClientId}/propose-inactive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast("Propunere trimisă spre aprobare!", "success");
    proposeDialog.close();
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
    btn.disabled = false;
    btn.textContent = "Trimite propunerea";
  }
}

/* ── Propose Rename ── */
let renameClientId = null;
const renameDialog = document.getElementById("renameDialog");

function openRenameDialog(clientId) {
  const c = allClients.find(cl => cl.id === clientId);
  if (!c) return;
  renameClientId = clientId;
  document.getElementById("renameTitle").textContent = `Propune modificare: ${(c.firma||'').toUpperCase()}`;
  document.getElementById("renameNewFirma").value = c.firma || "";
  document.getElementById("renameNewPoc").value = c.nume_poc || "";
  document.getElementById("renameNewCif").value = c.cif || "";
  document.getElementById("renameNewContact").value = c.contact_person || "";
  document.getElementById("renameNewTelefon").value = c.telefon || "";
  document.getElementById("renameNewEmail").value = c.email || "";
  document.getElementById("renameReason").value = "";
  document.getElementById("renameSubmitBtn").disabled = false;
  document.getElementById("renameSubmitBtn").textContent = "Trimite propunerea";
  renameDialog.showModal();
}

async function submitRename() {
  const new_firma = document.getElementById("renameNewFirma").value.trim();
  const new_nume_poc = document.getElementById("renameNewPoc").value.trim();
  const new_cif = document.getElementById("renameNewCif").value.trim();
  const new_contact = document.getElementById("renameNewContact").value.trim();
  const new_telefon = document.getElementById("renameNewTelefon").value.trim();
  const new_email = document.getElementById("renameNewEmail").value.trim();
  const reason = document.getElementById("renameReason").value.trim();
  if (!new_firma && !new_nume_poc && !new_cif && !new_contact && !new_telefon && !new_email) {
    toast("Completează cel puțin un câmp!", "warning"); return;
  }
  const btn = document.getElementById("renameSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Se trimite...';
  try {
    const r = await fetch(`/api/clients/${renameClientId}/propose-rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_firma, new_nume_poc, new_cif, new_contact, new_telefon, new_email, reason })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast("Propunere de modificare trimisă!", "success");
    renameDialog.close();
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
    btn.disabled = false;
    btn.textContent = "Trimite propunerea";
  }
}

async function openProposalsDialog() {
  const body = document.getElementById("proposalsBody");
  body.innerHTML = '<div style="text-align:center;padding:2rem"><div class="spinner" style="width:30px;height:30px"></div></div>';
  proposalsDialog.showModal();

  try {
    const r = await fetch("/api/proposals");
    const proposals = await r.json();

    if (proposals.length === 0) {
      body.innerHTML = '<p style="text-align:center;padding:2rem;color:var(--muted)">Nu există propuneri.</p>';
      return;
    }

    const pending = proposals.filter(p => p.decision === "pending");
    const processed = proposals.filter(p => p.decision !== "pending");

    let html = "";
    if (pending.length > 0) {
      html += `<h4 style="margin-bottom:.5rem;color:var(--warning)">În așteptare (${pending.length})</h4>`;
      html += pending.map(p => proposalCard(p, true)).join("");
    }
    if (processed.length > 0) {
      html += `<h4 style="margin:.8rem 0 .5rem;color:var(--muted)">Procesate (${processed.length})</h4>`;
      html += processed.slice(0, 50).map(p => proposalCard(p, false)).join("");
    }
    body.innerHTML = html;
  } catch (ex) {
    body.innerHTML = `<p style="color:var(--danger);padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

function proposalCard(p, canReview) {
  const statusColor = p.decision === "pending" ? "warn" : p.decision === "approved" ? "ok" : "bad";
  const statusText = p.decision === "pending" ? "În așteptare" : p.decision === "approved" ? "Aprobat" : "Respins";
  const isRename = p.proposed_status === "redenumire";
  const typeLabel = isRename ? "✏️ Redenumire" : "🚫 Inactiv";
  const reviewBtns = canReview && currentRole !== "agent" ? `
    <div style="margin-top:.5rem;display:flex;gap:.5rem;align-items:center">
      <input id="reviewNote_${p.id}" placeholder="Notă (opțional)..." style="flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font-size:.8rem">
      <button class="btn success small" onclick="reviewProposal(${p.id},'approved')">Aprobă</button>
      <button class="btn ghost small" onclick="reviewProposal(${p.id},'rejected')">Respinge</button>
    </div>
  ` : "";
  const reviewInfo = p.reviewed_by ? `<p style="font-size:.75rem;color:var(--muted);margin-top:.3rem">Revizuit de: ${esc(p.reviewed_by)} la ${p.reviewed_at}${p.review_note ? ' • ' + esc(p.review_note) : ''}</p>` : "";

  let renameInfo = "";
  if (isRename) {
    renameInfo = `<div style="font-size:.82rem;margin-top:.3rem;padding:.4rem;background:var(--bg);border-radius:4px">`;
    if (p.new_firma) renameInfo += `<strong>Firma:</strong> ${esc(p.new_firma)}<br>`;
    if (p.new_nume_poc) renameInfo += `<strong>Nume POC:</strong> ${esc(p.new_nume_poc)}<br>`;
    if (p.new_cif) renameInfo += `<strong>CUI:</strong> ${esc(p.new_cif)}<br>`;
    if (p.new_contact) renameInfo += `<strong>Contact:</strong> ${esc(p.new_contact)}<br>`;
    if (p.new_telefon) renameInfo += `<strong>Telefon:</strong> ${esc(p.new_telefon)}<br>`;
    if (p.new_email) renameInfo += `<strong>Email:</strong> ${esc(p.new_email)}`;
    renameInfo += `</div>`;
  }

  return `
    <div style="border:1px solid var(--border);border-radius:8px;padding:.6rem;margin-bottom:.5rem;background:var(--bg2)">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong style="font-size:.9rem">${esc((p.firma||'').toUpperCase())}</strong>
        <div><span style="font-size:.7rem;margin-right:4px">${typeLabel}</span><span class="chip ${statusColor}">${statusText}</span></div>
      </div>
      <p style="font-size:.8rem;margin-top:.2rem">${esc(p.nume_poc)} • ${esc(p.oras)} • Cod: ${p.code}</p>
      <p style="font-size:.8rem">Agent: ${esc(p.agent)} • Canal: ${p.canal}</p>
      ${renameInfo}
      ${p.reason ? `<p style="font-size:.82rem;margin-top:.3rem;padding:.4rem;background:var(--bg);border-radius:4px"><strong>Motiv:</strong> ${esc(p.reason)}</p>` : ''}
      <p style="font-size:.75rem;color:var(--muted)">Propus de: ${esc(p.proposed_by)} la ${p.proposed_at}</p>
      ${reviewInfo}
      ${reviewBtns}
    </div>
  `;
}

async function reviewProposal(id, decision) {
  const noteEl = document.getElementById("reviewNote_" + id);
  const review_note = noteEl ? noteEl.value.trim() : "";
  try {
    const r = await fetch(`/api/proposals/${id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, review_note })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast(decision === "approved" ? "Propunere aprobată!" : "Propunere respinsă", decision === "approved" ? "success" : "info");
    // Refresh proposals and client data
    openProposalsDialog();
    refreshData();
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
  }
}

/* ═══════════════════════════════════════════
   ROUTE MODE – Multi-select → Google Maps
   ═══════════════════════════════════════════ */
function toggleRouteMode() {
  const bar = document.getElementById("routeBar");
  const btn = document.getElementById("routeToggleBtn");
  if (bar.style.display === "none" || !bar.style.display) {
    bar.style.display = "flex";
    btn.classList.add("active");
  } else {
    bar.style.display = "none";
    btn.classList.remove("active");
    clearRoute();
  }
}

function addToRoute(id) {
  // Find client in either census or audit lists
  const c = allClients.find(cl => cl.id === id) || auditClients.find(cl => cl.id === id);
  if (!c || !c.lat || !c.lon) { toast("Client fără coordonate!", "error"); return; }

  const idx = routeClients.findIndex(rc => rc.id === id);
  if (idx >= 0) {
    // Already in route – remove it
    routeClients.splice(idx, 1);
    // Update marker highlight
    markers.eachLayer(m => { if (m._clientId === id && m._icon) m._icon.classList.remove("route-selected"); });
    // Update popup button text
    const btn = document.getElementById("routeBtn_" + id);
    if (btn) { btn.textContent = "+ Traseu"; }
    toast(`${c.nume_poc} scos din traseu`, "info", 2000);
  } else {
    if (routeClients.length >= 25) { toast("Maxim 25 de puncte pe traseu!", "error"); return; }
    routeClients.push({ id: c.id, lat: c.lat, lon: c.lon, name: c.nume_poc });
    // Highlight marker
    markers.eachLayer(m => { if (m._clientId === id && m._icon) m._icon.classList.add("route-selected"); });
    // Update popup button text
    const btn = document.getElementById("routeBtn_" + id);
    if (btn) { btn.textContent = "✓ În traseu"; }
    toast(`${c.nume_poc} adăugat la traseu (${routeClients.length})`, "success", 2000);
  }

  // Auto-show route bar when first client added
  const bar = document.getElementById("routeBar");
  if (routeClients.length > 0 && bar.style.display === "none") {
    bar.style.display = "flex";
    const toggleBtn = document.getElementById("routeToggleBtn");
    if (toggleBtn) toggleBtn.classList.add("active");
  }
  // Auto-hide when empty
  if (routeClients.length === 0) {
    bar.style.display = "none";
    const toggleBtn = document.getElementById("routeToggleBtn");
    if (toggleBtn) toggleBtn.classList.remove("active");
  }
  updateRouteBar();
}

function toggleRouteClient(c, m) {
  addToRoute(c.id);
}

function updateRouteBar() {
  const countEl = document.getElementById("routeCount");
  const listEl = document.getElementById("routeList");
  const openBtn = document.getElementById("routeOpenBtn");
  if (countEl) countEl.textContent = routeClients.length;
  if (openBtn) openBtn.style.display = routeClients.length >= 1 ? "block" : "none";
  if (listEl) {
    if (routeClients.length === 0) {
      listEl.innerHTML = '<span style="color:var(--muted)">Apasă pe clienți de pe hartă...</span>';
    } else {
      listEl.innerHTML = routeClients.map((rc, i) =>
        `<span class="route-chip">${i + 1}. ${esc(rc.name)} <button onclick="removeRouteClient(${rc.id})" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-weight:bold;padding:0 2px">✕</button></span>`
      ).join(" ");
    }
  }
}

function removeRouteClient(id) {
  routeClients = routeClients.filter(rc => rc.id !== id);
  // Remove visual highlight
  markers.eachLayer(m => {
    if (m._clientId === id && m._icon) m._icon.classList.remove("route-selected");
  });
  updateRouteBar();
}

function clearRoute() {
  routeClients = [];
  markers.eachLayer(m => { if (m._icon) m._icon.classList.remove("route-selected"); });
  updateRouteBar();
}

function openGoogleMapsRoute() {
  if (routeClients.length < 1) {
    toast("Selectează cel puțin 1 client!", "error");
    return;
  }
  // Single client = navigate directly
  if (routeClients.length === 1) {
    const c = routeClients[0];
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}&travelmode=driving`, "_blank");
    return;
  }
  // First point = origin, last = destination, middle = waypoints
  const origin = routeClients[0];
  const dest = routeClients[routeClients.length - 1];
  const waypoints = routeClients.slice(1, -1);

  let url = `https://www.google.com/maps/dir/?api=1`;
  url += `&origin=${origin.lat},${origin.lon}`;
  url += `&destination=${dest.lat},${dest.lon}`;
  if (waypoints.length > 0) {
    url += `&waypoints=` + waypoints.map(w => `${w.lat},${w.lon}`).join("|");
  }
  url += `&travelmode=driving`;

  window.open(url, "_blank");
  toast(`Traseu deschis cu ${routeClients.length} puncte`, "success");
}

/* ═══════════════════════════════════════════
   OBIECTIVE TAB (Target vs Realizat)
   ═══════════════════════════════════════════ */

async function loadObiective() {
  const monthInput = document.getElementById("obiectiveMonth");
  const month = monthInput.value || new Date().toISOString().slice(0, 7);
  monthInput.value = month;

  const summary = document.getElementById("obiectiveSummary");
  const agentsDiv = document.getElementById("obiectiveAgents");
  summary.innerHTML = '<div style="text-align:center;padding:1rem"><div class="spinner" style="width:30px;height:30px"></div></div>';
  agentsDiv.innerHTML = "";

  try {
    const r = await fetch(`/api/obiective?month=${month}`);
    if (!r.ok) throw new Error("Eroare la încărcare");
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); } catch { throw new Error("Serverul nu a răspuns corect. Reîncearcă."); }

    if (d.agents.length === 0) {
      summary.innerHTML = '<p style="text-align:center;padding:1rem;color:var(--muted)">Nu există obiective pentru această lună.</p>';
      return;
    }

    // Progress info
    const daysPct = d.working_days > 0 ? Math.round((d.worked_days / d.working_days) * 100) : 0;

    summary.innerHTML = `
      <div class="obj-summary-card">
        <div class="obj-summary-header">
          <span>TOTAL ECHIPĂ • ${d.month}</span>
          <span class="obj-days">${d.worked_days}/${d.working_days} zile lucr. (${daysPct}%)</span>
        </div>
        <div class="obj-metrics">
          ${objMetricBox("VALORIC (LEI)", d.totals.realizat_val, d.totals.target_val, d.totals.pct_val, formatLei)}
          ${objMetricBox("HECTOLITRI", d.totals.realizat_hl, d.totals.target_hl, d.totals.pct_hl, formatHL)}
          ${objMetricBox("CLIENȚI 2 SKU", d.totals.realizat_clienti_2sku, d.totals.target_clienti, d.totals.pct_clienti, formatInt)}
        </div>
        ${d.agents[0] && d.agents[0].last_import ? `<div class="obj-import-info">Ultimul import: ${d.agents[0].import_file || 'N/A'} • ${new Date(d.agents[0].last_import).toLocaleDateString('ro-RO')}</div>` : '<div class="obj-import-info" style="color:var(--warning)">Nu există date importate pentru această lună</div>'}
      </div>
    `;

    // Per-agent cards
    const sorted = [...d.agents].sort((a, b) => b.pct_val - a.pct_val);
    agentsDiv.innerHTML = sorted.map((ag, idx) => {
      const rank = idx + 1;
      const medalClass = rank <= 3 ? ` obj-medal-${rank}` : "";
      const hasData = ag.realizat_val > 0;
      const neededPerDay = d.days_remaining > 0 ? Math.round((ag.target_val - ag.realizat_val) / d.days_remaining) : 0;

      return `
        <div class="obj-agent-card${medalClass}">
          <div class="obj-agent-header">
            <span class="obj-rank">#${rank}</span>
            <span class="obj-agent-name">${esc(ag.agent_name)}</span>
            <span class="obj-agent-pct ${pctColorClass(ag.pct_val, daysPct)}">${ag.pct_val}%</span>
          </div>
          <div class="obj-agent-metrics">
            <div class="obj-metric-row">
              <span class="obj-metric-label">Valoric</span>
              <div class="obj-progress-wrap">
                <div class="obj-progress-bar">
                  <div class="obj-progress-fill ${pctColorClass(ag.pct_val, daysPct)}" style="width:${Math.min(ag.pct_val, 100)}%"></div>
                </div>
                <span class="obj-metric-val">${formatLei(ag.realizat_val)} / ${formatLei(ag.target_val)}</span>
              </div>
            </div>
            <div class="obj-metric-row">
              <span class="obj-metric-label">HL</span>
              <div class="obj-progress-wrap">
                <div class="obj-progress-bar">
                  <div class="obj-progress-fill ${pctColorClass(ag.pct_hl, daysPct)}" style="width:${Math.min(ag.pct_hl, 100)}%"></div>
                </div>
                <span class="obj-metric-val">${formatHL(ag.realizat_hl)} / ${formatHL(ag.target_hl)}</span>
              </div>
            </div>
            <div class="obj-metric-row">
              <span class="obj-metric-label">Clienți 2SKU</span>
              <div class="obj-progress-wrap">
                <div class="obj-progress-bar">
                  <div class="obj-progress-fill ${pctColorClass(ag.pct_clienti, daysPct)}" style="width:${Math.min(ag.pct_clienti, 100)}%"></div>
                </div>
                <span class="obj-metric-val">${ag.realizat_clienti_2sku} / ${ag.target_clienti}</span>
              </div>
            </div>
            ${hasData && d.days_remaining > 0 ? `<div class="obj-needed">De vândut/zi: <strong>${formatLei(Math.max(neededPerDay, 0))}</strong> (${d.days_remaining} zile rămase)</div>` : ''}
          </div>
        </div>
      `;
    }).join("");

    // Load daily history below summary
    loadDailyHistory(month);

    // Render GT section in OBIECTIVE
    renderGtInObiective(d.gt);

  } catch (ex) {
    summary.innerHTML = `<p style="color:var(--danger);padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

function renderGtInObiective(gt) {
  const container = document.getElementById("gtObiectiveContent");
  if (!container) return;
  if (!gt || !gt.agents || gt.agents.length === 0) {
    container.innerHTML = '<p style="text-align:center;color:var(--muted);padding:.5rem">Nu există date GT pentru această lună.</p>';
    return;
  }

  const fNum = (v) => v ? v.toLocaleString("ro-RO", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : "0";
  const pctClass = (p) => p >= 100 ? "obj-green" : p >= 70 ? "obj-yellow" : p >= 40 ? "obj-orange" : "obj-red";

  const th = 'style="padding:6px 4px;text-align:center;font-size:.7rem"';
  const thG = 'style="padding:4px 4px;text-align:center;font-size:.65rem;color:var(--muted)"';

  let html = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.75rem;margin-top:.3rem">';

  // 2-row header like Excel: Row 1 = group names, Row 2 = Target/Realizat/%
  html += '<thead>';
  html += '<tr style="background:var(--bg2);border-bottom:1px solid var(--border)">';
  html += `<th rowspan="2" style="padding:6px 8px;text-align:left;vertical-align:bottom">AGENT</th>`;
  html += `<th colspan="3" ${th} style="padding:6px 4px;text-align:center;border-left:2px solid var(--border);background:#e8f5e9">Core Segment</th>`;
  html += `<th colspan="3" ${th} style="padding:6px 4px;text-align:center;border-left:2px solid var(--border);background:#e3f2fd">ABI</th>`;
  html += `<th colspan="3" ${th} style="padding:6px 4px;text-align:center;border-left:2px solid var(--border);background:#fff3e0">Altele</th>`;
  html += `<th colspan="3" ${th} style="padding:6px 4px;text-align:center;border-left:2px solid var(--border);background:#f3e5f5">Total SO</th>`;
  html += '</tr>';
  html += '<tr style="background:var(--bg2);border-bottom:2px solid var(--border)">';
  for (let i = 0; i < 4; i++) {
    const bl = 'border-left:2px solid var(--border);';
    html += `<th ${thG} style="padding:4px 3px;text-align:right;font-size:.65rem;color:var(--muted);${bl}">Target</th>`;
    html += `<th ${thG} style="padding:4px 3px;text-align:right;font-size:.65rem;color:var(--muted)">Realizat</th>`;
    html += `<th ${thG} style="padding:4px 3px;text-align:center;font-size:.65rem;color:var(--muted)">%</th>`;
  }
  html += '</tr>';
  html += '</thead><tbody>';

  const renderRow = (label, a, isBold, bgStyle) => {
    html += `<tr style="border-bottom:1px solid var(--border);${bgStyle || ''}${isBold ? 'font-weight:700;' : ''}">`;
    html += `<td style="padding:5px 8px;font-weight:600;white-space:nowrap">${esc(label)}</td>`;
    // Core
    html += `<td style="padding:5px 3px;text-align:right;border-left:2px solid var(--border)">${fNum(a.target_core)}</td>`;
    html += `<td style="padding:5px 3px;text-align:right">${fNum(a.real_core)}</td>`;
    html += `<td style="padding:5px 3px;text-align:center"><span class="${pctClass(a.pct_core)}" style="font-weight:700">${a.pct_core}%</span></td>`;
    // ABI
    html += `<td style="padding:5px 3px;text-align:right;border-left:2px solid var(--border)">${fNum(a.target_abi)}</td>`;
    html += `<td style="padding:5px 3px;text-align:right">${fNum(a.real_abi)}</td>`;
    html += `<td style="padding:5px 3px;text-align:center"><span class="${pctClass(a.pct_abi)}" style="font-weight:700">${a.pct_abi}%</span></td>`;
    // Altele
    html += `<td style="padding:5px 3px;text-align:right;border-left:2px solid var(--border)">${fNum(a.target_other || 0)}</td>`;
    html += `<td style="padding:5px 3px;text-align:right">${fNum(a.real_other || 0)}</td>`;
    html += `<td style="padding:5px 3px;text-align:center"><span class="${pctClass(a.pct_other || 0)}" style="font-weight:700">${(a.pct_other || 0)}%</span></td>`;
    // Total SO
    html += `<td style="padding:5px 3px;text-align:right;border-left:2px solid var(--border)">${fNum(a.target_total)}</td>`;
    html += `<td style="padding:5px 3px;text-align:right">${fNum(a.real_total)}</td>`;
    html += `<td style="padding:5px 3px;text-align:center"><span class="${pctClass(a.pct_total)}" style="font-weight:700">${a.pct_total}%</span></td>`;
    html += '</tr>';
  };

  for (const a of gt.agents) {
    renderRow(a.agent, a, false, '');
  }

  if (gt.totals) {
    renderRow('TOTAL', gt.totals, true, 'background:var(--bg2);border-top:2px solid var(--border);');
  }

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function objMetricBox(label, realizat, target, pct, formatter) {
  const daysPct = 50; // placeholder, real value computed in parent
  return `
    <div class="obj-metric-box">
      <div class="obj-metric-box-label">${label}</div>
      <div class="obj-metric-box-value ${pctColorClass(pct, 0)}">${formatter(realizat)}</div>
      <div class="obj-metric-box-target">din ${formatter(target)}</div>
      <div class="obj-metric-box-pct">${pct}%</div>
      <div class="obj-progress-bar" style="height:6px;margin-top:4px">
        <div class="obj-progress-fill ${pctColorClass(pct, 0)}" style="width:${Math.min(pct, 100)}%"></div>
      </div>
    </div>
  `;
}

function pctColorClass(pct, daysPct) {
  if (pct >= 100) return "obj-green";
  if (pct >= 70) return "obj-yellow";
  if (pct >= 40) return "obj-orange";
  return "obj-red";
}

/* ── Daily Sales History ── */
async function loadDailyHistory(month) {
  const container = document.getElementById("dailySalesHistory");
  if (!container) return;

  try {
    const r = await fetch(`/api/sales/daily-history?month=${month}`);
    if (!r.ok) { container.innerHTML = ""; return; }
    const d = await r.json();

    if (!d.daily || d.daily.length === 0) {
      container.innerHTML = "";
      return;
    }

    const formatDate = (ds) => {
      const parts = ds.split("-");
      return `${parts[2]}.${parts[1]}`;
    };
    const fLei = (v) => v.toLocaleString("ro-RO", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const fHL = (v) => v.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const hasEngros = d.daily.some(day => day.engros_hl > 0 || day.engros_valoare > 0);
    const engrosInfo = d.engros_agents && d.engros_agents.length > 0
      ? `<div style="font-size:.75rem;color:#666;margin-top:.3rem">En-gros: ${d.engros_agents.join(", ")}</div>`
      : "";

    let tableRows = d.daily.map(day => `
      <tr>
        <td>${formatDate(day.date)}</td>
        <td>${fLei(day.team_valoare !== undefined ? day.team_valoare : day.valoare)} lei</td>
        <td>${fHL(day.team_hl !== undefined ? day.team_hl : day.hl)}</td>
        <td>${day.team_clients !== undefined ? day.team_clients : day.unique_clients}</td>
        ${hasEngros ? `<td class="daily-engros">${fLei(day.engros_valoare || 0)} lei</td><td class="daily-engros">${fHL(day.engros_hl || 0)}</td>` : ""}
        <td>${fLei(day.valoare)} lei</td>
        <td>${fHL(day.hl)}</td>
        <td class="daily-cum">${fLei(day.cum_team_valoare !== undefined ? day.cum_team_valoare : day.cum_valoare)}</td>
        <td class="daily-cum">${fHL(day.cum_team_hl !== undefined ? day.cum_team_hl : day.cum_hl)}</td>
      </tr>
    `).join("");

    // Total row
    tableRows += `
      <tr class="total-row">
        <td>TOTAL</td>
        <td>${fLei(d.totals.team_valoare !== undefined ? d.totals.team_valoare : d.totals.valoare)} lei</td>
        <td>${fHL(d.totals.team_hl !== undefined ? d.totals.team_hl : d.totals.hl)}</td>
        <td></td>
        ${hasEngros ? `<td class="daily-engros">${fLei(d.totals.engros_valoare || 0)} lei</td><td class="daily-engros">${fHL(d.totals.engros_hl || 0)}</td>` : ""}
        <td>${fLei(d.totals.valoare)} lei</td>
        <td>${fHL(d.totals.hl)}</td>
        <td></td>
        <td></td>
      </tr>
    `;

    container.innerHTML = `
      <div class="daily-history-card">
        <div class="daily-history-title">📊 ISTORIC VÂNZĂRI PE ZILE • ${month}</div>
        ${engrosInfo}
        <div style="overflow-x:auto">
          <table class="daily-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Echipă Val.</th>
                <th>Echipă HL</th>
                <th>Cl.</th>
                ${hasEngros ? `<th class="daily-engros">Engros Val.</th><th class="daily-engros">Engros HL</th>` : ""}
                <th>Total Val.</th>
                <th>Total HL</th>
                <th>Cum. Val.</th>
                <th>Cum. HL</th>
              </tr>
            </thead>
            <tbody>
              ${tableRows}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (ex) {
    container.innerHTML = "";
  }
}

function formatLei(v) {
  if (v >= 1000000) return (v / 1000000).toFixed(2) + "M";
  if (v >= 1000) return Math.round(v).toLocaleString("ro-RO");
  return v.toFixed(0);
}

function formatHL(v) {
  return v >= 1000 ? (v / 1000).toFixed(2) + "K" : v.toFixed(1);
}

function formatInt(v) { return Math.round(v).toString(); }

/* ═══════════════════════════════════════════
   ÎNCASĂRI TAB (Daily Cash Collections)
   ═══════════════════════════════════════════ */

async function loadIncasari() {
  const agentView = document.getElementById("incasariAgentView");
  const adminView = document.getElementById("incasariAdminView");
  const content = document.getElementById("incasariContent");

  if (currentRole === "agent") {
    agentView.style.display = "block";
    adminView.style.display = "none";
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById("incasariToday").textContent = today;

    // Load today's value
    try {
      const r = await fetch(`/api/incasari?date=${today}`);
      const d = await r.json();
      if (d.suma !== undefined && d.suma !== null) {
        document.getElementById("incasariSuma").value = d.suma;
        document.getElementById("incasariStatus").innerHTML = '<span class="chip ok">✓ Completat azi</span>';
      } else {
        document.getElementById("incasariSuma").value = "";
        document.getElementById("incasariStatus").innerHTML = '<span class="chip bad">✗ Necompletat azi</span>';
      }
    } catch {
      document.getElementById("incasariStatus").innerHTML = '<span class="chip bad">Eroare la încărcare</span>';
    }

    // Load history
    try {
      const r = await fetch("/api/incasari/history");
      const rows = await r.json();
      if (rows.length === 0) {
        document.getElementById("incasariHistory").innerHTML = '<p style="color:var(--muted);font-size:.82rem">Nu ai încasări înregistrate.</p>';
      } else {
        document.getElementById("incasariHistory").innerHTML = `
          <table class="missing-table" style="margin-top:.3rem">
            <tr><th>Data</th><th style="text-align:right">Suma (lei)</th></tr>
            ${rows.map(r => `<tr><td>${r.data}</td><td style="text-align:right;font-weight:600">${Number(r.suma).toLocaleString("ro-RO", {minimumFractionDigits: 2})}</td></tr>`).join("")}
          </table>
        `;
      }
    } catch { /* ignore */ }

  } else {
    // SPV / Admin view
    agentView.style.display = "none";
    adminView.style.display = "block";
    const dateInput = document.getElementById("incasariDate");
    if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
    loadIncasariAll();
  }
}

async function saveIncasare() {
  const sumaEl = document.getElementById("incasariSuma");
  const suma = parseFloat(sumaEl.value);
  if (isNaN(suma) || suma < 0) { toast("Introdu o sumă validă!", "warning"); return; }

  try {
    const r = await fetch("/api/incasari", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suma })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast("Încasare salvată cu succes!", "success");
    document.getElementById("incasariStatus").innerHTML = '<span class="chip ok">✓ Completat azi</span>';
    // Reload history
    loadIncasari();
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
  }
}

async function loadIncasariAll() {
  const date = document.getElementById("incasariDate").value;
  if (!date) { toast("Selectează o dată", "warning"); return; }
  const content = document.getElementById("incasariContent");
  content.innerHTML = '<div style="text-align:center;padding:2rem"><div class="spinner" style="width:30px;height:30px"></div></div>';

  try {
    const r = await fetch(`/api/incasari/all?date=${date}`);
    const d = await r.json();

    const rows = d.agents.map(a => `
      <tr>
        <td>${esc(a.display_name || a.agent_dtr)}</td>
        <td style="text-align:right;font-weight:600">${a.completat ? Number(a.suma).toLocaleString("ro-RO", {minimumFractionDigits: 2}) : '—'}</td>
        <td><span class="chip ${a.completat ? 'ok' : 'bad'}">${a.completat ? 'DA' : 'NU'}</span></td>
      </tr>
    `).join("");

    content.innerHTML = `
      <div class="report-card">
        <h4>Încasări zilnice: ${d.date}</h4>
        <div class="report-stat"><span>Agenți completați:</span><span class="val">${d.completati} / ${d.total_agenti}</span></div>
        <div class="report-stat"><span>Total încasat:</span><span class="val" style="color:var(--success)">${Number(d.total).toLocaleString("ro-RO", {minimumFractionDigits: 2})} lei</span></div>
      </div>
      <div class="report-card">
        <table class="missing-table">
          <tr><th>Agent</th><th style="text-align:right">Sumă (lei)</th><th>Completat</th></tr>
          ${rows}
        </table>
      </div>
    `;
  } catch (ex) {
    content.innerHTML = `<p style="color:var(--danger);padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

async function loadIncasariMonthly() {
  const date = document.getElementById("incasariDate").value;
  const month = date ? date.slice(0, 7) : new Date().toISOString().slice(0, 7);
  const content = document.getElementById("incasariContent");
  content.innerHTML = '<div style="text-align:center;padding:2rem"><div class="spinner" style="width:30px;height:30px"></div></div>';

  try {
    const r = await fetch(`/api/incasari/monthly?month=${month}`);
    const d = await r.json();

    const rows = d.agents.map(a => `
      <tr>
        <td>${esc(a.display_name || a.agent_dtr)}</td>
        <td style="text-align:right;font-weight:600">${Number(a.total_suma).toLocaleString("ro-RO", {minimumFractionDigits: 2})}</td>
        <td style="text-align:center">${a.zile_raportate}</td>
        <td style="text-align:right">${Number(a.media_zilnica).toLocaleString("ro-RO", {minimumFractionDigits: 2})}</td>
      </tr>
    `).join("");

    content.innerHTML = `
      <div class="report-card">
        <h4>Sumar lunar: ${d.month}</h4>
        <div class="report-stat"><span>Total echipă:</span><span class="val" style="color:var(--success)">${Number(d.grand_total).toLocaleString("ro-RO", {minimumFractionDigits: 2})} lei</span></div>
      </div>
      <div class="report-card">
        <table class="missing-table">
          <tr><th>Agent</th><th style="text-align:right">Total (lei)</th><th style="text-align:center">Zile</th><th style="text-align:right">Media/zi</th></tr>
          ${rows}
        </table>
      </div>
    `;
  } catch (ex) {
    content.innerHTML = `<p style="color:var(--danger);padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

/* Import sales XLSX */
async function importSalesFile() {
  const fileInput = document.getElementById("salesFileInput");
  const statusEl = document.getElementById("importStatus");
  if (!fileInput.files || !fileInput.files[0]) { toast("Selectează un fișier XLSX!", "warning"); return; }

  const file = fileInput.files[0];
  const month = document.getElementById("obiectiveMonth").value || new Date().toISOString().slice(0, 7);

  statusEl.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Se importă...';

  const fd = new FormData();
  fd.append("file", file);
  fd.append("month", month);

  try {
    const r = await fetch("/api/obiective/import-sales", { method: "POST", body: fd });
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); } catch { throw new Error("Serverul nu a răspuns corect. Reîncearcă."); }
    if (!r.ok) throw new Error(d.error || "Eroare server");

    statusEl.innerHTML = `<span style="color:var(--success)">Import reușit: ${esc(String(d.agents_imported))} agenți, ${esc(String(d.rows_processed))} rânduri (${esc(d.month)})</span>`;
    if (d.unmatched_agents.length > 0) {
      statusEl.innerHTML += `<br><span style="color:var(--warning)">Nepotriviți: ${esc(d.unmatched_agents.join(", "))}</span>`;
    }
    toast(`Import reușit: ${d.agents_imported} agenți`, "success");
    // Reload obiective + GT
    loadObiective();
    if (typeof renderGtInObiective === "function") renderGtInObiective();
  } catch (ex) {
    statusEl.innerHTML = `<span style="color:var(--danger)">Eroare: ${esc(ex.message)}</span>`;
    toast("Eroare import: " + ex.message, "error");
  }
}

async function importClienti2Luni() {
  const fileInput = document.getElementById("sales2luniFile");
  const statusEl = document.getElementById("import2luniStatus");
  if (!fileInput.files || !fileInput.files[0]) { toast("Selectează fișierul de vânzări pe 2 luni!", "warning"); return; }

  const file = fileInput.files[0];
  const month = document.getElementById("obiectiveMonth").value || new Date().toISOString().slice(0, 7);

  statusEl.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Se calculează clienții unici pe 2 luni...';

  const fd = new FormData();
  fd.append("file", file);
  fd.append("month", month);

  try {
    const r = await fetch("/api/obiective/import-clienti-2luni", { method: "POST", body: fd });
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); } catch { throw new Error("Serverul nu a răspuns corect. Reîncearcă."); }
    if (!r.ok) throw new Error(d.error || "Eroare server");

    statusEl.innerHTML = `<span style="color:var(--success)">✅ ${esc(String(d.agents_updated))} agenți actualizați (Clienți 2 SKU pe 2 luni) — luna ${esc(d.month)}</span>`;
    toast(`Clienți 2 luni: ${d.agents_updated} agenți actualizați`, "success");
    loadObiective();
  } catch (ex) {
    statusEl.innerHTML = `<span style="color:var(--danger)">Eroare: ${esc(ex.message)}</span>`;
    toast("Eroare import: " + ex.message, "error");
  }
}

/* ═══════════════════════════════════════════
   VIZITE TAB (Check-in + Routes)
   ═══════════════════════════════════════════ */
let viziteFiltered = [];
let viziteTodayMap = {}; // client_id -> visit data
let viziteStatusFilter = "all"; // all | visited | unvisited
const viziteSel = { agent: new Set(), city: new Set(), achizitii: new Set() };
let viziteCheckinClientId = null;

/* Load vizite tab */
async function loadVizite() {
  // Load today's status
  try {
    const r = await fetch("/api/visits/today-status");
    if (r.ok) {
      const data = await r.json();
      viziteTodayMap = {};
      (data.visits || []).forEach(v => { viziteTodayMap[v.client_id] = v; });
    }
  } catch (e) { console.error("Vizite today-status error:", e); }

  buildViziteFilters();
  applyViziteFilters();

  // Show route button for SPV/admin
  const routeBar = document.getElementById("viziteRouteBar");
  if (routeBar && (currentRole === "admin" || currentRole === "spv")) {
    routeBar.style.display = "";
  }

  // Load predefined routes
  await initRutePrestabilite();
  await loadRutePredefinite();
}

function buildViziteFilters() {
  const agents = groupBy(allClients, "agent");
  const cities = groupBy(allClients, "oras");

  const agentContainer = document.getElementById("viziteAgentFilter");
  agentContainer.innerHTML = agents.map(([val, cnt]) => `
    <label class="check-item">
      <input type="checkbox" data-val="${val}" ${viziteSel.agent.has(val) ? "checked" : ""}>
      <span>${val}</span><em>${cnt}</em>
    </label>
  `).join("");
  agentContainer.querySelectorAll("input").forEach(cb => {
    cb.onchange = () => { cb.checked ? viziteSel.agent.add(cb.dataset.val) : viziteSel.agent.delete(cb.dataset.val); };
  });

  // If agent role, auto-select own agent (no action needed, filtered in applyViziteFilters)

  const cityContainer = document.getElementById("viziteCityFilter");
  cityContainer.innerHTML = cities.map(([val, cnt]) => `
    <label class="check-item">
      <input type="checkbox" data-val="${val}" ${viziteSel.city.has(val) ? "checked" : ""}>
      <span>${val}</span><em>${cnt}</em>
    </label>
  `).join("");
  cityContainer.querySelectorAll("input").forEach(cb => {
    cb.onchange = () => { cb.checked ? viziteSel.city.add(cb.dataset.val) : viziteSel.city.delete(cb.dataset.val); };
  });

  // City search filter
  const citySearch = document.getElementById("viziteCitySearch");
  if (citySearch) {
    citySearch.oninput = () => {
      const q = citySearch.value.toLowerCase();
      cityContainer.querySelectorAll(".check-item").forEach(item => {
        item.style.display = item.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    };
  }

  // Achizitii filter
  const achContainer = document.getElementById("viziteAchizitiiFilter");
  if (achContainer) {
    const achDa = allClients.filter(c => c.lat && c.lon && purchaseMap[c.code]).length;
    const achNu = allClients.filter(c => c.lat && c.lon).length - achDa;
    achContainer.innerHTML = [["Da - Achiziție luna", achDa], ["Nu - Fără achiziție", achNu]].map(([val, cnt]) => `
      <label class="check-item">
        <input type="checkbox" data-val="${val}" ${viziteSel.achizitii.has(val) ? "checked" : ""}>
        <span>${val}</span><em>${cnt}</em>
      </label>
    `).join("");
    achContainer.querySelectorAll("input").forEach(cb => {
      cb.onchange = () => { cb.checked ? viziteSel.achizitii.add(cb.dataset.val) : viziteSel.achizitii.delete(cb.dataset.val); };
    });
  }
}

function applyViziteFilters() {
  const q = (document.getElementById("viziteSearch")?.value || "").toLowerCase();
  let list = allClients.filter(c => validGPS(c.lat, c.lon));

  // Agent role: show only own clients (use sales_rep from user profile which matches clients.agent)
  if (currentRole === "agent" && currentSalesRep) {
    list = list.filter(c => c.agent === currentSalesRep);
  }

  // Apply filters
  if (viziteSel.agent.size) list = list.filter(c => viziteSel.agent.has(c.agent));
  if (viziteSel.city.size) list = list.filter(c => viziteSel.city.has(c.oras));
  if (viziteSel.achizitii.size) {
    list = list.filter(c => {
      const label = purchaseMap[c.code] ? "Da - Achiziție luna" : "Nu - Fără achiziție";
      return viziteSel.achizitii.has(label);
    });
  }

  // Search
  if (q) {
    list = list.filter(c =>
      (c.nume_poc || "").toLowerCase().includes(q) ||
      (c.firma || "").toLowerCase().includes(q) ||
      (c.oras || "").toLowerCase().includes(q) ||
      (c.code || "").toString().includes(q)
    );
  }

  // Status filter
  if (viziteStatusFilter === "visited") {
    list = list.filter(c => viziteTodayMap[c.id]);
  } else if (viziteStatusFilter === "unvisited") {
    list = list.filter(c => !viziteTodayMap[c.id]);
  }

  viziteFiltered = list;
  renderViziteList();
  renderViziteMap();
}

function resetViziteFilters() {
  viziteSel.agent.clear();
  viziteSel.city.clear();
  viziteStatusFilter = "all";
  document.getElementById("viziteSearch").value = "";
  document.querySelectorAll(".vizite-status-filters .status-chip").forEach(s => s.classList.remove("active"));
  document.querySelector('.vizite-status-filters .status-chip[data-vstatus="all"]').classList.add("active");
  buildViziteFilters();
  applyViziteFilters();
}

function setViziteStatus(status) {
  viziteStatusFilter = status;
  document.querySelectorAll(".vizite-status-filters .status-chip").forEach(s => s.classList.remove("active"));
  document.querySelector(`.vizite-status-filters .status-chip[data-vstatus="${status}"]`).classList.add("active");
  applyViziteFilters();
}

function renderViziteList() {
  const ul = document.getElementById("viziteClientList");
  const visitedCount = viziteFiltered.filter(c => viziteTodayMap[c.id]).length;
  const totalCount = viziteFiltered.length;

  document.getElementById("viziteStats").textContent = `Clienți: ${totalCount}`;
  document.getElementById("viziteTodayStats").textContent = `Vizitați azi: ${visitedCount}/${totalCount}`;

  if (!viziteFiltered.length) {
    ul.innerHTML = `<li style="padding:1rem;color:var(--muted);text-align:center">Niciun client găsit</li>`;
    return;
  }

  ul.innerHTML = viziteFiltered.map(c => {
    const visited = viziteTodayMap[c.id];
    const visitBadge = visited
      ? `<span class="chip ok">✓ Vizitat ${visited.visit_time || ""}</span>`
      : `<span class="chip warn">— Nevizitat</span>`;
    const purch = purchaseMap[c.code];
    const purchBadge = purch
      ? `<span class="chip ok" style="font-size:.7rem">🛒 ${purch.valoare.toLocaleString("ro-RO",{minimumFractionDigits:0,maximumFractionDigits:0})} lei · ${purch.cantHL} HL</span>`
      : `<span class="chip bad" style="font-size:.7rem">Fără achiziție</span>`;
    const checkinBtn = (currentRole === "agent" && !visited)
      ? `<button class="chip-btn" onclick="openCheckinDialog(${c.id})" style="background:var(--success);color:#fff;border-color:var(--success)">📸 Check-in</button>`
      : "";
    const histBtn = `<button class="chip-btn" onclick="showVisitHistory(${c.id})">📋 Istoric</button>`;
    return `<li class="client-item" onclick="focusOnMap(${c.id},'vizite')" style="cursor:pointer">
      <div class="client-title">${esc(c.nume_poc)} ${visitBadge}</div>
      <div class="client-meta">${esc(c.firma)} · ${esc(c.oras)} · ${esc(c.agent)}</div>
      <div class="client-meta">Achiziții luna: ${purchBadge}</div>
      <div class="tiny-actions">${checkinBtn} ${histBtn}
        <button class="chip-btn" onclick="event.stopPropagation();navigateTo(${c.lat},${c.lon})">🧭 Navighează</button>
      </div>
    </li>`;
  }).join("");
}

function renderViziteMap() {
  markers.clearLayers();
  viziteFiltered.forEach(c => {
    if (!validGPS(c.lat, c.lon)) return;
    const visited = viziteTodayMap[c.id];
    const color = visited ? "#2ecc71" : "#e74c3c";
    const icon = L.divIcon({
      className: "vizite-marker",
      html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    const m = L.marker([c.lat, c.lon], { icon });
    const status = visited ? `✅ Vizitat la ${visited.visit_time}` : "❌ Nevizitat azi";
    m.bindTooltip(`<strong>${esc(c.nume_poc)}</strong><br>${status}`, { direction: "top", offset: [0, -8] });
    m.on("click", () => {
      const purch = purchaseMap[c.code];
      const purchTag = purch
        ? `<span class="chip ok">🛒 ${purch.valoare.toLocaleString("ro-RO",{minimumFractionDigits:0,maximumFractionDigits:0})} lei · ${purch.cantHL} HL</span>`
        : `<span class="chip bad">Fără achiziție</span>`;
      const checkinBtn = (currentRole === "agent" && !visited)
        ? `<button class="chip-btn" onclick="openCheckinDialog(${c.id})" style="background:var(--success);color:#fff">📸 Check-in</button>`
        : "";
      const popup = `
        <strong>${esc(c.nume_poc)}</strong><br>
        <small>${esc(c.firma)} • Cod: ${c.code}</small><br>
        <small>${esc(c.oras)} • Agent: ${esc(c.agent)}</small><br>
        ${status}<br>
        Achiziții: ${purchTag}<br>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
          ${checkinBtn}
          <button class="chip-btn" onclick="showVisitHistory(${c.id})">📋 Istoric</button>
          <button class="chip-btn" onclick="navigateTo(${c.lat},${c.lon})">🧭 Navighează</button>
          <button class="chip-btn" onclick="showClientDetail(${c.id})">📋 Detalii</button>
        </div>`;
      m.bindPopup(popup, { maxWidth: 300 }).openPopup();
    });
    markers.addLayer(m);
  });
  fitBounds(viziteFiltered);
}

/* ── Check-in dialog ── */
function openCheckinDialog(clientId) {
  event && event.stopPropagation();
  const c = allClients.find(cl => cl.id === clientId);
  if (!c) return;
  viziteCheckinClientId = clientId;
  document.getElementById("checkinTitle").textContent = "Check-in: " + c.nume_poc;
  document.getElementById("checkinClientInfo").textContent = `${c.firma} · ${c.oras} · Cod: ${c.code}`;
  document.getElementById("checkinPhoto").value = "";
  document.getElementById("checkinNotes").value = "";
  document.getElementById("checkinPhotoPreview").style.display = "none";
  document.getElementById("checkinSubmitBtn").disabled = true;
  document.getElementById("checkinDialog").showModal();
}

// Photo preview handler
document.addEventListener("DOMContentLoaded", () => {
  const photoInput = document.getElementById("checkinPhoto");
  if (photoInput) {
    photoInput.onchange = () => {
      const file = photoInput.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = e => {
          document.getElementById("checkinPhotoImg").src = e.target.result;
          document.getElementById("checkinPhotoPreview").style.display = "";
          document.getElementById("checkinSubmitBtn").disabled = false;
        };
        reader.readAsDataURL(file);
      } else {
        document.getElementById("checkinPhotoPreview").style.display = "none";
        document.getElementById("checkinSubmitBtn").disabled = true;
      }
    };
  }
});

async function submitCheckin() {
  const photo = document.getElementById("checkinPhoto").files[0];
  if (!photo) { toast("Adaugă o poză!", "warning"); return; }

  const btn = document.getElementById("checkinSubmitBtn");
  btn.disabled = true;
  btn.textContent = "Se trimite...";

  const fd = new FormData();
  fd.append("photo", photo);
  fd.append("client_id", viziteCheckinClientId);
  fd.append("client_type", "census");
  fd.append("notes", document.getElementById("checkinNotes").value.trim());

  try {
    const r = await fetch("/api/visits/checkin", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Eroare");

    toast("Check-in reușit!", "success");
    document.getElementById("checkinDialog").close();

    // Update local state
    viziteTodayMap[viziteCheckinClientId] = {
      client_id: viziteCheckinClientId,
      visit_time: d.visit?.visit_time || new Date().toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" })
    };
    applyViziteFilters();
  } catch (e) {
    toast("Eroare check-in: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "📸 Check-in";
  }
}

/* ── Visit history ── */
async function showVisitHistory(clientId) {
  event && event.stopPropagation();
  const c = allClients.find(cl => cl.id === clientId);
  if (!c) return;
  document.getElementById("visitHistoryTitle").textContent = "Istoric vizite: " + c.nume_poc;
  document.getElementById("visitHistoryBody").innerHTML = `<div style="text-align:center;padding:1rem"><div class="spinner"></div> Se încarcă...</div>`;
  document.getElementById("visitHistoryDialog").showModal();

  try {
    const r = await fetch(`/api/visits/list?client_id=${clientId}&limit=30`);
    const data = await r.json();
    const visits = data.visits || [];

    if (!visits.length) {
      document.getElementById("visitHistoryBody").innerHTML = `<p style="text-align:center;color:var(--muted);padding:1rem">Nicio vizită înregistrată</p>`;
      return;
    }

    document.getElementById("visitHistoryBody").innerHTML = visits.map(v => `
      <div style="padding:.6rem;border-bottom:1px solid var(--border);display:flex;gap:.6rem;align-items:flex-start">
        ${v.photo_url ? `<img src="${v.photo_url}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;cursor:pointer;flex-shrink:0" onclick="window.open('${v.photo_url}','_blank')">` : `<div style="width:60px;height:60px;background:var(--bg2);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0">📍</div>`}
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:.85rem">${v.visit_day || ""} ${v.visit_date || ""} · ${v.visit_time || ""}</div>
          <div style="font-size:.78rem;color:var(--muted)">Agent: ${esc(v.agent || "")}</div>
          ${v.notes ? `<div style="font-size:.82rem;margin-top:2px">${esc(v.notes)}</div>` : ""}
        </div>
      </div>
    `).join("");
  } catch (e) {
    document.getElementById("visitHistoryBody").innerHTML = `<p style="color:var(--danger);padding:1rem">Eroare: ${esc(e.message)}</p>`;
  }
}

/* ── Route generation ── */
async function generateViziteRoutes() {
  const resultDiv = document.getElementById("viziteRouteResult");
  resultDiv.innerHTML = `<div class="spinner" style="display:inline-block"></div> Se calculează rutele...`;

  try {
    const r = await fetch("/api/visits/routes");
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Eroare");

    if (!d.has_enough_data) {
      resultDiv.innerHTML = `<p style="color:var(--warning)">⚠️ Date insuficiente (${parseInt(d.total_visits)||0} vizite). Sunt necesare minim 4 săptămâni de date pentru generare rute optime.</p>`;
      return;
    }

    const days = Object.keys(d.routes || {});
    let html = `<p style="color:var(--success);margin-bottom:.5rem">✅ Rute generate din ${d.total_visits} vizite</p>`;
    html += `<p style="font-size:.78rem;color:var(--muted);margin-bottom:.5rem">Agenți: ${(d.agents || []).join(", ")}</p>`;

    days.forEach(day => {
      const route = d.routes[day];
      if (!route || !route.length) return;
      html += `<div style="margin-bottom:.6rem">`;
      html += `<strong style="font-size:.82rem">${day}</strong> <span style="color:var(--muted);font-size:.78rem">(${route.length} clienți, ${route.reduce((s,r2)=>s+(r2.distance_km||0),0).toFixed(1)} km)</span>`;
      html += `<div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:2px">`;
      route.forEach((stop, i) => {
        html += `<span class="route-chip">${i + 1}. ${esc(stop.client_name || "")}</span>`;
      });
      html += `</div>`;

      // Google Maps link
      if (route.length >= 2) {
        const origin = `${route[0].lat},${route[0].lon}`;
        const dest = `${route[route.length - 1].lat},${route[route.length - 1].lon}`;
        const waypoints = route.slice(1, -1).map(s => `${s.lat},${s.lon}`).join("|");
        const gmUrl = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}${waypoints ? "&waypoints=" + waypoints : ""}&travelmode=driving`;
        html += `<a href="${gmUrl}" target="_blank" style="font-size:.78rem;color:var(--primary);text-decoration:underline">🧭 Deschide în Google Maps</a>`;
      }
      html += `</div>`;
    });

    resultDiv.innerHTML = html;
  } catch (e) {
    resultDiv.innerHTML = `<p style="color:var(--danger)">Eroare: ${esc(e.message)}</p>`;
  }
}

/* ── Vizite search listener ── */
document.addEventListener("DOMContentLoaded", () => {
  const vizSearch = document.getElementById("viziteSearch");
  if (vizSearch) {
    let vizSearchTimeout;
    vizSearch.oninput = () => {
      clearTimeout(vizSearchTimeout);
      vizSearchTimeout = setTimeout(() => applyViziteFilters(), 300);
    };
  }
});

/* ═══════════════════════════════════════════
   RUTE PRESTABILITE (imported from Excel)
   ═══════════════════════════════════════════ */
let ruteData = [];
let ruteMarkers = L.layerGroup();

async function initRutePrestabilite() {
  // Show import bar for admin/spv
  const bar = document.getElementById("ruteImportBar");
  if (bar && (currentRole === "admin" || currentRole === "spv")) {
    bar.style.display = "";
  }
  // Load agents list
  try {
    const r = await fetch("/api/visits/predefined-routes?day=__none__");
    if (r.ok) {
      const d = await r.json();
      const sel = document.getElementById("ruteAgentSel");
      if (sel && d.agents) {
        sel.innerHTML = `<option value="">-- Toți agenții --</option>` +
          d.agents.map(a => `<option value="${a}">${a}</option>`).join("");
      }
    }
  } catch(e) { console.error("Init rute err:", e); }
}

async function loadRutePredefinite() {
  const agent = document.getElementById("ruteAgentSel")?.value || "";
  const day = document.getElementById("ruteDaySel")?.value || "";

  const params = new URLSearchParams();
  if (agent) params.set("agent", agent);
  if (day) params.set("day", day);

  try {
    const r = await fetch("/api/visits/predefined-routes?" + params.toString());
    if (!r.ok) throw new Error("Eroare server");
    const d = await r.json();
    ruteData = d.routes || [];

    document.getElementById("ruteCount").textContent = `${ruteData.length} clienți în rute`;

    const ul = document.getElementById("ruteList");
    if (!ruteData.length) {
      ul.innerHTML = `<li style="padding:.8rem;text-align:center;color:var(--muted)">Nu există rute importate. ${currentRole !== "agent" ? "Importă un fișier Excel cu rutele." : ""}</li>`;
      return;
    }

    // Group by day
    const byDay = {};
    ruteData.forEach(r => {
      if (!byDay[r.route_day]) byDay[r.route_day] = [];
      byDay[r.route_day].push(r);
    });

    let html = "";
    const dayOrder = ["Luni+Joi", "Marți+Vineri", "Miercuri", "Ambiguu", "Date Insuficiente"];
    for (const dayKey of dayOrder) {
      const clients = byDay[dayKey];
      if (!clients || !clients.length) continue;
      const matched = clients.filter(c => c.client_id).length;
      html += `<li style="padding:.5rem .8rem;background:var(--bg2);font-weight:600;font-size:.82rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between">
        <span>${dayKey}</span>
        <span style="font-weight:400;color:var(--muted)">${clients.length} clienți · ${matched} pe hartă</span>
      </li>`;
      clients.forEach(c => {
        const onMap = c.client_id ? `<span class="chip ok" style="font-size:.7rem">🗺 Pe hartă</span>` : `<span class="chip bad" style="font-size:.7rem">⚠ Nemapat</span>`;
        html += `<li class="client-item" ${c.client_id ? `onclick="focusOnMap(${c.client_id},'vizite')" style="cursor:pointer"` : ""}>
          <div class="client-title">${esc(c.client_name)} ${onMap}</div>
          <div class="client-meta">${esc(c.adresa)} · ${esc(c.cod_fiscal)}</div>
          <div class="client-meta">Vizite: ${c.vizite} · ${esc(c.distributie_zile)} · Ultima: ${esc(c.ultima_factura)}</div>
        </li>`;
      });
    }
    ul.innerHTML = html;

    // Auto-show on map when agent is selected
    if (agent) {
      showRuteOnMap();
    } else if (ruteMapActive) {
      clearRuteMap();
    }
  } catch(e) {
    document.getElementById("ruteList").innerHTML = `<li style="padding:.8rem;color:var(--danger)">${esc(e.message)}</li>`;
  }
}

let ruteMapActive = false; // track if rute-only mode is on

function showRuteOnMap() {
  // Clear ALL existing markers (vizite layer) so only route clients show
  markers.clearLayers();
  if (map.hasLayer(ruteMarkers)) map.removeLayer(ruteMarkers);
  ruteMarkers = L.layerGroup();
  ruteMapActive = true;

  const mapped = ruteData.filter(r => r.client_id);
  if (!mapped.length) {
    toast("Nu există clienți mapați pe hartă. Verificați dacă codurile fiscale corespund.", "warning");
    return;
  }

  // Get client coords from allClients
  const bounds = [];
  const dayColors = {
    "Luni+Joi": "#3498db",
    "Marți+Vineri": "#e67e22",
    "Miercuri": "#2ecc71",
    "Ambiguu": "#9b59b6",
    "Date Insuficiente": "#95a5a6"
  };

  // Also build a set of matched client IDs for the list
  const routeClientIds = new Set(mapped.map(r => r.client_id));

  mapped.forEach(r => {
    const client = allClients.find(c => c.id === r.client_id);
    if (!client || !client.lat || !client.lon) return;

    const visited = viziteTodayMap[client.id];
    const visitStatus = visited ? `✅ Vizitat ${visited.visit_time || ""}` : "❌ Nevizitat azi";
    const color = dayColors[r.route_day] || "#3498db";
    const icon = L.divIcon({
      className: "rute-marker",
      html: `<div style="width:24px;height:24px;border-radius:50%;background:${color};border:3px solid ${visited ? "#2ecc71" : "#fff"};box-shadow:0 2px 6px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:700">${r.route_day.charAt(0)}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    const m = L.marker([client.lat, client.lon], { icon });
    m.bindTooltip(`<strong>${esc(r.client_name)}</strong><br>Ruta: ${r.route_day}<br>${visitStatus}`, { direction: "top", offset: [0, -8] });
    m.on("click", () => {
      const purch = purchaseMap[client.code];
      const purchTag = purch
        ? `<span class="chip ok">🛒 ${purch.valoare.toLocaleString("ro-RO",{minimumFractionDigits:0,maximumFractionDigits:0})} lei</span>`
        : `<span class="chip bad">Fără achiziție</span>`;
      const checkinBtn = (currentRole === "agent" && !visited)
        ? `<button class="chip-btn" onclick="openCheckinDialog(${client.id})" style="background:var(--success);color:#fff">📸 Check-in</button>`
        : "";
      m.bindPopup(`
        <strong>${esc(client.nume_poc || r.client_name)}</strong><br>
        <small>${esc(client.firma)} • ${esc(client.oras)}</small><br>
        <small>Ruta: <b>${r.route_day}</b> · Vizite Excel: ${r.vizite}</small><br>
        ${visitStatus}<br>Achiziții: ${purchTag}<br>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
          ${checkinBtn}
          <button class="chip-btn" onclick="showVisitHistory(${client.id})">📋 Istoric</button>
          <button class="chip-btn" onclick="navigateTo(${client.lat},${client.lon})">🧭 Nav</button>
        </div>
      `, { maxWidth: 300 }).openPopup();
    });
    ruteMarkers.addLayer(m);
    bounds.push([client.lat, client.lon]);
  });

  ruteMarkers.addTo(map);
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
  toast(`${mapped.length} clienți din rute pe hartă (din ${ruteData.length} total)`, "success");
}

function clearRuteMap() {
  if (map.hasLayer(ruteMarkers)) map.removeLayer(ruteMarkers);
  ruteMarkers = L.layerGroup();
  ruteMapActive = false;
  // Restore normal vizite map
  renderViziteMap();
}

async function importRuteExcel(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = "";

  const status = document.getElementById("ruteImportStatus");
  status.textContent = "Se importă...";
  status.style.color = "var(--muted)";

  const fd = new FormData();
  fd.append("file", file);

  try {
    const r = await fetch("/api/visits/import-routes", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Eroare import");

    status.textContent = d.message;
    status.style.color = "var(--success)";
    toast(d.message, "success");

    // Reload
    await initRutePrestabilite();
    await loadRutePredefinite();
  } catch(e) {
    status.textContent = "Eroare: " + e.message;
    status.style.color = "var(--danger)";
    toast("Eroare import rute: " + e.message, "error");
  }
}

/* ── Init ── */
(async function init() {
  initMap();
  if (await checkAuth()) {
    await loadData();
    // Show admin buttons
    if (currentRole === "admin") {
      const el = document.getElementById("adminEmailBtns");
      if (el) el.style.display = "block";
      const importEl = document.getElementById("adminImportBtns");
      if (importEl) importEl.style.display = "block";
    }
    // Set default month for obiective
    const monthInput = document.getElementById("obiectiveMonth");
    if (monthInput) monthInput.value = new Date().toISOString().slice(0, 7);
    // Set default month for GT
    const gtMo = document.getElementById("gtMonth");
    if (gtMo) gtMo.value = new Date().toISOString().slice(0, 7);
    const gtTgtMo = document.getElementById("gtTargetMonth");
    if (gtTgtMo) gtTgtMo.value = new Date().toISOString().slice(0, 7);
    const gtCenMo = document.getElementById("gtCentralizatorMonth");
    if (gtCenMo) gtCenMo.value = new Date().toISOString().slice(0, 7);
    // Set default month for GT targeturi in OBIECTIVE panel
    const gtTgtMoObj = document.getElementById("gtTargetMonth");
    if (gtTgtMoObj) gtTgtMoObj.value = new Date().toISOString().slice(0, 7);
    // Show GT admin config (both in BUGET GT tab and OBIECTIVE panel)
    if (currentRole === "admin") {
      const gtCfg = document.getElementById("gtAdminConfig");
      if (gtCfg) gtCfg.style.display = "block";
      const gtObjCfg = document.getElementById("gtObjAdminConfig");
      if (gtObjCfg) gtObjCfg.style.display = "block";
    }
    // Show proposals button for SPV and admin
    if (currentRole === "admin" || currentRole === "spv") {
      const pb = document.getElementById("proposalsBtn");
      if (pb) pb.style.display = "";
    }
    // Show export Excel button only for non-agents
    if (currentRole !== "agent") {
      const expBtn = document.getElementById("exportExcelBtn");
      if (expBtn) expBtn.style.display = "";
    }
    // Default tab = VIZITE (skip for upload role, already set)
    if (currentRole !== "upload") {
      switchTab("vizite");

      // Show HOME GRID as default landing screen
      showHomeGrid();
      // Update home grid user label
      const hl = document.getElementById('homeUserLabel');
      if (hl) hl.textContent = document.getElementById('userLabel')?.textContent || '';
      // Handle upload rapoarte visibility in grid
      if (currentRole === "admin" || currentRole === "spv") {
        const gur = document.getElementById('gridUploadRapoarte');
        if (gur) gur.style.display = '';
        const gb2c = document.getElementById('gridContracteB2C');
        if (gb2c) gb2c.style.display = '';
        const tb2c = document.getElementById('tabContracteB2C');
        if (tb2c) tb2c.style.display = '';
      }
      // Show post-login dashboard
      showPostLoginDashboard();

      // Show ranking popup after dashboard
      showRankingPopup();
    }

    // Load notifications
    loadNotifications();

    // Show What's New popup if there are changes since last login
    try {
      const prevLogin = sessionStorage.getItem("previous_login");
      if (prevLogin) {
        sessionStorage.removeItem("previous_login");
        showWhatsNew(prevLogin);
      }
    } catch(e) {}

    // Add census cascade filter
    addCensusCascadeFilter();

    // Initialize calendar state
    initCalendarState();
  }
})();

/* ═══════════════════════════════════════════
   POST-LOGIN DASHBOARD DIALOG
   ═══════════════════════════════════════════ */
async function showPostLoginDashboard() {
  try {
    const r = await fetch("/api/agent-dashboard");
    if (!r.ok) return;
    const d = await r.json();
    if (!d.my && !d.ranking) return;

    const dialog = document.getElementById("dashboardDialog");
    const body = document.getElementById("dashboardBody");
    const title = document.getElementById("dashboardTitle");
    if (!dialog || !body) return;

    const fLei = (v) => (v || 0).toLocaleString("ro-RO", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const fHL = (v) => (v || 0).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const daysPct = d.working_days > 0 ? Math.round((d.worked_days / d.working_days) * 100) : 0;

    function barColorClass(pct) {
      if (pct >= 100) return "blue";
      if (pct >= 70) return "green";
      if (pct >= 40) return "yellow";
      return "red";
    }
    function pctHex(pct) {
      if (pct >= 100) return "#3498db";
      if (pct >= 70) return "#2ecc71";
      if (pct >= 40) return "#f1c40f";
      return "#e74c3c";
    }

    // SVG ring helper
    function ring(pct, color, label) {
      const r = 38, circ = 2 * Math.PI * r;
      const offset = circ - (Math.min(pct, 100) / 100) * circ;
      return `<div class="dash-ring">
        <svg width="90" height="90" viewBox="0 0 90 90">
          <circle class="dash-ring-bg" cx="45" cy="45" r="${r}"/>
          <circle class="dash-ring-fill" cx="45" cy="45" r="${r}"
            stroke="${color}" stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
        </svg>
        <div class="dash-ring-label">
          <span class="dash-ring-pct" style="color:${color}">${pct}%</span>
          <span class="dash-ring-name">${label}</span>
        </div>
      </div>`;
    }

    // ── Personalized messages per rank ──
    function getPersonalizedMsg(my, total, zileRamase) {
      const rank = my.rank_val;
      const rt = `${rank}/${total}`;
      const pv = my.pct_val;
      const pc = my.pct_clienti;
      const dp = my.delta_prev || 0;
      const dn = my.delta_next || 0;
      const dpod = my.delta_podium || 0;

      const msgs = {
        1:  `${rt} – ${pv}% realizare. Standardul echipei. Păstrează distanța de +${dn}%.`,
        2:  `${rt} – ${pv}% realizare. Doar ${dp}% până la primul loc. Atacă acum.`,
        3:  `${rt} – ${pv}% realizare. ${dp}% până la locul 2. Podiumul nu e finalul.`,
        4:  `${rt} – ${pv}%. ${dpod}% până la podium. Sprint decisiv.`,
        5:  `${rt} – ${pv}%. Diferență mică: ${dp}%. Urci cu o zi bună.`,
        6:  `${rt} – ${pv}%. Zonă de echilibru. +${dp}% și urci.`,
        7:  `${rt} – ${pv}%. Ești la ${dp}% de top 6. Decide ritmul.`,
        8:  `${rt} – ${pv}%. Activează clienții: ${pc}% vs target.`,
        9:  `${rt} – ${pv}%. ${zileRamase} zile rămase. Fereastra încă deschisă.`,
        10: `${rt} – ${pv}%. +${dp}% pentru urcare. Fără amânare.`,
        11: `${rt} – ${pv}%. Diferență recuperabilă: ${dp}%.`,
        12: `${rt} – ${pv}%. Ținta e clară. Execuția decide.`,
        13: `${rt} – ${pv}%. Ultimul loc e temporar. ${zileRamase} zile pentru reset.`
      };
      return msgs[rank] || `${rt} – ${pv}%. ${zileRamase} zile rămase. Fiecare zi contează.`;
    }

    function heroClass(rank) {
      if (rank === 1) return "gold";
      if (rank === 2) return "silver";
      if (rank === 3) return "bronze";
      if (rank <= 8) return "mid";
      return "low";
    }

    function heroEmoji(rank) {
      if (rank === 1) return "🥇";
      if (rank === 2) return "🥈";
      if (rank === 3) return "🥉";
      if (rank <= 5) return "4️⃣5️⃣".charAt((rank - 4) * 2) + "️⃣";
      return "📊";
    }
    const rankEmojis = ["","🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟","1️⃣1️⃣","1️⃣2️⃣","1️⃣3️⃣"];

    if (d.ranking) {
      // ═══ SPV / Admin view ═══
      title.textContent = `Clasament echipă • ${d.month}`;

      let html = `
        <div class="dash-days">
          <div class="dash-days-text">${d.worked_days} din ${d.working_days} zile lucrătoare (${daysPct}%)</div>
          <div class="dash-days-bar"><div class="dash-days-fill" style="width:${daysPct}%"></div></div>
        </div>
      `;

      // Valoric ranking with bars
      const maxPctVal = Math.max(...d.ranking.map(a => a.pct_val), 1);
      html += `<div class="dash-section"><div class="dash-section-title">🏆 Clasament vânzări (% target valoric)</div>`;
      for (const ag of d.ranking) {
        const barW = Math.round((ag.pct_val / maxPctVal) * 100);
        const medal = rankEmojis[ag.rank_val] || `#${ag.rank_val}`;
        html += `
          <div class="dash-spv-row${ag.rank_val <= 3 ? ' top3' : ''}">
            <span class="dash-spv-rank">${medal}</span>
            <span class="dash-spv-name">${esc(ag.agent_name)}</span>
            <span class="dash-spv-bar-wrap"><span class="dash-spv-bar" style="width:${barW}%;background:${pctHex(ag.pct_val)}"></span></span>
            <span class="dash-spv-pct" style="color:${pctHex(ag.pct_val)}">${ag.pct_val}%</span>
            <span class="dash-spv-val">${fLei(ag.realizat_val)} lei</span>
          </div>`;
      }
      html += `</div>`;

      // HL ranking
      const byHL = [...d.ranking].sort((a, b) => b.pct_hl - a.pct_hl);
      const maxPctHL = Math.max(...byHL.map(a => a.pct_hl), 1);
      html += `<div class="dash-section"><div class="dash-section-title">📦 Clasament hectolitri (% target HL)</div>`;
      byHL.forEach((ag, i) => {
        const rank = i + 1;
        const barW = Math.round((ag.pct_hl / maxPctHL) * 100);
        const medal = rankEmojis[rank] || `#${rank}`;
        html += `
          <div class="dash-spv-row${rank <= 3 ? ' top3' : ''}">
            <span class="dash-spv-rank">${medal}</span>
            <span class="dash-spv-name">${esc(ag.agent_name)}</span>
            <span class="dash-spv-bar-wrap"><span class="dash-spv-bar" style="width:${barW}%;background:${pctHex(ag.pct_hl)}"></span></span>
            <span class="dash-spv-pct" style="color:${pctHex(ag.pct_hl)}">${ag.pct_hl}%</span>
            <span class="dash-spv-val">${fHL(ag.realizat_hl)} HL</span>
          </div>`;
      });
      html += `</div>`;

      // Clienti 2SKU ranking
      const byCl = [...d.ranking].sort((a, b) => b.pct_clienti - a.pct_clienti);
      const maxPctCl = Math.max(...byCl.map(a => a.pct_clienti), 1);
      html += `<div class="dash-section"><div class="dash-section-title">👥 Clasament clienți 2SKU (% target)</div>`;
      byCl.forEach((ag, i) => {
        const rank = i + 1;
        const barW = Math.round((ag.pct_clienti / maxPctCl) * 100);
        const medal = rankEmojis[rank] || `#${rank}`;
        html += `
          <div class="dash-spv-row${rank <= 3 ? ' top3' : ''}">
            <span class="dash-spv-rank">${medal}</span>
            <span class="dash-spv-name">${esc(ag.agent_name)}</span>
            <span class="dash-spv-bar-wrap"><span class="dash-spv-bar" style="width:${barW}%;background:${pctHex(ag.pct_clienti)}"></span></span>
            <span class="dash-spv-pct" style="color:${pctHex(ag.pct_clienti)}">${ag.pct_clienti}%</span>
            <span class="dash-spv-val">${ag.realizat_clienti_2sku}/${ag.target_clienti}</span>
          </div>`;
      });
      html += `</div>`;

      body.innerHTML = html;

    } else if (d.my) {
      // ═══ Agent view ═══
      const my = d.my;
      title.textContent = `Realizările tale • ${d.month}`;
      const msg = getPersonalizedMsg(my, d.total_agents, d.days_remaining);
      const hClass = heroClass(my.rank_val);

      // Trend indicator
      let trendHtml = "";
      if (my.pct_val >= 100) trendHtml = `<span class="dash-trend over">🔵 Peste target!</span>`;

      // Last import info
      let importInfo = "";
      if (d.last_import) {
        const importDate = new Date(d.last_import);
        const fDate = importDate.toLocaleDateString("ro-RO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
        importInfo = `<div class="dash-hero-sub">Actualizat: ${esc(fDate)}${d.import_file ? " – " + esc(d.import_file) : ""}</div>`;
      } else {
        importInfo = `<div class="dash-hero-sub" style="color:var(--warning)">Nu sunt date importate</div>`;
      }

      body.innerHTML = `
        <div class="dash-hero ${hClass}">
          <div class="dash-hero-rank">${rankEmojis[my.rank_val] || "#" + my.rank_val}</div>
          <div class="dash-hero-msg">${msg}</div>
          ${trendHtml ? `<div style="margin-top:.4rem">${trendHtml}</div>` : ""}
          ${importInfo}
        </div>

        <div class="dash-days">
          <div class="dash-days-text">${d.worked_days}/${d.working_days} zile lucrătoare • ${d.days_remaining} rămase</div>
          <div class="dash-days-bar"><div class="dash-days-fill" style="width:${daysPct}%"></div></div>
        </div>

        <div class="dash-ring-wrap">
          ${ring(my.pct_val, pctHex(my.pct_val), "Valoric")}
          ${ring(my.pct_hl, pctHex(my.pct_hl), "HL")}
          ${ring(my.pct_clienti, pctHex(my.pct_clienti), "Clienți")}
        </div>

        <div class="dash-bar-section">
          <div class="dash-bar-title">Detalii realizare</div>
          <div class="dash-bar-row">
            <div class="dash-bar-header">
              <span class="dash-bar-label">Valoric</span>
              <span class="dash-bar-values">${fLei(my.realizat_val)} / ${fLei(my.target_val)} lei</span>
            </div>
            <div class="dash-bar-track">
              <div class="dash-bar-fill ${barColorClass(my.pct_val)}" style="width:${Math.min(my.pct_val, 100)}%"></div>
            </div>
          </div>
          <div class="dash-bar-row">
            <div class="dash-bar-header">
              <span class="dash-bar-label">Hectolitri</span>
              <span class="dash-bar-values">${fHL(my.realizat_hl)} / ${fHL(my.target_hl)} HL</span>
            </div>
            <div class="dash-bar-track">
              <div class="dash-bar-fill ${barColorClass(my.pct_hl)}" style="width:${Math.min(my.pct_hl, 100)}%"></div>
            </div>
          </div>
          <div class="dash-bar-row">
            <div class="dash-bar-header">
              <span class="dash-bar-label">Clienți 2SKU</span>
              <span class="dash-bar-values">${my.realizat_clienti_2sku} / ${my.target_clienti}</span>
            </div>
            <div class="dash-bar-track">
              <div class="dash-bar-fill ${barColorClass(my.pct_clienti)}" style="width:${Math.min(my.pct_clienti, 100)}%"></div>
            </div>
          </div>
        </div>

        ${d.days_remaining > 0 && my.target_val > my.realizat_val ? `
        <div class="dash-needed">
          <div class="dash-bar-title">De vândut pe zi</div>
          <div class="dash-needed-val">${fLei(Math.round((my.target_val - my.realizat_val) / d.days_remaining))} lei/zi</div>
          <div class="dash-needed-sub">pentru a atinge targetul în ${d.days_remaining} zile</div>
        </div>` : ""}
      `;
    }

    dialog.showModal();
  } catch (ex) {
    console.log("Dashboard load error:", ex);
  }
}

/* ═══════════════════════════════════════════════════════════════
   MODULE 1: COMUNICARE / ANUNȚURI
   ═══════════════════════════════════════════════════════════════ */

let agentsList = [];

async function loadAgentsList() {
  if (agentsList.length > 0) return;
  try {
    const r = await fetch("/api/agents/list");
    if (r.ok) agentsList = await r.json();
  } catch (e) { console.log("Failed to load agents list"); }
}

function loadComunicare() {
  loadAnnouncements();
}

async function loadAnnouncements() {
  try {
    const r = await fetch("/api/announcements");
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById("annList");
    if (data.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:1rem">Niciun anunț</p>';
      return;
    }
    el.innerHTML = data.map(a => {
      const pri = a.priority === "urgent" ? "border-left:3px solid var(--danger)" : a.priority === "info" ? "border-left:3px solid var(--info, #2196F3)" : "";
      const pin = a.pinned ? "📌 " : "";
      const del = currentRole !== "agent" ? `<button class="btn ghost small" onclick="deleteAnnouncement(${a.id})" style="font-size:.7rem;padding:2px 6px">🗑</button>` : "";
      return `<div class="module-card" style="${pri}">
        <div style="display:flex;justify-content:space-between;align-items:start">
          <strong style="font-size:.9rem">${pin}${esc(a.title)}</strong>${del}
        </div>
        <p style="font-size:.82rem;margin:.3rem 0;white-space:pre-wrap">${esc(a.body)}</p>
        <div style="font-size:.72rem;color:var(--muted)">${a.created_by} · ${fmtDate(a.created_at)}${a.expires_at ? ` · Expiră: ${a.expires_at}` : ""}</div>
      </div>`;
    }).join("");
  } catch (e) { toast("Eroare la încărcarea anunțurilor", "error"); }
}

async function submitAnnouncement() {
  const title = document.getElementById("annTitle").value.trim();
  const body = document.getElementById("annBody").value.trim();
  if (!title) return toast("Titlul este obligatoriu", "error");
  const r = await fetch("/api/announcements", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, priority: document.getElementById("annPriority").value, expires_at: document.getElementById("annExpires").value })
  });
  if (r.ok) {
    toast("Anunț publicat!", "success");
    document.getElementById("annTitle").value = "";
    document.getElementById("annBody").value = "";
    loadAnnouncements();
  } else {
    const d = await r.json();
    toast(d.error || "Eroare", "error");
  }
}

async function deleteAnnouncement(id) {
  if (!confirm("Ștergi acest anunț?")) return;
  await fetch(`/api/announcements/${id}`, { method: "DELETE" });
  loadAnnouncements();
}

/* ═══════════════════════════════════════════════════════════════
   MODULE 2: TASKURI / SARCINI ZILNICE
   ═══════════════════════════════════════════════════════════════ */

function loadTaskuri() {
  loadAgentsList().then(() => {
    populateAgentDropdowns();
    loadTasks();
  });
}

function populateAgentDropdowns() {
  const containers = ["taskAgent", "taskFilterAgent", "calAgent"];
  containers.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const placeholder = id === "taskAgent" ? "Caută agent..." : "Toți agenții (caută...)";
    populateAgentSearchable(id, placeholder);
  });
}

async function loadTasks() {
  try {
    let url = "/api/tasks";
    if (currentRole !== "agent") {
      const agent = getSearchableValue("taskFilterAgent");
      if (agent) url += `?agent=${agent}`;
    }
    const r = await fetch(url);
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById("taskList");
    if (data.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:1rem">Nicio sarcină</p>';
      return;
    }
    el.innerHTML = data.map(t => {
      const statusIcon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳";
      const priColor = t.priority === "urgent" ? "var(--danger)" : t.priority === "low" ? "var(--muted)" : "var(--fg)";
      const strikeCls = t.status === "completed" ? "text-decoration:line-through;opacity:.6" : "";
      const actions = t.status !== "completed" ? `
        <div style="margin-top:.4rem;display:flex;gap:.3rem">
          ${t.status === "pending" ? `<button class="btn primary small" onclick="updateTask(${t.id},'in_progress')" style="font-size:.7rem;padding:2px 8px">Start</button>` : ""}
          <button class="btn success small" onclick="updateTask(${t.id},'completed')" style="font-size:.7rem;padding:2px 8px">✓ Gata</button>
          ${currentRole !== "agent" ? `<button class="btn ghost small" onclick="deleteTask(${t.id})" style="font-size:.7rem;padding:2px 6px">🗑</button>` : ""}
        </div>` : "";
      return `<div class="module-card" style="${strikeCls}">
        <div style="display:flex;justify-content:space-between">
          <strong style="font-size:.88rem;color:${priColor}">${statusIcon} ${esc(t.title)}</strong>
          <span style="font-size:.72rem;color:var(--muted)">${t.due_date || ""}</span>
        </div>
        ${t.description ? `<p style="font-size:.8rem;margin:.2rem 0;color:var(--muted)">${esc(t.description)}</p>` : ""}
        <div style="font-size:.72rem;color:var(--muted)">→ ${t.assigned_to} · de la ${t.assigned_by}${t.completed_at ? ` · ✓ ${fmtDate(t.completed_at)}` : ""}</div>
        ${actions}
      </div>`;
    }).join("");
  } catch (e) { toast("Eroare la încărcarea sarcinilor", "error"); }
}

async function submitTask() {
  const title = document.getElementById("taskTitle").value.trim();
  const assigned_to = getSearchableValue("taskAgent");
  if (!title) return toast("Titlul este obligatoriu", "error");
  if (!assigned_to) return toast("Selectează agentul", "error");
  const r = await fetch("/api/tasks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description: document.getElementById("taskDesc").value, assigned_to, due_date: document.getElementById("taskDue").value, priority: document.getElementById("taskPriority").value })
  });
  if (r.ok) {
    toast("Sarcină creată!", "success");
    document.getElementById("taskTitle").value = "";
    document.getElementById("taskDesc").value = "";
    loadTasks();
  } else { const d = await r.json(); toast(d.error || "Eroare", "error"); }
}

async function updateTask(id, status) {
  await fetch(`/api/tasks/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
  loadTasks();
}

async function deleteTask(id) {
  if (!confirm("Ștergi această sarcină?")) return;
  await fetch(`/api/tasks/${id}`, { method: "DELETE" });
  loadTasks();
}

/* ═══════════════════════════════════════════════════════════════
   MODULE 3: GPS TRACKING / MONITORIZARE LIVE
   ═══════════════════════════════════════════════════════════════ */

let gpsInterval = null;
let gpsAutoRefresh = null;
let gpsMarkers = [];

function isWorkingHours() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon ... 6=Sat
  const h = now.getHours();
  const m = now.getMinutes();
  const time = h * 60 + m; // minutes since midnight
  if (day === 0) return false; // Duminică — nu se lucrează
  if (day === 6) return time >= 420 && time < 780; // Sâmbătă 7:00-13:00
  return time >= 420 && time < 1080; // Luni-Vineri 7:00-18:00
}

function startGpsTracking() {
  if (currentRole !== "agent") return;
  if (!navigator.geolocation) return;
  // Send location every 60 seconds, only during working hours
  function sendLoc() {
    if (!isWorkingHours()) {
      const el = document.getElementById("gpsMyStatus");
      if (el) el.innerHTML = `<span style="color:var(--muted)">📍 GPS inactiv — în afara programului de lucru</span>`;
      return;
    }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        await fetch("/api/gps/update", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, speed: pos.coords.speed || 0 })
        });
        const el = document.getElementById("gpsMyStatus");
        if (el) el.innerHTML = `<span style="color:var(--success)">📍 Ultima locație: ${new Date().toLocaleTimeString("ro-RO")}</span>`;
      } catch (e) {}
    }, () => {}, { enableHighAccuracy: true, timeout: 10000 });
  }
  sendLoc();
  gpsInterval = setInterval(sendLoc, 120000); // la fiecare 2 minute
}

function loadGps() {
  if (currentRole === "admin") loadGpsLive();
}

async function loadGpsLive() {
  try {
    const r = await fetch("/api/gps/live");
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById("gpsAgentList");
    // Clear old GPS markers
    gpsMarkers.forEach(m => map.removeLayer(m));
    gpsMarkers = [];
    if (data.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:1rem">Niciun agent activ</p>';
      return;
    }
    el.innerHTML = data.map(g => {
      const ago = Math.round((Date.now() - new Date(g.recorded_at + "Z").getTime()) / 60000);
      const statusColor = ago < 5 ? "var(--success)" : ago < 30 ? "var(--warning)" : "var(--danger)";
      return `<div class="module-card" onclick="map.setView([${g.lat},${g.lon}],15)" style="cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:.85rem">${esc(g.agent_name)}</strong>
          <span style="font-size:.72rem;color:${statusColor}">● ${ago < 1 ? "acum" : ago + " min"}</span>
        </div>
        <div style="font-size:.75rem;color:var(--muted)">Vizite azi: ${g.visits_today || 0} · Viteză: ${Math.round(g.speed || 0)} km/h</div>
      </div>`;
    }).join("");
    // Add markers to map
    data.forEach(g => {
      const icon = L.divIcon({ className: "gps-marker", html: `<div style="background:${(Date.now() - new Date(g.recorded_at+"Z").getTime()) < 300000 ? "#4CAF50" : "#FF9800"};width:12px;height:12px;border-radius:50%;border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,.4)"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
      const m = L.marker([g.lat, g.lon], { icon }).addTo(map);
      m.bindPopup(`<b>${g.agent_name}</b><br>Vizite: ${g.visits_today}<br>${new Date(g.recorded_at+"Z").toLocaleTimeString("ro-RO")}`);
      gpsMarkers.push(m);
    });
    // Fit map to GPS markers
    if (gpsMarkers.length > 0) {
      const group = L.featureGroup(gpsMarkers);
      map.fitBounds(group.getBounds().pad(0.2));
    }
  } catch (e) { toast("Eroare GPS", "error"); }
}

function toggleGpsAutoRefresh() {
  if (gpsAutoRefresh) {
    clearInterval(gpsAutoRefresh);
    gpsAutoRefresh = null;
    toast("Auto-refresh dezactivat", "info");
  } else {
    gpsAutoRefresh = setInterval(loadGpsLive, 30000);
    toast("Auto-refresh la 30s", "success");
  }
}

/* ═══════════════════════════════════════════════════════════════
   MODULE 4: COMPETIȚIE / INTELLIGENCE
   ═══════════════════════════════════════════════════════════════ */

function loadCompetition() {
  loadCompetitionList();
}

function openCompetitionDialog() {
  populateClientDropdown("compClient");
  document.getElementById("competitionDialog").showModal();
}

async function submitCompetition() {
  const client_id = getSearchableValue("compClient");
  if (!client_id) return toast("Selectează clientul", "error");
  const r = await fetch("/api/competition", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id, competitor_brand: document.getElementById("compBrand").value,
      competitor_product: document.getElementById("compProduct").value,
      competitor_price: document.getElementById("compPrice").value,
      competitor_promo: document.getElementById("compPromo").value,
      shelf_presence: document.getElementById("compShelf").value,
      notes: document.getElementById("compNotes").value
    })
  });
  if (r.ok) {
    toast("Raport competiție salvat!", "success");
    document.getElementById("competitionDialog").close();
    loadCompetitionList();
  } else { const d = await r.json(); toast(d.error || "Eroare", "error"); }
}

async function loadCompetitionList() {
  try {
    const r = await fetch("/api/competition");
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById("compList");
    if (data.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:1rem">Niciun raport</p>';
      return;
    }
    el.innerHTML = data.map(c => `<div class="module-card">
      <div style="display:flex;justify-content:space-between">
        <strong style="font-size:.85rem">${esc(c.competitor_brand)} — ${esc(c.competitor_product || "")}</strong>
        <span style="font-size:.75rem;color:var(--muted)">${fmtDate(c.reported_at)}</span>
      </div>
      <div style="font-size:.8rem;margin:.2rem 0">📍 ${esc(c.firma || "")} · ${esc(c.oras || "")}</div>
      <div style="font-size:.78rem;color:var(--muted)">
        ${c.competitor_price ? `Preț: ${c.competitor_price} lei` : ""} ${c.shelf_presence ? `· Raft: ${c.shelf_presence}` : ""} ${c.competitor_promo ? `· Promoție: ${c.competitor_promo}` : ""}
      </div>
      ${c.notes ? `<p style="font-size:.78rem;margin:.2rem 0;font-style:italic">${esc(c.notes)}</p>` : ""}
      <div style="font-size:.7rem;color:var(--muted)">Raportat de: ${c.reported_by}</div>
    </div>`).join("");
  } catch (e) { toast("Eroare la încărcarea rapoartelor", "error"); }
}

/* ═══════════════════════════════════════════════════════════════
   MODULE 5: STOC FRIGIDER / MERCHANDISING
   ═══════════════════════════════════════════════════════════════ */

function loadFridge() {
  loadFridgeList();
  loadFridgeSummary();
}

function openFridgeDialog() {
  populateClientDropdown("fridgeClient");
  document.getElementById("fridgeDialog").showModal();
}

async function submitFridge() {
  const client_id = getSearchableValue("fridgeClient");
  if (!client_id) return toast("Selectează clientul", "error");
  const r = await fetch("/api/fridge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id,
      fridge_present: document.getElementById("fridgePresent").checked,
      fridge_functional: document.getElementById("fridgeFunctional").checked,
      fridge_clean: document.getElementById("fridgeClean").checked,
      fridge_branded: document.getElementById("fridgeBranded").checked,
      stock_level: document.getElementById("fridgeStock").value,
      sku_count: parseInt(document.getElementById("fridgeSku").value) || 0,
      competitor_products: parseInt(document.getElementById("fridgeComp").value) || 0,
      notes: document.getElementById("fridgeNotes").value
    })
  });
  if (r.ok) {
    toast("Audit frigider salvat!", "success");
    document.getElementById("fridgeDialog").close();
    loadFridge();
  } else { const d = await r.json(); toast(d.error || "Eroare", "error"); }
}

async function loadFridgeList() {
  try {
    const r = await fetch("/api/fridge");
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById("fridgeList");
    if (data.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:1rem">Niciun audit frigider</p>';
      return;
    }
    el.innerHTML = data.map(f => {
      const checks = [f.fridge_present && "Prezent", f.fridge_functional && "Funcțional", f.fridge_clean && "Curat", f.fridge_branded && "Brandat"].filter(Boolean).join(" · ");
      const stockColor = f.stock_level === "plin" ? "var(--success)" : f.stock_level === "scazut" ? "var(--warning)" : f.stock_level === "gol" ? "var(--danger)" : "var(--fg)";
      return `<div class="module-card">
        <div style="display:flex;justify-content:space-between">
          <strong style="font-size:.85rem">🧊 ${esc(f.firma || "")} — ${esc(f.nume_poc || "")}</strong>
          <span style="font-size:.72rem;color:var(--muted)">${fmtDate(f.audited_at)}</span>
        </div>
        <div style="font-size:.8rem;margin:.2rem 0;color:var(--muted)">${checks || "Frigider absent"}</div>
        <div style="font-size:.78rem">Stoc: <span style="color:${stockColor};font-weight:600">${f.stock_level}</span> · SKU BB: ${f.sku_count} · Concurență: ${f.competitor_products}</div>
        ${f.notes ? `<p style="font-size:.78rem;margin:.2rem 0;font-style:italic">${esc(f.notes)}</p>` : ""}
        <div style="font-size:.7rem;color:var(--muted)">${f.audited_by} · ${esc(f.oras || "")}</div>
      </div>`;
    }).join("");
  } catch (e) { toast("Eroare frigider", "error"); }
}

async function loadFridgeSummary() {
  try {
    const r = await fetch("/api/fridge/summary");
    if (!r.ok) return;
    const s = await r.json();
    const el = document.getElementById("fridgeSummary");
    if (!s.total) { el.innerHTML = ""; return; }
    el.innerHTML = `<div style="font-size:.8rem;color:var(--muted);padding:.3rem 0">Luna curentă: ${s.total} audituri · ${s.with_fridge} cu frigider · ${s.functional} funcționale · ${s.branded} brandate · SKU mediu: ${Math.round(s.avg_sku || 0)}</div>`;
  } catch (e) {}
}

/* ═══════════════════════════════════════════════════════════════
   MODULE 6: PROMOȚII ACTIVE
   ═══════════════════════════════════════════════════════════════ */

function loadPromotions() {
  loadPromotionsList();
}

async function loadPromotionsList() {
  try {
    const showAll = currentRole !== "agent" ? "?all=1" : "";
    const r = await fetch("/api/promotions" + showAll);
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById("promoList");
    if (data.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:1rem">Nicio promoție activă</p>';
      return;
    }
    el.innerHTML = data.map(p => {
      const isActive = p.active && p.start_date <= new Date().toISOString().slice(0, 10) && p.end_date >= new Date().toISOString().slice(0, 10);
      const statusBadge = isActive ? '<span style="color:var(--success);font-weight:600">● ACTIVĂ</span>' : '<span style="color:var(--muted)">● Inactivă</span>';
      const del = currentRole !== "agent" ? `<button class="btn ghost small" onclick="deletePromotion(${p.id})" style="font-size:.7rem;padding:2px 6px">🗑</button>` : "";
      return `<div class="module-card" style="${isActive ? "border-left:3px solid var(--success)" : ""}">
        <div style="display:flex;justify-content:space-between;align-items:start">
          <strong style="font-size:.88rem">🎯 ${esc(p.title)}</strong>
          <div style="display:flex;gap:.3rem;align-items:center">${statusBadge} ${del}</div>
        </div>
        ${p.description ? `<p style="font-size:.82rem;margin:.3rem 0">${esc(p.description)}</p>` : ""}
        <div style="font-size:.78rem;color:var(--muted)">📅 ${p.start_date} → ${p.end_date} · Activări: ${p.activations || 0}</div>
        ${p.products ? `<div style="font-size:.78rem;margin:.2rem 0">Produse: ${esc(p.products)}</div>` : ""}
        ${isActive ? `<button class="btn primary small" onclick="activatePromotion(${p.id})" style="font-size:.75rem;margin-top:.3rem">Activează pentru client</button>` : ""}
      </div>`;
    }).join("");
  } catch (e) { toast("Eroare promoții", "error"); }
}

async function submitPromotion() {
  const title = document.getElementById("promoTitle").value.trim();
  if (!title) return toast("Titlul este obligatoriu", "error");
  const r = await fetch("/api/promotions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title, description: document.getElementById("promoDesc").value,
      start_date: document.getElementById("promoStart").value,
      end_date: document.getElementById("promoEnd").value,
      products: document.getElementById("promoProducts").value
    })
  });
  if (r.ok) {
    toast("Promoție creată!", "success");
    document.getElementById("promoTitle").value = "";
    document.getElementById("promoDesc").value = "";
    loadPromotionsList();
  } else { const d = await r.json(); toast(d.error || "Eroare", "error"); }
}

let activePromoId = null;
function activatePromotion(promoId) {
  activePromoId = promoId;
  populateClientDropdown("promoActivateClient");
  document.getElementById("promoActivateTitle").textContent = "Selectează clientul pentru activarea promoției #" + promoId;
  document.getElementById("promoActivateNotes").value = "";
  document.getElementById("promoActivateDialog").showModal();
}

async function submitPromoActivation() {
  const clientId = getSearchableValue("promoActivateClient");
  if (!clientId) return toast("Selectează clientul", "error");
  const notes = document.getElementById("promoActivateNotes").value;
  const r = await fetch(`/api/promotions/${activePromoId}/activate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: parseInt(clientId), notes })
  });
  if (r.ok) {
    toast("Promoție activată!", "success");
    document.getElementById("promoActivateDialog").close();
    loadPromotionsList();
  } else { const d = await r.json(); toast(d.error || "Eroare", "error"); }
}

async function deletePromotion(id) {
  if (!confirm("Ștergi această promoție?")) return;
  await fetch(`/api/promotions/${id}`, { method: "DELETE" });
  loadPromotionsList();
}

/* ═══════════════════════════════════════════════════════════════
   MODULE 7: CALENDAR / PLANIFICARE RUTE
   ═══════════════════════════════════════════════════════════════ */

function loadCalendar() {
  loadAgentsList().then(() => {
    populateAgentDropdowns();
    loadBeatPlan();
  });
}

async function loadBeatPlan() {
  try {
    let url = "/api/beat-plan";
    if (currentRole !== "agent") {
      const agent = getSearchableValue("calAgent");
      if (agent) url += `?agent=${agent}`;
    }
    const r = await fetch(url);
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById("calContent");
    if (data.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:1rem">Niciun plan de rută configurat. Adaugă clienți din VIZITE.</p>';
      return;
    }
    // Group by day
    const days = ["Luni", "Marți", "Miercuri", "Joi", "Vineri", "Sâmbătă"];
    const grouped = {};
    days.forEach(d => grouped[d] = []);
    data.forEach(bp => { if (grouped[bp.day_of_week]) grouped[bp.day_of_week].push(bp); });

    el.innerHTML = days.map(day => {
      const items = grouped[day];
      if (items.length === 0) return "";
      return `<div style="margin-bottom:.8rem">
        <h4 style="font-size:.85rem;color:var(--accent);margin-bottom:.3rem">${day} (${items.length} clienți)</h4>
        ${items.map(bp => `<div class="module-card" style="padding:.4rem .6rem">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:.82rem">${esc(bp.firma || "")} — ${esc(bp.nume_poc || "")}</span>
            <button class="btn ghost small" onclick="deleteBeatPlan(${bp.id})" style="font-size:.65rem;padding:1px 4px">✕</button>
          </div>
          <div style="font-size:.72rem;color:var(--muted)">${esc(bp.oras || "")} · ${bp.visit_frequency}</div>
        </div>`).join("")}
      </div>`;
    }).join("");
  } catch (e) { toast("Eroare calendar", "error"); }
}

async function loadUnvisitedToday() {
  try {
    let url = "/api/beat-plan/unvisited";
    if (currentRole !== "agent") {
      const agent = getSearchableValue("calAgent");
      if (agent) url += `?agent=${agent}`;
    }
    const r = await fetch(url);
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById("calContent");
    if (data.unvisited.length === 0) {
      el.innerHTML = `<div class="module-card" style="border-left:3px solid var(--success)"><strong>✅ ${esc(data.day)}</strong> — Toți clienții planificați au fost vizitați! (${parseInt(data.visited)||0}/${parseInt(data.planned)||0})</div>`;
      return;
    }
    el.innerHTML = `<div class="module-card" style="border-left:3px solid var(--warning)">
      <strong>⚠ ${data.day}</strong> — ${data.unvisited.length} clienți nevizitați din ${data.planned} planificați
    </div>` + data.unvisited.map(u => `<div class="module-card" style="padding:.4rem .6rem">
      <span style="font-size:.82rem">${esc(u.firma || "")} — ${esc(u.nume_poc || "")}</span>
      <div style="font-size:.72rem;color:var(--muted)">${esc(u.oras || "")}</div>
    </div>`).join("");
  } catch (e) { toast("Eroare", "error"); }
}

async function deleteBeatPlan(id) {
  await fetch(`/api/beat-plan/${id}`, { method: "DELETE" });
  loadBeatPlan();
}

/* ═══════════════════════════════════════════════════════════════
   MODULE 8: EXPIRĂRI / FRESHNESS
   ═══════════════════════════════════════════════════════════════ */

function loadExpiry() {
  loadExpiryList();
}

function openExpiryDialog() {
  populateClientDropdown("expiryClient");
  document.getElementById("expiryDialog").showModal();
}

async function submitExpiry() {
  const client_id = getSearchableValue("expiryClient");
  const product_name = document.getElementById("expiryProduct").value.trim();
  const expiry_date = document.getElementById("expiryDate").value;
  if (!client_id) return toast("Selectează clientul", "error");
  if (!product_name) return toast("Introduceți produsul", "error");
  if (!expiry_date) return toast("Selectează data expirării", "error");
  const r = await fetch("/api/expiry", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id, product_name, expiry_date,
      batch_number: document.getElementById("expiryBatch").value,
      quantity: parseInt(document.getElementById("expiryQty").value) || 1,
      action_needed: document.getElementById("expiryAction").value,
      notes: document.getElementById("expiryNotes").value
    })
  });
  if (r.ok) {
    toast("Expirare raportată!", "success");
    document.getElementById("expiryDialog").close();
    loadExpiryList();
  } else { const d = await r.json(); toast(d.error || "Eroare", "error"); }
}

async function loadExpiryList() {
  try {
    const r = await fetch("/api/expiry");
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById("expiryList");
    if (data.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:1rem">Niciun raport de expirare</p>';
      return;
    }
    el.innerHTML = data.map(e => {
      const daysToExp = Math.round((new Date(e.expiry_date) - new Date()) / 86400000);
      const urgColor = daysToExp < 0 ? "var(--danger)" : daysToExp < 7 ? "var(--warning)" : daysToExp < 30 ? "#FF9800" : "var(--muted)";
      const statusBadge = e.status === "resolved" ? '<span style="color:var(--success)">✅ Rezolvat</span>' : e.status === "in_progress" ? '<span style="color:var(--warning)">🔄 În lucru</span>' : `<span style="color:${urgColor}">⏰ ${daysToExp < 0 ? "EXPIRAT" : daysToExp + " zile"}</span>`;
      const resolve = e.status !== "resolved" && currentRole !== "agent" ? `<button class="btn success small" onclick="resolveExpiry(${e.id})" style="font-size:.7rem;padding:2px 8px">✓ Rezolvat</button>` : "";
      return `<div class="module-card" style="${daysToExp < 0 ? "border-left:3px solid var(--danger)" : daysToExp < 7 ? "border-left:3px solid var(--warning)" : ""}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:.85rem">${esc(e.product_name)}</strong>
          ${statusBadge}
        </div>
        <div style="font-size:.8rem;margin:.2rem 0">📍 ${esc(e.firma || "")} · ${esc(e.oras || "")}</div>
        <div style="font-size:.78rem;color:var(--muted)">Expiră: ${e.expiry_date} · Cant: ${e.quantity} · Acțiune: ${e.action_needed}${e.batch_number ? ` · Lot: ${e.batch_number}` : ""}</div>
        ${e.notes ? `<p style="font-size:.78rem;margin:.2rem 0;font-style:italic">${esc(e.notes)}</p>` : ""}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:.3rem">
          <span style="font-size:.7rem;color:var(--muted)">${e.reported_by} · ${fmtDate(e.reported_at)}</span>
          ${resolve}
        </div>
      </div>`;
    }).join("");
  } catch (e) { toast("Eroare expirări", "error"); }
}

async function loadExpiryAlerts() {
  try {
    const r = await fetch("/api/expiry/alerts");
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById("expiryList");
    if (data.length === 0) {
      el.innerHTML = '<div class="module-card" style="border-left:3px solid var(--success)"><strong>✅ Nicio alertă de expirare</strong></div>';
      return;
    }
    // Reuse same render
    const mockR = { ok: true, json: () => Promise.resolve(data) };
    // Just render directly
    el.innerHTML = `<div class="module-card" style="border-left:3px solid var(--warning)"><strong>⚠ ${data.length} produse expiră în max 30 zile</strong></div>`;
    el.innerHTML += data.map(e => {
      const daysToExp = Math.round((new Date(e.expiry_date) - new Date()) / 86400000);
      const urgColor = daysToExp < 0 ? "var(--danger)" : daysToExp < 7 ? "var(--warning)" : "#FF9800";
      return `<div class="module-card" style="border-left:3px solid ${urgColor}">
        <strong style="font-size:.85rem">${esc(e.product_name)}</strong> — ${esc(e.firma || "")}
        <div style="font-size:.78rem;color:${urgColor};font-weight:600">${daysToExp < 0 ? "EXPIRAT!" : daysToExp + " zile rămase"} · ${e.expiry_date}</div>
        <div style="font-size:.75rem;color:var(--muted)">${esc(e.oras || "")} · Cant: ${e.quantity} · ${e.action_needed}</div>
      </div>`;
    }).join("");
  } catch (e) { toast("Eroare alerte", "error"); }
}

async function resolveExpiry(id) {
  await fetch(`/api/expiry/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "resolved" }) });
  loadExpiryList();
}

/* ═══════════════════════════════════════════════════════════════
   HELPER: Searchable dropdown component
   ═══════════════════════════════════════════════════════════════ */

function createSearchableDropdown(containerId, items, placeholder) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  container.className = "sd-wrap";
  const input = document.createElement("input");
  input.type = "text"; input.className = "sd-input"; input.placeholder = placeholder || "Caută...";
  input.setAttribute("autocomplete", "off");
  const hidden = document.createElement("input");
  hidden.type = "hidden"; hidden.className = "sd-value"; hidden.id = containerId + "_val";
  const list = document.createElement("div");
  list.className = "sd-list"; list.style.display = "none";
  container.appendChild(input); container.appendChild(hidden); container.appendChild(list);

  function renderItems(filter) {
    const q = (filter || "").toLowerCase().trim();
    const filtered = q ? items.filter(it => it.label.toLowerCase().includes(q) || (it.sub || "").toLowerCase().includes(q)) : items.slice(0, 50);
    if (filtered.length === 0) {
      list.innerHTML = '<div class="sd-item sd-empty">Niciun rezultat</div>';
    } else {
      list.innerHTML = filtered.slice(0, 80).map(it =>
        `<div class="sd-item" data-val="${it.value}"><span class="sd-item-label">${esc(it.label)}</span>${it.sub ? `<span class="sd-item-sub">${esc(it.sub)}</span>` : ""}</div>`
      ).join("");
    }
    list.style.display = "";
  }
  input.addEventListener("focus", () => renderItems(input.value));
  input.addEventListener("input", () => { hidden.value = ""; renderItems(input.value); });
  list.addEventListener("click", (e) => {
    const item = e.target.closest(".sd-item[data-val]");
    if (!item) return;
    hidden.value = item.dataset.val;
    input.value = item.querySelector(".sd-item-label")?.textContent || item.textContent;
    list.style.display = "none";
  });
  document.addEventListener("click", (e) => { if (!container.contains(e.target)) list.style.display = "none"; });
}

function getSearchableValue(containerId) {
  const h = document.getElementById(containerId + "_val");
  return h ? h.value : "";
}

function populateClientDropdown(containerId) {
  const clients = currentRole === "agent" ? allClients.filter(c => c.agent === currentSalesRep) : allClients;
  const items = clients.map(c => ({
    value: String(c.id),
    label: `${c.firma || ""} — ${c.nume_poc || ""}`,
    sub: `${c.oras || ""} · ${c.code || ""}`
  }));
  createSearchableDropdown(containerId, items, "Caută client (firmă, oraș, cod)...");
}

function populateAgentSearchable(containerId, placeholder) {
  const items = agentsList.map(a => ({ value: a.username, label: a.display_name, sub: a.username }));
  createSearchableDropdown(containerId, items, placeholder || "Caută agent...");
}

/* ── Date format helper (new modules) ── */
function fmtDate(d) { if (!d) return ""; try { return new Date(d).toLocaleDateString("ro-RO", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch(e) { return d; } }
function fmtDateShort(d) { if (!d) return ""; try { return new Date(d).toLocaleDateString("ro-RO", { day: "2-digit", month: "short", year: "numeric" }); } catch(e) { return d; } }

/* ═══════════════════════════════════════════════════════════════
   SECȚIUNEA CLIENȚI — MODULE NOI
   ═══════════════════════════════════════════════════════════════ */

/* ══════ 1. SCADENȚAR QUATRO ══════ */

async function uploadScadentar() {
  const fileInput = document.getElementById("scadentarFile");
  const statusEl = document.getElementById("scadentarUploadStatus");
  if (!fileInput.files.length) { toast("Selectează un fișier Excel!", "warning"); return; }
  const fd = new FormData();
  fd.append("file", fileInput.files[0]);
  statusEl.innerHTML = '<span class="spinner" style="width:16px;height:16px"></span> Se importă scadențarul...';
  try {
    const r = await fetch("/api/scadentar/upload", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    statusEl.textContent = `✅ ${d.message}`;
    toast(d.message, "success");
    fileInput.value = "";
    loadScadentar();
  } catch (ex) {
    statusEl.textContent = "❌ " + ex.message;
    toast("Eroare: " + ex.message, "error");
  }
}

function _depColor(days) {
  if (days <= 30) return '#27ae60';
  if (days <= 60) return '#f39c12';
  if (days <= 90) return '#e67e22';
  return '#e74c3c';
}
function _divColor(div) {
  const m = { BB: '#3498db', JTI: '#9b59b6', URSUS: '#e67e22', SPV: '#95a5a6', NECUNOSCUT: '#7f8c8d' };
  return m[div] || '#7f8c8d';
}

async function onScadDivChange() {
  const div = document.getElementById('scadFilterDiv').value;
  const agentSel = document.getElementById('scadFilterAgent');
  const partenerSel = document.getElementById('scadFilterPartener');
  agentSel.innerHTML = '<option value="">Toți agenții</option>';
  partenerSel.innerHTML = '<option value="">Toți partenerii</option>';
  try {
    const qs = div && div !== 'ALL' ? `?divizie=${div}` : '';
    const r = await fetch('/api/scadentar/agents' + qs);
    const d = await r.json();
    (d.agents || []).forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.agent;
      opt.textContent = `${a.agent} (${a.cnt} fact. | ${Number(a.total_rest||0).toLocaleString('ro-RO')} RON)`;
      agentSel.appendChild(opt);
    });
  } catch(e) {}
  loadScadentar();
}

async function onScadAgentChange() {
  const div = document.getElementById('scadFilterDiv').value;
  const agent = document.getElementById('scadFilterAgent').value;
  const partenerSel = document.getElementById('scadFilterPartener');
  partenerSel.innerHTML = '<option value="">Toți partenerii</option>';
  try {
    let qs = '?';
    if (agent) qs += `agent=${encodeURIComponent(agent)}&`;
    if (div && div !== 'ALL') qs += `divizie=${div}`;
    const r = await fetch('/api/scadentar/partners' + qs);
    const d = await r.json();
    (d.partners || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.partener;
      opt.textContent = `${p.partener} (${Number(p.total_rest||0).toLocaleString('ro-RO')} RON)`;
      partenerSel.appendChild(opt);
    });
  } catch(e) {}
  loadScadentar();
}

async function loadScadentar() {
  const listEl = document.getElementById("scadentarList");
  const infoEl = document.getElementById("scadentarInfo");
  const summaryEl = document.getElementById("scadentarSummary");
  const alertsEl = document.getElementById("scadentarAlerts");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';

  const div = document.getElementById("scadFilterDiv")?.value || 'ALL';
  const agent = document.getElementById("scadFilterAgent")?.value || '';
  const partener = document.getElementById("scadFilterPartener")?.value || '';
  const depRange = document.getElementById("scadFilterDepasire")?.value || '';

  let qs = `?divizie=${div}`;
  if (agent) qs += `&agent=${encodeURIComponent(agent)}`;
  if (partener) qs += `&partener=${encodeURIComponent(partener)}`;
  if (depRange === '0-30') qs += '&min_depasire=0&max_depasire=30';
  else if (depRange === '31-60') qs += '&min_depasire=31&max_depasire=60';
  else if (depRange === '61-90') qs += '&min_depasire=61&max_depasire=90';
  else if (depRange === '90+') qs += '&min_depasire=91';

  try {
    const [scadR, alertR] = await Promise.all([
      fetch('/api/scadentar' + qs),
      fetch('/api/scadentar/alerts')
    ]);
    const d = await scadR.json();
    const alerts = await alertR.json();

    if (!d.import) {
      infoEl.textContent = "Niciun scadențar încărcat";
      summaryEl.innerHTML = '';
      alertsEl.innerHTML = '';
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Încarcă un fișier Scadențar Quatro din Mentor</p>';
      return;
    }

    infoEl.textContent = `Import: ${d.import.filename} • ${d.import.import_date} • ${d.import.total_rows} facturi`;

    // Summary cards per division
    if (d.summary && d.summary.length > 0) {
      summaryEl.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.3rem">${d.summary.map(s => `
        <div style="flex:1;min-width:100px;padding:.4rem .6rem;border-radius:8px;background:var(--bg2);border-left:3px solid ${_divColor(s.divizie)}">
          <div style="font-size:.7rem;color:var(--muted)">${esc(s.divizie)}</div>
          <div style="font-size:.9rem;font-weight:700;color:${_divColor(s.divizie)}">${Number(s.total_rest).toLocaleString("ro-RO", {maximumFractionDigits:0})} lei</div>
          <div style="font-size:.68rem;color:var(--muted)">${s.cnt} fact. • med ${Math.round(s.avg_depasire)}z</div>
        </div>
      `).join('')}</div>`;
    } else { summaryEl.innerHTML = ''; }

    // Cross-division alerts
    if (alerts.length > 0 && currentRole !== 'agent') {
      alertsEl.innerHTML = `
        <details style="margin-bottom:.4rem">
          <summary style="cursor:pointer;font-size:.8rem;font-weight:600;color:#e74c3c;padding:.3rem">⚠️ ${alerts.length} clienți cu solduri în mai multe divizii</summary>
          <div style="max-height:300px;overflow-y:auto">${alerts.map(a => `
            <div class="module-card" style="border-left:3px solid #e74c3c;margin:.3rem 0;padding:.4rem .6rem">
              <strong style="font-size:.82rem">${esc(a.partener)}</strong>
              <span style="font-size:.75rem;color:var(--muted);margin-left:.5rem">${esc(a.cod_fiscal || '')}</span>
              <div style="font-size:.78rem;margin-top:.2rem">Total: <strong style="color:#e74c3c">${Number(a.total_rest).toLocaleString("ro-RO",{maximumFractionDigits:0})} lei</strong> • Max ${a.max_depasire}z</div>
              <div style="display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.2rem">${a.details.map(dd => `
                <span style="font-size:.7rem;padding:1px 6px;border-radius:4px;background:${_divColor(dd.divizie)};color:#fff">${dd.divizie}: ${Number(dd.rest_div).toLocaleString("ro-RO",{maximumFractionDigits:0})} lei (${dd.nr_facturi}f, ${dd.max_dep}z) — ${esc(dd.agent)}</span>
              `).join('')}</div>
            </div>
          `).join('')}</div>
        </details>`;
    } else { alertsEl.innerHTML = ''; }

    // Agent summary
    if (d.agentSummary && d.agentSummary.length > 0 && currentRole !== 'agent') {
      listEl.innerHTML = `
        <details open style="margin-bottom:.4rem">
          <summary style="cursor:pointer;font-size:.82rem;font-weight:600;padding:.2rem">👤 Sumar pe agenți (${d.agentSummary.length})</summary>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.3rem;margin:.3rem 0">
            ${d.agentSummary.map(a => `
              <div style="padding:.3rem .5rem;border-radius:6px;background:var(--bg2);border-left:3px solid ${_divColor(a.divizie)};cursor:pointer" onclick="document.getElementById('scadFilterDiv').value='${esc(a.divizie)}';onScadDivChange().then(()=>{document.getElementById('scadFilterAgent').value='${esc(a.agent)}';onScadAgentChange()})">
                <div style="font-size:.78rem;font-weight:600">${esc(a.agent)}</div>
                <div style="font-size:.72rem;color:var(--muted)">${a.divizie} • ${a.cnt} fact.</div>
                <div style="font-size:.82rem;font-weight:700;color:${_depColor(60)}">${Number(a.total_rest).toLocaleString("ro-RO",{maximumFractionDigits:0})} lei</div>
              </div>
            `).join('')}
          </div>
        </details>`;
    } else { listEl.innerHTML = ''; }

    // Grouped by client with expandable invoices
    if (d.data.length > 0) {
      // Group invoices by partener
      const clientMap = {};
      d.data.forEach(f => {
        const key = f.partener || 'NECUNOSCUT';
        if (!clientMap[key]) clientMap[key] = { partener: key, agent: f.agent, divizie: f.divizie, cod_fiscal: f.cod_fiscal || '', total_rest: 0, max_dep: 0, invoices: [], cifra_afaceri: f.cifra_afaceri_curent || 0 };
        clientMap[key].total_rest += (f.rest || 0);
        if (f.depasire_termen > clientMap[key].max_dep) clientMap[key].max_dep = f.depasire_termen;
        clientMap[key].invoices.push(f);
      });
      const clients = Object.values(clientMap).sort((a,b) => b.total_rest - a.total_rest);
      const totalRest = d.data.reduce((s,f) => s + f.rest, 0);

      // Warning badges
      const warn45 = clients.filter(c => c.max_dep > 45).length;
      const overLimitCnt = clients.filter(c => c.cifra_afaceri > 0 && c.total_rest > c.cifra_afaceri).length;

      listEl.innerHTML += `
        <div style="font-size:.78rem;color:var(--muted);margin:.3rem 0">
          ${clients.length} clienți • ${d.data.length} facturi • Total rest: <strong style="color:#e74c3c">${totalRest.toLocaleString("ro-RO",{maximumFractionDigits:0})} lei</strong>
          ${warn45 ? ` • <span style="color:#e67e22;font-weight:600">⚠ ${warn45} clienți > 45 zile</span>` : ''}
          ${overLimitCnt ? ` • <span style="color:#e74c3c;font-weight:600">🔴 ${overLimitCnt} peste limită credit</span>` : ''}
        </div>
        <div style="overflow-x:auto">
        <table style="width:100%;font-size:.75rem;border-collapse:collapse" id="scadClientTable">
          <thead><tr style="background:var(--bg2);position:sticky;top:0">
            <th style="padding:4px 6px;text-align:left;border-bottom:2px solid var(--border);cursor:pointer" onclick="sortScadClients('partener')">Client ▾</th>
            <th style="padding:4px 6px;text-align:right;border-bottom:2px solid var(--border);cursor:pointer" onclick="sortScadClients('total_rest')">Total Rest ▾</th>
            <th style="padding:4px 6px;text-align:right;border-bottom:2px solid var(--border);cursor:pointer" onclick="sortScadClients('cifra_afaceri')">Limită Credit ▾</th>
            <th style="padding:4px 6px;text-align:center;border-bottom:2px solid var(--border);cursor:pointer" onclick="sortScadClients('invoices')">Facturi ▾</th>
            <th style="padding:4px 6px;text-align:center;border-bottom:2px solid var(--border);cursor:pointer" onclick="sortScadClients('max_dep')">Max Zile ▾</th>
            <th style="padding:4px 6px;text-align:left;border-bottom:2px solid var(--border)">Agent</th>
            <th style="padding:4px 6px;text-align:left;border-bottom:2px solid var(--border)">Div</th>
          </tr></thead>
          <tbody>${clients.map((c, idx) => {
            const depBg = c.max_dep > 90 ? '#e74c3c' : c.max_dep > 60 ? '#e67e22' : c.max_dep > 45 ? '#f39c12' : c.max_dep > 30 ? '#f1c40f' : '#27ae60';
            const warn = c.max_dep > 45 ? '⚠️ ' : '';
            const overLimit = c.cifra_afaceri > 0 && c.total_rest > c.cifra_afaceri;
            const limitPct = c.cifra_afaceri > 0 ? Math.round(c.total_rest / c.cifra_afaceri * 100) : 0;
            const limitColor = overLimit ? '#e74c3c' : (limitPct > 80 ? '#e67e22' : '#27ae60');
            const limitText = c.cifra_afaceri > 0 ? Number(c.cifra_afaceri).toLocaleString("ro-RO",{maximumFractionDigits:0}) : '—';
            const limitBadge = c.cifra_afaceri > 0 ? (overLimit ? ' <span style="font-size:.6rem;color:#fff;background:#e74c3c;padding:0 4px;border-radius:3px">' + limitPct + '%</span>' : ' <span style="font-size:.6rem;color:#27ae60">' + limitPct + '%</span>') : '';
            return `
            <tr class="scad-client-row" style="border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s${overLimit ? ';background:#fef2f2' : ''}" onclick="toggleScadClient(${idx})" onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background='${overLimit ? '#fef2f2' : ''}'">
              <td style="padding:4px 6px;font-weight:600" title="${esc(c.partener)}${c.cod_fiscal ? ' ('+c.cod_fiscal+')' : ''}">${warn}${esc(c.partener)}</td>
              <td style="padding:4px 6px;text-align:right;font-weight:700;color:#e74c3c">${Number(c.total_rest).toLocaleString("ro-RO",{minimumFractionDigits:2})}</td>
              <td style="padding:4px 6px;text-align:right;color:${limitColor}">${limitText}${limitBadge}</td>
              <td style="padding:4px 6px;text-align:center">${c.invoices.length}</td>
              <td style="padding:4px 6px;text-align:center"><span style="background:${depBg}22;color:${depBg};padding:1px 8px;border-radius:10px;font-weight:700">${c.max_dep}</span></td>
              <td style="padding:4px 6px;font-size:.7rem">${esc(c.agent)}</td>
              <td style="padding:4px 6px"><span style="font-size:.65rem;padding:1px 4px;border-radius:3px;background:${_divColor(c.divizie)};color:#fff">${c.divizie}</span></td>
            </tr>
            <tr id="scadDetail_${idx}" style="display:none">
              <td colspan="7" style="padding:0 0 0 20px;background:var(--bg2)">
                <table style="width:100%;font-size:.72rem;border-collapse:collapse;margin:4px 0">
                  <thead><tr style="color:var(--muted)">
                    <th style="padding:2px 4px;text-align:left">Document</th>
                    <th style="padding:2px 4px;text-align:right">Valoare</th>
                    <th style="padding:2px 4px;text-align:right">Rest</th>
                    <th style="padding:2px 4px;text-align:center">Zile depășire</th>
                    <th style="padding:2px 4px;text-align:left">Serie</th>
                  </tr></thead>
                  <tbody>${c.invoices.sort((a,b) => b.depasire_termen - a.depasire_termen).map(inv => `
                    <tr style="border-bottom:1px solid var(--border)">
                      <td style="padding:2px 4px">${esc(inv.document)}</td>
                      <td style="padding:2px 4px;text-align:right">${Number(inv.valoare||0).toLocaleString("ro-RO",{minimumFractionDigits:2})}</td>
                      <td style="padding:2px 4px;text-align:right;font-weight:600;color:#e74c3c">${Number(inv.rest).toLocaleString("ro-RO",{minimumFractionDigits:2})}</td>
                      <td style="padding:2px 4px;text-align:center;color:${_depColor(inv.depasire_termen)};font-weight:600">${inv.depasire_termen}</td>
                      <td style="padding:2px 4px;font-size:.68rem;color:var(--muted)">${esc(inv.serie_document||'')}</td>
                    </tr>
                  `).join('')}</tbody>
                </table>
              </td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        </div>`;

      // Store clients data for sorting
      window._scadClients = clients;
    }
  } catch (ex) {
    listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

// Toggle expand/collapse client invoices
function toggleScadClient(idx) {
  const row = document.getElementById('scadDetail_' + idx);
  if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
}

// Sort clients table
let _scadSortField = 'total_rest';
let _scadSortDir = -1;
function sortScadClients(field) {
  if (_scadSortField === field) _scadSortDir *= -1;
  else { _scadSortField = field; _scadSortDir = -1; }
  if (window._scadClients) {
    window._scadClients.sort((a, b) => {
      let va, vb;
      if (field === 'invoices') { va = a.invoices.length; vb = b.invoices.length; }
      else if (field === 'partener') { va = a.partener.toLowerCase(); vb = b.partener.toLowerCase(); return va < vb ? -_scadSortDir : va > vb ? _scadSortDir : 0; }
      else { va = a[field] || 0; vb = b[field] || 0; }
      return (va - vb) * _scadSortDir;
    });
    loadScadentar(); // re-render
  }
}

// Keep old solduri functions as aliases (backward compat)
async function uploadSolduri() { uploadScadentar(); }
async function loadSolduri() { loadScadentar(); }

/* ══════ 2. ESCALADĂRI SPV ══════ */

const escalationDialog = document.getElementById("escalationDialog");
const escResolveDialog = document.getElementById("escResolveDialog");
let escResolveId = null;

function openEscalationDialog() {
  populateClientDropdown("escClient");
  document.getElementById("escMessage").value = "";
  escalationDialog.showModal();
}

async function submitEscalation() {
  const client_id = getSearchableValue("escClient");
  const message = document.getElementById("escMessage").value.trim();
  if (!client_id) { toast("Selectează un client!", "warning"); return; }
  const btn = document.getElementById("escSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Se trimite...';
  try {
    const r = await fetch("/api/escalations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: parseInt(client_id), message }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast("Escaladare trimisă către SPV!", "success");
    escalationDialog.close();
    loadEscalations();
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Trimite solicitare";
  }
}

async function loadEscalations() {
  const listEl = document.getElementById("escList");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';
  try {
    const r = await fetch("/api/escalations");
    const data = await r.json();
    if (data.length === 0) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Nicio escaladare</p>';
      return;
    }
    listEl.innerHTML = data.map(e => {
      const isPending = e.status === "pending";
      const elapsed = isPending ? getElapsedTime(e.created_at) : getElapsedBetween(e.created_at, e.resolved_at);
      const canResolve = isPending && currentRole !== "agent";
      return `
        <div class="module-card" style="border-left:3px solid ${isPending ? '#e74c3c' : '#27ae60'}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong style="font-size:.88rem">${esc((e.firma || "").toUpperCase())}</strong>
            <span class="chip ${isPending ? 'bad' : 'ok'}">${isPending ? '🚨 ACTIV' : '✅ Rezolvat'}</span>
          </div>
          <p style="font-size:.8rem;color:var(--muted)">${esc(e.nume_poc || "")} • ${esc(e.oras || "")} • Agent: ${esc(e.agent_name || e.agent_username)}</p>
          ${e.message ? `<p style="font-size:.82rem;margin-top:.3rem;padding:.3rem;background:var(--bg);border-radius:4px">${esc(e.message)}</p>` : ""}
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:.3rem">
            <span style="font-size:.78rem;color:var(--muted)">Creat: ${fmtDate(e.created_at)}</span>
            <span style="font-size:.82rem;font-weight:600;color:${isPending ? '#e74c3c' : 'var(--muted)'}">⏱ ${elapsed}</span>
          </div>
          ${e.resolved_by ? `<p style="font-size:.78rem;color:var(--muted)">Rezolvat de: ${esc(e.resolved_by)} la ${fmtDate(e.resolved_at)}</p>` : ""}
          ${e.checkin_photo ? `<img src="${e.checkin_photo}" style="max-width:100%;max-height:120px;border-radius:6px;margin-top:.3rem" onclick="window.open(this.src)">` : ""}
          ${canResolve ? `<button class="btn success small" style="margin-top:.4rem" onclick="openEscResolve(${e.id}, '${esc(e.firma || "")}')">📸 Check-in & Rezolvă</button>` : ""}
        </div>
      `;
    }).join("");
  } catch (ex) {
    listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

function getElapsedTime(startDate) {
  const start = new Date(startDate + (startDate.includes("Z") ? "" : "Z"));
  const now = new Date();
  const diffMs = now - start;
  const mins = Math.floor(diffMs / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}z ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

function getElapsedBetween(start, end) {
  const s = new Date(start + (start.includes("Z") ? "" : "Z"));
  const e = new Date(end + (end.includes("Z") ? "" : "Z"));
  const diffMs = e - s;
  const mins = Math.floor(diffMs / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}z ${hrs % 24}h ${mins % 60}m`;
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

function openEscResolve(id, firma) {
  escResolveId = id;
  document.getElementById("escResolveInfo").textContent = `Check-in la: ${firma}`;
  document.getElementById("escResolvePhoto").value = "";
  document.getElementById("escResolvePhotoPreview").style.display = "none";
  document.getElementById("escResolveNote").value = "";
  document.getElementById("escResolveSubmitBtn").disabled = false;
  escResolveDialog.showModal();
}

// Preview photo for escalation resolve
document.getElementById("escResolvePhoto")?.addEventListener("change", function() {
  const file = this.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = e => {
      document.getElementById("escResolvePhotoImg").src = e.target.result;
      document.getElementById("escResolvePhotoPreview").style.display = "";
    };
    reader.readAsDataURL(file);
    document.getElementById("escResolveSubmitBtn").disabled = false;
  }
});

async function submitEscResolve() {
  const photoFile = document.getElementById("escResolvePhoto").files[0];
  if (!photoFile) { toast("Trebuie să faci o poză!", "warning"); return; }
  const btn = document.getElementById("escResolveSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Se trimite...';

  // Get GPS
  let lat = null, lon = null;
  try {
    const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 }));
    lat = pos.coords.latitude;
    lon = pos.coords.longitude;
  } catch (e) { console.warn("GPS unavailable for check-in"); }

  const fd = new FormData();
  fd.append("photo", photoFile);
  if (lat) fd.append("lat", lat);
  if (lon) fd.append("lon", lon);
  fd.append("note", document.getElementById("escResolveNote").value.trim());

  try {
    const r = await fetch(`/api/escalations/${escResolveId}/resolve`, { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast("Escaladare rezolvată cu check-in!", "success");
    escResolveDialog.close();
    loadEscalations();
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
    btn.disabled = false;
    btn.textContent = "✅ Check-in & Rezolvă";
  }
}

/* ══════ 3. ALERTĂ CLIENT ══════ */

const clientAlertDialog = document.getElementById("clientAlertDialog");

function openClientAlertDialog() {
  populateClientDropdown("alertClient");
  document.getElementById("alertType").value = "shop_closure";
  document.getElementById("alertReason").value = "";
  clientAlertDialog.showModal();
}

async function submitClientAlert() {
  const client_id = getSearchableValue("alertClient");
  const alert_type = document.getElementById("alertType").value;
  const reason = document.getElementById("alertReason").value.trim();
  if (!client_id) { toast("Selectează un client!", "warning"); return; }
  if (!reason) { toast("Completează motivul!", "warning"); return; }
  const btn = document.getElementById("alertSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Se trimite...';
  try {
    const r = await fetch("/api/client-alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: parseInt(client_id), alert_type, reason }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast("Alertă trimisă către SPV!", "success");
    clientAlertDialog.close();
    loadClientAlerts();
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Trimite alertă";
  }
}

const alertTypeLabels = { shop_closure: "🏚️ Închidere magazin", suspicious_stock: "📦 Lipsă suspectă marfă", payment_issues: "💳 Probleme plată", other: "❓ Altele" };

async function loadClientAlerts() {
  const listEl = document.getElementById("alertList");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';
  try {
    const r = await fetch("/api/client-alerts");
    const data = await r.json();
    if (data.length === 0) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Nicio alertă</p>';
      return;
    }
    listEl.innerHTML = data.map(a => {
      const isPending = a.status === "pending";
      const canAck = isPending && currentRole !== "agent";
      return `
        <div class="module-card" style="border-left:3px solid ${isPending ? '#f39c12' : '#27ae60'}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong style="font-size:.88rem">${esc((a.firma || "").toUpperCase())}</strong>
            <div>
              <span style="font-size:.75rem;margin-right:4px">${alertTypeLabels[a.alert_type] || a.alert_type}</span>
              <span class="chip ${isPending ? 'warn' : 'ok'}">${isPending ? 'În așteptare' : 'Confirmat'}</span>
            </div>
          </div>
          <p style="font-size:.8rem;color:var(--muted)">${esc(a.nume_poc || "")} • ${esc(a.oras || "")} • Agent: ${esc(a.agent || "")}</p>
          <p style="font-size:.82rem;margin-top:.3rem;padding:.3rem;background:var(--bg);border-radius:4px"><strong>Motiv:</strong> ${esc(a.reason)}</p>
          <p style="font-size:.78rem;color:var(--muted);margin-top:.2rem">Raportat de: ${esc(a.reported_by)} la ${fmtDate(a.reported_at)}</p>
          ${a.acknowledged_by ? `<p style="font-size:.78rem;color:var(--muted)">Confirmat de: ${esc(a.acknowledged_by)} la ${fmtDate(a.acknowledged_at)}</p>` : ""}
          ${canAck ? `<button class="btn success small" style="margin-top:.4rem" onclick="acknowledgeAlert(${a.id})">✅ Confirm că am luat la cunoștință</button>` : ""}
        </div>
      `;
    }).join("");
  } catch (ex) {
    listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

async function acknowledgeAlert(id) {
  try {
    const r = await fetch(`/api/client-alerts/${id}/acknowledge`, { method: "POST", headers: { "Content-Type": "application/json" } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast("Alertă confirmată!", "success");
    loadClientAlerts();
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
  }
}

/* ══════ 4. RISC FINANCIAR (Coface) ══════ */

async function uploadCoface() {
  const fileInput = document.getElementById("cofaceFile");
  const statusEl = document.getElementById("cofaceUploadStatus");
  if (!fileInput.files.length) { toast("Selectează un fișier Excel!", "warning"); return; }
  const fd = new FormData();
  fd.append("file", fileInput.files[0]);
  statusEl.innerHTML = '<span class="spinner" style="width:16px;height:16px"></span> Se importă...';
  try {
    const r = await fetch("/api/financial-risk/upload", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    statusEl.textContent = `✅ ${d.message}`;
    toast(d.message, "success");
    fileInput.value = "";
    loadFinancialRisk();
  } catch (ex) {
    statusEl.textContent = "❌ " + ex.message;
    toast("Eroare: " + ex.message, "error");
  }
}

async function loadFinancialRisk() {
  const listEl = document.getElementById("riscList");
  const infoEl = document.getElementById("riscInfo");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';
  try {
    const r = await fetch("/api/financial-risk");
    const d = await r.json();
    if (!d.data || d.data.length === 0) {
      infoEl.textContent = d.upload_date ? `Ultimul upload: ${fmtDateShort(d.upload_date)} — Niciun client cu risc` : "Niciun raport Coface încărcat";
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Niciun client cu risc financiar</p>';
      return;
    }
    infoEl.textContent = `Ultimul upload: ${fmtDateShort(d.upload_date)} — ${d.data.length} clienți cu risc`;
    listEl.innerHTML = d.data.map(fr => `
      <div class="module-card" style="border-left:3px solid #e74c3c">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:.88rem">${esc(fr.client_name || fr.client_code)}</strong>
          <span class="chip bad">${esc(fr.risk_score || "RISC")}</span>
        </div>
        <p style="font-size:.8rem;color:var(--muted)">CUI/Cod: ${esc(fr.client_code)}</p>
        ${fr.risk_details ? `<p style="font-size:.82rem;margin-top:.2rem;padding:.3rem;background:var(--bg);border-radius:4px">${esc(fr.risk_details)}</p>` : ""}
      </div>
    `).join("");
  } catch (ex) {
    listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

/* ══════ 5. VERIFICARE CUI ══════ */

const cuiDialog = document.getElementById("cuiDialog");

function openCuiDialog() {
  populateClientDropdown("cuiClient");
  document.getElementById("cuiInput").value = "";
  document.getElementById("cuiLookupResult").style.display = "none";
  document.getElementById("cuiCompanyName").value = "";
  document.getElementById("cuiAddress").value = "";
  document.getElementById("cuiAdmin").value = "";
  document.getElementById("cuiGuarantor").value = "";
  document.getElementById("cuiPhone").value = "";
  document.getElementById("cuiEmail").value = "";
  document.getElementById("cuiIdSeries").value = "";
  document.getElementById("cuiIdNumber").value = "";
  document.getElementById("cuiGdpr").checked = false;
  cuiDialog.showModal();
}

async function lookupCui() {
  const cui = document.getElementById("cuiInput").value.trim();
  if (!cui) { toast("Introdu un CUI!", "warning"); return; }
  const resultEl = document.getElementById("cuiLookupResult");
  resultEl.style.display = "";
  resultEl.innerHTML = '<span class="spinner" style="width:16px;height:16px"></span> Se verifică în baza ANAF...';
  try {
    const r = await fetch(`/api/cui-lookup/${encodeURIComponent(cui)}`, { method: "POST" });
    const d = await r.json();
    if (d.ok) {
      resultEl.innerHTML = `<div style="color:#27ae60">✅ <strong>${esc(d.name)}</strong><br>${esc(d.address)}<br>Status: ${esc(d.status)}</div>`;
      // Auto-fill fields
      document.getElementById("cuiCompanyName").value = d.name || "";
      document.getElementById("cuiAddress").value = d.address || "";
      if (d.phone) document.getElementById("cuiPhone").value = d.phone;
    } else {
      resultEl.innerHTML = `<span style="color:#e74c3c">❌ ${esc(d.error)}</span>`;
    }
  } catch (ex) {
    resultEl.innerHTML = `<span style="color:#e74c3c">❌ Eroare: ${esc(ex.message)}</span>`;
  }
}

async function submitCuiVerification() {
  const cui = document.getElementById("cuiInput").value.trim();
  if (!cui) { toast("Introdu un CUI!", "warning"); return; }
  const client_id = getSearchableValue("cuiClient");
  const btn = document.getElementById("cuiSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Se salvează...';
  try {
    const body = {
      client_id: client_id ? parseInt(client_id) : null,
      cui,
      company_name: document.getElementById("cuiCompanyName").value.trim(),
      address: document.getElementById("cuiAddress").value.trim(),
      administrator: document.getElementById("cuiAdmin").value.trim(),
      guarantor: document.getElementById("cuiGuarantor").value.trim(),
      phone: document.getElementById("cuiPhone").value.trim(),
      id_series: document.getElementById("cuiIdSeries").value.trim(),
      id_number: document.getElementById("cuiIdNumber").value.trim(),
      email: document.getElementById("cuiEmail").value.trim(),
      gdpr_accepted: document.getElementById("cuiGdpr").checked
    };
    const r = await fetch("/api/cui-verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast("Verificare CUI salvată!", "success");
    cuiDialog.close();
    loadCuiVerifications();
  } catch (ex) {
    toast("Eroare: " + ex.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 Salvează verificare";
  }
}

async function loadCuiVerifications() {
  const listEl = document.getElementById("cuiList");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';
  try {
    const r = await fetch("/api/cui-verify");
    const data = await r.json();
    if (data.length === 0) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Nicio verificare CUI</p>';
      return;
    }
    listEl.innerHTML = data.map(v => `
      <div class="module-card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:.88rem">${esc(v.company_name || v.cui)}</strong>
          <span class="chip ${v.gdpr_accepted ? 'ok' : 'warn'}">${v.gdpr_accepted ? '✅ GDPR' : '⚠ Fără GDPR'}</span>
        </div>
        <p style="font-size:.8rem;color:var(--muted)">CUI: ${esc(v.cui)} ${v.firma ? `• Client: ${esc(v.firma)}` : ""}</p>
        ${v.administrator ? `<p style="font-size:.82rem">Admin: ${esc(v.administrator)} ${v.guarantor ? `• Girant: ${esc(v.guarantor)}` : ""}</p>` : ""}
        ${v.phone || v.email ? `<p style="font-size:.82rem">${v.phone ? `Tel: ${esc(v.phone)}` : ""} ${v.email ? `• Email: ${esc(v.email)}` : ""}</p>` : ""}
        ${v.id_series || v.id_number ? `<p style="font-size:.82rem">CI: ${esc(v.id_series)} ${esc(v.id_number)}</p>` : ""}
        <p style="font-size:.78rem;color:var(--muted);margin-top:.2rem">Verificat de: ${esc(v.verified_by)} la ${fmtDate(v.verified_at)}</p>
      </div>
    `).join("");
  } catch (ex) {
    listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

/* ═══ END SECȚIUNEA CLIENȚI ═══ */

/* ═══════════════════════════════════════════
   SECȚIUNEA PERFORMANȚĂ
   ═══════════════════════════════════════════ */

/* ── 1. PERFORMANȚĂ TARGETE ── */
async function uploadProducerTargets() {
  const fileEl = document.getElementById("perfTargeteFile");
  const monthEl = document.getElementById("perfTargeteMonth");
  const statusEl = document.getElementById("perfTargeteUploadStatus");
  if (!fileEl.files[0]) return toast("Selectează fișier Excel", "warn");
  statusEl.textContent = "Se importă...";
  const fd = new FormData();
  fd.append("file", fileEl.files[0]);
  fd.append("month", monthEl.value || new Date().toISOString().slice(0, 7));
  fd.append("producer", document.getElementById("perfProducer").value || "BB");
  try {
    const r = await fetch("/api/producer-targets/upload", { method: "POST", body: fd });
    const d = await r.json();
    if (d.ok) { statusEl.textContent = `✅ ${d.count} targete importate (${d.producer})`; toast(`${d.count} targete importate`, "ok"); loadPerfTargete(); }
    else statusEl.textContent = `❌ ${d.error}`;
  } catch (ex) { statusEl.textContent = `❌ ${ex.message}`; }
}

async function loadPerfTargete() {
  const monthEl = document.getElementById("perfTargeteMonth");
  if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  const listEl = document.getElementById("perfTargeteList");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';
  try {
    const r = await fetch(`/api/producer-targets?month=${monthEl.value}`);
    const d = await r.json();
    if (!d.targets || d.targets.length === 0) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Niciun target pentru această lună</p>';
      return;
    }
    // Group by producer
    const byProd = {};
    d.targets.forEach(t => { if (!byProd[t.producer]) byProd[t.producer] = []; byProd[t.producer].push(t); });
    let html = '';
    for (const [prod, targets] of Object.entries(byProd)) {
      const totalVal = targets.reduce((s, t) => s + t.target_val, 0);
      const totalHl = targets.reduce((s, t) => s + t.target_hl, 0);
      html += `<div style="margin-bottom:.5rem"><strong style="font-size:.85rem;color:var(--accent)">${esc(prod)}</strong> — Total: ${fmtNum(totalVal)} RON | ${fmtNum(totalHl)} HL</div>`;
      html += targets.map(t => `
        <div class="module-card" style="border-left-color:var(--accent)">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong style="font-size:.85rem">${esc(t.agent_name)}</strong>
            <span style="font-size:.82rem;font-weight:600;color:var(--accent)">${fmtNum(t.target_val)} RON</span>
          </div>
          <p style="font-size:.8rem;color:var(--muted)">HL: ${fmtNum(t.target_hl)} | Clienți: ${t.target_clienti || 0}</p>
        </div>
      `).join("");
    }
    listEl.innerHTML = html;
  } catch (ex) { listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`; }
}

/* ── 2. RANKING AGENȚI ── */
async function computeRankings() {
  const monthEl = document.getElementById("rankingMonth");
  if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  try {
    const r = await fetch("/api/rankings/compute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: monthEl.value }) });
    const d = await r.json();
    if (d.ok) { toast(`Ranking calculat: ${d.count} agenți`, "ok"); loadRankings(); }
    else toast(d.error, "warn");
  } catch (ex) { toast("Eroare: " + ex.message, "warn"); }
}

async function loadRankings() {
  const monthEl = document.getElementById("rankingMonth");
  if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  const listEl = document.getElementById("rankingList");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';
  try {
    const r = await fetch(`/api/rankings?month=${monthEl.value}`);
    const d = await r.json();
    if (!d.rankings || d.rankings.length === 0) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Niciun ranking calculat</p>';
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    listEl.innerHTML = d.rankings.map((r, i) => {
      const medal = i < 3 ? medals[i] : `#${r.rank_position}`;
      const scoreColor = r.total_score >= 80 ? '#27ae60' : r.total_score >= 50 ? '#f39c12' : '#e74c3c';
      return `
        <div class="module-card" style="border-left-color:${scoreColor}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong style="font-size:.9rem">${medal} ${esc(r.agent_name)}</strong>
            <span style="font-size:1rem;font-weight:700;color:${scoreColor}">${r.total_score}p</span>
          </div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.3rem;font-size:.78rem;color:var(--muted)">
            <span>Val: ${r.kpi_val_pct}%</span>
            <span>HL: ${r.kpi_hl_pct}%</span>
            <span>Clienți: ${r.kpi_clienti_pct}%</span>
            <span>Vizite: ${r.kpi_visits}</span>
            <span>Audit: ${r.kpi_audit_score}</span>
          </div>
        </div>
      `;
    }).join("");
  } catch (ex) { listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`; }
}

/* ── 3. CONTROL DISCOUNTURI ── */
async function uploadDiscounts() {
  const fileEl = document.getElementById("discountFile");
  const monthEl = document.getElementById("discountMonth");
  const statusEl = document.getElementById("discountUploadStatus");
  if (!fileEl.files[0]) return toast("Selectează fișier Excel", "warn");
  statusEl.textContent = "Se importă...";
  const fd = new FormData();
  fd.append("file", fileEl.files[0]);
  fd.append("month", monthEl.value || new Date().toISOString().slice(0, 7));
  try {
    const r = await fetch("/api/discounts/upload", { method: "POST", body: fd });
    const d = await r.json();
    if (d.ok) { statusEl.textContent = `✅ ${d.count} înregistrări importate`; toast(`${d.count} discounturi importate`, "ok"); loadDiscounts(); }
    else statusEl.textContent = `❌ ${d.error}`;
  } catch (ex) { statusEl.textContent = `❌ ${ex.message}`; }
}

async function loadDiscounts() {
  const monthEl = document.getElementById("discountMonth");
  if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  const listEl = document.getElementById("discountList");
  const summaryEl = document.getElementById("discountSummary");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';
  try {
    const r = await fetch(`/api/discounts?month=${monthEl.value}`);
    const d = await r.json();
    if (!d.alerts || d.alerts.length === 0) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Nicio alertă discount</p>';
      summaryEl.innerHTML = '';
      return;
    }
    // Summary
    if (d.summary && d.summary.length > 0) {
      summaryEl.innerHTML = '<strong style="font-size:.82rem">Pierderi per agent:</strong> ' + d.summary.map(s => `<span style="font-size:.8rem">${esc(s.agent)}: <b style="color:#e74c3c">${fmtNum(s.total)} RON</b> (${s.cnt} art.)</span>`).join(" | ");
    }
    listEl.innerHTML = d.alerts.map(a => `
      <div class="module-card" style="border-left-color:#e74c3c">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:.85rem">${esc(a.client_name || a.client_code)}</strong>
          <span style="font-size:.82rem;font-weight:600;color:#e74c3c">-${fmtNum(a.total_loss)} RON</span>
        </div>
        <p style="font-size:.82rem">${esc(a.product)}</p>
        <p style="font-size:.78rem;color:var(--muted)">Agent: ${esc(a.agent)} | Preț: ${fmtNum(a.list_price)} → ${fmtNum(a.sold_price)} (-${a.discount_pct}%) | Cant: ${a.quantity}</p>
      </div>
    `).join("");
  } catch (ex) { listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`; }
}

/* ═══════════════════════════════════════════
   SECȚIUNEA CONTRACTE
   ═══════════════════════════════════════════ */

function openContractDialog() {
  const dlg = document.getElementById("contractDialog");
  // Reset fields
  ["contractCui","contractCompanyName","contractAddress","contractOrc","contractAdmin","contractGuarantor","contractGuarantorAddress","contractPhone","contractEmail","contractIdSeries","contractIdNumber"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  document.getElementById("contractDate").value = new Date().toISOString().slice(0, 10);
  document.getElementById("contractGdpr").checked = false;
  document.getElementById("contractLookupResult").style.display = "none";
  // Searchable dropdown
  const clientWrap = document.getElementById("contractClient");
  clientWrap.innerHTML = "";
  const options = (allClients || []).map(c => ({ value: c.id, label: `${c.firma || ""} — ${c.code || ""} (${c.oras || ""})` }));
  createSearchableDropdown(clientWrap, options, "contractClientSelect", "Selectează client...");
  dlg.showModal();
}

async function lookupContractCui() {
  const cuiRaw = document.getElementById("contractCui").value.trim().replace(/^RO/i, "");
  if (!cuiRaw) return toast("Introdu CUI", "warn");
  const resEl = document.getElementById("contractLookupResult");
  resEl.style.display = "";
  resEl.innerHTML = '<span class="spinner" style="width:16px;height:16px"></span> Se verifică...';
  try {
    const r = await fetch(`/api/cui-lookup/${cuiRaw}`, { method: "POST" });
    const d = await r.json();
    if (d.ok) {
      resEl.innerHTML = `<span style="color:#27ae60">✅ ${esc(d.name)}</span><br><span style="font-size:.78rem">${esc(d.address)}</span>`;
      document.getElementById("contractCompanyName").value = d.name || "";
      document.getElementById("contractAddress").value = d.address || "";
    } else {
      resEl.innerHTML = `<span style="color:#e74c3c">❌ ${esc(d.error)}</span>`;
    }
  } catch (ex) { resEl.innerHTML = `<span style="color:#e74c3c">Eroare: ${esc(ex.message)}</span>`; }
}

async function submitContract() {
  const cui = document.getElementById("contractCui").value.trim();
  if (!cui) return toast("CUI obligatoriu", "warn");
  const btn = document.getElementById("contractSubmitBtn");
  btn.disabled = true;
  try {
    const body = {
      client_id: getSearchableValue("contractClientSelect") || null,
      cui,
      company_name: document.getElementById("contractCompanyName").value,
      address: document.getElementById("contractAddress").value,
      orc_number: document.getElementById("contractOrc").value,
      administrator: document.getElementById("contractAdmin").value,
      guarantor: document.getElementById("contractGuarantor").value,
      guarantor_address: document.getElementById("contractGuarantorAddress").value,
      phone: document.getElementById("contractPhone").value,
      id_series: document.getElementById("contractIdSeries").value,
      id_number: document.getElementById("contractIdNumber").value,
      email: document.getElementById("contractEmail").value,
      contract_date: document.getElementById("contractDate").value,
      gdpr_accepted: document.getElementById("contractGdpr").checked
    };
    const r = await fetch("/api/contracts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) { toast("Contract salvat", "ok"); document.getElementById("contractDialog").close(); loadContracts(); }
    else toast(d.error, "warn");
  } catch (ex) { toast("Eroare: " + ex.message, "warn"); }
  btn.disabled = false;
}

async function loadContracts() {
  const listEl = document.getElementById("contractList");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';
  try {
    const r = await fetch("/api/contracts");
    const data = await r.json();
    if (data.length === 0) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Niciun contract</p>';
      return;
    }
    listEl.innerHTML = data.map(c => `
      <div class="module-card" style="border-left-color:#3498db">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:.85rem">${esc(c.company_name || c.cui)}</strong>
          <span class="chip ${c.gdpr_accepted ? 'ok' : 'warn'}">${c.gdpr_accepted ? '✅ GDPR' : '⚠ Fără GDPR'}</span>
        </div>
        <p style="font-size:.8rem;color:var(--muted)">CUI: ${esc(c.cui)} ${c.firma ? `• Client: ${esc(c.firma)}` : ""} ${c.client_code ? `(${esc(c.client_code)})` : ""}</p>
        ${c.administrator ? `<p style="font-size:.82rem">Admin: ${esc(c.administrator)} ${c.guarantor ? `• Girant: ${esc(c.guarantor)}` : ""}</p>` : ""}
        ${c.phone || c.email ? `<p style="font-size:.82rem">${c.phone ? `Tel: ${esc(c.phone)}` : ""} ${c.email ? `• Email: ${esc(c.email)}` : ""}</p>` : ""}
        <p style="font-size:.78rem;color:var(--muted);margin-top:.2rem">Data contract: ${c.contract_date || "-"} | Creat de: ${esc(c.created_by)} la ${fmtDate(c.created_at)}</p>
        <div style="display:flex;gap:.4rem;margin-top:.4rem;flex-wrap:wrap">
          <a href="/api/contracts/${c.id}/download-contract" class="btn primary small" style="text-decoration:none;font-size:.78rem" download>📄 Contract Vânzare-Cumpărare B2B</a>
          <a href="/api/contracts/${c.id}/download-gdpr" class="btn success small" style="text-decoration:none;font-size:.78rem" download>🔒 Acord GDPR</a>
        </div>
      </div>
    `).join("");
  } catch (ex) { listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`; }
}

/* ═══════════════════════════════════════════
   SECȚIUNEA OBIECTIVE LUNARE
   ═══════════════════════════════════════════ */

async function computeSmartTargets() {
  const monthEl = document.getElementById("smartMonth");
  if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  const seasonal = parseFloat(document.getElementById("smartSeasonal").value) || 1.0;
  const growth = parseFloat(document.getElementById("smartGrowth").value) || 1.0;
  try {
    const r = await fetch("/api/smart-targets/compute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: monthEl.value, seasonal_coeff: seasonal, growth_coeff: growth }) });
    const d = await r.json();
    if (d.ok) { toast(`Targete calculate: ${d.count} agenți`, "ok"); loadSmartTargets(); }
    else toast(d.error, "warn");
  } catch (ex) { toast("Eroare: " + ex.message, "warn"); }
}

async function loadSmartTargets() {
  const monthEl = document.getElementById("smartMonth");
  if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  const listEl = document.getElementById("smartTargetList");
  const totalEl = document.getElementById("smartTotalInfo");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';
  try {
    const r = await fetch(`/api/smart-targets?month=${monthEl.value}`);
    const d = await r.json();
    if (!d.targets || d.targets.length === 0) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Niciun target setat</p>';
      totalEl.innerHTML = '';
      return;
    }
    // SPV total
    if (d.spv_total) {
      totalEl.innerHTML = `<strong>Total SPV:</strong> ${fmtNum(d.spv_total.final_target_val)} RON | ${fmtNum(d.spv_total.computed_target_hl)} HL | ${parseInt(d.spv_total.computed_target_clienti)||0} clienți`;
    }
    listEl.innerHTML = d.targets.map(t => `
      <div class="module-card" style="border-left-color:#8e44ad">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:.85rem">${esc(t.agent_name)}</strong>
          <span style="font-size:.88rem;font-weight:700;color:#8e44ad">${fmtNum(t.final_target_val)} RON</span>
        </div>
        <div style="display:flex;gap:.8rem;flex-wrap:wrap;font-size:.78rem;color:var(--muted);margin-top:.3rem">
          <span>An prec: ${fmtNum(t.prev_year_val)}</span>
          <span>Luna prec: ${fmtNum(t.prev_month_val)}</span>
          <span>Producător: ${fmtNum(t.producer_target)}</span>
        </div>
        <div style="display:flex;gap:.8rem;flex-wrap:wrap;font-size:.78rem;margin-top:.2rem">
          <span>Sezon: ×${t.seasonal_coeff}</span>
          <span>Creștere: ×${t.growth_coeff}</span>
          <span>HL: ${fmtNum(t.computed_target_hl)}</span>
          <span>Clienți: ${t.computed_target_clienti}</span>
        </div>
        ${t.notes ? `<p style="font-size:.78rem;color:var(--muted);margin-top:.2rem">📝 ${esc(t.notes)}</p>` : ""}
      </div>
    `).join("");
  } catch (ex) { listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`; }
}

/* ═══════════════════════════════════════════
   SECȚIUNEA BUGETE PROMO
   ═══════════════════════════════════════════ */

async function uploadPromoBudgets() {
  const fileEl = document.getElementById("promoBudgetFile");
  const monthEl = document.getElementById("promoBudgetMonth");
  const statusEl = document.getElementById("promoBudgetUploadStatus");
  if (!fileEl.files[0]) return toast("Selectează fișier Excel", "warn");
  statusEl.textContent = "Se importă...";
  const fd = new FormData();
  fd.append("file", fileEl.files[0]);
  fd.append("month", monthEl.value || new Date().toISOString().slice(0, 7));
  try {
    const r = await fetch("/api/promo-budgets/upload", { method: "POST", body: fd });
    const d = await r.json();
    if (d.ok) { statusEl.textContent = `✅ ${d.count} bugete importate`; toast(`${d.count} bugete importate`, "ok"); loadPromoBudgets(); }
    else statusEl.textContent = `❌ ${d.error}`;
  } catch (ex) { statusEl.textContent = `❌ ${ex.message}`; }
}

async function loadPromoBudgets() {
  const monthEl = document.getElementById("promoBudgetMonth");
  if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  const listEl = document.getElementById("promoBudgetList");
  const summaryEl = document.getElementById("promoBudgetSummary");
  listEl.innerHTML = '<div style="text-align:center;padding:1rem"><span class="spinner"></span></div>';
  try {
    const r = await fetch(`/api/promo-budgets?month=${monthEl.value}`);
    const d = await r.json();
    if (!d.budgets || d.budgets.length === 0) {
      listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Niciun buget promo</p>';
      summaryEl.innerHTML = '';
      return;
    }
    // Summary per promo
    if (d.summary && d.summary.length > 0) {
      summaryEl.innerHTML = d.summary.map(s => {
        const pct = s.total_budget > 0 ? Math.round((s.spent / s.total_budget) * 100) : 0;
        const color = pct > 100 ? '#e74c3c' : pct > 80 ? '#f39c12' : '#27ae60';
        return `<div style="margin-bottom:.3rem"><strong>${esc(s.promo_name)}</strong>: Buget <b>${fmtNum(s.total_budget)}</b> | Alocat <b>${fmtNum(s.allocated)}</b> | Cheltuit <b style="color:${color}">${fmtNum(s.spent)}</b> (${pct}%) | ${s.agents} agenți</div>`;
      }).join("");
    }
    // Group by promo
    const byPromo = {};
    d.budgets.forEach(b => { if (!byPromo[b.promo_name]) byPromo[b.promo_name] = []; byPromo[b.promo_name].push(b); });
    let html = '';
    for (const [promo, items] of Object.entries(byPromo)) {
      html += `<div style="margin:.5rem 0 .3rem"><strong style="font-size:.85rem;color:var(--accent)">${esc(promo)}</strong></div>`;
      html += items.filter(b => b.agent).map(b => {
        const pct = b.agent_budget > 0 ? Math.round((b.agent_spent / b.agent_budget) * 100) : 0;
        const color = pct > 100 ? '#e74c3c' : pct > 80 ? '#f39c12' : '#27ae60';
        const barWidth = Math.min(pct, 100);
        return `
          <div class="module-card" style="border-left-color:${color}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong style="font-size:.82rem">${esc(b.agent)}</strong>
              <span style="font-size:.82rem;font-weight:600;color:${color}">${pct}%</span>
            </div>
            <div style="background:var(--bg);border-radius:4px;height:6px;margin:.3rem 0;overflow:hidden">
              <div style="width:${barWidth}%;height:100%;background:${color};border-radius:4px;transition:width .3s"></div>
            </div>
            <p style="font-size:.78rem;color:var(--muted)">Buget: ${fmtNum(b.agent_budget)} RON | Cheltuit: ${fmtNum(b.agent_spent)} RON</p>
          </div>
        `;
      }).join("");
    }
    listEl.innerHTML = html;
  } catch (ex) { listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`; }
}

/* ── Helper: format number with thousands separator ── */
function fmtNum(n) {
  if (n == null || isNaN(n)) return "0";
  return Number(n).toLocaleString("ro-RO", { maximumFractionDigits: 2 });
}

/* ═══════════════════════════════════════════════════════════════
   NOTIFICATIONS SYSTEM (bell + panel + polling)
   ═══════════════════════════════════════════════════════════════ */

let notifOpen = false;

function toggleNotifPanel() {
  const panel = document.getElementById("notifPanel");
  notifOpen = !notifOpen;
  panel.style.display = notifOpen ? "block" : "none";
  if (notifOpen) loadNotifications();
}

async function loadNotifications() {
  try {
    const r = await fetch("/api/notifications");
    if (!r.ok) return;
    const d = await r.json();
    // Badge
    const badge = document.getElementById("notifBadge");
    if (d.unread_count > 0) {
      badge.textContent = d.unread_count > 99 ? "99+" : d.unread_count;
      badge.style.display = "inline-block";
    } else {
      badge.style.display = "none";
    }
    // List
    const list = document.getElementById("notifList");
    if (!d.notifications || d.notifications.length === 0) {
      list.innerHTML = '<p style="padding:.8rem;color:var(--muted);text-align:center;font-size:.8rem">Nicio notificare</p>';
      return;
    }
    list.innerHTML = d.notifications.map(n => {
      const cls = n.is_read ? "notif-item" : "notif-item unread";
      const icon = n.type === "warning" ? "⚠️" : n.type === "success" ? "✅" : n.type === "error" ? "❌" : "ℹ️";
      const ago = timeAgo(n.created_at);
      return `<div class="${cls}" onclick="readNotif(${n.id},'${esc(n.link_tab || "")}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <strong style="font-size:.8rem">${icon} ${esc(n.title)}</strong>
          <span style="font-size:.68rem;color:var(--muted);white-space:nowrap;margin-left:.5rem">${ago}</span>
        </div>
        ${n.message ? `<p style="margin:.2rem 0 0;font-size:.76rem;color:var(--muted)">${esc(n.message)}</p>` : ""}
      </div>`;
    }).join("");
  } catch (e) { console.error("Notif load error:", e); }
}

async function readNotif(id, linkTab) {
  try { await fetch(`/api/notifications/${id}/read`, { method: "POST" }); } catch(e) {}
  if (linkTab) {
    notifOpen = false;
    document.getElementById("notifPanel").style.display = "none";
    selectTab(linkTab, tabLabels[linkTab] || linkTab.toUpperCase());
  }
  loadNotifications();
}

async function markAllNotifRead() {
  try { await fetch("/api/notifications/read-all", { method: "POST" }); } catch(e) {}
  loadNotifications();
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = (Date.now() - new Date(dateStr + "Z").getTime()) / 1000;
  if (diff < 60) return "acum";
  if (diff < 3600) return Math.floor(diff / 60) + " min";
  if (diff < 86400) return Math.floor(diff / 3600) + " ore";
  return Math.floor(diff / 86400) + " zile";
}

// Poll notifications every 60 seconds
setInterval(() => {
  if (currentUsername) {
    fetch("/api/notifications").then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return;
      const badge = document.getElementById("notifBadge");
      if (d.unread_count > 0) {
        badge.textContent = d.unread_count > 99 ? "99+" : d.unread_count;
        badge.style.display = "inline-block";
      } else {
        badge.style.display = "none";
      }
    }).catch(() => {});
  }
}, 60000);

// Close notif panel on outside click
document.addEventListener("click", function(e) {
  if (notifOpen) {
    const bell = document.getElementById("notifBellBtn");
    const panel = document.getElementById("notifPanel");
    if (bell && panel && !bell.contains(e.target) && !panel.contains(e.target)) {
      notifOpen = false;
      panel.style.display = "none";
    }
  }
});

/* ═══════════════════════════════════════════════════════════════
   WHAT'S NEW / CHANGELOG POPUP
   ═══════════════════════════════════════════════════════════════ */

async function showWhatsNew(previousLogin) {
  try {
    let url = "/api/changelog";
    if (previousLogin) url += `?since=${encodeURIComponent(previousLogin)}`;
    const r = await fetch(url);
    if (!r.ok) return;
    const entries = await r.json();
    if (!entries || entries.length === 0) return;

    const body = document.getElementById("whatsNewBody");
    body.innerHTML = entries.map(e => {
      const typeIcon = e.change_type === "feature" ? "🆕" : e.change_type === "fix" ? "🔧" : e.change_type === "improvement" ? "⬆️" : "📋";
      return `<div style="margin-bottom:.6rem;padding:.4rem .5rem;background:var(--bg);border-radius:6px;border-left:3px solid var(--accent)">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:.82rem">${typeIcon} ${esc(e.title)}</strong>
          <span style="font-size:.68rem;color:var(--muted)">${e.version} · ${e.change_date}</span>
        </div>
        ${e.description ? `<p style="margin:.2rem 0 0;font-size:.78rem;color:var(--text)">${esc(e.description)}</p>` : ""}
        ${e.module ? `<span style="font-size:.68rem;color:var(--muted);background:var(--bg2);padding:1px 6px;border-radius:3px;display:inline-block;margin-top:.2rem">${esc(e.module)}</span>` : ""}
      </div>`;
    }).join("");
    document.getElementById("whatsNewOverlay").style.display = "flex";
  } catch (e) { console.error("Changelog error:", e); }
}

function closeWhatsNew() {
  document.getElementById("whatsNewOverlay").style.display = "none";
}

/* ═══════════════════════════════════════════════════════════════
   HELP SYSTEM (?) buttons on each module
   ═══════════════════════════════════════════════════════════════ */

const helpTexts = {
  census: { title: "Census Clienți", body: `<div class="help-section"><h4>Descriere</h4><p>Vizualizare completă a bazei de clienți cu filtre multiple (agent, oraș, canal, format, stare) și afișare pe hartă. Folosește filtrele din stânga pentru a restrânge rezultatele.</p></div><div class="help-section"><h4>Funcții</h4><p>Căutare client după firmă, cod sau oraș. Filtrare multi-criteriu. Click pe client = navigare pe hartă. Popup cu detalii complete.</p></div>` },
  audit: { title: "Audit", body: `<div class="help-section"><h4>Descriere</h4><p>Sistem de audit vizite la clienți. Permite deschiderea unui audit cu foto + GPS, completarea cu produse, și închiderea cu raport final.</p></div><div class="help-section"><h4>Pași</h4><p>1. Selectează client → 2. Deschide audit (foto + GPS) → 3. Adaugă produse → 4. Închide auditul.</p></div>` },
  obiective: { title: "Obiective", body: `<div class="help-section"><h4>Descriere</h4><p>Upload și monitorizare obiective lunare per agent. Admin/SPV încarcă fișierul Excel cu targeturi, agenții văd progresul lor.</p></div>` },
  incasari: { title: "Încasări", body: `<div class="help-section"><h4>Descriere</h4><p>Evidență încasări pe teren. Agentul raportează suma încasată, metoda de plată, și atașează dovadă foto dacă e cazul.</p></div>` },
  vizite: { title: "Vizite", body: `<div class="help-section"><h4>Descriere</h4><p>Panoul principal de lucru. Agentul deschide vizita → completează produse → adaugă note → închide vizita cu foto/GPS.</p></div><div class="help-section"><h4>Sfat</h4><p>Folosește butonul 🗺 Traseu din header pentru a selecta mai mulți clienți și genera o rută Google Maps.</p></div>` },
  reports: { title: "Rapoarte", body: `<div class="help-section"><h4>Descriere</h4><p>Generare rapoarte zilnice/lunare: livrări per agent, performanță, audit summary. Datele sunt în HL (hectolitri) și RON.</p></div>` },
  comunicare: { title: "Comunicare", body: `<div class="help-section"><h4>Descriere</h4><p>Anunțuri interne. SPV/Admin creează anunțuri vizibile tuturor sau specific agenților. Se pot atașa fișiere.</p></div>` },
  taskuri: { title: "Taskuri", body: `<div class="help-section"><h4>Descriere</h4><p>Sistem de task-uri cu asignare, deadline, și status. SPV/Admin creează taskuri, agenții le marchează completate.</p></div>` },
  gps: { title: "GPS Tracking", body: `<div class="help-section"><h4>Descriere</h4><p>Urmărire GPS agenți în timp real. Doar admin poate vedea poziția fiecărui agent pe hartă. Agenții trimit automat poziția.</p></div>` },
  competitie: { title: "Competiție", body: `<div class="help-section"><h4>Descriere</h4><p>Raportare produse competitoare găsite la client. Agent fotografiază și notează detalii despre produse concurente.</p></div>` },
  frigider: { title: "Frigider", body: `<div class="help-section"><h4>Descriere</h4><p>Audit frigidere Ursus. Verifică starea, curățenia, brandul, poziția produselor și conformitatea cu standardele.</p></div>` },
  promotii: { title: "Promoții", body: `<div class="help-section"><h4>Descriere</h4><p>Gestionare promoții active. SPV/Admin creează promoția cu perioada și detaliile. Agenții confirmă implementarea la client.</p></div>` },
  calendar: { title: "Calendar / Planificare", body: `<div class="help-section"><h4>Descriere</h4><p>Calendar vizual cu grid lunar. Selectează o zi din calendar, apoi bifează clienții pe care vrei să-i vizitezi. Generează rută Google Maps pentru clienții selectați.</p></div><div class="help-section"><h4>Funcții noi</h4><p>Filtre județ → oraș cascadă. Checkbox "Arată clienți nealocați" pentru a vedea și clienții NEALOCAT.</p></div>` },
  expirari: { title: "Expirări / Freshness", body: `<div class="help-section"><h4>Descriere</h4><p>Raportare produse cu termen de valabilitate aproape expirat sau expirate. Sistemul generează alerte automate.</p></div>` },
  solduri: { title: "Scadențar — Import Mentor", body: `<div class="help-section"><h4>Descriere</h4><p>Scadențar combinat importat din WinMentor (Quatro) cu toate diviziile: BB, JTI, URSUS. Divizia se detectează automat din agentul asociat fiecărei facturi.</p></div><div class="help-section"><h4>Funcții</h4><p>Filtrare pe: divizie, agent, partener, interval depășire. Carduri sumar pe divizie cu total rest și nr. agenți. Alerte parteneri cu solduri în mai multe divizii. Tabel detaliat cu facturi, zile depășire, blocat DA/NU.</p></div><div class="help-section"><h4>Upload (Admin/SPV)</h4><p>Apasă „📤 Upload Scadențar" și selectează fișierul Excel „Scadențar Quatro" exportat din WinMentor. La fiecare import, datele anterioare sunt înlocuite.</p></div>` },
  escaladari: { title: "Escaladări SPV", body: `<div class="help-section"><h4>Descriere</h4><p>Agentul solicită SPV să vină pe teren. Se creează alertă cu timer. SPV face check-in cu foto+GPS pentru confirmare.</p></div>` },
  alertaClient: { title: "Alertă Client", body: `<div class="help-section"><h4>Descriere</h4><p>Agent generează alertă risc operațional/financiar pentru un client. SPV confirmă luarea la cunoștință.</p></div>` },
  riscFinanciar: { title: "Risc Financiar", body: `<div class="help-section"><h4>Descriere</h4><p>Upload raport Coface cu clienți risc mare. Lista e vizibilă tuturor utilizatorilor.</p></div>` },
  cuiVerify: { title: "Verificare CUI", body: `<div class="help-section"><h4>Descriere</h4><p>Scanare CUI la vizită. Auto-completare date firmă de la ANAF. Agent completează date suplimentare (administrator, CI, telefon).</p></div>` },
  perfTargete: { title: "Performanță Targete", body: `<div class="help-section"><h4>Descriere</h4><p>Upload și monitorizare target-uri de performanță. Progress bar vizual per agent cu culori (roșu/galben/verde).</p></div>` },
  ranking: { title: "Ranking Agenți", body: `<div class="help-section"><h4>Descriere</h4><p>Clasament agenți pe criterii: vizite, încasări, audit-uri. Admin definește criteriile, toți văd clasamentul.</p></div>` },
  discounturi: { title: "Control Discounturi", body: `<div class="help-section"><h4>Descriere</h4><p>Monitorizare discounturi acordate. Upload Excel cu limita și discountul real per agent/client.</p></div>` },
  contracte: { title: "Contracte Clienți", body: `<div class="help-section"><h4>Descriere</h4><p>Generare contract + acord GDPR pe baza datelor din Verificare CUI. Se completează date suplimentare și se descarcă DOCX.</p></div>` },
  smartTargets: { title: "Obiective Lunare", body: `<div class="help-section"><h4>Descriere</h4><p>Obiective SMART lunare cu reguli automate. Se definesc per produs/agent cu threshold-uri configurabile.</p></div>` },
  promoBudgets: { title: "Bugete Promo", body: `<div class="help-section"><h4>Descriere</h4><p>Alocare și monitorizare buget per promoție per agent. Progress bar vizual cu limită de depășire.</p></div>` },
  bugetGt: { title: "Buget GT Ursus", body: `<div class="help-section"><h4>Descriere</h4><p>Centralizator realizare GT (Gross Turnover) Ursus per agent. GT = CANTHL × GT/HL (preț pe hectolitru per SKU). Grupe obiectiv: Core Segment și ABI.</p></div><div class="help-section"><h4>Configurare (admin)</h4><p>1. Upload Mapare SKU (Quatro → BB) — ~4800 rânduri<br>2. Upload Prețuri GT/HL — ~60 SKU-uri cu preț și grupă<br>3. Upload Targeturi GT lunare per agent</p></div><div class="help-section"><h4>Funcționare</h4><p>La importul VANZARE BB din tab-ul Obiective, GT-ul se calculează automat. Centralizatorul arată Target vs Realizat per agent cu procente colorate.</p></div>` }
};

function showHelp(moduleKey) {
  const info = helpTexts[moduleKey];
  if (!info) return;
  document.getElementById("helpTitle").textContent = "ℹ️ " + info.title;
  document.getElementById("helpBody").innerHTML = info.body;
  document.getElementById("helpOverlay").style.display = "flex";
}

function closeHelp() {
  document.getElementById("helpOverlay").style.display = "none";
}

/* ═══════════════════════════════════════════════════════════════
   CALENDAR VISUAL GRID + MULTI-SELECT + ROUTE
   ═══════════════════════════════════════════════════════════════ */

let calYear, calMonth; // 0-indexed
let calSelectedDate = null;
let calSelectedClients = []; // [{id, lat, lon, name, code}]
let calClientData = []; // all clients for calendar

function initCalendarState() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  calSelectedDate = null;
  calSelectedClients = [];
}

function calPrevMonth() {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  calSelectedDate = null;
  calSelectedClients = [];
  renderCalGrid();
  updateCalSelectionInfo();
}

function calNextMonth() {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  calSelectedDate = null;
  calSelectedClients = [];
  renderCalGrid();
  updateCalSelectionInfo();
}

function renderCalGrid() {
  const grid = document.getElementById("calGrid");
  const label = document.getElementById("calMonthLabel");
  const monthNames = ["Ianuarie", "Februarie", "Martie", "Aprilie", "Mai", "Iunie", "Iulie", "August", "Septembrie", "Octombrie", "Noiembrie", "Decembrie"];
  label.textContent = `${monthNames[calMonth]} ${calYear}`;

  const dayNames = ["Lu", "Ma", "Mi", "Jo", "Vi", "Sâ", "Du"];
  let html = dayNames.map(d => `<div class="cal-header">${d}</div>`).join("");

  const firstDay = new Date(calYear, calMonth, 1).getDay(); // 0=Sun
  const shift = firstDay === 0 ? 6 : firstDay - 1; // Mon=0
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;

  // Empty cells before first day
  for (let i = 0; i < shift; i++) html += `<div class="cal-day empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === calSelectedDate;
    let cls = "cal-day";
    if (isToday) cls += " today";
    if (isSelected) cls += " selected";
    html += `<div class="${cls}" onclick="selectCalDate('${dateStr}',this)">${d}</div>`;
  }
  grid.innerHTML = html;
}

function selectCalDate(dateStr, el) {
  calSelectedDate = dateStr;
  calSelectedClients = [];
  // Re-render grid to update selection styling
  renderCalGrid();
  filterCalClients();
  updateCalSelectionInfo();
}

function filterCalClients() {
  const listEl = document.getElementById("calClientList");
  if (!calSelectedDate) {
    listEl.innerHTML = '<p style="color:var(--muted);font-size:.82rem;text-align:center;padding:.5rem">Selectează o zi din calendar</p>';
    return;
  }

  const searchQ = (document.getElementById("calSearch").value || "").toLowerCase();
  const cityFilter = document.getElementById("calCityFilter").value;
  const judetFilter = document.getElementById("calJudetFilter").value;
  const showNealocat = document.getElementById("calShowNealocat").checked;

  let clients = allClients.filter(c => {
    // Agent filter
    if (currentRole === "agent" && c.agent !== currentSalesRep) return false;
    // SPV/Admin: check calAgent dropdown
    if (currentRole !== "agent") {
      const selAgent = getSearchableValue("calAgent");
      if (selAgent && c.agent !== selAgent) return false;
    }
    // Nealocat filter
    if (!showNealocat && (c.agent === "NEALOCAT" || !c.agent)) return false;
    // Search
    if (searchQ) {
      const haystack = `${c.firma || ""} ${c.oras || ""} ${c.cod_client || ""} ${c.nume_poc || ""}`.toLowerCase();
      if (!haystack.includes(searchQ)) return false;
    }
    // City
    if (cityFilter && c.oras !== cityFilter) return false;
    // Judet
    if (judetFilter && c.judet !== judetFilter) return false;
    return true;
  });

  calClientData = clients;

  if (clients.length === 0) {
    listEl.innerHTML = '<p style="color:var(--muted);font-size:.82rem;text-align:center;padding:.5rem">Niciun client găsit</p>';
    return;
  }

  listEl.innerHTML = clients.map(c => {
    const isSelected = calSelectedClients.some(sc => sc.id === c.id);
    const isNealocat = (c.agent === "NEALOCAT" || !c.agent);
    return `<div class="cal-client-row${isSelected ? " selected" : ""}${isNealocat ? " cal-nealocat" : ""}" onclick="toggleCalClient(${parseInt(c.id)||0})" data-id="${parseInt(c.id)||0}">
      <div style="display:flex;align-items:center;gap:.4rem">
        <input type="checkbox" ${isSelected ? "checked" : ""} style="pointer-events:none">
        <div>
          <div style="font-size:.82rem;font-weight:600">${esc(c.firma || "N/A")}${isNealocat ? ' <span style="color:#e74c3c;font-size:.7rem">(NEALOCAT)</span>' : ""}</div>
          <div style="font-size:.72rem;color:var(--muted)">${esc(c.oras || "")} · ${esc(c.cod_client || "")}</div>
        </div>
      </div>
      <button class="btn ghost small" onclick="event.stopPropagation();openPurchaseModal('${esc(c.cod_client || "")}','${esc(c.firma || "")}')" style="font-size:.65rem;padding:1px 5px" title="Achiziții">💰</button>
    </div>`;
  }).join("");
}

function toggleCalClient(clientId) {
  const idx = calSelectedClients.findIndex(c => c.id === clientId);
  if (idx >= 0) {
    calSelectedClients.splice(idx, 1);
  } else {
    const client = allClients.find(c => c.id === clientId);
    if (client) {
      calSelectedClients.push({
        id: client.id,
        lat: client.lat,
        lon: client.lon,
        name: client.firma || "Client",
        code: client.cod_client || ""
      });
    }
  }
  filterCalClients(); // re-render list
  updateCalSelectionInfo();
}

function updateCalSelectionInfo() {
  const el = document.getElementById("calSelectionInfo");
  if (calSelectedClients.length === 0) {
    el.textContent = calSelectedDate ? "Selectează clienți pentru rută" : "";
  } else {
    el.textContent = `${calSelectedClients.length} clienți selectați`;
  }
}

function calClearSelection() {
  calSelectedClients = [];
  filterCalClients();
  updateCalSelectionInfo();
}

function openCalRoute() {
  if (calSelectedClients.length === 0) {
    toast("Selectează cel puțin un client", "warning");
    return;
  }
  const withCoords = calSelectedClients.filter(c => c.lat && c.lon);
  if (withCoords.length === 0) {
    toast("Clienții selectați nu au coordonate GPS", "warning");
    return;
  }
  // Build Google Maps directions URL
  const waypoints = withCoords.map(c => `${c.lat},${c.lon}`);
  let url;
  if (waypoints.length === 1) {
    url = `https://www.google.com/maps/dir/?api=1&destination=${waypoints[0]}`;
  } else {
    const dest = waypoints.pop();
    url = `https://www.google.com/maps/dir/?api=1&destination=${dest}&waypoints=${waypoints.join("|")}`;
  }
  window.open(url, "_blank");
}

// Populate calendar dropdowns (județ → oraș cascade)
function populateCalFilters() {
  const judete = [...new Set(allClients.map(c => c.judet).filter(Boolean))].sort();
  const judetSel = document.getElementById("calJudetFilter");
  if (judetSel) {
    judetSel.innerHTML = '<option value="">Toate</option>' + judete.map(j => `<option value="${esc(j)}">${esc(j)}</option>`).join("");
  }
  populateCalCities();
}

function onCalJudetChange() {
  populateCalCities();
  filterCalClients();
}

function populateCalCities() {
  const judet = document.getElementById("calJudetFilter").value;
  const filtered = judet ? allClients.filter(c => c.judet === judet) : allClients;
  const cities = [...new Set(filtered.map(c => c.oras).filter(Boolean))].sort();
  const citySel = document.getElementById("calCityFilter");
  if (citySel) {
    citySel.innerHTML = '<option value="">Toate</option>' + cities.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  }
}

/* Override loadCalendar to use new grid system */
const _origLoadCalendar = loadCalendar;
loadCalendar = function() {
  if (!calYear) initCalendarState();
  renderCalGrid();
  populateCalFilters();
  filterCalClients();
  updateCalSelectionInfo();
  // Also load agents list for admin/spv filter
  loadAgentsList().then(() => populateAgentDropdowns());
};

/* ═══════════════════════════════════════════════════════════════
   PURCHASES MODAL (HL + RON for beer division)
   ═══════════════════════════════════════════════════════════════ */

async function openPurchaseModal(clientCode, clientName) {
  const overlay = document.getElementById("purchaseOverlay");
  const title = document.getElementById("purchaseTitle");
  const body = document.getElementById("purchaseBody");
  title.textContent = `💰 Achiziții: ${clientName}`;
  body.innerHTML = '<p style="text-align:center;padding:1rem"><span class="spinner" style="width:20px;height:20px;display:inline-block"></span></p>';
  overlay.style.display = "flex";

  try {
    const r = await fetch(`/api/client-purchases/${encodeURIComponent(clientCode)}`);
    if (!r.ok) throw new Error("Eroare la încărcare");
    const d = await r.json();

    let html = "";

    // Last purchase
    if (d.last_purchase_date) {
      html += `<div style="background:var(--bg);border-radius:6px;padding:.5rem;margin-bottom:.5rem;border-left:3px solid var(--accent)">
        <strong style="font-size:.8rem">Ultima livrare: ${d.last_purchase_date}</strong>`;
      if (d.last_purchase && d.last_purchase.length > 0) {
        html += `<table style="width:100%;font-size:.75rem;margin-top:.3rem;border-collapse:collapse">
          <tr style="color:var(--muted)"><th style="text-align:left;padding:2px 4px">Produs</th><th style="text-align:right;padding:2px 4px">Cant (HL)</th><th style="text-align:right;padding:2px 4px">Val (RON)</th></tr>`;
        d.last_purchase.forEach(p => {
          html += `<tr><td style="padding:2px 4px">${esc(p.product_name || p.product_code || "")}</td>
            <td style="text-align:right;padding:2px 4px">${fmtNum(p.cantitate_hl || p.cantitate || 0)}</td>
            <td style="text-align:right;padding:2px 4px">${fmtNum(p.valoare || 0)}</td></tr>`;
        });
        html += `</table>`;
      }
      html += `</div>`;
    } else {
      html += `<p style="color:var(--muted);font-size:.82rem">Nicio livrare înregistrată</p>`;
    }

    // Totals per product
    if (d.totals && d.totals.length > 0) {
      html += `<div style="margin-top:.5rem"><strong style="font-size:.82rem;color:var(--accent)">Totaluri per produs</strong>
        <table style="width:100%;font-size:.75rem;margin-top:.3rem;border-collapse:collapse">
          <tr style="color:var(--muted);border-bottom:1px solid var(--border)"><th style="text-align:left;padding:3px 4px">Produs</th><th style="text-align:right;padding:3px 4px">HL</th><th style="text-align:right;padding:3px 4px">RON</th></tr>`;
      let totalHL = 0, totalRON = 0;
      d.totals.forEach(t => {
        totalHL += (t.total_hl || t.total_cantitate || 0);
        totalRON += (t.total_valoare || 0);
        html += `<tr><td style="padding:3px 4px">${esc(t.product_name || t.product_code || "")}</td>
          <td style="text-align:right;padding:3px 4px">${fmtNum(t.total_hl || t.total_cantitate || 0)}</td>
          <td style="text-align:right;padding:3px 4px">${fmtNum(t.total_valoare || 0)}</td></tr>`;
      });
      html += `<tr style="font-weight:700;border-top:2px solid var(--accent)"><td style="padding:3px 4px">TOTAL</td>
        <td style="text-align:right;padding:3px 4px">${fmtNum(totalHL)}</td>
        <td style="text-align:right;padding:3px 4px">${fmtNum(totalRON)}</td></tr></table></div>`;
    }

    // Last report date
    if (d.last_report_date) {
      html += `<p style="font-size:.72rem;color:var(--muted);margin-top:.5rem;text-align:right">Raport actualizat: ${d.last_report_date}</p>`;
    }

    body.innerHTML = html || '<p style="color:var(--muted)">Nu sunt date disponibile</p>';
  } catch (e) {
    body.innerHTML = `<p style="color:#e74c3c;padding:.5rem">Eroare: ${esc(e.message)}</p>`;
  }
}

function closePurchaseModal() {
  document.getElementById("purchaseOverlay").style.display = "none";
}

/* ═══════════════════════════════════════════════════════════════
   EXIF GPS EXTRACTION from uploaded photos
   ═══════════════════════════════════════════════════════════════ */

function parseExifGps(file) {
  return new Promise((resolve) => {
    if (!file || !file.type.startsWith("image/")) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const view = new DataView(e.target.result);
        // Check JPEG
        if (view.getUint16(0) !== 0xFFD8) { resolve(null); return; }
        let offset = 2;
        while (offset < view.byteLength - 2) {
          const marker = view.getUint16(offset);
          if (marker === 0xFFE1) { // APP1 - EXIF
            const exifLen = view.getUint16(offset + 2);
            const exifData = extractExifGps(view, offset + 4, exifLen);
            resolve(exifData);
            return;
          }
          if ((marker & 0xFF00) !== 0xFF00) break;
          offset += 2 + view.getUint16(offset + 2);
        }
        resolve(null);
      } catch (err) {
        console.warn("EXIF parse error:", err);
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, 128 * 1024)); // Read first 128KB
  });
}

function extractExifGps(view, start, len) {
  try {
    // Check for "Exif\0\0"
    const exifStr = String.fromCharCode(view.getUint8(start), view.getUint8(start+1), view.getUint8(start+2), view.getUint8(start+3));
    if (exifStr !== "Exif") return null;
    const tiffStart = start + 6;
    const endian = view.getUint16(tiffStart);
    const le = endian === 0x4949; // Little endian
    const getU16 = (o) => view.getUint16(o, le);
    const getU32 = (o) => view.getUint32(o, le);
    const getRational = (o) => {
      const num = getU32(o);
      const den = getU32(o + 4);
      return den === 0 ? 0 : num / den;
    };

    // Find IFD0
    const ifd0Offset = tiffStart + getU32(tiffStart + 4);
    const ifd0Count = getU16(ifd0Offset);

    // Find GPS IFD pointer in IFD0
    let gpsIfdOffset = 0;
    for (let i = 0; i < ifd0Count; i++) {
      const entryOffset = ifd0Offset + 2 + i * 12;
      const tag = getU16(entryOffset);
      if (tag === 0x8825) { // GPSInfo
        gpsIfdOffset = tiffStart + getU32(entryOffset + 8);
        break;
      }
    }
    if (!gpsIfdOffset) return null;

    // Parse GPS IFD
    const gpsCount = getU16(gpsIfdOffset);
    let latRef = "", lonRef = "", latVals = null, lonVals = null;
    for (let i = 0; i < gpsCount; i++) {
      const entryOffset = gpsIfdOffset + 2 + i * 12;
      const tag = getU16(entryOffset);
      if (tag === 1) { // GPSLatitudeRef
        latRef = String.fromCharCode(view.getUint8(entryOffset + 8));
      } else if (tag === 2) { // GPSLatitude
        const valOff = tiffStart + getU32(entryOffset + 8);
        latVals = [getRational(valOff), getRational(valOff + 8), getRational(valOff + 16)];
      } else if (tag === 3) { // GPSLongitudeRef
        lonRef = String.fromCharCode(view.getUint8(entryOffset + 8));
      } else if (tag === 4) { // GPSLongitude
        const valOff = tiffStart + getU32(entryOffset + 8);
        lonVals = [getRational(valOff), getRational(valOff + 8), getRational(valOff + 16)];
      }
    }
    if (!latVals || !lonVals) return null;

    let lat = latVals[0] + latVals[1] / 60 + latVals[2] / 3600;
    let lon = lonVals[0] + lonVals[1] / 60 + lonVals[2] / 3600;
    if (latRef === "S") lat = -lat;
    if (lonRef === "W") lon = -lon;

    if (lat === 0 && lon === 0) return null;
    return { lat: Math.round(lat * 1000000) / 1000000, lon: Math.round(lon * 1000000) / 1000000 };
  } catch (err) {
    console.warn("GPS extraction error:", err);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════
   CENSUS CASCADE FILTERS (Județ → Oraș)
   ═══════════════════════════════════════════════════════════════ */

function addCensusCascadeFilter() {
  // Add județ dropdown above city filter in Census
  const citySection = document.getElementById("censusCityFilter");
  if (!citySection) return;
  const parent = citySection.parentElement;
  // Check if already added
  if (document.getElementById("censusJudetFilter")) return;

  const wrapper = document.createElement("div");
  wrapper.style.marginBottom = ".3rem";
  wrapper.innerHTML = `<p class="label" style="font-size:.7rem">JUDEȚ</p>
    <select id="censusJudetFilter" onchange="onCensusJudetChange()" style="width:100%;padding:4px;font-size:.78rem;background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:4px;margin-bottom:.3rem">
      <option value="">Toate județele</option>
    </select>`;
  parent.insertBefore(wrapper, parent.querySelector(".label"));

  // Populate județe
  const judete = [...new Set(allClients.map(c => c.judet).filter(Boolean))].sort();
  const sel = document.getElementById("censusJudetFilter");
  judete.forEach(j => { const o = document.createElement("option"); o.value = j; o.textContent = j; sel.appendChild(o); });
}

function onCensusJudetChange() {
  // Re-filter city checklist based on selected județ
  const judet = document.getElementById("censusJudetFilter") ? document.getElementById("censusJudetFilter").value : "";
  const filtered = judet ? allClients.filter(c => c.judet === judet) : allClients;
  const cities = groupBy(filtered, "oras");
  renderFilterChecklist("censusCityFilter", cities, censusSel.city, "censusCitySearch");
}

/* ═══════════════════════════════════════════════════════════════
   GEOCODING ADDRESS (frontend trigger for batch)
   ═══════════════════════════════════════════════════════════════ */

async function geocodeBatch() {
  if (currentRole !== "admin") { toast("Doar admin poate rula geocodarea", "warning"); return; }
  toast("Se geocodează adresele clienților...", "info", 5000);
  try {
    const r = await fetch("/api/geocode-batch", { method: "POST" });
    if (!r.ok) throw new Error("Eroare geocodare");
    const d = await r.json();
    toast(`Geocodare completă: ${d.geocoded || 0} din ${d.total || 0} clienți`, "success", 5000);
    // Reload data to refresh map
    refreshData();
  } catch (e) {
    toast("Eroare geocodare: " + e.message, "error", 5000);
  }
}

/* ═══ END ALL SECTIONS ═══ */

/* ═══════════ RANKING POPUP ═══════════ */
async function showRankingPopup() {
  try {
    const r = await fetch("/api/ranking");
    if (!r.ok) return;
    const data = await r.json();
    if (!data.ranking || !data.ranking.length) return;

    const { ranking, myPosition, myAgent, totalAgents, month } = data;
    const monthLabel = new Date(month + "-01").toLocaleDateString("ro-RO", { month: "long", year: "numeric" });

    // Medal emojis
    const medals = ["🥇", "🥈", "🥉"];
    function getMedal(pos) { return pos <= 3 ? medals[pos - 1] : `${pos}.`; }

    // For agents: show ONLY their own position, not the full leaderboard
    const isAgent = currentRole === "agent";

    // Build ranking rows - agents see only their own row
    const displayRanking = isAgent && myAgent ? ranking.filter(a => a.app_sales_rep === myAgent.app_sales_rep) : ranking;

    let rankingHtml = "";
    for (const agent of displayRanking) {
      const isMe = myAgent && agent.app_sales_rep === myAgent.app_sales_rep;
      const medal = getMedal(agent.position);
      const barWidth = Math.min(agent.score, 150);
      const barColor = agent.score >= 100 ? "#22c55e" : agent.score >= 75 ? "#eab308" : agent.score >= 50 ? "#f97316" : "#ef4444";

      rankingHtml += `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;margin:4px 0;border-radius:10px;
          ${isMe ? "background:linear-gradient(135deg,#1e3a5f,#1a4a7a);border:2px solid #3b82f6;box-shadow:0 0 12px rgba(59,130,246,.3);" : "background:#1c2128;border:1px solid #30363d;"}
          transition:transform .15s;cursor:default;" ${isMe ? 'id="myRankRow"' : ""}>
          <div style="font-size:1.4rem;min-width:36px;text-align:center">${medal}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:${isMe ? "700" : "500"};color:${isMe ? "#60a5fa" : "#e6edf3"};font-size:.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${agent.agent_name}${isMe ? " ⭐" : ""}
            </div>
            <div style="display:flex;gap:12px;margin-top:4px;font-size:.78rem;color:#8b949e">
              <span>Val: <b style="color:${agent.pct_val >= 100 ? "#22c55e" : "#e6edf3"}">${agent.pct_val}%</b></span>
              <span>Clienti: <b style="color:${agent.pct_clienti >= 100 ? "#22c55e" : "#e6edf3"}">${agent.pct_clienti}%</b></span>
              <span>HL: <b style="color:${agent.pct_hl >= 100 ? "#22c55e" : "#e6edf3"}">${agent.pct_hl}%</b></span>
            </div>
          </div>
          <div style="min-width:80px;text-align:right">
            <div style="height:8px;background:#30363d;border-radius:4px;overflow:hidden;margin-bottom:3px">
              <div style="height:100%;width:${barWidth}%;background:${barColor};border-radius:4px;transition:width .5s"></div>
            </div>
            <div style="font-size:.85rem;font-weight:700;color:${barColor}">${agent.score}%</div>
          </div>
        </div>`;
    }

    // My position highlight
    let myHighlight = "";
    if (myPosition && myAgent) {
      const posColor = myPosition === 1 ? "#fbbf24" : myPosition === 2 ? "#c0c0c0" : myPosition === 3 ? "#cd7f32" : "#60a5fa";
      myHighlight = `
        <div style="text-align:center;padding:20px 0 16px;border-bottom:1px solid #30363d;margin-bottom:12px">
          <div style="font-size:3rem;margin-bottom:4px">${getMedal(myPosition)}</div>
          <div style="font-size:1.5rem;font-weight:800;color:${posColor}">Locul ${myPosition} din ${totalAgents}</div>
          <div style="font-size:.9rem;color:#8b949e;margin-top:6px">
            Scor general: <b style="color:#e6edf3">${myAgent.score}%</b>
            <span style="margin:0 8px;color:#30363d">|</span>
            Val: <b style="color:#e6edf3">${myAgent.pct_val}%</b>
            <span style="margin:0 8px;color:#30363d">|</span>
            Clienti: <b style="color:#e6edf3">${myAgent.pct_clienti}%</b>
          </div>
        </div>`;
    } else if (currentRole === "admin" || currentRole === "spv") {
      myHighlight = `
        <div style="text-align:center;padding:16px 0 12px;border-bottom:1px solid #30363d;margin-bottom:12px">
          <div style="font-size:1.2rem;font-weight:600;color:#60a5fa">Clasament Agenti — ${monthLabel}</div>
          <div style="font-size:.85rem;color:#8b949e;margin-top:4px">${totalAgents} agenti in divizia Ursus</div>
        </div>`;
    }

    // Create overlay
    const overlay = document.createElement("div");
    overlay.id = "rankingOverlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);animation:fadeIn .3s";
    overlay.innerHTML = `
      <div style="background:#0d1117;border:1px solid #30363d;border-radius:16px;width:92%;max-width:480px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 25px 80px rgba(0,0,0,.6);animation:slideUp .4s ease-out">
        <div style="padding:16px 20px 0;flex-shrink:0">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2 style="color:#e6edf3;font-size:1.15rem;margin:0">🏆 Clasament Agenti</h2>
            <button onclick="document.getElementById('rankingOverlay').remove()" style="background:none;border:none;color:#8b949e;font-size:1.3rem;cursor:pointer;padding:4px 8px;border-radius:6px;transition:background .2s" onmouseover="this.style.background='#21262d'" onmouseout="this.style.background='none'">✕</button>
          </div>
        </div>
        ${myHighlight}
        <div style="overflow-y:auto;padding:0 16px 16px;flex:1">
          ${rankingHtml}
        </div>
        <div style="padding:12px 16px;border-top:1px solid #30363d;flex-shrink:0">
          <button onclick="document.getElementById('rankingOverlay').remove()" style="width:100%;padding:10px;background:#1a8cff;color:#fff;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;transition:background .2s" onmouseover="this.style.background='#3da0ff'" onmouseout="this.style.background='#1a8cff'">Am inteles!</button>
        </div>
      </div>
      <style>
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes slideUp{from{transform:translateY(30px);opacity:0}to{transform:translateY(0);opacity:1}}
      </style>`;

    document.body.appendChild(overlay);

    // Scroll to my row
    setTimeout(() => {
      const myRow = document.getElementById("myRankRow");
      if (myRow) myRow.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 500);

    // Close on overlay click (not on popup)
    overlay.addEventListener("click", e => {
      if (e.target === overlay) overlay.remove();
    });

  } catch (e) {
    console.error("Ranking popup error:", e);
  }
}


/* ═══════════════════════════════════════════════════════════════
   NEARBY CLIENTS – GPS proximity search
   ═══════════════════════════════════════════════════════════════ */
async function findNearbyClients() {
  const statusEl = document.getElementById("nearbyStatus");
  const resultsEl = document.getElementById("nearbyResults");
  const radius = parseInt(document.getElementById("nearbyRadiusSelect").value) || 200;

  statusEl.textContent = "📡 Se obține locația GPS...";
  statusEl.style.color = "var(--text)";
  resultsEl.innerHTML = "";

  clearNearbyMarkers();

  if (!navigator.geolocation) {
    statusEl.textContent = "❌ GPS indisponibil pe acest dispozitiv";
    statusEl.style.color = "var(--danger)";
    return;
  }

  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 15000, maximumAge: 30000
      });
    });

    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    statusEl.textContent = `📡 Căutare clienți în raza de ${radius}m...`;

    const r = await fetch(`/api/clients/nearby?lat=${lat}&lon=${lon}&radius=${radius}`);
    const data = await r.json();
    if (!data.ok) {
      statusEl.textContent = "❌ " + (data.error || "Eroare");
      statusEl.style.color = "var(--danger)";
      return;
    }

    if (data.total === 0) {
      statusEl.textContent = `Niciun client găsit în raza de ${radius}m`;
      statusEl.style.color = "var(--warning)";
      showNearbyOnMap(lat, lon, radius, []);
      return;
    }

    statusEl.innerHTML = `<strong style="color:var(--success)">✅ ${esc(String(data.total))} clienți găsiți</strong> în raza de ${esc(String(radius))}m`;

    showNearbyOnMap(lat, lon, radius, data.clients);

    // Render client cards matching census format
    resultsEl.innerHTML = `
      <div style="margin-bottom:6px;display:flex;gap:4px;flex-wrap:wrap">
        <button class="btn primary small" onclick="nearbyBulkRoute()" style="font-size:11px">🗺️ Traseu toți</button>
        <button class="btn small" onclick="nearbyBulkNavigate()" style="font-size:11px;background:#3b82f6;color:#fff">🧭 Navigare</button>
        <button class="btn small" onclick="clearNearbyMarkers();document.getElementById('nearbyResults').innerHTML='';document.getElementById('nearbyStatus').textContent=''" style="font-size:11px;background:var(--muted);color:#fff">✕ Închide</button>
      </div>
    ` + data.clients.map(c => {
      const stareColor = c.stare_poc === "Deschis" ? "ok" : c.stare_poc === "Pre-Closed" ? "warn" : "bad";
      const purch = purchaseMap[c.code];
      const purchBadge = purch
        ? `<span class="chip ok" style="font-size:.7rem">🛒 ${purch.valoare.toLocaleString("ro-RO",{minimumFractionDigits:0,maximumFractionDigits:0})} lei · ${purch.cantHL} HL</span>`
        : `<span class="chip bad" style="font-size:.7rem">Fără achiziție</span>`;
      return `
        <li class="client-item" data-id="${parseInt(c.id)||0}" style="border-left:3px solid #10b981">
          <p class="client-title">${esc((c.firma||'').toUpperCase())} <span class="chip ${esc(stareColor)}">${esc(c.stare_poc||'')}</span> <span style="font-size:11px;color:#10b981;font-weight:600">${parseInt(c.distance)||0}m</span></p>
          <p class="client-meta">${esc(c.nume_poc||'')} • Cod: ${esc(c.code||'')}</p>
          <p class="client-meta">${esc(c.oras||'')} • ${esc(c.canal||'')} • ${esc(c.format||'')}</p>
          <p class="client-meta">Agent: ${esc(c.agent||'')} • SR: ${esc(c.sales_rep||'')}</p>
          <p class="client-meta">Achiziții luna: ${purchBadge}</p>
          <div class="tiny-actions">
            <button class="chip-btn" onclick="focusOnMap(${c.id},'census')">Pe hartă</button>
            <button class="chip-btn" onclick="navigateTo(${c.lat},${c.lon})">Navighează</button>
            <button class="chip-btn" onclick="showClientDetail(${c.id})">Detalii</button>
            <button class="chip-btn" onclick="addToRoute(${c.id})" style="background:#00b894;color:#fff">+ Traseu</button>
          </div>
        </li>`;
    }).join("");

    window._nearbyClients = data.clients;

  } catch(e) {
    if (e.code === 1) {
      statusEl.textContent = "❌ Acces GPS refuzat. Permite localizarea în browser.";
    } else if (e.code === 2) {
      statusEl.textContent = "❌ Locație indisponibilă. Verifică GPS-ul.";
    } else if (e.code === 3) {
      statusEl.textContent = "❌ Timeout GPS. Încearcă din nou.";
    } else {
      statusEl.textContent = "❌ Eroare: " + e.message;
    }
    statusEl.style.color = "var(--danger)";
  }
}

function showNearbyOnMap(lat, lon, radius, clients) {
  clearNearbyMarkers();

  nearbyMarkerGroup = L.layerGroup().addTo(map);

  // User position marker (blue dot)
  nearbyUserMarker = L.marker([lat, lon], {
    icon: L.divIcon({
      className: "nearby-user-marker",
      html: '<div style="background:#3b82f6;width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 8px rgba(59,130,246,0.6)"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    })
  }).bindTooltip("📍 Poziția ta", { permanent: true, direction: "top", offset: [0, -12] });
  nearbyMarkerGroup.addLayer(nearbyUserMarker);

  // Radius circle
  nearbyCircle = L.circle([lat, lon], {
    radius: radius,
    color: "#3b82f6",
    fillColor: "#3b82f6",
    fillOpacity: 0.08,
    weight: 2,
    dashArray: "6, 4"
  });
  nearbyMarkerGroup.addLayer(nearbyCircle);

  // Client markers with distance labels
  clients.forEach(c => {
    if (!validGPS(c.lat, c.lon)) return;
    const m = L.marker([c.lat, c.lon], {
      icon: L.divIcon({
        className: "nearby-client-marker",
        html: `<div style="background:#10b981;color:#fff;padding:2px 6px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3)">${c.distance}m</div>`,
        iconSize: [50, 20],
        iconAnchor: [25, 10]
      })
    });
    m._popupContent = censusPopup(c);
    m.bindTooltip(`<b>${esc(c.firma||c.nume_poc||'')}</b><br>${parseInt(c.distance)||0}m`, { direction: "top", offset: [0, -10] });
    m.on("click", () => {
      m.unbindPopup();
      m.bindPopup(m._popupContent, { maxWidth: 300 }).openPopup();
    });
    nearbyMarkerGroup.addLayer(m);
  });

  // Fit map bounds
  const bounds = L.latLngBounds([[lat, lon]]);
  clients.forEach(c => { if (c.lat && c.lon) bounds.extend([c.lat, c.lon]); });
  bounds.extend([lat - radius/111000, lon - radius/111000]);
  bounds.extend([lat + radius/111000, lon + radius/111000]);
  map.fitBounds(bounds, { padding: [30, 30] });
}

function clearNearbyMarkers() {
  if (nearbyMarkerGroup) { map.removeLayer(nearbyMarkerGroup); nearbyMarkerGroup = null; }
  nearbyCircle = null;
  nearbyUserMarker = null;
}

function nearbyBulkRoute() {
  const clients = window._nearbyClients || [];
  clients.forEach(c => addToRoute(c.id));
}

function nearbyBulkNavigate() {
  const clients = window._nearbyClients || [];
  if (!clients.length) return;
  const waypoints = clients.filter(c => c.lat && c.lon).map(c => `${c.lat},${c.lon}`);
  if (waypoints.length === 0) return;
  const dest = waypoints.pop();
  const url = waypoints.length > 0
    ? `https://www.google.com/maps/dir/?api=1&destination=${dest}&waypoints=${waypoints.join("|")}&travelmode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
  window.open(url, "_blank");
}

/* ═══════════════ BUGET GT URSUS ═══════════════ */

async function loadGtCentralizator() {
  const month = document.getElementById("gtMonth").value || new Date().toISOString().slice(0, 7);
  const container = document.getElementById("gtCentralizator");
  const unmatchedDiv = document.getElementById("gtUnmatched");
  container.innerHTML = '<p style="text-align:center;padding:1rem;color:var(--muted)">Se încarcă...</p>';
  unmatchedDiv.innerHTML = "";

  try {
    // Load config status
    const cfgR = await fetch("/api/gt/config");
    const cfg = await cfgR.json();
    const cfgInfo = document.getElementById("gtConfigInfo");
    if (cfgInfo) {
      cfgInfo.innerHTML = `Mapare SKU: <b>${esc(String(cfg.sku_mapping || 0))}</b> rânduri | Prețuri GT: <b>${esc(String(cfg.gt_prices || 0))}</b> SKU-uri`;
    }

    const r = await fetch(`/api/gt/centralizator?month=${encodeURIComponent(month)}`);
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "Eroare");

    if (!d.agents || d.agents.length === 0) {
      container.innerHTML = '<p style="text-align:center;padding:1rem;color:var(--muted)">Nu există date GT pentru această lună. Importă VANZARE BB din tab-ul Obiective.</p>';
      return;
    }

    // Config warning
    let warning = "";
    if (!d.config || d.config.sku_mapping === 0) {
      warning += '<div style="background:#FFF3CD;border:1px solid #FFEAA7;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:.8rem">⚠️ Maparea SKU nu este încărcată. Încarcă fișierul de mapare din secțiunea Config.</div>';
    }
    if (!d.config || d.config.gt_prices === 0) {
      warning += '<div style="background:#FFF3CD;border:1px solid #FFEAA7;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:.8rem">⚠️ Prețurile GT/HL nu sunt încărcate. Încarcă fișierul cu prețuri din secțiunea Config.</div>';
    }

    function pctColor(pct) {
      if (pct >= 100) return "#27AE60";
      if (pct >= 80) return "#F39C12";
      if (pct >= 50) return "#E67E22";
      return "#E74C3C";
    }

    function fmtNum(n) { return (n || 0).toLocaleString("ro-RO", { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

    let html = warning;
    html += `<div style="margin-bottom:8px;font-size:.85rem;color:var(--muted)">Luna: <b>${esc(month)}</b></div>`;

    // Summary cards
    const t = d.totals;
    html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px">`;
    html += `<div style="background:#e8f5e9;border-radius:8px;padding:10px;border:1px solid var(--border)">
      <div style="font-size:.7rem;color:var(--muted)">CORE SEGMENT</div>
      <div style="font-size:1.1rem;font-weight:700;color:${pctColor(t.pct_core)}">${t.pct_core}%</div>
      <div style="font-size:.75rem">${fmtNum(t.real_core)} / ${fmtNum(t.target_core)}</div>
    </div>`;
    html += `<div style="background:#e3f2fd;border-radius:8px;padding:10px;border:1px solid var(--border)">
      <div style="font-size:.7rem;color:var(--muted)">ABI</div>
      <div style="font-size:1.1rem;font-weight:700;color:${pctColor(t.pct_abi)}">${t.pct_abi}%</div>
      <div style="font-size:.75rem">${fmtNum(t.real_abi)} / ${fmtNum(t.target_abi)}</div>
    </div>`;
    html += `<div style="background:#fff3e0;border-radius:8px;padding:10px;border:1px solid var(--border)">
      <div style="font-size:.7rem;color:var(--muted)">ALTELE</div>
      <div style="font-size:1.1rem;font-weight:700;color:${pctColor(t.pct_other || 0)}">${t.pct_other || 0}%</div>
      <div style="font-size:.75rem">${fmtNum(t.real_other)} / ${fmtNum(t.target_other)}</div>
    </div>`;
    html += `<div style="background:#f3e5f5;border-radius:8px;padding:10px;border:1px solid var(--border)">
      <div style="font-size:.7rem;color:var(--muted)">TOTAL SO</div>
      <div style="font-size:1.1rem;font-weight:700;color:${pctColor(t.pct_total)}">${t.pct_total}%</div>
      <div style="font-size:.75rem">${fmtNum(t.real_total)} / ${fmtNum(t.target_total)}</div>
    </div>`;
    html += `</div>`;

    // Table with 4 groups: Core, ABI, Altele, Total SO
    html += `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.75rem">`;
    html += `<thead><tr style="background:var(--bg2);border-bottom:1px solid var(--border)">
      <th rowspan="2" style="padding:6px 8px;text-align:left;vertical-align:bottom">Agent</th>
      <th colspan="3" style="padding:4px;text-align:center;border-left:2px solid var(--border);background:#e8f5e9;font-size:.7rem">Core Segment</th>
      <th colspan="3" style="padding:4px;text-align:center;border-left:2px solid var(--border);background:#e3f2fd;font-size:.7rem">ABI</th>
      <th colspan="3" style="padding:4px;text-align:center;border-left:2px solid var(--border);background:#fff3e0;font-size:.7rem">Altele</th>
      <th colspan="3" style="padding:4px;text-align:center;border-left:2px solid var(--border);background:#f3e5f5;font-size:.7rem">Total SO</th>
    </tr><tr style="background:var(--bg2);border-bottom:2px solid var(--border)">`;
    for (let i = 0; i < 4; i++) {
      html += `<th style="padding:3px;text-align:right;font-size:.65rem;color:var(--muted);border-left:2px solid var(--border)">Target</th>
        <th style="padding:3px;text-align:right;font-size:.65rem;color:var(--muted)">Realizat</th>
        <th style="padding:3px;text-align:center;font-size:.65rem;color:var(--muted)">%</th>`;
    }
    html += `</tr></thead><tbody>`;

    function gtRow(label, a, isBold, bgStyle) {
      let r = `<tr style="border-bottom:1px solid var(--border);${bgStyle || ''}${isBold ? 'font-weight:700;' : ''}">`;
      r += `<td style="padding:5px 8px;font-weight:600;white-space:nowrap">${esc(label)}</td>`;
      // Core
      r += `<td style="padding:5px 3px;text-align:right;border-left:2px solid var(--border)">${fmtNum(a.target_core)}</td>`;
      r += `<td style="padding:5px 3px;text-align:right">${fmtNum(a.real_core)}</td>`;
      r += `<td style="padding:5px 3px;text-align:center;font-weight:700;color:${pctColor(a.pct_core)}">${a.pct_core}%</td>`;
      // ABI
      r += `<td style="padding:5px 3px;text-align:right;border-left:2px solid var(--border)">${fmtNum(a.target_abi)}</td>`;
      r += `<td style="padding:5px 3px;text-align:right">${fmtNum(a.real_abi)}</td>`;
      r += `<td style="padding:5px 3px;text-align:center;font-weight:700;color:${pctColor(a.pct_abi)}">${a.pct_abi}%</td>`;
      // Altele
      r += `<td style="padding:5px 3px;text-align:right;border-left:2px solid var(--border)">${fmtNum(a.target_other || 0)}</td>`;
      r += `<td style="padding:5px 3px;text-align:right">${fmtNum(a.real_other || 0)}</td>`;
      r += `<td style="padding:5px 3px;text-align:center;font-weight:700;color:${pctColor(a.pct_other || 0)}">${(a.pct_other || 0)}%</td>`;
      // Total SO
      r += `<td style="padding:5px 3px;text-align:right;border-left:2px solid var(--border)">${fmtNum(a.target_total)}</td>`;
      r += `<td style="padding:5px 3px;text-align:right">${fmtNum(a.real_total)}</td>`;
      r += `<td style="padding:5px 3px;text-align:center;font-weight:700;color:${pctColor(a.pct_total)}">${a.pct_total}%</td>`;
      r += `</tr>`;
      return r;
    }

    for (const a of d.agents) {
      html += gtRow(a.agent, a, false, '');
    }
    html += gtRow('TOTAL', t, true, 'background:var(--bg2);border-top:2px solid var(--border);');
    html += `</tbody></table></div>`;

    container.innerHTML = html;

    // Load unmatched products
    const ur = await fetch(`/api/gt/unmatched?month=${encodeURIComponent(month)}`);
    const ud = await ur.json();
    if (ud.ok && ud.count > 0) {
      let uhtml = `<details style="margin-top:8px"><summary style="font-size:.8rem;cursor:pointer;color:var(--muted)">⚠️ ${esc(String(ud.count))} produse nemapate</summary>`;
      uhtml += `<div style="font-size:.75rem;padding:6px;background:var(--bg2);border-radius:6px;margin-top:4px;max-height:200px;overflow:auto">`;
      for (const p of ud.unmatched) {
        uhtml += `<div style="padding:2px 0;border-bottom:1px solid var(--border)">${esc(p)}</div>`;
      }
      uhtml += `</div></details>`;
      unmatchedDiv.innerHTML = uhtml;
    }
  } catch (ex) {
    container.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`;
  }
}

function downloadGtTemplate(type) {
  const month = document.getElementById("gtTargetMonth").value || new Date().toISOString().slice(0, 7);
  if (type === "mapare") {
    window.open("/api/gt/template-mapare", "_blank");
  } else if (type === "targeturi") {
    window.open(`/api/gt/template-targeturi?month=${encodeURIComponent(month)}`, "_blank");
  }
}

async function uploadGtMapare() {
  const file = document.getElementById("gtMapareFile").files[0];
  const monthEl = document.getElementById("gtMapareMonth");
  const month = monthEl ? monthEl.value : "";
  const status = document.getElementById("gtMapareStatus");
  if (!file) { status.textContent = "Selectează fișierul"; return; }
  if (!month) { status.textContent = "Selectează luna"; return; }
  status.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Se importă din fișierul Ursus...';
  const fd = new FormData();
  fd.append("file", file);
  fd.append("month", month);
  try {
    const r = await fetch("/api/gt/upload-mapare-preturi", { method: "POST", body: fd });
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); } catch { throw new Error("Serverul nu a răspuns corect. Reîncarcă pagina."); }
    if (!r.ok) throw new Error(d.error || "Eroare server");
    let msg = `✅ ${esc(String(d.sku_count))} produse mapate, ${esc(String(d.prices_count))} prețuri importate`;
    if (d.centralizator_count > 0) msg += `, ${esc(String(d.centralizator_count))} agenți (target+realizat)`;
    status.innerHTML = `<span style="color:var(--success)">${msg}</span>`;
    toast("Fișier Ursus importat cu succes!", "success");
    if (typeof renderGtInObiective === "function") renderGtInObiective();
  } catch (ex) {
    status.innerHTML = `<span style="color:var(--danger)">❌ ${esc(ex.message)}</span>`;
  }
}

async function uploadGtTargeturi() {
  const file = document.getElementById("gtTargeturiFile").files[0];
  const month = document.getElementById("gtTargetMonth").value;
  const status = document.getElementById("gtTargeturiStatus");
  if (!file) { status.textContent = "Selectează fișierul"; return; }
  if (!month) { status.textContent = "Selectează luna"; return; }
  status.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Se importă targeturi...';
  const fd = new FormData();
  fd.append("file", file);
  fd.append("month", month);
  try {
    const r = await fetch("/api/gt/upload-targeturi", { method: "POST", body: fd });
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); } catch { throw new Error("Serverul nu a răspuns corect. Reîncarcă pagina."); }
    if (!r.ok) throw new Error(d.error || "Eroare server");
    status.innerHTML = `<span style="color:var(--success)">✅ ${esc(String(d.count))} targeturi importate pentru ${esc(d.month)}</span>`;
    toast("Targeturi GT importate!", "success");
    if (typeof renderGtInObiective === "function") renderGtInObiective();
  } catch (ex) {
    status.innerHTML = `<span style="color:var(--danger)">❌ ${esc(ex.message)}</span>`;
  }
}


async function exportGtExcel() {
  const month = document.getElementById("obiectiveMonth").value || new Date().toISOString().slice(0, 7);
  try {
    const r = await fetch(`/api/gt/export-excel?month=${encodeURIComponent(month)}`);
    if (!r.ok) { alert("Eroare la export"); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Raport_GT_Ursus_${month}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (ex) { alert("Eroare: " + ex.message); }
}

async function exportObiectiveExcel() {
  const month = document.getElementById("obiectiveMonth").value || new Date().toISOString().slice(0, 7);
  try {
    const r = await fetch(`/api/obiective/export-excel?month=${encodeURIComponent(month)}`);
    if (!r.ok) { alert("Eroare la export"); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Raport_Obiective_BB_${month}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (ex) { alert("Eroare: " + ex.message); }
}

async function uploadGtCentralizator(fileId, monthId, statusId) {
  const file = document.getElementById(fileId || "gtCentralizatorFile").files[0];
  const month = document.getElementById(monthId || "gtCentralizatorMonth").value;
  const status = document.getElementById(statusId || "gtCentralizatorStatus");
  if (!file) { status.textContent = "Selectează fișier"; return; }
  if (!month) { status.textContent = "Selectează luna"; return; }
  status.textContent = "Se încarcă...";
  const fd = new FormData();
  fd.append("file", file);
  fd.append("month", month);
  try {
    const r = await fetch("/api/gt/upload-centralizator", { method: "POST", body: fd });
    const d = await r.json();
    if (d.ok) {
      status.innerHTML = `✅ ${esc(String(d.targets_imported))} targeturi + ${esc(String(d.sales_updated))} realizări importate`;
      loadGtCentralizator();
    } else status.innerHTML = `❌ ${esc(d.error)}`;
  } catch (ex) { status.innerHTML = `❌ ${esc(ex.message)}`; }
}

/* ═══════════════ CLEANUP TEST DATA (admin only, temporary) ═════════ */
async function cleanupTestData() {
  if (!confirm("⚠️ ATENȚIE: Aceasta va ȘTERGE toate datele de test (vizite, fotografii, propuneri, loguri, notificări, task-uri etc.).\n\nDatele importate din Excel (clienți, vânzări, solduri, targete, cataloage) NU vor fi afectate.\n\nContinui?")) return;
  if (!confirm("🔴 CONFIRMARE FINALĂ: Ești sigur? Acțiunea este ireversibilă!")) return;
  try {
    const r = await fetch("/api/admin/cleanup-test-data", { method: "POST" });
    const data = await r.json();
    if (data.ok) {
      let msg = "✅ Date de test șterse cu succes!\n\n";
      for (const [k, v] of Object.entries(data.report || {})) {
        if (v > 0) msg += `• ${k}: ${v} înregistrări șterse\n`;
      }
      alert(msg);
      location.reload();
    } else {
      alert("❌ Eroare: " + (data.error || "Necunoscută"));
    }
  } catch(e) {
    alert("❌ Eroare: " + e.message);
  }
}

/* ═══════════════════════════════════════════
   SECȚIUNEA DASHBOARD VÂNZĂRI ALL
   ═══════════════════════════════════════════ */

let _dashboardData = null; // Store for Excel export

async function exportDashboardExcel() {
  if (!_dashboardData || !_dashboardData.agents || _dashboardData.agents.length === 0) {
    toast("Nu sunt date de exportat. Încarcă dashboard-ul mai întâi.", "warn");
    return;
  }
  try {
    const r = await fetch("/api/sales-all/export-excel", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": _csrfToken || "" },
      body: JSON.stringify(_dashboardData)
    });
    if (!r.ok) { toast("Eroare la export", "err"); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Dashboard_Vanzari_${_dashboardData.month || "export"}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("Excel exportat!", "ok");
  } catch (ex) { toast("Eroare: " + ex.message, "err"); }
}

async function loadDashboardAll() {
  const monthEl = document.getElementById("dashMonth");
  if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  const month = monthEl.value;

  // Show admin sections
  if (currentRole === "admin") {
    document.getElementById("dashAdminUpload").style.display = "";
    document.getElementById("dashDivisionMgmt").style.display = "";
    loadDivisionConfig();
  }

  const statusEl = document.getElementById("dashDataStatus");
  const summaryEl = document.getElementById("dashSummaryCards");
  const tableEl = document.getElementById("dashTableContainer");
  statusEl.innerHTML = '<span class="spinner" style="width:16px;height:16px;display:inline-block"></span> Se încarcă...';
  summaryEl.innerHTML = "";
  tableEl.innerHTML = "";

  try {
    // Load status
    const stR = await fetch(`/api/sales-all/status?month=${encodeURIComponent(month)}`);
    const st = await stR.json();
    if (st.hasData) {
      const dateRange = st.dates && st.dates.length > 0 ? `${st.dates[0]} → ${st.dates[st.dates.length - 1]}` : "-";
      statusEl.innerHTML = `📊 <b>${fmtNum(st.rows)}</b> rânduri | Zile: <b>${parseInt(st.dates.length)||0}</b> (${esc(dateRange)})`;
    } else {
      statusEl.innerHTML = '⚠️ Nu sunt date încărcate pentru această lună. Importă fișierul de vânzări.';
      return;
    }

    // Load dashboard
    const r = await fetch(`/api/sales-all/dashboard?month=${encodeURIComponent(month)}`);
    const d = await r.json();
    _dashboardData = d; // Store for Excel export
    if (d.error) {
      tableEl.innerHTML = `<p style="text-align:center;color:#E74C3C;padding:1rem">❌ Eroare server: ${esc(d.error)}</p>`;
      return;
    }
    if (!d.agents || d.agents.length === 0) {
      tableEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1rem">Nu sunt date pentru această lună.</p>';
      return;
    }

    // Summary cards — with target info
    const totalTarget = d.agents.reduce((s, a) => s + (a.target_total || 0), 0);
    const pctCompany = totalTarget > 0 ? Math.round(d.companyTotal.val / totalTarget * 100) : 0;
    function pctColor(p) { return p >= 100 ? "#27AE60" : p >= 80 ? "#F39C12" : p >= 50 ? "#E67E22" : "#E74C3C"; }

    let sumHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-bottom:10px">';
    sumHtml += `<div style="background:#e3f2fd;border-radius:8px;padding:10px;border:1px solid var(--border)">
      <div style="font-size:.7rem;color:var(--muted)">REALIZAT / TARGET</div>
      <div style="font-size:1rem;font-weight:700;color:${pctColor(pctCompany)}">${fmtNum(d.companyTotal.val)} / ${fmtNum(totalTarget)} RON</div>
      <div style="font-size:1.1rem;font-weight:700;color:${pctColor(pctCompany)}">${pctCompany}%</div>
    </div>`;
    sumHtml += `<div style="background:#e8f5e9;border-radius:8px;padding:10px;border:1px solid var(--border)">
      <div style="font-size:.7rem;color:var(--muted)">TOTAL HL</div>
      <div style="font-size:1.1rem;font-weight:700;color:#2e7d32">${fmtNum(d.companyTotal.hl)} HL</div>
    </div>`;
    sumHtml += `<div style="background:#fff3e0;border-radius:8px;padding:10px;border:1px solid var(--border)">
      <div style="font-size:.7rem;color:var(--muted)">AGENȚI</div>
      <div style="font-size:1.1rem;font-weight:700;color:#e65100">${d.agents.length}</div>
    </div>`;
    sumHtml += `<div style="background:#f3e5f5;border-radius:8px;padding:10px;border:1px solid var(--border)">
      <div style="font-size:.7rem;color:var(--muted)">PRODUCĂTORI</div>
      <div style="font-size:1.1rem;font-weight:700;color:#6a1b9a">${d.allGama.length}</div>
    </div>`;
    sumHtml += '</div>';
    summaryEl.innerHTML = sumHtml;

    // Build list of targeted producers per agent (union of all)
    const allTargetedProducers = new Set();
    for (const a of d.agents) {
      for (const [g, info] of Object.entries(a.game || {})) {
        if (info.target != null && info.target > 0) allTargetedProducers.add(g);
      }
    }
    // Sort targeted producers, then add remaining by value
    const targetedGama = [...allTargetedProducers].sort();

    // Agent-level cards (each agent = collapsible card with their producers)
    let html = '';
    for (const a of d.agents) {
      const aPct = a.pct_total || 0;
      const aColor = pctColor(aPct);
      const barW = Math.min(aPct, 100);
      html += `<div style="margin:6px 0;border:1px solid var(--border);border-radius:8px;border-left:4px solid ${aColor};overflow:hidden">`;
      html += `<div style="padding:8px 12px;display:flex;justify-content:space-between;align-items:center;background:var(--bg2);cursor:pointer" onclick="this.parentElement.querySelector('.dash-detail').style.display=this.parentElement.querySelector('.dash-detail').style.display==='none'?'':'none'">`;
      html += `<div><strong style="font-size:.85rem">${esc(a.agent_name)}</strong>`;
      html += ` <span style="font-size:.75rem;color:var(--muted)">${fmtNum(a.total_val)} / ${fmtNum(a.target_total || 0)} RON</span></div>`;
      html += `<div style="text-align:right"><span style="font-size:1rem;font-weight:700;color:${aColor}">${aPct}%</span></div>`;
      html += `</div>`;
      // Progress bar
      html += `<div style="height:4px;background:var(--bg)"><div style="width:${barW}%;height:100%;background:${aColor};transition:width .3s"></div></div>`;
      // Detail table (collapsible)
      html += `<div class="dash-detail" style="display:none;padding:6px 10px">`;
      html += '<table style="width:100%;font-size:.75rem;border-collapse:collapse">';
      html += '<tr style="border-bottom:1px solid var(--border);color:var(--muted)"><th style="text-align:left;padding:3px">Producător</th><th style="text-align:right;padding:3px">Target</th><th style="text-align:right;padding:3px">Realizat</th><th style="text-align:right;padding:3px">%</th></tr>';
      // Show all targeted producers for this agent + non-targeted with sales
      const shownGama = new Set();
      // First: producers with targets
      for (const [g, info] of Object.entries(a.game || {}).sort((x, y) => (y[1].target || 0) - (x[1].target || 0))) {
        if (!info.target || info.target <= 0) continue;
        shownGama.add(g);
        const isBuc = info.target_unit === "bucati";
        const realized = isBuc ? info.cant : info.val;
        const tgt = info.target;
        const pct = tgt > 0 ? Math.round(realized / tgt * 100) : 0;
        const pc = pctColor(pct);
        const unit = isBuc ? "buc" : "RON";
        html += `<tr style="border-bottom:1px solid var(--border)">`;
        html += `<td style="padding:3px;font-weight:600">${esc(g)}</td>`;
        html += `<td style="padding:3px;text-align:right">${fmtNum(tgt)} ${unit}</td>`;
        html += `<td style="padding:3px;text-align:right">${fmtNum(Math.round(realized))} ${unit}</td>`;
        html += `<td style="padding:3px;text-align:right;font-weight:700;color:${pc}">${pct}%</td>`;
        html += `</tr>`;
      }
      // Then: non-targeted producers with sales (grouped as "Altele fără target")
      let otherVal = 0;
      for (const [g, info] of Object.entries(a.game || {})) {
        if (shownGama.has(g)) continue;
        if (info.val !== 0) otherVal += info.val;
      }
      if (otherVal !== 0) {
        html += `<tr style="border-bottom:1px solid var(--border);color:var(--muted)"><td style="padding:3px">Altele (fără target)</td><td style="padding:3px;text-align:right">-</td><td style="padding:3px;text-align:right">${fmtNum(Math.round(otherVal))} RON</td><td style="padding:3px;text-align:right">-</td></tr>`;
      }
      // Total row
      html += `<tr style="border-top:2px solid var(--border);font-weight:700"><td style="padding:4px">CIFRA AFACERI</td><td style="padding:4px;text-align:right">${fmtNum(a.target_total || 0)} RON</td><td style="padding:4px;text-align:right">${fmtNum(a.total_val)} RON</td><td style="padding:4px;text-align:right;color:${aColor}">${aPct}%</td></tr>`;
      html += '</table></div></div>';
    }
    tableEl.innerHTML = html;

  } catch (ex) {
    statusEl.innerHTML = `❌ Eroare: ${esc(ex.message)}`;
    tableEl.innerHTML = "";
  }
}

/* Upload fișier vânzări ALL (suprascrie luna) */
async function uploadDashSalesAll() {
  const fileEl = document.getElementById("dashSalesFile");
  const statusEl = document.getElementById("dashUploadStatus");
  if (!fileEl.files[0]) return toast("Selectează fișierul Excel", "warn");
  statusEl.innerHTML = '<span class="spinner" style="width:14px;height:14px;display:inline-block"></span> Se importă... (poate dura 10-30s)';
  const fd = new FormData();
  fd.append("file", fileEl.files[0]);
  const monthEl = document.getElementById("dashMonth");
  if (monthEl.value) fd.append("month", monthEl.value);
  try {
    const r = await fetch("/api/sales-all/upload", { method: "POST", body: fd });
    const d = await r.json();
    if (d.ok) {
      statusEl.textContent = `✅ ${fmtNum(d.count)} rânduri importate (luna ${d.month}). ${d.skipped || 0} filtrate.`;
      toast(`${fmtNum(d.count)} rânduri importate`, "ok");
      loadDashboardAll();
    } else {
      statusEl.textContent = `❌ ${d.error}`;
    }
  } catch (ex) { statusEl.textContent = `❌ ${ex.message}`; }
}

/* Configurare divizii */
async function loadDivisionConfig() {
  const listEl = document.getElementById("dashDivisionList");
  if (!listEl) return;
  try {
    const r = await fetch("/api/divisions");
    const d = await r.json();
    if (!d.users || d.users.length === 0) { listEl.innerHTML = "Nu sunt utilizatori."; return; }
    const divisions = ["", "URSUS"];
    let html = '<table style="width:100%;font-size:.75rem;border-collapse:collapse">';
    html += '<tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:3px">User</th><th style="text-align:left;padding:3px">Rol</th><th style="text-align:left;padding:3px">Divizie</th></tr>';
    for (const u of d.users) {
      html += `<tr style="border-bottom:1px solid var(--border)">`;
      html += `<td style="padding:3px">${esc(u.display_name || u.username)}</td>`;
      html += `<td style="padding:3px">${esc(u.role)}</td>`;
      html += `<td style="padding:3px"><select data-user-id="${u.id}" class="div-select" style="font-size:.75rem;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--fg)">`;
      for (const dv of divisions) {
        html += `<option value="${esc(dv)}" ${u.division === dv ? 'selected' : ''}>${dv || '(nealocat)'}</option>`;
      }
      html += '</select></td></tr>';
    }
    html += '</table>';
    listEl.innerHTML = html;
  } catch (ex) { listEl.innerHTML = `Eroare: ${esc(ex.message)}`; }
}

async function saveDivisions() {
  const statusEl = document.getElementById("dashDivisionStatus");
  const selects = document.querySelectorAll(".div-select");
  const assignments = [];
  selects.forEach(sel => {
    assignments.push({ userId: parseInt(sel.dataset.userId), division: sel.value });
  });
  try {
    const r = await fetch("/api/divisions/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": _csrfToken || "" },
      body: JSON.stringify({ assignments })
    });
    const d = await r.json();
    if (d.ok) { statusEl.textContent = `✅ ${d.count} utilizatori actualizați`; toast("Divizii salvate", "ok"); }
    else statusEl.textContent = `❌ ${d.error}`;
  } catch (ex) { statusEl.textContent = `❌ ${ex.message}`; }
}

/* ═══════════════════════════════════════════════════════════
   CLIENT NOU B2B — Frontend Logic
   ═══════════════════════════════════════════════════════════ */
let _cnEntryId = null;
let _cnCurrentStep = 1;
let _cnFotoLat = null, _cnFotoLon = null;
let _cnDocCUI = null, _cnDocCI = null;

function openClientNouDialog() {
  _cnEntryId = null;
  _cnCurrentStep = 1;
  _cnFotoLat = null; _cnFotoLon = null;
  _cnDocCUI = null; _cnDocCI = null;
  // Reset all inputs
  document.querySelectorAll("#clientNouOverlay input").forEach(i => { i.value = ""; });
  document.getElementById("cnFotoPreview").style.display = "none";
  document.getElementById("cnAnafResult").style.display = "none";
  document.getElementById("cnContractStatus").textContent = "";
  document.getElementById("cnFinalizeErrors").style.display = "none";
  document.getElementById("btnCnFotoCUI").textContent = "📄 Foto CUI";
  document.getElementById("btnCnFotoCI").textContent = "🪪 Foto CI";
  // Show step 1
  cnShowStep(1);
  document.getElementById("clientNouOverlay").style.display = "flex";
}

function closeClientNouDialog() {
  document.getElementById("clientNouOverlay").style.display = "none";
}

function cnShowStep(n) {
  _cnCurrentStep = n;
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById("cnStep" + i);
    if (el) el.style.display = i === n ? "block" : "none";
  }
  // Update step indicators
  document.querySelectorAll("#cnSteps .cn-step").forEach(s => {
    const step = parseInt(s.dataset.step);
    s.classList.remove("active", "done");
    if (step === n) s.classList.add("active");
    else if (step < n) s.classList.add("done");
  });
  // Build summary on step 5
  if (n === 5) cnBuildSummary();
}

function cnNextStep(n) {
  cnShowStep(n);
}

/* ── Step 1: Foto magazin with GPS extraction ── */
async function cnHandleFoto(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  // Preview
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById("cnFotoImg").src = e.target.result;
    document.getElementById("cnFotoPreview").style.display = "block";
  };
  reader.readAsDataURL(file);

  // Extract GPS from EXIF
  _cnFotoLat = null; _cnFotoLon = null;
  try {
    const gps = await cnExtractGPS(file);
    if (gps) {
      _cnFotoLat = gps.lat;
      _cnFotoLon = gps.lon;
      document.getElementById("cnGpsInfo").textContent = `📍 GPS: ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;
    } else {
      document.getElementById("cnGpsInfo").textContent = "⚠ Nu s-au găsit coordonate GPS în imagine";
    }
  } catch { document.getElementById("cnGpsInfo").textContent = "⚠ Eroare extragere GPS"; }
}

function cnExtractGPS(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const view = new DataView(e.target.result);
        // Quick JPEG EXIF parser
        if (view.getUint16(0) !== 0xFFD8) { resolve(null); return; }
        let offset = 2;
        while (offset < view.byteLength - 2) {
          const marker = view.getUint16(offset);
          if (marker === 0xFFE1) { // APP1 (EXIF)
            const exifData = cnParseExif(view, offset + 4);
            resolve(exifData);
            return;
          }
          const size = view.getUint16(offset + 2);
          offset += 2 + size;
        }
        resolve(null);
      } catch { resolve(null); }
    };
    reader.readAsArrayBuffer(file);
  });
}

function cnParseExif(view, start) {
  try {
    // Check "Exif\0\0"
    if (view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0) return null;
    const tiffStart = start + 6;
    const byteOrder = view.getUint16(tiffStart);
    const le = byteOrder === 0x4949; // Intel = little endian
    const g16 = (o) => view.getUint16(tiffStart + o, le);
    const g32 = (o) => view.getUint32(tiffStart + o, le);
    // IFD0
    const ifd0Offset = g32(4);
    const ifd0Count = g16(ifd0Offset);
    let gpsIFDOffset = null;
    for (let i = 0; i < ifd0Count; i++) {
      const entryOff = ifd0Offset + 2 + i * 12;
      if (g16(entryOff) === 0x8825) { // GPSInfoIFDPointer
        gpsIFDOffset = g32(entryOff + 8);
        break;
      }
    }
    if (!gpsIFDOffset) return null;
    // Parse GPS IFD
    const gpsCount = g16(gpsIFDOffset);
    let latRef = "", lonRef = "", latVals = null, lonVals = null;
    for (let i = 0; i < gpsCount; i++) {
      const eo = gpsIFDOffset + 2 + i * 12;
      const tag = g16(eo);
      if (tag === 1) latRef = String.fromCharCode(view.getUint8(tiffStart + eo + 8));
      if (tag === 3) lonRef = String.fromCharCode(view.getUint8(tiffStart + eo + 8));
      if (tag === 2) latVals = cnReadRationals(view, tiffStart, g32(eo + 8), le, 3);
      if (tag === 4) lonVals = cnReadRationals(view, tiffStart, g32(eo + 8), le, 3);
    }
    if (!latVals || !lonVals) return null;
    let lat = latVals[0] + latVals[1] / 60 + latVals[2] / 3600;
    let lon = lonVals[0] + lonVals[1] / 60 + lonVals[2] / 3600;
    if (latRef === "S") lat = -lat;
    if (lonRef === "W") lon = -lon;
    if (lat === 0 && lon === 0) return null;
    return { lat, lon };
  } catch { return null; }
}

function cnReadRationals(view, tiffStart, offset, le, count) {
  const vals = [];
  for (let i = 0; i < count; i++) {
    const num = view.getUint32(tiffStart + offset + i * 8, le);
    const den = view.getUint32(tiffStart + offset + i * 8 + 4, le);
    vals.push(den ? num / den : 0);
  }
  return vals;
}

/* ── Step 2: Verificare ANAF ── */
async function cnVerificaANAF() {
  const cuiInput = document.getElementById("cnCuiInput");
  const cui = cuiInput.value.trim().replace(/\D/g, "");
  if (!cui || cui.length < 2) { toast("Introdu un CUI valid!", "err"); return; }
  const spinner = document.getElementById("cnAnafSpinner");
  const resultDiv = document.getElementById("cnAnafResult");
  const btn = document.getElementById("btnCnAnaf");
  spinner.style.display = "block";
  resultDiv.style.display = "none";
  btn.disabled = true;
  btn.textContent = "⏳ Verificare...";
  try {
    const resp = await fetch("/api/client-nou/verifica-anaf", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": _csrfToken },
      body: JSON.stringify({ cui })
    });
    const res = await resp.json();
    if (res.error) throw new Error(res.error);
    if (!res.found) {
      resultDiv.style.background = "rgba(255,68,68,0.15)";
      resultDiv.style.border = "1px solid #ff4444";
      resultDiv.innerHTML = `<strong style="color:#ff4444">⚠️ CUI ${cui} nu a fost găsit în baza ANAF!</strong>`;
      resultDiv.style.display = "block";
      return;
    }
    const statusColor = res.activa ? "#00c853" : "#ff4444";
    const statusIcon = res.activa ? "✅" : "❌";
    const statusText = res.activa ? "ACTIVĂ" : "INACTIVĂ / RADIATĂ";
    resultDiv.style.background = res.activa ? "rgba(0,200,83,0.1)" : "rgba(255,68,68,0.15)";
    resultDiv.style.border = `1px solid ${statusColor}`;
    resultDiv.innerHTML = `
      <div style="font-weight:700;font-size:1rem;color:${statusColor};margin-bottom:4px">${statusIcon} ${res.denumire_societate}</div>
      <div>CUI: <strong>${res.cui}</strong> · ORC: <strong>${res.orc_nr || "-"}</strong></div>
      <div>Stare: <strong style="color:${statusColor}">${statusText}</strong></div>
      <div style="font-size:.8rem;color:var(--muted);margin-top:2px">${res.stare_inregistrare || ""}</div>
      <div style="font-size:.8rem;color:var(--muted)">TVA: ${res.platitor_tva ? "DA" : "NU"} · CAEN: ${res.cod_CAEN || "-"}</div>
      ${res.sediu_social ? `<div style="font-size:.8rem;margin-top:2px">📍 ${res.sediu_social}</div>` : ""}
    `;
    resultDiv.style.display = "block";
    // Auto-fill form
    if (res.denumire_societate) document.getElementById("cnDenumire").value = res.denumire_societate;
    document.getElementById("cnCui").value = res.cui || cui;
    if (res.orc_nr) document.getElementById("cnOrc").value = res.orc_nr;
    if (res.sediu_social) document.getElementById("cnSediu").value = res.sediu_social;
    if (res.judet) document.getElementById("cnJudet").value = res.judet;
    if (res.telefon) document.getElementById("cnTelefon").value = res.telefon;
    if (res.iban) document.getElementById("cnIban").value = res.iban;
    toast("✅ Date ANAF preluate!", "ok");
  } catch(e) {
    resultDiv.style.background = "rgba(255,68,68,0.15)";
    resultDiv.style.border = "1px solid #ff4444";
    resultDiv.innerHTML = `<strong style="color:#ff4444">Eroare: ${e.message}</strong>`;
    resultDiv.style.display = "block";
  } finally {
    spinner.style.display = "none";
    btn.disabled = false;
    btn.textContent = "🔍 Verifică ANAF";
  }
}

/* ── Step 2: Foto documente (fără OCR) ── */
function cnHandleDocPhoto(input, type) {
  const file = input.files[0];
  if (!file) return;
  if (type === "cui") {
    _cnDocCUI = file;
    document.getElementById("btnCnFotoCUI").textContent = "✅ Foto CUI";
  } else {
    _cnDocCI = file;
    document.getElementById("btnCnFotoCI").textContent = "✅ Foto CI";
  }
  toast(`Foto ${type.toUpperCase()} salvată!`, "ok");
}

/* ── Step 3: Save and go to contracts ── */
async function cnSaveAndNext() {
  const formData = cnCollectFormData();
  // Ensure entry exists
  if (!_cnEntryId) {
    const resp = await fetch("/api/client-nou", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": _csrfToken },
      body: JSON.stringify(formData)
    });
    const data = await resp.json();
    if (!data.ok) { toast(data.error || "Eroare", "err"); return; }
    _cnEntryId = data.entry.id;
  } else {
    const resp = await fetch("/api/client-nou/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": _csrfToken },
      body: JSON.stringify({ id: _cnEntryId, ...formData })
    });
    const data = await resp.json();
    if (!data.ok) { toast(data.error || "Eroare salvare", "err"); return; }
  }
  // Upload foto magazin
  const fotoInput = document.getElementById("cnFotoInput");
  if (fotoInput.files && fotoInput.files[0] && !fotoInput.dataset.uploaded) {
    const fotoFd = new FormData();
    fotoFd.append("photo", fotoInput.files[0]);
    fotoFd.append("client_nou_id", _cnEntryId);
    if (_cnFotoLat) fotoFd.append("foto_lat", _cnFotoLat);
    if (_cnFotoLon) fotoFd.append("foto_lon", _cnFotoLon);
    await fetch("/api/client-nou/upload-foto", { method: "POST", headers: { "X-CSRF-Token": _csrfToken }, body: fotoFd });
    fotoInput.dataset.uploaded = "1";
  }
  // Upload doc photos (no OCR)
  if (_cnDocCUI) {
    const fd = new FormData();
    fd.append("document", _cnDocCUI);
    fd.append("doc_type", "cui");
    fd.append("client_nou_id", _cnEntryId);
    await fetch("/api/client-nou/upload-doc", { method: "POST", headers: { "X-CSRF-Token": _csrfToken }, body: fd });
    _cnDocCUI = null;
  }
  if (_cnDocCI) {
    const fd = new FormData();
    fd.append("document", _cnDocCI);
    fd.append("doc_type", "ci");
    fd.append("client_nou_id", _cnEntryId);
    await fetch("/api/client-nou/upload-doc", { method: "POST", headers: { "X-CSRF-Token": _csrfToken }, body: fd });
    _cnDocCI = null;
  }
  toast("Date salvate", "ok");
  cnShowStep(4);
}

function cnCollectFormData() {
  return {
    denumire_societate: document.getElementById("cnDenumire").value.trim(),
    cui: document.getElementById("cnCui").value.trim(),
    orc_nr: document.getElementById("cnOrc").value.trim(),
    sediu_social: document.getElementById("cnSediu").value.trim(),
    judet: document.getElementById("cnJudet").value.trim(),
    adresa_punct_lucru: document.getElementById("cnPunctLucru").value.trim(),
    administrator: document.getElementById("cnAdmin").value.trim(),
    fidejusor_ci_seria: document.getElementById("cnCiSeria").value.trim(),
    fidejusor_ci_nr: document.getElementById("cnCiNr").value.trim(),
    telefon: document.getElementById("cnTelefon").value.trim(),
    email: document.getElementById("cnEmail").value.trim(),
    iban: document.getElementById("cnIban").value.trim(),
    banca: document.getElementById("cnBanca").value.trim(),
    foto_lat: _cnFotoLat, foto_lon: _cnFotoLon
  };
}

/* ── Step 4: Download contracts ── */
function cnDownloadDoc(type) {
  if (!_cnEntryId) { toast("Salvează datele mai întâi", "warn"); return; }
  const url = `/api/client-nou/${_cnEntryId}/${type}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  document.getElementById("cnContractStatus").textContent = "✅ Contract descărcat";
}

/* ── Step 5: Summary & Finalize ── */
function cnBuildSummary() {
  const d = cnCollectFormData();
  const hasFoto = _cnFotoLat ? "✅" : "⚠";
  const el = document.getElementById("cnSummary");
  const fotoCUI = document.getElementById("btnCnFotoCUI").textContent.includes("✅") ? "✅" : "❌";
  const fotoCI = document.getElementById("btnCnFotoCI").textContent.includes("✅") ? "✅" : "❌";
  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:.85rem">
      <tr><td style="padding:3px 6px;font-weight:600;width:40%">Societate</td><td>${d.denumire_societate || "—"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">CUI</td><td>${d.cui || "—"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">ORC</td><td>${d.orc_nr || "—"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">Sediu</td><td>${d.sediu_social || "—"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">Județ</td><td>${d.judet || "—"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">Administrator</td><td>${d.administrator || "—"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">CI</td><td>${(d.fidejusor_ci_seria + " " + d.fidejusor_ci_nr).trim() || "—"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">Telefon</td><td>${d.telefon || "—"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">Email</td><td>${d.email || "—"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">IBAN</td><td>${d.iban || "—"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">Foto GPS</td><td>${hasFoto} ${_cnFotoLat ? _cnFotoLat.toFixed(4)+", "+_cnFotoLon.toFixed(4) : "Fără GPS"}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">Foto CUI</td><td>${fotoCUI}</td></tr>
      <tr><td style="padding:3px 6px;font-weight:600">Foto CI</td><td>${fotoCI}</td></tr>
    </table>
  `;
}

async function cnFinalize() {
  if (!_cnEntryId) { toast("Nu există entry salvat", "err"); return; }
  const btn = document.getElementById("cnFinalizeBtn");
  btn.disabled = true;
  btn.textContent = "⏳ Se finalizează...";

  try {
    // Save latest data first
    await fetch("/api/client-nou/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": _csrfToken },
      body: JSON.stringify({ id: _cnEntryId, ...cnCollectFormData() })
    });

    const resp = await fetch("/api/client-nou/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": _csrfToken },
      body: JSON.stringify({ id: _cnEntryId })
    });
    const data = await resp.json();

    if (!data.ok) {
      const errEl = document.getElementById("cnFinalizeErrors");
      errEl.style.display = "block";
      errEl.innerHTML = (data.errors || ["Eroare necunoscută"]).map(e => `❌ ${e}`).join("<br>");
      btn.disabled = false;
      btn.textContent = "✅ Finalizează Client Nou";
      return;
    }

    toast(data.message || "Client Nou finalizat!", "ok");
    btn.textContent = "✅ Finalizat!";
    setTimeout(() => closeClientNouDialog(), 2000);
  } catch(e) {
    toast("Eroare: " + e.message, "err");
    btn.disabled = false;
    btn.textContent = "✅ Finalizează Client Nou";
  }
}

/* ═══════════════════════════════════════════
   SECȚIUNEA CONTRACTE B2C — EVENIMENTE PF
   ═══════════════════════════════════════════ */

function openB2CDialog(editData) {
  document.getElementById('b2cId').value = editData ? editData.id : '';
  document.getElementById('b2cNume').value = editData?.nume_complet || '';
  document.getElementById('b2cCNP').value = editData?.cnp || '';
  document.getElementById('b2cCISeria').value = editData?.ci_seria || '';
  document.getElementById('b2cCINr').value = editData?.ci_nr || '';
  document.getElementById('b2cCIEmitent').value = editData?.ci_emitent || '';
  document.getElementById('b2cCIData').value = editData?.ci_data || '';
  document.getElementById('b2cTelefon').value = editData?.telefon || '';
  document.getElementById('b2cEmail').value = editData?.email || '';
  document.getElementById('b2cLocalitate').value = editData?.localitate || '';
  document.getElementById('b2cJudet').value = editData?.judet || '';
  document.getElementById('b2cStrada').value = editData?.strada || '';
  document.getElementById('b2cNrStrada').value = editData?.nr_strada || '';
  document.getElementById('b2cBloc').value = editData?.bloc || '';
  document.getElementById('b2cScara').value = editData?.scara || '';
  document.getElementById('b2cApartament').value = editData?.apartament || '';
  document.getElementById('b2cTipEveniment').value = editData?.tip_eveniment || '';
  document.getElementById('b2cDataEveniment').value = editData?.data_eveniment || '';
  document.getElementById('b2cPret').value = editData?.pret_total || '';
  document.getElementById('b2cIBAN').value = editData?.iban_retur || '';
  document.getElementById('b2cAdresaLivrare').value = editData?.adresa_livrare || '';
  document.getElementById('b2cTransport').value = editData?.suporta_transport || 'Cumpărător';
  document.getElementById('b2cDataLivrare').value = editData?.data_livrare || '';
  document.getElementById('b2cIntervalOrar').value = editData?.interval_orar || '';
  document.getElementById('b2cGDPR').checked = editData?.gdpr_accepted ? true : false;
  document.getElementById('b2cOCRStatus').textContent = '';
  document.getElementById('b2cCIFile').value = '';
  document.getElementById('b2cDialog').showModal();
}
function closeB2CModal() { document.getElementById('b2cDialog').close(); }

async function scanCIforB2C() {
  const fileInput = document.getElementById('b2cCIFile');
  const statusEl = document.getElementById('b2cOCRStatus');
  if (!fileInput.files.length) { statusEl.textContent = '⚠ Selectează o imagine CI!'; statusEl.style.color = '#e74c3c'; return; }
  statusEl.textContent = '⏳ Se procesează OCR...'; statusEl.style.color = 'var(--primary)';
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  try {
    const r = await fetch('/api/contracts-b2c/ocr-preview', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    const ex = d.extracted || {};
    if (ex.fidejusor_nume) document.getElementById('b2cNume').value = ex.fidejusor_nume;
    if (ex.cnp) document.getElementById('b2cCNP').value = ex.cnp;
    if (ex.fidejusor_ci_seria) document.getElementById('b2cCISeria').value = ex.fidejusor_ci_seria;
    if (ex.fidejusor_ci_nr) document.getElementById('b2cCINr').value = ex.fidejusor_ci_nr;
    if (ex.fidejusor_domiciliu) document.getElementById('b2cLocalitate').value = ex.fidejusor_domiciliu;
    const fields = Object.keys(ex).filter(k => ex[k]).length;
    statusEl.textContent = `✅ OCR complet — ${fields} câmpuri extrase`;
    statusEl.style.color = '#27ae60';
  } catch (e) {
    statusEl.textContent = '❌ Eroare OCR: ' + e.message;
    statusEl.style.color = '#e74c3c';
  }
}

function _gatherB2CData() {
  return {
    nume_complet: document.getElementById('b2cNume').value.trim(),
    cnp: document.getElementById('b2cCNP').value.trim(),
    ci_seria: document.getElementById('b2cCISeria').value.trim(),
    ci_nr: document.getElementById('b2cCINr').value.trim(),
    ci_emitent: document.getElementById('b2cCIEmitent').value.trim(),
    ci_data: document.getElementById('b2cCIData').value.trim(),
    telefon: document.getElementById('b2cTelefon').value.trim(),
    email: document.getElementById('b2cEmail').value.trim(),
    localitate: document.getElementById('b2cLocalitate').value.trim(),
    judet: document.getElementById('b2cJudet').value.trim(),
    strada: document.getElementById('b2cStrada').value.trim(),
    nr_strada: document.getElementById('b2cNrStrada').value.trim(),
    bloc: document.getElementById('b2cBloc').value.trim(),
    scara: document.getElementById('b2cScara').value.trim(),
    apartament: document.getElementById('b2cApartament').value.trim(),
    tip_eveniment: document.getElementById('b2cTipEveniment').value,
    data_eveniment: document.getElementById('b2cDataEveniment').value,
    pret_total: document.getElementById('b2cPret').value,
    iban_retur: document.getElementById('b2cIBAN').value.trim(),
    adresa_livrare: document.getElementById('b2cAdresaLivrare').value.trim(),
    suporta_transport: document.getElementById('b2cTransport').value,
    data_livrare: document.getElementById('b2cDataLivrare').value,
    interval_orar: document.getElementById('b2cIntervalOrar').value.trim(),
    gdpr_accepted: document.getElementById('b2cGDPR').checked ? 1 : 0
  };
}

async function saveB2CContract() {
  const data = _gatherB2CData();
  if (!data.nume_complet) { toast('Numele cumpărătorului este obligatoriu!', 'err'); return; }
  if (!data.telefon) { toast('Telefonul este obligatoriu!', 'err'); return; }
  const id = document.getElementById('b2cId').value;
  try {
    let r;
    if (id) {
      r = await fetch(`/api/contracts-b2c/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    } else {
      r = await fetch('/api/contracts-b2c', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    const savedId = id || d.id;
    toast('✅ Contract B2C salvat! Se trimit documentele pe email...', 'ok');
    closeB2CModal();
    loadContractsB2C();

    // Auto-send email if email exists
    if (data.email) {
      try {
        const er = await fetch(`/api/contracts-b2c/${savedId}/send-email`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email: data.email }) });
        const ed = await er.json();
        if (er.ok) {
          toast('📧 Email trimis la ' + data.email, 'ok');
          loadContractsB2C();
        } else {
          toast('⚠ Contract salvat dar email-ul nu s-a trimis: ' + (ed.error || ''), 'err');
        }
      } catch(emailErr) {
        toast('⚠ Contract salvat dar email-ul nu s-a trimis', 'err');
      }
    }
  } catch (e) { toast('Eroare: ' + e.message, 'err'); }
}

async function loadContractsB2C() {
  const listEl = document.getElementById('b2cContractList');
  if (!listEl) return;
  try {
    const r = await fetch('/api/contracts-b2c');
    const rows = await r.json();
    if (!rows.length) { listEl.innerHTML = '<p style="color:var(--muted);padding:1rem;text-align:center">Nu există contracte B2C încă.</p>'; return; }
    listEl.innerHTML = rows.map(c => `
      <div class="module-card" style="border-left-color:#ad1457">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:.85rem">${esc(c.nume_complet || 'Fără nume')}</strong>
          <div style="display:flex;gap:.2rem;align-items:center">
            ${c.email_sent ? '<span class="chip ok" style="font-size:.7rem">📧 Trimis</span>' : '<span class="chip warn" style="font-size:.7rem">📧 Netrimis</span>'}
            <span class="chip ${c.gdpr_accepted ? 'ok' : 'warn'}">${c.gdpr_accepted ? '✅ GDPR' : '⚠ GDPR'}</span>
          </div>
        </div>
        <p style="font-size:.8rem;color:var(--muted)">CNP: ${esc(c.cnp || '-')} • CI: ${esc(c.ci_seria || '')} ${esc(c.ci_nr || '-')}</p>
        <p style="font-size:.8rem">🎉 ${esc(c.tip_eveniment || '-')} ${c.data_eveniment ? '• Data: '+c.data_eveniment : ''} ${c.pret_total ? '• <strong>'+esc(c.pret_total)+' RON</strong>' : ''}</p>
        <p style="font-size:.78rem;color:var(--muted)">Tel: ${esc(c.telefon || '-')} • Email: ${esc(c.email || '-')}</p>
        <p style="font-size:.75rem;color:var(--muted)">Creat de: ${esc(c.created_by)} la ${fmtDate(c.created_at)}</p>
        <div style="display:flex;gap:.3rem;margin-top:.4rem;flex-wrap:wrap">
          <a href="/api/contracts-b2c/${c.id}/download-contract" class="btn primary small" style="text-decoration:none;font-size:.78rem" download>📄 Contract B2C</a>
          <a href="/api/contracts-b2c/${c.id}/download-gdpr" class="btn success small" style="text-decoration:none;font-size:.78rem" download>🔒 Acord GDPR</a>
          <button class="btn ghost small" style="font-size:.78rem" onclick='openB2CDialog(${JSON.stringify(c).replace(/'/g,"&#39;")})'>✏️ Editează</button>
          ${!c.email_sent && c.email ? `<button class="btn small" style="font-size:.78rem;background:#8e24aa;color:#fff" onclick="resendB2CEmail(${c.id})">📧 Trimite email</button>` : ''}
          <button class="btn danger small" style="font-size:.74rem" onclick="deleteB2C(${c.id})">🗑️</button>
        </div>
      </div>
    `).join('');
  } catch(ex) { listEl.innerHTML = `<p style="color:#e74c3c;padding:1rem">Eroare: ${esc(ex.message)}</p>`; }
}

async function resendB2CEmail(id) {
  if (!confirm('Trimiți contractul + GDPR pe email?')) return;
  try {
    const r = await fetch(`/api/contracts-b2c/${id}/send-email`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast('📧 Email trimis la ' + d.sentTo, 'ok');
    loadContractsB2C();
  } catch(e) { toast('Eroare email: ' + e.message, 'err'); }
}

async function deleteB2C(id) {
  if (!confirm('Ștergi acest contract B2C?')) return;
  try {
    await fetch(`/api/contracts-b2c/${id}`, { method: 'DELETE' });
    toast('Contract B2C șters', 'ok');
    loadContractsB2C();
  } catch(e) { toast('Eroare: ' + e.message, 'err'); }
}

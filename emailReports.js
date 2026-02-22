/* ═══════════════════════════════════════════════════════════════
   QMaps Audit BB – Email Report System (Consolidated)
   UN SINGUR EMAIL cu toate rapoartele → toți destinatarii
   ═══════════════════════════════════════════════════════════════ */
const nodemailer = require("nodemailer");
const XLSX_LIB = require("xlsx");

/* ── Config from env ── */
const CFG = {
  enabled:       (process.env.REPORT_AUTOSEND_ENABLED || "0") === "1",
  timezone:      process.env.REPORT_TIMEZONE || "Europe/Bucharest",
  targetHour:    parseInt(process.env.REPORT_TARGET_HOUR || "20", 10),
  monthlyDay:    parseInt(process.env.REPORT_MONTHLY_DAY || "1", 10),
  emailFrom:     process.env.REPORT_EMAIL_FROM || "",
  /* TOȚI destinatarii într-o singură listă (eliminăm duplicatele) */
  emailTo:       [...new Set([
    ...(process.env.REPORT_EMAIL_TO || "raportzilnic@quatrogrup.com,ibrian@quatrogrup.com,florin.rata@quatrogrup.com").split(",").map(s => s.trim()).filter(Boolean),
    ...(process.env.GPS_EMAIL_TO || "popa.stefan@quatrogrup.com").split(",").map(s => s.trim()).filter(Boolean)
  ])],
  smtpHost:      process.env.REPORT_SMTP_HOST || "",
  smtpPort:      parseInt(process.env.REPORT_SMTP_PORT || "587", 10),
  smtpUser:      process.env.REPORT_SMTP_USER || "",
  smtpPass:      process.env.REPORT_SMTP_PASS || "",
  smtpStartTLS:  (process.env.REPORT_SMTP_STARTTLS || "true") === "true"
};

/* Persist last-sent dates in DB to survive Render restarts */
let lastDailySent = "";
let lastMonthlySent = "";

function loadLastSent(db) {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_schedule_state (key TEXT PRIMARY KEY, value TEXT)");
    const daily = db.prepare("SELECT value FROM email_schedule_state WHERE key='lastDailySent'").get();
    const monthly = db.prepare("SELECT value FROM email_schedule_state WHERE key='lastMonthlySent'").get();
    if (daily) lastDailySent = daily.value;
    if (monthly) lastMonthlySent = monthly.value;
    console.log(`[Email] Loaded schedule state: daily=${lastDailySent}, monthly=${lastMonthlySent}`);
  } catch (e) { console.error("[Email] loadLastSent error:", e.message); }
}

function saveLastSent(db) {
  try {
    db.prepare("INSERT OR REPLACE INTO email_schedule_state (key, value) VALUES ('lastDailySent', ?)").run(lastDailySent);
    db.prepare("INSERT OR REPLACE INTO email_schedule_state (key, value) VALUES ('lastMonthlySent', ?)").run(lastMonthlySent);
  } catch (e) { console.error("[Email] saveLastSent error:", e.message); }
}

/* ── SMTP Transport ── */
function createTransport() {
  if (!CFG.smtpHost || !CFG.smtpUser) return null;
  return nodemailer.createTransport({
    host: CFG.smtpHost,
    port: CFG.smtpPort,
    secure: CFG.smtpPort === 465,
    auth: { user: CFG.smtpUser, pass: CFG.smtpPass },
    tls: { rejectUnauthorized: false }
  });
}

/* ── Date helpers ── */
function nowInRomania() {
  const d = new Date();
  const str = d.toLocaleString("en-US", { timeZone: CFG.timezone });
  return new Date(str);
}

function todayStr() {
  const d = nowInRomania();
  return d.toISOString().slice(0, 10);
}

/* ── Haversine distance in meters ── */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ═══════════════════════════════════════════
   GPS HELPERS: client proximity matching
   ═══════════════════════════════════════════ */

function loadClientCoords(db) {
  return db.prepare(`
    SELECT id, code, firma, nume_poc, oras, lat, lon, agent
    FROM clients WHERE lat IS NOT NULL AND lon IS NOT NULL AND lat != 0 AND lon != 0
  `).all();
}

function findNearestClient(lat, lon, clientCoords) {
  if (!lat || !lon || !clientCoords || clientCoords.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of clientCoords) {
    const d = haversine(lat, lon, c.lat, c.lon);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  if (bestDist > 500) return { firma: "", oras: best ? best.oras : "", distance_m: Math.round(bestDist), inTransit: true };
  return { firma: best.firma, oras: best.oras, code: best.code, distance_m: Math.round(bestDist), inTransit: false };
}

/* ═══════════════════════════════════════════
   DATA GATHERING: AUDIT
   ═══════════════════════════════════════════ */

function gatherDailyData(db, date, getProductsForClient) {
  const visits = db.prepare(`
    SELECT v.*, c.code, c.firma, c.nume_poc, c.oras, c.agent, c.sales_rep,
           c.format, c.subformat, c.canal, c.lat AS client_lat, c.lon AS client_lon,
           c.stare_poc, c.municipality, c.email, c.telefon
    FROM visits v JOIN clients c ON v.client_id = c.id
    WHERE date(v.visited_at) = ?
    ORDER BY c.agent, v.visited_at
  `).all(date);

  const totalClients = db.prepare("SELECT COUNT(*) as c FROM clients").get().c;

  const byAgent = {};
  for (const v of visits) {
    const ag = v.agent || "NEALOCATI";
    if (!byAgent[ag]) byAgent[ag] = { visits: 0, withPhoto: 0, closed: 0, scores: [], gpsOk: 0, gpsLipsa: 0, over5m: 0 };
    byAgent[ag].visits++;
    if (v.photo_path) byAgent[ag].withPhoto++;
    if (v.closed_at) {
      byAgent[ag].closed++;
      byAgent[ag].scores.push(v.score);
    }
    if (v.photo_lat && v.photo_lon && v.client_lat && v.client_lon) {
      const dist = haversine(v.photo_lat, v.photo_lon, v.client_lat, v.client_lon);
      byAgent[ag].gpsOk++;
      if (dist > 5) byAgent[ag].over5m++;
    } else {
      byAgent[ag].gpsLipsa++;
    }
  }

  for (const ag of Object.keys(byAgent)) {
    const s = byAgent[ag];
    s.avgScore = s.scores.length ? Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length) : 0;
  }

  const auditRows = visits.filter(v => v.closed_at).map(v => {
    const products = getProductsForClient(v.canal, v.subformat, v.code);
    const ownProducts = products.filter(p => p.requirement.toUpperCase() !== "X");
    const present = JSON.parse(v.products_json || "[]");
    const presentSet = new Set(present);
    const missing = ownProducts.filter(p => !presentSet.has(p.product)).map(p => p.product);
    const dist = (v.photo_lat && v.photo_lon && v.client_lat && v.client_lon)
      ? Math.round(haversine(v.photo_lat, v.photo_lon, v.client_lat, v.client_lon))
      : null;
    return {
      code: v.code, firma: v.firma, numePoc: v.nume_poc, oras: v.oras,
      agentDTR: v.agent, email: v.email || '', telefon: v.telefon || '', canal: v.canal, format: v.format,
      subformat: v.subformat, visitedAt: v.visited_at, photoPath: v.photo_path ? "DA" : "NU",
      totalRequired: v.total_required, totalPresent: v.total_present, score: v.score,
      missingProducts: missing.join("; "), distanceM: dist,
      gpsFlag: dist === null ? "GPS LIPSA" : dist > 5 ? "DEPASIRE >5m" : "OK"
    };
  });

  const incasariRows = db.prepare(`
    SELECT i.agent_dtr, i.suma, u.display_name
    FROM incasari i LEFT JOIN users u ON i.user_id = u.id
    WHERE i.data = ?
  `).all(date);

  const allAgents = db.prepare("SELECT sales_rep, display_name FROM users WHERE role = 'agent'").all();
  const incasariMap = {};
  for (const row of incasariRows) incasariMap[row.agent_dtr] = row;
  const incasariTotal = incasariRows.reduce((s, r) => s + (r.suma || 0), 0);
  const incasariCompletati = incasariRows.length;

  return { date, visits, totalClients, byAgent, auditRows, incasari: { rows: incasariRows, allAgents, map: incasariMap, total: incasariTotal, completati: incasariCompletati } };
}

function gatherMonthlyData(db, month, getProductsForClient) {
  const visits = db.prepare(`
    SELECT v.*, c.code, c.firma, c.nume_poc, c.oras, c.agent, c.sales_rep,
           c.format, c.subformat, c.canal, c.lat AS client_lat, c.lon AS client_lon,
           c.stare_poc, c.municipality, c.email, c.telefon
    FROM visits v JOIN clients c ON v.client_id = c.id
    WHERE strftime('%Y-%m', v.visited_at) = ?
    ORDER BY c.agent, v.visited_at
  `).all(month);

  const totalClients = db.prepare("SELECT COUNT(*) as c FROM clients").get().c;
  const visitedIds = new Set(visits.map(v => v.client_id));

  const byAgent = {};
  for (const v of visits) {
    const ag = v.agent || "NEALOCATI";
    if (!byAgent[ag]) byAgent[ag] = { visits: 0, withPhoto: 0, closed: 0, scores: [], uniqueClients: new Set() };
    byAgent[ag].visits++;
    byAgent[ag].uniqueClients.add(v.client_id);
    if (v.photo_path) byAgent[ag].withPhoto++;
    if (v.closed_at) { byAgent[ag].closed++; byAgent[ag].scores.push(v.score); }
  }

  for (const ag of Object.keys(byAgent)) {
    const s = byAgent[ag];
    s.avgScore = s.scores.length ? Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length) : 0;
    s.uniqueCount = s.uniqueClients.size;
  }

  const auditRows = visits.filter(v => v.closed_at).map(v => {
    const products = getProductsForClient(v.canal, v.subformat, v.code);
    const ownProducts = products.filter(p => p.requirement.toUpperCase() !== "X");
    const present = JSON.parse(v.products_json || "[]");
    const presentSet = new Set(present);
    const missing = ownProducts.filter(p => !presentSet.has(p.product)).map(p => p.product);
    const dist = (v.photo_lat && v.photo_lon && v.client_lat && v.client_lon)
      ? Math.round(haversine(v.photo_lat, v.photo_lon, v.client_lat, v.client_lon)) : null;
    return {
      code: v.code, firma: v.firma, numePoc: v.nume_poc, oras: v.oras,
      agentDTR: v.agent, email: v.email || '', telefon: v.telefon || '', canal: v.canal, format: v.format,
      subformat: v.subformat, visitedAt: v.visited_at, photoPath: v.photo_path ? "DA" : "NU",
      totalRequired: v.total_required, totalPresent: v.total_present, score: v.score,
      missingProducts: missing.join("; "), distanceM: dist,
      gpsFlag: dist === null ? "GPS LIPSA" : dist > 5 ? "DEPASIRE >5m" : "OK"
    };
  });

  const incasariMonthly = db.prepare(`
    SELECT i.agent_dtr, SUM(i.suma) AS total_suma, COUNT(*) AS zile_raportate,
           ROUND(AVG(i.suma), 2) AS media_zilnica, u.display_name
    FROM incasari i LEFT JOIN users u ON i.user_id = u.id
    WHERE strftime('%Y-%m', i.data) = ?
    GROUP BY i.agent_dtr
  `).all(month);

  const incasariGrandTotal = incasariMonthly.reduce((s, r) => s + (r.total_suma || 0), 0);

  return { month, visits, totalClients, visitedClients: visitedIds.size, byAgent, auditRows, incasari: { agents: incasariMonthly, grandTotal: incasariGrandTotal } };
}

/* ═══════════════════════════════════════════
   DATA GATHERING: GPS
   ═══════════════════════════════════════════ */

function gatherDailyGpsData(db, date) {
  const clientCoords = loadClientCoords(db);
  const points = db.prepare(`
    SELECT g.*, u.display_name
    FROM gps_locations g LEFT JOIN users u ON g.username = u.username
    WHERE date(g.recorded_at) = ?
    ORDER BY g.agent_name, g.recorded_at
  `).all(date);

  for (const p of points) {
    const nearest = findNearestClient(p.lat, p.lon, clientCoords);
    p.nearestClient = nearest ? nearest.firma : "";
    p.nearestOras = nearest ? nearest.oras : "";
    p.nearestDist = nearest ? nearest.distance_m : null;
    p.inTransit = nearest ? nearest.inTransit : true;
    if (nearest && !nearest.inTransit) {
      p.locationLabel = `${nearest.firma} (${nearest.oras})`;
    } else if (nearest && nearest.oras) {
      p.locationLabel = `In deplasare — ${nearest.oras}`;
    } else {
      p.locationLabel = `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
    }
  }

  const byAgent = {};
  for (const p of points) {
    const ag = p.agent_name || p.username;
    if (!byAgent[ag]) byAgent[ag] = { username: p.username, display_name: p.display_name || ag, points: [] };
    byAgent[ag].points.push(p);
  }

  for (const ag of Object.keys(byAgent)) {
    const pts = byAgent[ag].points;
    let totalDist = 0;
    for (let i = 1; i < pts.length; i++) totalDist += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    byAgent[ag].totalDistanceKm = Math.round(totalDist / 100) / 10;
    byAgent[ag].pointCount = pts.length;
    byAgent[ag].firstTime = pts[0]?.recorded_at || "";
    byAgent[ag].lastTime = pts[pts.length - 1]?.recorded_at || "";
    byAgent[ag].firstLocation = pts[0]?.locationLabel || "";
    byAgent[ag].lastLocation = pts[pts.length - 1]?.locationLabel || "";
    const clientsNearby = new Set(pts.filter(p => !p.inTransit && p.nearestClient).map(p => p.nearestClient));
    byAgent[ag].clientsNearGps = clientsNearby.size;
  }

  const visitCounts = db.prepare(`SELECT agent, COUNT(DISTINCT client_id) as cnt FROM visits_checkin WHERE visit_date=? GROUP BY agent`).all(date);
  const vcMap = {};
  visitCounts.forEach(v => vcMap[v.agent] = v.cnt);
  for (const ag of Object.keys(byAgent)) byAgent[ag].visitsToday = vcMap[ag] || 0;

  return { date, byAgent, totalAgents: Object.keys(byAgent).length };
}

function gatherMonthlyGpsData(db, month) {
  const clientCoords = loadClientCoords(db);
  const days = db.prepare(`SELECT DISTINCT date(recorded_at) AS day FROM gps_locations WHERE strftime('%Y-%m', recorded_at) = ? ORDER BY day`).all(month);

  const agentDays = db.prepare(`
    SELECT agent_name, date(recorded_at) AS day, COUNT(*) AS points,
           MIN(recorded_at) AS first_time, MAX(recorded_at) AS last_time
    FROM gps_locations WHERE strftime('%Y-%m', recorded_at) = ?
    GROUP BY agent_name, date(recorded_at) ORDER BY agent_name, day
  `).all(month);

  const byAgent = {};
  for (const row of agentDays) {
    if (!byAgent[row.agent_name]) byAgent[row.agent_name] = { days: [], totalPoints: 0, totalDistKm: 0, activeDays: 0 };
    const firstPt = db.prepare(`SELECT lat, lon FROM gps_locations WHERE agent_name=? AND date(recorded_at)=? ORDER BY recorded_at ASC LIMIT 1`).get(row.agent_name, row.day);
    const lastPt = db.prepare(`SELECT lat, lon FROM gps_locations WHERE agent_name=? AND date(recorded_at)=? ORDER BY recorded_at DESC LIMIT 1`).get(row.agent_name, row.day);
    const pts = db.prepare(`SELECT lat, lon FROM gps_locations WHERE agent_name=? AND date(recorded_at)=? ORDER BY recorded_at`).all(row.agent_name, row.day);
    let dist = 0;
    for (let i = 1; i < pts.length; i++) dist += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    const distKm = Math.round(dist / 100) / 10;

    const firstNearest = firstPt ? findNearestClient(firstPt.lat, firstPt.lon, clientCoords) : null;
    const lastNearest = lastPt ? findNearestClient(lastPt.lat, lastPt.lon, clientCoords) : null;
    const firstLabel = firstNearest && !firstNearest.inTransit ? `${firstNearest.firma} (${firstNearest.oras})` : (firstNearest && firstNearest.oras ? firstNearest.oras : "");
    const lastLabel = lastNearest && !lastNearest.inTransit ? `${lastNearest.firma} (${lastNearest.oras})` : (lastNearest && lastNearest.oras ? lastNearest.oras : "");

    byAgent[row.agent_name].days.push({ day: row.day, points: row.points, distKm, firstTime: row.first_time, lastTime: row.last_time, firstLocation: firstLabel, lastLocation: lastLabel });
    byAgent[row.agent_name].totalPoints += row.points;
    byAgent[row.agent_name].totalDistKm += distKm;
    byAgent[row.agent_name].activeDays++;
  }

  const visitCounts = db.prepare(`SELECT agent, COUNT(DISTINCT client_id || visit_date) as total_visits, COUNT(DISTINCT visit_date) as visit_days FROM visits_checkin WHERE strftime('%Y-%m', visit_date) = ? GROUP BY agent`).all(month);
  const vcMap = {};
  visitCounts.forEach(v => vcMap[v.agent] = v);
  for (const ag of Object.keys(byAgent)) {
    byAgent[ag].totalVisits = vcMap[ag]?.total_visits || 0;
    byAgent[ag].visitDays = vcMap[ag]?.visit_days || 0;
  }

  return { month, days: days.map(d => d.day), byAgent, totalAgents: Object.keys(byAgent).length };
}

/* ═══════════════════════════════════════════
   DATA GATHERING: EXPIRARI
   ═══════════════════════════════════════════ */

function gatherDailyExpiryData(db, date) {
  const rows = db.prepare(`
    SELECT er.*, c.firma, c.nume_poc, c.oras, c.agent,
           u.display_name AS reporter_name
    FROM expiry_reports er
    LEFT JOIN clients c ON er.client_id = c.id
    LEFT JOIN users u ON er.reported_by = u.username
    WHERE er.status != 'resolved'
    ORDER BY er.expiry_date ASC
  `).all();

  const reportedToday = db.prepare(`
    SELECT er.*, c.firma, c.nume_poc, c.oras, c.agent,
           u.display_name AS reporter_name
    FROM expiry_reports er
    LEFT JOIN clients c ON er.client_id = c.id
    LEFT JOIN users u ON er.reported_by = u.username
    WHERE date(er.reported_at) = ?
    ORDER BY er.expiry_date ASC
  `).all(date);

  const today = date;
  for (const r of rows) {
    if (r.expiry_date <= today) {
      r.expiryStatus = "EXPIRAT";
    } else {
      const daysLeft = Math.ceil((new Date(r.expiry_date) - new Date(today)) / 86400000);
      r.daysLeft = daysLeft;
      r.expiryStatus = daysLeft <= 30 ? "TERMEN SCURT" : "OK";
    }
  }

  return { date, activeReports: rows, reportedToday, totalActive: rows.length, totalExpired: rows.filter(r => r.expiryStatus === "EXPIRAT").length, totalSoon: rows.filter(r => r.expiryStatus === "TERMEN SCURT").length };
}

function gatherMonthlyExpiryData(db, month) {
  const reported = db.prepare(`
    SELECT er.*, c.firma, c.nume_poc, c.oras, c.agent,
           u.display_name AS reporter_name
    FROM expiry_reports er
    LEFT JOIN clients c ON er.client_id = c.id
    LEFT JOIN users u ON er.reported_by = u.username
    WHERE strftime('%Y-%m', er.reported_at) = ?
    ORDER BY er.expiry_date ASC
  `).all(month);

  const resolved = db.prepare(`
    SELECT er.*, c.firma, c.oras, c.agent
    FROM expiry_reports er LEFT JOIN clients c ON er.client_id = c.id
    WHERE strftime('%Y-%m', er.resolved_at) = ?
  `).all(month);

  const stillActive = db.prepare(`
    SELECT er.*, c.firma, c.nume_poc, c.oras, c.agent,
           u.display_name AS reporter_name
    FROM expiry_reports er
    LEFT JOIN clients c ON er.client_id = c.id
    LEFT JOIN users u ON er.reported_by = u.username
    WHERE er.status != 'resolved'
    ORDER BY er.expiry_date ASC
  `).all();

  const lastDay = `${month}-31`;
  for (const r of stillActive) {
    if (r.expiry_date <= lastDay) {
      r.expiryStatus = "EXPIRAT";
    } else {
      const daysLeft = Math.ceil((new Date(r.expiry_date) - new Date(lastDay)) / 86400000);
      r.daysLeft = daysLeft;
      r.expiryStatus = daysLeft <= 30 ? "TERMEN SCURT" : "OK";
    }
  }

  return { month, reported, resolved, stillActive, totalReported: reported.length, totalResolved: resolved.length, totalStillActive: stillActive.length };
}

/* ═══════════════════════════════════════════
   EXCEL GENERATION
   ═══════════════════════════════════════════ */

/* ── Helper: create sheet from array-of-arrays with column widths ── */
function makeSheet(data, colWidths) {
  const ws = XLSX_LIB.utils.aoa_to_sheet(data);
  if (colWidths) ws["!cols"] = colWidths.map(w => ({ wch: w }));
  return ws;
}

/* ── DAILY: Audit + Incasari Excel ── */
function buildDailyAuditExcel(data) {
  const wb = XLSX_LIB.utils.book_new();

  // Sheet 1: Sumar Zilnic
  const s1 = [["Agent DTR", "Vizite", "Cu Poza", "Audit Complet", "Scor Mediu %", "GPS OK", "GPS Lipsa", "Depasire >5m"]];
  for (const [ag, s] of Object.entries(data.byAgent)) {
    s1.push([ag, s.visits, s.withPhoto, s.closed, s.avgScore, s.gpsOk, s.gpsLipsa, s.over5m]);
  }
  s1.push([]);
  s1.push(["TOTAL", data.visits.length, data.visits.filter(v => v.photo_path).length, data.visits.filter(v => v.closed_at).length]);
  XLSX_LIB.utils.book_append_sheet(wb, makeSheet(s1, [35, 10, 10, 14, 14, 10, 12, 14]), "Sumar Zilnic");

  // Sheet 2: Audit Detaliat
  const s2 = [["Cod", "Firma", "Nume POC", "Oras", "Agent DTR", "Email", "Telefon", "Canal", "Format", "SubFormat", "Data Vizita", "Poza", "Cerute", "Prezente", "Scor %", "Produse Lipsa", "Distanta (m)", "GPS Status"]];
  for (const r of data.auditRows) s2.push([r.code, r.firma, r.numePoc, r.oras, r.agentDTR, r.email, r.telefon, r.canal, r.format, r.subformat, r.visitedAt, r.photoPath, r.totalRequired, r.totalPresent, r.score, r.missingProducts, r.distanceM, r.gpsFlag]);
  XLSX_LIB.utils.book_append_sheet(wb, makeSheet(s2, [12, 25, 25, 15, 35, 25, 16, 12, 15, 15, 18, 8, 10, 10, 10, 40, 14, 14]), "Audit Detaliat");

  // Sheet 3: Incasari
  if (data.incasari) {
    const s3 = [["Agent DTR", "Nume", "Suma Incasata (lei)", "Completat"]];
    for (const ag of data.incasari.allAgents) {
      const inc = data.incasari.map[ag.sales_rep];
      s3.push([ag.sales_rep, ag.display_name || ag.sales_rep, inc ? inc.suma : 0, inc ? "DA" : "NU"]);
    }
    s3.push([]);
    s3.push(["TOTAL", "", data.incasari.total, `${data.incasari.completati}/${data.incasari.allAgents.length}`]);
    XLSX_LIB.utils.book_append_sheet(wb, makeSheet(s3, [35, 25, 20, 12]), "Incasari Zilnice");
  }

  return XLSX_LIB.write(wb, { type: "buffer", bookType: "xlsx" });
}

/* ── DAILY: GPS Excel ── */
function buildDailyGpsExcel(data) {
  const wb = XLSX_LIB.utils.book_new();

  const s1 = [["Agent", "Puncte GPS", "Distanta (km)", "Prima locatie", "Ora start", "Ultima locatie", "Ora final", "Vizite azi", "Clienti detectati GPS"]];
  for (const [ag, s] of Object.entries(data.byAgent)) {
    const firstHour = s.firstTime ? s.firstTime.split(" ")[1] || "" : "";
    const lastHour = s.lastTime ? s.lastTime.split(" ")[1] || "" : "";
    s1.push([ag, s.pointCount, s.totalDistanceKm, s.firstLocation, firstHour, s.lastLocation, lastHour, s.visitsToday, s.clientsNearGps]);
  }
  XLSX_LIB.utils.book_append_sheet(wb, makeSheet(s1, [35, 12, 14, 35, 12, 35, 12, 12, 18]), "Sumar GPS Zilnic");

  const s2 = [["Agent", "Ora", "Locatie", "Client apropiat", "Oras", "Dist. client (m)", "Latitudine", "Longitudine", "Acuratete (m)", "Viteza", "Google Maps"]];
  for (const [ag, s] of Object.entries(data.byAgent)) {
    for (const p of s.points) {
      s2.push([ag, p.recorded_at, p.locationLabel, p.inTransit ? "—" : p.nearestClient, p.nearestOras || "", p.nearestDist, p.lat, p.lon, p.accuracy, p.speed, `https://www.google.com/maps?q=${p.lat},${p.lon}`]);
    }
  }
  XLSX_LIB.utils.book_append_sheet(wb, makeSheet(s2, [35, 20, 40, 30, 18, 16, 12, 12, 14, 10, 45]), "Traseu Detaliat");

  return XLSX_LIB.write(wb, { type: "buffer", bookType: "xlsx" });
}

/* ── DAILY: Expirari Excel ── */
function buildDailyExpiryExcel(expiryData) {
  const wb = XLSX_LIB.utils.book_new();
  addExpirySheetToWorkbook(wb, expiryData, "Expirari Active");
  return XLSX_LIB.write(wb, { type: "buffer", bookType: "xlsx" });
}

function addExpirySheetToWorkbook(wb, expiryData, sheetName) {
  if (!expiryData || expiryData.activeReports.length === 0) return;
  const data = [["Status", "Produs", "Firma", "Oras", "Agent", "Lot", "Data Expirare", "Cantitate", "Actiune", "Raportat de", "Data Raportare", "Note"]];
  for (const r of expiryData.activeReports) {
    const statusLabel = r.expiryStatus === "EXPIRAT" ? "EXPIRAT" : r.expiryStatus === "TERMEN SCURT" ? "TERMEN SCURT" : "OK";
    data.push([statusLabel, r.product_name, r.firma || "", r.oras || "", r.agent || "", r.batch_number || "", r.expiry_date, r.quantity || 0, r.action_needed || "", r.reporter_name || r.reported_by || "", r.reported_at || "", r.notes || ""]);
  }
  data.push([]);
  data.push(["TOTAL", `${expiryData.totalExpired} expirate | ${expiryData.totalSoon} termen scurt | ${expiryData.totalActive} active`]);
  XLSX_LIB.utils.book_append_sheet(wb, makeSheet(data, [16, 25, 25, 15, 35, 15, 14, 12, 14, 20, 18, 30]), sheetName || "Expirari Active");
}

/* ── MONTHLY: Audit + Incasari Excel ── */
function buildMonthlyAuditExcel(data) {
  const wb = XLSX_LIB.utils.book_new();

  const s1 = [["Agent DTR", "Clienti Unici", "Total Vizite", "Cu Poza", "Audit Complet", "Scor Mediu %"]];
  for (const [ag, s] of Object.entries(data.byAgent)) {
    s1.push([ag, s.uniqueCount, s.visits, s.withPhoto, s.closed, s.avgScore]);
  }
  s1.push([]);
  s1.push(["TOTAL", data.visitedClients, data.visits.length, data.visits.filter(v => v.photo_path).length, data.visits.filter(v => v.closed_at).length]);
  XLSX_LIB.utils.book_append_sheet(wb, makeSheet(s1, [35, 14, 12, 10, 14, 14]), "Sumar Lunar");

  const s2 = [["Cod", "Firma", "Nume POC", "Oras", "Agent DTR", "Email", "Telefon", "Canal", "Format", "SubFormat", "Data Vizita", "Poza", "Cerute", "Prezente", "Scor %", "Produse Lipsa", "Distanta (m)", "GPS Status"]];
  for (const r of data.auditRows) s2.push([r.code, r.firma, r.numePoc, r.oras, r.agentDTR, r.email, r.telefon, r.canal, r.format, r.subformat, r.visitedAt, r.photoPath, r.totalRequired, r.totalPresent, r.score, r.missingProducts, r.distanceM, r.gpsFlag]);
  XLSX_LIB.utils.book_append_sheet(wb, makeSheet(s2, [12, 25, 25, 15, 35, 25, 16, 12, 15, 15, 18, 8, 10, 10, 10, 40, 14, 14]), "Audit Detaliat");

  if (data.incasari) {
    const s3 = [["Agent DTR", "Nume", "Total Incasat (lei)", "Zile Raportate", "Media Zilnica (lei)"]];
    for (const ag of data.incasari.agents) {
      s3.push([ag.agent_dtr, ag.display_name || ag.agent_dtr, ag.total_suma, ag.zile_raportate, ag.media_zilnica]);
    }
    s3.push([]);
    s3.push(["TOTAL", "", data.incasari.grandTotal]);
    XLSX_LIB.utils.book_append_sheet(wb, makeSheet(s3, [35, 25, 20, 16, 20]), "Incasari Lunare");
  }

  return wb;
}

/* ── MONTHLY: GPS Excel ── */
function buildMonthlyGpsExcel(data) {
  const wb = XLSX_LIB.utils.book_new();

  const s1 = [["Agent", "Zile Active", "Total Puncte", "Distanta Tot. (km)", "Media Dist/zi (km)", "Total Vizite", "Zile cu Vizite"]];
  for (const [ag, s] of Object.entries(data.byAgent)) {
    s1.push([ag, s.activeDays, s.totalPoints, Math.round(s.totalDistKm * 10) / 10, s.activeDays > 0 ? Math.round(s.totalDistKm / s.activeDays * 10) / 10 : 0, s.totalVisits, s.visitDays]);
  }
  XLSX_LIB.utils.book_append_sheet(wb, makeSheet(s1, [35, 14, 14, 18, 18, 14, 14]), "Sumar GPS Lunar");

  const s2 = [["Agent", "Ziua", "Puncte GPS", "Distanta (km)", "Prima locatie", "Ora start", "Ultima locatie", "Ora final"]];
  for (const [ag, s] of Object.entries(data.byAgent)) {
    for (const d of s.days) {
      const firstHour = d.firstTime ? d.firstTime.split(" ")[1] || "" : "";
      const lastHour = d.lastTime ? d.lastTime.split(" ")[1] || "" : "";
      s2.push([ag, d.day, d.points, d.distKm, d.firstLocation || "", firstHour, d.lastLocation || "", lastHour]);
    }
  }
  XLSX_LIB.utils.book_append_sheet(wb, makeSheet(s2, [35, 14, 12, 14, 35, 12, 35, 12]), "GPS pe Zile");

  return XLSX_LIB.write(wb, { type: "buffer", bookType: "xlsx" });
}

/* ═══════════════════════════════════════════
   EMAIL TEXT BUILDERS (CONSOLIDATED)
   ═══════════════════════════════════════════ */

function buildDailyEmailText(auditData, gpsData, expiryData) {
  const closedVisits = auditData.visits.filter(v => v.closed_at);
  const avgScore = closedVisits.length ? Math.round(closedVisits.reduce((s, v) => s + v.score, 0) / closedVisits.length) : 0;
  const coverage = auditData.totalClients ? ((auditData.visits.length / auditData.totalClients) * 100).toFixed(1) : "0";

  let text = `══════════════════════════════════════\n`;
  text += `  QMAPS AUDIT BB - RAPORT ZILNIC CONSOLIDAT\n`;
  text += `  Data: ${auditData.date}\n`;
  text += `══════════════════════════════════════\n\n`;

  // AUDIT
  text += `═══ AUDIT VIZITE ═══\n`;
  text += `Total vizite: ${auditData.visits.length} | Cu poza: ${auditData.visits.filter(v => v.photo_path).length} | Audit complet: ${closedVisits.length}\n`;
  text += `Scor mediu: ${avgScore}% | Acoperire: ${coverage}% (${auditData.visits.length}/${auditData.totalClients})\n\n`;
  for (const [ag, s] of Object.entries(auditData.byAgent)) {
    text += `  ${ag}: ${s.visits} viz. | ${s.withPhoto} poze | ${s.closed} audit | scor ${s.avgScore}%`;
    if (s.gpsLipsa > 0) text += ` | GPS lipsa: ${s.gpsLipsa}`;
    if (s.over5m > 0) text += ` | >5m: ${s.over5m}`;
    text += `\n`;
  }

  // INCASARI
  if (auditData.incasari) {
    text += `\n═══ INCASARI NUMERAR ═══\n`;
    text += `Total: ${auditData.incasari.total.toFixed(2)} lei | Completati: ${auditData.incasari.completati}/${auditData.incasari.allAgents.length}\n`;
    for (const ag of auditData.incasari.allAgents) {
      const inc = auditData.incasari.map[ag.sales_rep];
      text += `  ${ag.display_name || ag.sales_rep}: ${inc ? inc.suma.toFixed(2) + ' lei' : 'NECOMPLETAT'}\n`;
    }
  }

  // GPS
  if (gpsData.totalAgents > 0) {
    text += `\n═══ GPS TRACKING ═══\n`;
    text += `Agenti cu GPS activ: ${gpsData.totalAgents}\n`;
    for (const [ag, s] of Object.entries(gpsData.byAgent)) {
      const firstHour = s.firstTime ? s.firstTime.split(" ")[1] || "" : "";
      const lastHour = s.lastTime ? s.lastTime.split(" ")[1] || "" : "";
      text += `  ${ag}: ${s.totalDistanceKm} km | ${s.pointCount} pct | ${firstHour}-${lastHour} | ${s.visitsToday} viz.\n`;
    }
  }

  // EXPIRARI
  if (expiryData && expiryData.totalActive > 0) {
    text += `\n═══ EXPIRARI PRODUSE ═══\n`;
    text += `Active: ${expiryData.totalActive} | Expirate: ${expiryData.totalExpired} | Termen scurt: ${expiryData.totalSoon}\n`;
    if (expiryData.reportedToday.length > 0) text += `Raportate azi: ${expiryData.reportedToday.length}\n`;
  }

  text += `\n── Detalii complete in fisierele Excel atasate ──\n`;
  text += `\nTrimis automat de QMaps Audit BB\n`;
  return text;
}

function buildMonthlyEmailText(auditData, gpsData, expiryData) {
  const closedVisits = auditData.visits.filter(v => v.closed_at);
  const avgScore = closedVisits.length ? Math.round(closedVisits.reduce((s, v) => s + v.score, 0) / closedVisits.length) : 0;
  const coverage = auditData.totalClients ? ((auditData.visitedClients / auditData.totalClients) * 100).toFixed(1) : "0";

  let text = `══════════════════════════════════════\n`;
  text += `  QMAPS AUDIT BB - RAPORT LUNAR CONSOLIDAT\n`;
  text += `  Luna: ${auditData.month}\n`;
  text += `══════════════════════════════════════\n\n`;

  text += `═══ AUDIT VIZITE ═══\n`;
  text += `Clienti vizitati: ${auditData.visitedClients}/${auditData.totalClients} (${coverage}%)\n`;
  text += `Total vizite: ${auditData.visits.length} | Audit complet: ${closedVisits.length} | Scor mediu: ${avgScore}%\n\n`;
  for (const [ag, s] of Object.entries(auditData.byAgent)) {
    text += `  ${ag}: ${s.uniqueCount} clienti unici | ${s.visits} viz. | ${s.closed} audit | scor ${s.avgScore}%\n`;
  }

  if (auditData.incasari) {
    text += `\n═══ INCASARI NUMERAR ═══\n`;
    text += `Total echipa: ${auditData.incasari.grandTotal.toFixed(2)} lei\n`;
    for (const ag of auditData.incasari.agents) {
      text += `  ${ag.display_name || ag.agent_dtr}: ${ag.total_suma.toFixed(2)} lei (${ag.zile_raportate} zile, media ${ag.media_zilnica.toFixed(2)} lei/zi)\n`;
    }
  }

  if (gpsData.totalAgents > 0) {
    text += `\n═══ GPS TRACKING ═══\n`;
    text += `Agenti: ${gpsData.totalAgents} | Zile cu GPS: ${gpsData.days.length}\n`;
    for (const [ag, s] of Object.entries(gpsData.byAgent)) {
      const avgDist = s.activeDays > 0 ? Math.round(s.totalDistKm / s.activeDays * 10) / 10 : 0;
      text += `  ${ag}: ${s.activeDays} zile | ${Math.round(s.totalDistKm * 10) / 10} km tot | ~${avgDist} km/zi | ${s.totalVisits} vizite\n`;
    }
  }

  if (expiryData) {
    text += `\n═══ EXPIRARI PRODUSE ═══\n`;
    text += `Raportate luna aceasta: ${expiryData.totalReported} | Rezolvate: ${expiryData.totalResolved} | Inca active: ${expiryData.totalStillActive}\n`;
  }

  text += `\n── Detalii complete in fisierele Excel atasate ──\n`;
  text += `\nTrimis automat de QMaps Audit BB\n`;
  return text;
}

/* ═══════════════════════════════════════════
   SEND FUNCTIONS: UN SINGUR EMAIL CU TOTUL
   ═══════════════════════════════════════════ */

async function sendDailyReport(db, getProductsForClient, dateOverride) {
  const date = dateOverride || todayStr();
  const now = nowInRomania();
  const dayOfWeek = now.getDay();

  if (!dateOverride && dayOfWeek === 0) {
    console.log(`[Email] Sunday — skipping daily report`);
    return { sent: false, reason: "sunday" };
  }

  // Gather ALL data
  const auditData = gatherDailyData(db, date, getProductsForClient);
  const gpsData = gatherDailyGpsData(db, date);
  const expiryData = gatherDailyExpiryData(db, date);

  const transport = createTransport();
  if (!transport) { console.log("[Email] SMTP not configured"); return { sent: false, reason: "smtp_not_configured" }; }

  try {
    const attachments = [];

    // 1. Audit + Incasari Excel (always)
    const auditBuffer = buildDailyAuditExcel(auditData);
    attachments.push({ filename: `QMapsBB_Audit_Zilnic_${date}.xlsx`, content: Buffer.from(auditBuffer) });

    // 2. GPS Excel (if data exists)
    if (gpsData.totalAgents > 0) {
      const gpsBuffer = buildDailyGpsExcel(gpsData);
      attachments.push({ filename: `QMapsBB_GPS_Zilnic_${date}.xlsx`, content: Buffer.from(gpsBuffer) });
    }

    // 3. Expirari Excel (if data exists)
    if (expiryData.totalActive > 0) {
      const expiryBuffer = buildDailyExpiryExcel(expiryData);
      attachments.push({ filename: `QMapsBB_Expirari_${date}.xlsx`, content: Buffer.from(expiryBuffer) });
    }

    const text = buildDailyEmailText(auditData, gpsData, expiryData);

    await transport.sendMail({
      from: CFG.emailFrom,
      to: CFG.emailTo.join(", "),
      subject: `QMaps Audit BB - Raport Zilnic ${date}`,
      text,
      attachments
    });

    console.log(`[Email] Daily consolidated report sent for ${date} to ${CFG.emailTo.join(", ")} (${attachments.length} attachments)`);
    return { sent: true, date, to: CFG.emailTo, attachments: attachments.length };
  } catch (err) {
    console.error(`[Email] Failed to send daily report:`, err.message);
    return { sent: false, reason: err.message };
  }
}

async function sendMonthlyReport(db, getProductsForClient, monthOverride) {
  const now = nowInRomania();
  const month = monthOverride || (() => {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();

  // Gather ALL data
  const auditData = gatherMonthlyData(db, month, getProductsForClient);
  const gpsData = gatherMonthlyGpsData(db, month);
  const expiryData = gatherMonthlyExpiryData(db, month);

  const transport = createTransport();
  if (!transport) return { sent: false, reason: "smtp_not_configured" };

  try {
    const attachments = [];

    // 1. Audit + Incasari Excel
    const auditWb = buildMonthlyAuditExcel(auditData);
    // Add expiry sheet directly to audit workbook
    if (expiryData.totalStillActive > 0) {
      const expiryForSheet = {
        activeReports: expiryData.stillActive,
        totalActive: expiryData.totalStillActive,
        totalExpired: expiryData.stillActive.filter(r => r.expiryStatus === "EXPIRAT").length,
        totalSoon: expiryData.stillActive.filter(r => r.expiryStatus === "TERMEN SCURT").length
      };
      addExpirySheetToWorkbook(auditWb, expiryForSheet, "Expirari Active");
    }
    const auditBuffer = XLSX_LIB.write(auditWb, { type: "buffer", bookType: "xlsx" });
    attachments.push({ filename: `QMapsBB_Audit_Lunar_${month}.xlsx`, content: Buffer.from(auditBuffer) });

    // 2. GPS Excel
    if (gpsData.totalAgents > 0) {
      const gpsBuffer = buildMonthlyGpsExcel(gpsData);
      attachments.push({ filename: `QMapsBB_GPS_Lunar_${month}.xlsx`, content: Buffer.from(gpsBuffer) });
    }

    const text = buildMonthlyEmailText(auditData, gpsData, expiryData);

    await transport.sendMail({
      from: CFG.emailFrom,
      to: CFG.emailTo.join(", "),
      subject: `QMaps Audit BB - Raport Lunar ${month}`,
      text,
      attachments
    });

    console.log(`[Email] Monthly consolidated report sent for ${month} to ${CFG.emailTo.join(", ")} (${attachments.length} attachments)`);
    return { sent: true, month, to: CFG.emailTo, attachments: attachments.length };
  } catch (err) {
    console.error(`[Email] Failed to send monthly report:`, err.message);
    return { sent: false, reason: err.message };
  }
}

/* ═══════════════════════════════════════════
   CRON-LIKE SCHEDULER (runs every 15 min)
   Zilnic: L-S la 20:00 — un singur email cu totul
   Lunar: pe 1 la 08:00 — un singur email consolidat
   ═══════════════════════════════════════════ */

function startScheduler(db, getProductsForClient) {
  if (!CFG.enabled) {
    console.log("[Email] Auto-send disabled (REPORT_AUTOSEND_ENABLED != 1)");
    return;
  }

  loadLastSent(db);

  console.log(`[Email] Scheduler started (CONSOLIDATED — un singur email)`);
  console.log(`[Email]   Daily: L-S at ${CFG.targetHour}:00 ${CFG.timezone}`);
  console.log(`[Email]   Monthly: day ${CFG.monthlyDay} at 08:00`);
  console.log(`[Email]   Destinatari: ${CFG.emailTo.join(", ")}`);

  setInterval(async () => {
    const now = nowInRomania();
    const hour = now.getHours();
    const today = todayStr();
    const dayOfWeek = now.getDay();
    const dayOfMonth = now.getDate();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    // Daily consolidated report (Mon-Sat at targetHour)
    if (dayOfWeek >= 1 && dayOfWeek <= 6 && hour >= CFG.targetHour && lastDailySent !== today) {
      lastDailySent = today;
      saveLastSent(db);
      console.log(`[Email] Triggering daily consolidated report for ${today}`);
      await sendDailyReport(db, getProductsForClient);
    }

    // Monthly consolidated report (on monthlyDay at 8:00)
    if (dayOfMonth === CFG.monthlyDay && hour >= 8 && lastMonthlySent !== currentMonth) {
      lastMonthlySent = currentMonth;
      saveLastSent(db);
      console.log(`[Email] Triggering monthly consolidated report`);
      await sendMonthlyReport(db, getProductsForClient);
    }
  }, 15 * 60 * 1000);

  // Check immediately on start (respect DB-persisted state)
  setTimeout(async () => {
    const now = nowInRomania();
    const hour = now.getHours();
    const today = todayStr();
    const dayOfWeek = now.getDay();
    if (dayOfWeek >= 1 && dayOfWeek <= 6 && hour >= CFG.targetHour && lastDailySent !== today) {
      lastDailySent = today;
      saveLastSent(db);
      await sendDailyReport(db, getProductsForClient);
    }
  }, 5000);
}

module.exports = {
  CFG,
  startScheduler,
  sendDailyReport,
  sendMonthlyReport
};

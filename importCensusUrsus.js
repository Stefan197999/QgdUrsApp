const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || "./data/app.db";
const db = new Database(DB_PATH);

const raw = fs.readFileSync('/sessions/amazing-funny-knuth/census_import.json', 'utf8');
const importData = JSON.parse(raw);

function parseGPS(gps) {
  if (!gps || gps === 'None' || gps === 'null') return [0, 0];
  const parts = String(gps).split(';');
  if (parts.length !== 2) return [0, 0];
  const lat = parseFloat(parts[0].replace(',', '.'));
  const lon = parseFloat(parts[1].replace(',', '.'));
  if (isNaN(lat) || isNaN(lon)) return [0, 0];
  return [lat, lon];
}

console.log("GPS parse test:", parseGPS("47,158752;27,619570"));
console.log("Entries to import:", importData.data.length);

// Clear existing
db.prepare('DELETE FROM census_ursus').run();
db.prepare('DELETE FROM census_columns_config').run();

// Insert column config
const RESTRICTED = ['Cortex LY-1', 'Cortex LY', 'Cortex An curent'];
const insCol = db.prepare('INSERT OR REPLACE INTO census_columns_config (column_name, display_mode, restricted) VALUES (?,?,?)');
db.transaction(() => {
  for (const h of importData.headers) {
    insCol.run(h, importData.metadata[h] || 'all', RESTRICTED.includes(h) ? 1 : 0);
  }
})();
console.log("Column config inserted:", importData.headers.length);

// Insert census rows
const ins = db.prepare(`INSERT INTO census_ursus (
  cui, outlet_name, locality, address, lat, lon, contact_person, phone,
  distributor1, distributor2, location_type, stare, channel,
  semafor, is_sis, agent_alocat, cc_alocat,
  bergenbier_med12, bergenbier_med3, ursus_med12, ursus_med3,
  maspex_med12, maspex_med3, spring_harghita_med12, spring_harghita_med3,
  altele_med12, altele_med3, jti_dist_bax_med12, jti_dist_bax_med3,
  top3_clase, census_full_json
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

db.transaction(() => {
  for (const entry of importData.data) {
    const c = entry.census || entry;
    const v = entry.vanzari || {};
    const [lat, lon] = parseGPS(c.GPS);
    ins.run(
      c.cui_norm || c.cui || '',
      c.OutletName || c.outlet_name || '',
      c.City || c.Locality || c.locality || '',
      c['Address (Outlet)'] || c.Address || c.address || '',
      lat, lon,
      c['Persoana Contact'] || c['Contact person'] || c.contact_person || '',
      c['Telefon Persoana Contact'] || c.Phone || c.phone || '',
      c['Distribuitor 1'] || c.DistributorName || c.distributor1 || '',
      c['Distribuitor 2'] || c.Distributor2Name || c.distributor2 || '',
      c.LocationType || c.LocationTypeName || c.location_type || '',
      c.Stare || c.stare || '',
      c['SalesForce Channel'] || c.Channel || c.channel || '',
      v.semafor || 'RED',
      v.is_sis || 0,
      v.agent_alocat || '',
      v.cc_alocat || '',
      v.bergenbier_med12 || 0,
      v.bergenbier_med3 || 0,
      v.ursus_med12 || 0,
      v.ursus_med3 || 0,
      v.maspex_med12 || 0,
      v.maspex_med3 || 0,
      v.spring_harghita_med12 || 0,
      v.spring_harghita_med3 || 0,
      v.altele_med12 || 0,
      v.altele_med3 || 0,
      v.jti_dist_bax_med12 || 0,
      v.jti_dist_bax_med3 || 0,
      v.top3_clase || '[]',
      JSON.stringify(c)
    );
  }
})();

// Verify
const total = db.prepare('SELECT COUNT(*) as c FROM census_ursus').get().c;
const stats = db.prepare('SELECT semafor, COUNT(*) as cnt FROM census_ursus GROUP BY semafor').all();
const withGps = db.prepare('SELECT COUNT(*) as c FROM census_ursus WHERE lat != 0 AND lon != 0').get().c;
const withAgent = db.prepare("SELECT COUNT(*) as c FROM census_ursus WHERE agent_alocat != ''").get().c;
const isSis = db.prepare('SELECT COUNT(*) as c FROM census_ursus WHERE is_sis = 1').get().c;
const withLocality = db.prepare("SELECT COUNT(*) as c FROM census_ursus WHERE locality != ''").get().c;

console.log("\nRESULT:");
console.log("Total:", total);
console.log("Stats:", JSON.stringify(stats));
console.log("GPS:", withGps, "| Agent:", withAgent, "| SIS:", isSis, "| Locality:", withLocality);

// Sample
const sample = db.prepare('SELECT outlet_name, cui, locality, lat, lon, semafor, ursus_med12, channel FROM census_ursus WHERE lat > 0 LIMIT 3').all();
console.log("\nSample:", JSON.stringify(sample, null, 2));

// Distributors
const distribs = db.prepare('SELECT distributor1, COUNT(*) as c FROM census_ursus GROUP BY distributor1 ORDER BY c DESC LIMIT 10').all();
console.log("\nDistributors:", JSON.stringify(distribs));

db.close();
console.log("\nDONE!");

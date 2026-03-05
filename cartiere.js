// ═══ Cartiere Iași & Pașcani — modul partajat ═══
// Coordonate centre cartiere pentru alocare clienți pe baza GPS (nearest center / Voronoi)

const CARTIERE_IASI = [
  { name: 'Centru',              lat: 47.1585, lon: 27.5875 },
  { name: 'Copou',               lat: 47.1780, lon: 27.5680 },
  { name: 'Tătărași',            lat: 47.1660, lon: 27.6100 },
  { name: 'Nicolina',            lat: 47.1430, lon: 27.5720 },
  { name: 'CUG',                 lat: 47.1340, lon: 27.5900 },
  { name: 'Podu Roș',           lat: 47.1570, lon: 27.5970 },
  { name: 'Păcurari',           lat: 47.1710, lon: 27.6020 },
  { name: 'Galata',              lat: 47.1480, lon: 27.5480 },
  { name: 'Alexandru cel Bun',   lat: 47.1560, lon: 27.6200 },
  { name: 'Dacia',               lat: 47.1620, lon: 27.5580 },
  { name: 'Tudor Vladimirescu',  lat: 47.1380, lon: 27.5520 },
  { name: 'Cantemir',            lat: 47.1500, lon: 27.5950 },
  { name: 'Frumoasa',            lat: 47.1800, lon: 27.5850 },
  { name: 'Moara de Vânt',      lat: 47.1420, lon: 27.6100 },
  { name: 'Bucium',              lat: 47.1280, lon: 27.5650 },
  { name: 'Socola',              lat: 47.1360, lon: 27.5780 },
  { name: 'Mircea cel Bătrân',  lat: 47.1670, lon: 27.5750 },
  { name: 'Metalurgie',          lat: 47.1520, lon: 27.5650 },
  { name: 'Podu de Piatră',     lat: 47.1630, lon: 27.6300 },
  { name: 'Tg. Cucu',            lat: 47.1610, lon: 27.5770 },
  { name: 'Independenței',      lat: 47.1730, lon: 27.5760 },
  { name: 'Billa/Poitiers',     lat: 47.1550, lon: 27.5760 },
  { name: 'Oancea',              lat: 47.1460, lon: 27.5400 },
  { name: 'Dancu',               lat: 47.1200, lon: 27.5700 },
  { name: 'Țesătura',           lat: 47.1500, lon: 27.6350 },
];

const CARTIERE_PASCANI = [
  { name: 'Centru Pașcani',     lat: 47.2490, lon: 26.7230 },
  { name: 'Blăgești',           lat: 47.2400, lon: 26.7080 },
  { name: 'Gara Pașcani',       lat: 47.2550, lon: 26.7150 },
  { name: 'Gâștești',           lat: 47.2600, lon: 26.7350 },
  { name: 'Nord Pașcani',       lat: 47.2650, lon: 26.7200 },
  { name: 'Sud Pașcani',        lat: 47.2350, lon: 26.7250 },
];

const _toRad = d => d * Math.PI / 180;
function _haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = _toRad(lat2 - lat1), dLon = _toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(_toRad(lat1)) * Math.cos(_toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function _assignNearest(lat, lon, cartiere) {
  let best = null, bestDist = Infinity;
  for (const c of cartiere) {
    const d = _haversine(lat, lon, c.lat, c.lon);
    if (d < bestDist) { bestDist = d; best = c.name; }
  }
  return best;
}

/**
 * Atribuie cartier unui client pe baza coordonatelor GPS.
 * Funcționează doar pentru Municipiul Iași și Pașcani.
 * @param {object} client - obiect cu lat, lon, uat, locality
 * @returns {string|null} numele cartierului sau null
 */
function getCartier(client) {
  if (!client.lat || !client.lon) return null;
  const uat = (client.uat || '').toLowerCase();
  const loc = (client.locality || '').toLowerCase();

  // Municipiul Iași
  if ((uat.includes('iasi') && !uat.includes('comuna')) || loc === 'iasi') {
    return _assignNearest(client.lat, client.lon, CARTIERE_IASI);
  }

  // Municipiul Pașcani + localități aparținătoare
  if (uat.includes('pascani') || loc === 'pascani' || loc === 'blagesti' || loc === 'gastesti' || loc === 'bosteni') {
    return _assignNearest(client.lat, client.lon, CARTIERE_PASCANI);
  }

  return null;
}

module.exports = { getCartier, CARTIERE_IASI, CARTIERE_PASCANI };

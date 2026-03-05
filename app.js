// ===== Richmond Summer Routes — app.js for GitHub Pages =====
// Leaflet map + events + GRTC layers + OSM trails + OpenRouteService routing.
// Everything runs client-side, suitable for GitHub Pages hosting.

// ---------- 0) CONFIG ----------
const CONFIG = {
  center: [37.5407, -77.4360], // Richmond, VA
  zoom: 12,
  orsApiKey: "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjFiMDE4NzE4NGRlNjRlYWFiNzAxYThiMDU0YjA4ZjAyIiwiaCI6Im11cm11cjY0In0=",
  // Richmond bounding box for Overpass [south, west, north, east]
  bbox: [37.25, -77.65, 37.86, -77.29],
  dataPaths: {
    stops: "data/grtc_stops.geojson",
    dayRoutes: "data/grtc_day_routes.geojson",
    nightRoutes: "data/grtc_night_routes.geojson"
  },
  styles: {
    stops: { radius: 4, color: "#1f2937", fillColor: "#3b82f6", fillOpacity: 0.9 },
    dayRoute: { color: "#10b981", weight: 3, opacity: 0.7 },
    nightRoute: { color: "#8b5cf6", weight: 3, opacity: 0.7 },
    trails: { color: "#ef4444", weight: 3, opacity: 0.8, dashArray: "4,3" },
    routeLegWalk: { color: "#2563eb", weight: 5 },
    routeLegBike: { color: "#16a34a", weight: 5 },
    busContext: { color: "#6b7280", weight: 3, dashArray: "6,6" }
  }
};

// ---------- 1) MAP ----------
const map = L.map("map").setView(CONFIG.center, CONFIG.zoom);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  { attribution: "&copy; OpenStreetMap contributors" }
).addTo(map);

// Layer groups to toggle
const layers = {
  events: L.layerGroup().addTo(map),
  stops: L.layerGroup().addTo(map),
  dayRoutes: L.layerGroup().addTo(map),
  nightRoutes: L.layerGroup(), // off by default
  trails: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map)
};

// ---------- 2) UTILITIES ----------
function toRad(deg) { return (deg * Math.PI) / 180; }
function haversine(a, b) {
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]), lat2 = toRad(b[0]);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function nearestPoint(origin, arr) {
  let best = null, bestDist = Infinity;
  for (const item of arr) {
    const d = haversine(origin, [item.lat, item.lon]);
    if (d < bestDist) { best = item; bestDist = d; }
  }
  return { best, bestDist };
}
async function fetchJSON(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// ---------- 3) EVENTS (Geocode venues via Nominatim) ----------
const EVENT_CATALOG = [
  { id: "maymont_concerts", label: "Maymont Summer Nights", type: "concert", query: "Maymont, Richmond, VA" },
  { id: "flowers_after_5", label: "Lewis Ginter: Flowers After 5", type: "garden", query: "Lewis Ginter Botanical Garden, Richmond, VA" },
  { id: "james_river_activities", label: "James River Water Activities", type: "river", query: "Belle Isle, Richmond, VA" },
  { id: "yoga_browns_island", label: "Outdoor Yoga (Brown’s Island)", type: "yoga", query: "Brown's Island, Richmond, VA" },
  { id: "yoga_maymont", label: "Outdoor Yoga (Maymont)", type: "yoga", query: "Maymont, Richmond, VA" },
  { id: "kickers", label: "Richmond Kickers (City Stadium)", type: "soccer", query: "City Stadium, Richmond, VA" },
  { id: "squirrels", label: "Flying Squirrels (The Diamond)", type: "baseball", query: "The Diamond, Richmond, VA" }
];
const eventCache = new Map();

document.getElementById("loadEventsBtn").addEventListener("click", loadEvents);
[
  {
    "id": "flowers_after_5",
    "label": "Lewis Ginter: Flowers After 5",
    "type": "garden",
    "lat": 37.6230,
    "lon": -77.4729,
    "schedule": {
      "recurrence": "weekly",
      "weekday": "Thursday",
      "startMonth": "May",
      "endMonth": "October"
    },
    "url": "https://example.com/flowers-after-5"
  }
]

async function geocodeVenue(q) {
  const cached = eventCache.get(q);
  if (cached) return cached;
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
  const json = await fetchJSON(url, {
    headers: { "Accept-Language": "en", "User-Agent": "RichmondSummerRoutes/1.0" }
  });
  if (!json.length) throw new Error(`No geocode result for: ${q}`);
  const { lat, lon, display_name } = json[0];
  const result = { lat: parseFloat(lat), lon: parseFloat(lon), name: display_name };
  eventCache.set(q, result);
  return result;
}

async function loadEvents() {
  const typeFilter = document.getElementById("eventType").value;
  layers.events.clearLayers();
  document.getElementById("eventsList").innerHTML = "Loading events...";
  const results = [];
  for (const ev of EVENT_CATALOG) {
    if (typeFilter !== "all" && ev.type !== typeFilter) continue;
    try {
      const g = await geocodeVenue(ev.query);
      const marker = L.marker([g.lat, g.lon]).addTo(layers.events);
      marker.bindPopup(`<strong>${ev.label}</strong><br>${g.name}`);
      results.push({ id: ev.id, label: ev.label, lat: g.lat, lon: g.lon, type: ev.type });
    } catch (e) { console.warn(e); }
  }
  const listEl = document.getElementById("eventsList");
  const destSel = document.getElementById("destinationSelect");
  listEl.innerHTML = "";
  destSel.innerHTML = "";
  results.forEach(r => {
    const li = document.createElement("div");
    li.textContent = r.label;
    listEl.appendChild(li);
    const opt = document.createElement("option");
    opt.value = JSON.stringify({ lat: r.lat, lon: r.lon, name: r.label });
    opt.textContent = r.label;
    destSel.appendChild(opt);
  });
}

// ---------- 4) BIKE TRAILS (OSM Overpass) ----------
async function loadBikeTrails() {
  layers.trails.clearLayers();
  const [s, w, n, e] = CONFIG.bbox;
  const overpassQL = `
    [out:json][timeout:25];
    (
      way"highway"="cycleway";
      way~"cycleway"~".";
    );
    (._;>;);
    out body;
  `.trim();

  const res = await fetchJSON("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: overpassQL,
    headers: { "Content-Type": "text/plain" }
  });

  const nodes = new Map();
  (res.elements || []).forEach(el => { if (el.type === "node") nodes.set(el.id, [el.lat, el.lon]); });
  (res.elements || []).forEach(el => {
    if (el.type === "way" && el.nodes) {
      const coords = el.nodes.map(id => nodes.get(id)).filter(Boolean);
      if (coords.length > 1) {
        L.polyline(coords, CONFIG.styles.trails).addTo(layers.trails);
      }
    }
  });
}

// ---------- 5) GRTC Context Layers (Stops + Routes from your repo) ----------
// Your uploaded metadata shows EPSG:2284 for the original data;
// convert to GeoJSON in EPSG:4326 before hosting (see instructions). [1](https://richmondgov-my.sharepoint.com/personal/abigail_chaikin_rva_gov/Documents/Microsoft%20Copilot%20Chat%20Files/GRTC_baseStops_Jan2021.shp.xml)[2](https://richmondgov-my.sharepoint.com/personal/abigail_chaikin_rva_gov/Documents/Microsoft%20Copilot%20Chat%20Files/GRTC_baseNightRoutes_Jan2021.shp.xml)[3](https://richmondgov-my.sharepoint.com/personal/abigail_chaikin_rva_gov/Documents/Microsoft%20Copilot%20Chat%20Files/GRTCbaseDayRoutes_Jan2021.shp.xml)

let GRTC_STOPS = []; // array of { stop_id, name, lat, lon }

async function fetchAndRenderStops() {
  layers.stops.clearLayers();
  const gj = await fetchJSON(CONFIG.dataPaths.stops);
  // Try to interpret common field names; fall back to coordinates.
  GRTC_STOPS = gj.features.map(f => {
    const p = f.properties || {};
    const [lon, lat] = f.geometry.coordinates;
    return {
      stop_id: p.stop_id ?? p.stop ?? p.id ?? "n/a",
      name: p.name ?? p.location ?? "Bus Stop",
      lat: lat,
      lon: lon
    };
  });

  // Render points
  L.geoJSON(gj, {
    pointToLayer: (feat, latlng) => L.circleMarker(latlng, CONFIG.styles.stops),
    onEachFeature: (feat, layer) => {
      const p = feat.properties || {};
      const name = p.name ?? p.location ?? "Bus Stop";
      const id = p.stop_id ?? p.stop ?? p.id ?? "n/a";
      layer.bindPopup(`<strong>${name}</strong><br>Stop ID: ${id}`);
    }
  }).addTo(layers.stops);
}

async function fetchAndRenderRoutes() {
  layers.dayRoutes.clearLayers();
  layers.nightRoutes.clearLayers();

  const dayGJ = await fetchJSON(CONFIG.dataPaths.dayRoutes);
  const nightGJ = await fetchJSON(CONFIG.dataPaths.nightRoutes);

  L.geoJSON(dayGJ, { style: CONFIG.styles.dayRoute }).addTo(layers.dayRoutes);
  L.geoJSON(nightGJ, { style: CONFIG.styles.nightRoute }).addTo(layers.nightRoutes);
}

// ---------- 6) ROUTING (OpenRouteService) ----------
async function geocodeSingle(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
  const json = await fetchJSON(url, { headers: { "Accept-Language": "en", "User-Agent": "RichmondSummerRoutes/1.0" } });
  if (!json.length) throw new Error(`Could not geocode ${query}`);
  return [parseFloat(json[0].lat), parseFloat(json[0].lon)];
}

async function orsRouteLine(mode, coords, preferences = {}) {
  // coords: [ [lon, lat], [lon, lat] ]
  const body = {
    coordinates: coords,
    preference: preferences.preference || "fastest",
    extra_info: ["waytype"]
  };
  if (mode.startsWith("cycling")) {
    body.options = { avoid_features: preferences.avoidUnpaved ? ["unpaved"] : [] };
  }

  const res = await fetchJSON(`https://api.openrouteservice.org/v2/directions/${mode}/geojson`, {
    method: "POST",
    headers: { "Authorization": CONFIG.orsApiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res;
}

async function buildRoute() {
  const summaryEl = document.getElementById("routeSummary");
  summaryEl.textContent = "Building route...";
  layers.route.clearLayers();

  const startQ = document.getElementById("startInput").value.trim();
  const destSel = document.getElementById("destinationSelect").value;
  const mode = document.getElementById("modeSelect").value;
  const preferTrails = document.getElementById("preferTrails").checked;
  const avoidUnpaved = document.getElementById("avoidUnpaved").checked;
  const maxAccess = parseFloat(document.getElementById("maxAccessMeters").value || "800");

  if (!startQ || !destSel) {
    summaryEl.textContent = "Please enter a start address and select a destination event.";
    return;
  }

  const originLatLon = await geocodeSingle(startQ);
  const destObj = JSON.parse(destSel);
  const destLatLon = [destObj.lat, destObj.lon];

  const { best: accessStop, bestDist: accessDist } = nearestPoint(originLatLon, GRTC_STOPS);
  const { best: egressStop, bestDist: egressDist } = nearestPoint(destLatLon, GRTC_STOPS);
  const useBusContext = accessDist <= maxAccess && egressDist <= maxAccess;

  const prefs = { avoidUnpaved, preference: preferTrails ? "shortest" : "fastest" };
  const lines = [];
  let totalMeters = 0;

  // Leg A: origin → access stop
  const legA = await orsRouteLine(mode, [
    [originLatLon[1], originLatLon[0]],
    [accessStop.lon, accessStop.lat]
  ], prefs);

  // Leg C: egress stop → destination
  const legC = await orsRouteLine(mode, [
    [egressStop.lon, egressStop.lat],
    [destLatLon[1], destLatLon[0]]
  ], prefs);

  // Render A and C
  [legA, legC].forEach(geojson => {
    const feat = geojson.features[0];
    const coords = feat.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    L.polyline(coords, mode.startsWith("cycling") ? CONFIG.styles.routeLegBike : CONFIG.styles.routeLegWalk).addTo(layers.route);
    totalMeters += feat.properties.summary?.distance || 0;
  });

  // Bus context: dashed line between stops (you can snap to day/night route if you want)
  if (useBusContext) {
    L.polyline([[accessStop.lat, accessStop.lon], [egressStop.lat, egressStop.lon]], CONFIG.styles.busContext).addTo(layers.route);
  }

  const km = (totalMeters / 1000).toFixed(2);
  summaryEl.innerHTML = `
    <strong>Route built!</strong><br/>
    Mode: ${mode.includes("cycling") ? "Bike" : "Walk"}<br/>
    Total non-transit distance: ${km} km<br/>
    Access stop: ${accessStop.name} (≈ ${(accessDist).toFixed(0)} m from origin)<br/>
    Egress stop: ${egressStop.name} (≈ ${(egressDist).toFixed(0)} m to destination)<br/>
    <em>Note:</em> Bus segment shown for context (check GRTC schedules to time your trip).
  `;
}

// ---------- 7) UI HOOKS ----------
document.getElementById("loadEventsBtn").addEventListener("click", loadEvents);
document.getElementById("routeBtn").addEventListener("click", buildRoute);

// Layer toggles
document.getElementById("toggleStops").addEventListener("change", e => {
  if (e.target.checked) map.addLayer(layers.stops); else map.removeLayer(layers.stops);
});
document.getElementById("toggleDayRoutes").addEventListener("change", e => {
  if (e.target.checked) map.addLayer(layers.dayRoutes); else map.removeLayer(layers.dayRoutes);
});
document.getElementById("toggleNightRoutes").addEventListener("change", e => {
  if (e.target.checked) map.addLayer(layers.nightRoutes); else map.removeLayer(layers.nightRoutes);
});
document.getElementById("toggleTrails").addEventListener("change", e => {
  if (e.target.checked) map.addLayer(layers.trails); else map.removeLayer(layers.trails);
});

// ---------- 8) INIT ----------
(async function init() {
  await fetchAndRenderStops();      // requires data/grtc_stops.geojson
  await fetchAndRenderRoutes();     // requires data/grtc_day_routes.geojson & data/grtc_night_routes.geojson
  await loadBikeTrails();
  await loadEvents();
})();

/* app.js — Richmond Summer Routes
   - Leaflet map init
   - Loads GRTC layers (stops/day/night) + Bike trails (optional file)
   - Loads events from data/events.json
   - Populates destination dropdown
   - Adds "Bus" mode to modeSelect
*/

(() => {
  "use strict";

  // -----------------------------
  // Helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  function setStatus(el, msg, kind = "info") {
    if (!el) return;
    el.innerHTML = "";
    const div = document.createElement("div");
    div.className = `status status-${kind}`;
    div.textContent = msg;
    el.appendChild(div);
  }

  function haversineMeters(a, b) {
    // a,b: [lat,lng]
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(2)} km`;
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  }

  // Try to guess [lat,lng] from common event formats.
  function getEventLatLng(evt) {
    // Supports:
    //  - evt.lat / evt.lng
    //  - evt.latitude / evt.longitude
    //  - evt.location: { lat, lng } or { latitude, longitude }
    //  - evt.geometry: GeoJSON Point
    const lat =
      evt?.lat ??
      evt?.latitude ??
      evt?.location?.lat ??
      evt?.location?.latitude ??
      evt?.geometry?.coordinates?.[1];

    const lng =
      evt?.lng ??
      evt?.lon ??
      evt?.longitude ??
      evt?.location?.lng ??
      evt?.location?.lon ??
      evt?.location?.longitude ??
      evt?.geometry?.coordinates?.[0];

    if (typeof lat === "number" && typeof lng === "number") return [lat, lng];
    // Sometimes numbers are strings:
    const latN = Number(lat);
    const lngN = Number(lng);
    if (!Number.isNaN(latN) && !Number.isNaN(lngN)) return [latN, lngN];

    return null;
  }

  function getEventLabel(evt) {
    return (
      evt?.name ||
      evt?.title ||
      evt?.event ||
      evt?.venue ||
      "Unnamed event"
    );
  }

  function getEventType(evt) {
    return (evt?.type || evt?.category || evt?.eventType || "other")
      .toString()
      .toLowerCase();
  }

  // -----------------------------
  // DOM Elements (must match index.html)
  // -----------------------------
  const elEventType = $("eventType");
  const elLoadEventsBtn = $("loadEventsBtn");
  const elEventsList = $("eventsList");
  const elDestinationSelect = $("destinationSelect");
  const elModeSelect = $("modeSelect");
  const elStartInput = $("startInput");
  const elRouteBtn = $("routeBtn");
  const elRouteSummary = $("routeSummary");

  const cbStops = $("toggleStops");
  const cbDayRoutes = $("toggleDayRoutes");
  const cbNightRoutes = $("toggleNightRoutes");
  const cbTrails = $("toggleTrails");

  // -----------------------------
  // Ensure "Bus" is in the Mode dropdown
  // (Your HTML currently includes Walk + Bike only.) [1](https://github.com/abigailchaikin-svg/rva_summer/blob/main/index.html)
  // -----------------------------
  function ensureBusModeOption() {
    if (!elModeSelect) return;

    const exists = Array.from(elModeSelect.options).some(
      (o) => o.value === "bus"
    );
    if (!exists) {
      const opt = document.createElement("option");
      opt.value = "bus";
      opt.textContent = "Bus";
      elModeSelect.appendChild(opt);
    }
  }

  // -----------------------------
  // Map init
  // -----------------------------
  let map;
  let layers = {
    stops: null,
    dayRoutes: null,
    nightRoutes: null,
    trails: null,
    routeLine: null,
    startMarker: null,
    destMarker: null,
  };

  function initMap() {
    // Leaflet should be available as `L` after leaflet.js loads.
    // Make sure your index.html includes leaflet.js before app.js.
    map = L.map("map", { zoomControl: true }).setView(
      [37.5407, -77.4360], // Richmond-ish
      12
    );

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
  }

  // -----------------------------
  // Layer loading
  // -----------------------------
  async function loadGeoJsonLayer(url, styleOrOptions) {
    const data = await fetchJSON(url);
    return L.geoJSON(data, styleOrOptions);
  }

  async function loadLayers() {
    // These file names appear in your repo /data folder. [2](https://github.com/abigailchaikin-svg/rva_summer/tree/main/data)
    // If a file is missing, we keep going (and show a friendly warning).
    const warnings = [];

    // Stops
    try {
      layers.stops = await loadGeoJsonLayer("data/day stops.geojson", {
        pointToLayer: (_, latlng) =>
          L.circleMarker(latlng, {
            radius: 3,
            weight: 1,
            color: "#0b3d91",
            fillColor: "#2b7bff",
            fillOpacity: 0.8,
          }),
      });
      if (cbStops?.checked) layers.stops.addTo(map);
    } catch (e) {
      warnings.push(`Could not load bus stops: ${e.message}`);
    }

    // Day routes
    try {
      layers.dayRoutes = await loadGeoJsonLayer("data/dayroutes.geojson", {
        style: { color: "#0b3d91", weight: 2, opacity: 0.8 },
      });
      if (cbDayRoutes?.checked) layers.dayRoutes.addTo(map);
    } catch (e) {
      warnings.push(`Could not load day bus routes: ${e.message}`);
    }

    // Night routes
    try {
      layers.nightRoutes = await loadGeoJsonLayer("data/nightroutes.geojson", {
        style: { color: "#5a189a", weight: 2, opacity: 0.8, dashArray: "4 4" },
      });
      if (cbNightRoutes?.checked) layers.nightRoutes.addTo(map);
    } catch (e) {
      warnings.push(`Could not load night bus routes: ${e.message}`);
    }

    // Bike trails:
    // Your index has a "Bike Trails" checkbox id=toggleTrails. [1](https://github.com/abigailchaikin-svg/rva_summer/blob/main/index.html)
    // If you have a trails GeoJSON, set the filename below.
    // If you don't, we just leave it off with a note.
    const trailsCandidates = [
      "data/trails.geojson",
      "data/bike_trails.geojson",
      "data/biketrails.geojson",
    ];

    for (const url of trailsCandidates) {
      try {
        layers.trails = await loadGeoJsonLayer(url, {
          style: { color: "#2d6a4f", weight: 3, opacity: 0.85 },
        });
        break;
      } catch {
        // keep trying
      }
    }
    if (layers.trails) {
      if (cbTrails?.checked) layers.trails.addTo(map);
    } else {
      // Not fatal—many projects add bike trails later.
      // We don't spam the UI; just console.
      console.warn(
        "Bike trails GeoJSON not found. Add one named trails.geojson (or similar) in /data to enable."
      );
    }

    if (warnings.length) {
      console.warn(warnings.join("\n"));
    }
  }

  function bindLayerToggles() {
    // Treat these three as "Bus" layers (stops + routes). [1](https://github.com/abigailchaikin-svg/rva_summer/blob/main/index.html)
    cbStops?.addEventListener("change", () => {
      if (!layers.stops) return;
      cbStops.checked ? layers.stops.addTo(map) : map.removeLayer(layers.stops);
    });

    cbDayRoutes?.addEventListener("change", () => {
      if (!layers.dayRoutes) return;
      cbDayRoutes.checked
        ? layers.dayRoutes.addTo(map)
        : map.removeLayer(layers.dayRoutes);
    });

    cbNightRoutes?.addEventListener("change", () => {
      if (!layers.nightRoutes) return;
      cbNightRoutes.checked
        ? layers.nightRoutes.addTo(map)
        : map.removeLayer(layers.nightRoutes);
    });

    // Bike routes checkbox. [1](https://github.com/abigailchaikin-svg/rva_summer/blob/main/index.html)
    cbTrails?.addEventListener("change", () => {
      if (!layers.trails) return;
      cbTrails.checked
        ? layers.trails.addTo(map)
        : map.removeLayer(layers.trails);
    });
  }

  // -----------------------------
  // Events loading + UI
  // -----------------------------
  let allEvents = [];

  function clearDestinations() {
    if (!elDestinationSelect) return;
    elDestinationSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(Select an event)";
    elDestinationSelect.appendChild(opt);
  }

  function populateDestinations(filteredEvents) {
    clearDestinations();
    if (!elDestinationSelect) return;

    for (const evt of filteredEvents) {
      const ll = getEventLatLng(evt);
      // Only include events that we can map
      if (!ll) continue;

      const opt = document.createElement("option");
      opt.value = evt.id ?? evt.slug ?? getEventLabel(evt);
      opt.textContent = getEventLabel(evt);

      // store lat/lng on the option for easy retrieval
      opt.dataset.lat = ll[0];
      opt.dataset.lng = ll[1];
      opt.dataset.type = getEventType(evt);

      elDestinationSelect.appendChild(opt);
    }
  }

  function renderEventsList(filteredEvents) {
    if (!elEventsList) return;
    elEventsList.innerHTML = "";

    if (!filteredEvents.length) {
      setStatus(elEventsList, "No events match this filter.", "warn");
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "events-ul";

    for (const evt of filteredEvents) {
      const li = document.createElement("li");
      const label = getEventLabel(evt);
      const ll = getEventLatLng(evt);
      li.textContent = ll ? label : `${label} (missing coordinates)`;
      ul.appendChild(li);
    }

    elEventsList.appendChild(ul);
  }

  function applyEventFilterAndUpdateUI() {
    const filter = (elEventType?.value || "all").toLowerCase();

    const filtered =
      filter === "all"
        ? allEvents
        : allEvents.filter((e) => getEventType(e) === filter);

    populateDestinations(filtered);
    renderEventsList(filtered);
  }

  async function loadEvents() {
    setStatus(elEventsList, "Loading events…", "info");
    try {
      // This file is present in your /data directory. [2](https://github.com/abigailchaikin-svg/rva_summer/tree/main/data)
      const data = await fetchJSON("data/events.json");

      // Accept either: {events:[...]} or a plain array [...]
      allEvents = Array.isArray(data) ? data : data.events ?? [];

      if (!Array.isArray(allEvents) || allEvents.length === 0) {
        setStatus(
          elEventsList,
          "Events file loaded, but it contains no events.",
          "warn"
        );
        clearDestinations();
        return;
      }

      applyEventFilterAndUpdateUI();
      setStatus(elEventsList, `Loaded ${allEvents.length} events.`, "ok");
    } catch (e) {
      console.error(e);
      setStatus(
        elEventsList,
        `Could not load events.json. Check the file path and JSON format. (${e.message})`,
        "error"
      );
      clearDestinations();
    }
  }

  // -----------------------------
  // Simple routing (no external API key needed)
  // - Walk/Bike: draws a straight line + distance
  // - Bus: shows bus layers and draws straight line + note
  // -----------------------------
  function clearRouteGraphics() {
    if (layers.routeLine) map.removeLayer(layers.routeLine);
    if (layers.startMarker) map.removeLayer(layers.startMarker);
    if (layers.destMarker) map.removeLayer(layers.destMarker);
    layers.routeLine = null;
    layers.startMarker = null;
    layers.destMarker = null;
  }

  async function geocodeStart(query) {
    // Nominatim (OpenStreetMap) — no key required, but be polite.
    // If you later host production traffic, you should use your own geocoder.
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
      encodeURIComponent(query);

    const res = await fetch(url, {
      headers: { "Accept-Language": "en" },
    });
    if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
    const arr = await res.json();
    if (!arr.length) return null;
    return [Number(arr[0].lat), Number(arr[0].lon)];
  }

  async function buildRoute() {
    clearRouteGraphics();

    const startText = elStartInput?.value?.trim() || "";
    if (!startText) {
      setStatus(elRouteSummary, "Enter a start address/place first.", "warn");
      return;
    }

    const sel = elDestinationSelect?.selectedOptions?.[0];
    const destLat = sel?.dataset?.lat ? Number(sel.dataset.lat) : NaN;
    const destLng = sel?.dataset?.lng ? Number(sel.dataset.lng) : NaN;

    if (!sel || Number.isNaN(destLat) || Number.isNaN(destLng)) {
      setStatus(elRouteSummary, "Select a destination event first.", "warn");
      return;
    }

    setStatus(elRouteSummary, "Finding start location…", "info");

    let startLL;
    try {
      startLL = await geocodeStart(startText);
    } catch (e) {
      console.error(e);
      setStatus(elRouteSummary, `Start lookup failed: ${e.message}`, "error");
      return;
    }

    if (!startLL) {
      setStatus(
        elRouteSummary,
        "Could not find that start location. Try a more specific address.",
        "warn"
      );
      return;
    }

    const destLL = [destLat, destLng];

    // Markers
    layers.startMarker = L.marker(startLL).addTo(map).bindPopup("Start");
    layers.destMarker = L.marker(destLL).addTo(map).bindPopup("Destination");

    // Simple line
    layers.routeLine = L.polyline([startLL, destLL], {
      color: "#ff6b35",
      weight: 4,
      opacity: 0.9,
    }).addTo(map);

    map.fitBounds(layers.routeLine.getBounds(), { padding: [30, 30] });

    const mode = elModeSelect?.value || "foot-walking";
    const dist = haversineMeters(startLL, destLL);

    let modeLabel = "Walk";
    if (mode === "cycling-regular") modeLabel = "Bike";
    if (mode === "bus") modeLabel = "Bus";

    // For "Bus" mode: ensure bus layers are visible
    if (mode === "bus") {
      cbStops && (cbStops.checked = true);
      cbDayRoutes && (cbDayRoutes.checked = true);
      if (layers.stops) layers.stops.addTo(map);
      if (layers.dayRoutes) layers.dayRoutes.addTo(map);
      // night routes optional
    }

    setStatus(
      elRouteSummary,
      `${modeLabel} route (straight-line preview): ${formatDistance(dist)}.` +
        (mode === "bus"
          ? " Bus routing logic is not included in this simple preview, but stops/routes are shown on the map."
          : ""),
      "ok"
    );
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function wireUI() {
    ensureBusModeOption();

    elLoadEventsBtn?.addEventListener("click", loadEvents);
    elEventType?.addEventListener("change", applyEventFilterAndUpdateUI);
    elRouteBtn?.addEventListener("click", buildRoute);

    // When user picks a destination, pan there
    elDestinationSelect?.addEventListener("change", () => {
      const opt = elDestinationSelect.selectedOptions?.[0];
      const lat = opt?.dataset?.lat ? Number(opt.dataset.lat) : NaN;
      const lng = opt?.dataset?.lng ? Number(opt.dataset.lng) : NaN;
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        map.setView([lat, lng], Math.max(map.getZoom(), 14));
      }
    });
  }

  // Wait for DOM
  window.addEventListener("DOMContentLoaded", async () => {
    try {
      wireUI();
      initMap();
      bindLayerToggles();
      await loadLayers();

      // auto-load events on startup (so dropdown is not empty)
      await loadEvents();
    } catch (e) {
      console.error(e);
      setStatus(
        elEventsList,
        "Startup error. Open DevTools Console for details.",
        "error"
      );
    }
  });
})();

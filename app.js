/* =========================================================
   app.js — Richmond Summer Routes (GTFS GeoJSON + Legend)
   ========================================================= */

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

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
    return await res.json();
  }

  function haversineMeters(a, b) {
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

  // -----------------------------
  // DOM Elements
  // -----------------------------
  const elEventType = $("eventType");
  const elLoadEventsBtn = $("loadEventsBtn");
  const elEventsList = $("eventsList");

  const elStartInput = $("startInput");
  const elDestinationSelect = $("destinationSelect");
  const elModeSelect = $("modeSelect");
  const elRouteBtn = $("routeBtn");
  const elRouteSummary = $("routeSummary");

  const cbStops = $("toggleStops");
  const cbDayRoutes = $("toggleDayRoutes");
  const cbNightRoutes = $("toggleNightRoutes");
  const cbTrails = $("toggleTrails");

  // -----------------------------
  // Ensure "Bus" option exists
  // -----------------------------
  function ensureBusModeOption() {
    if (!elModeSelect) return;
    const exists = Array.from(elModeSelect.options).some((o) => o.value === "bus");
    if (!exists) {
      const opt = document.createElement("option");
      opt.value = "bus";
      opt.textContent = "Bus";
      elModeSelect.appendChild(opt);
    }
  }

  // -----------------------------
  // Leaflet Map + Legend
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
    eventsLayer: null,
  };

  function initMap() {
    map = L.map("map", { zoomControl: true }).setView([37.5407, -77.436], 12);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }

  function addLegend(map) {
    const legend = L.control({ position: "bottomright" });

    legend.onAdd = function () {
      const div = L.DomUtil.create("div", "map-legend");
      div.innerHTML = `
        <div class="legend-title">Legend</div>
        <div class="legend-row"><span class="swatch swatch-day"></span> Bus routes (Day)</div>
        <div class="legend-row"><span class="swatch swatch-night"></span> Bus routes (Night)</div>
        <div class="legend-row"><span class="swatch swatch-stops"></span> Bus stops</div>
        <div class="legend-row"><span class="swatch swatch-bike"></span> Bike routes / trails</div>
        <div class="legend-row"><span class="swatch swatch-events"></span> Event locations</div>
      `;
      return div;
    };

    legend.addTo(map);
  }

  // -----------------------------
  // GeoJSON loading
  // -----------------------------
  async function loadGeoJsonLayer(url, options) {
    const data = await fetchJSON(url);
    return L.geoJSON(data, options);
  }

  async function loadLayers() {
    const warnings = [];

    // ---- GTFS Stops (Points)
    try {
      layers.stops = await loadGeoJsonLayer("data/grtc_stops.geojson", {
        pointToLayer: (_, latlng) =>
          L.circleMarker(latlng, {
            radius: 3,
            weight: 1,
            color: "#0b3d91",
            fillColor: "#2b7bff",
            fillOpacity: 0.85,
          }),
      });
      if (cbStops?.checked) layers.stops.addTo(map);
    } catch (e) {
      warnings.push(`Could not load GTFS stops: ${e.message}`);
      if (cbStops) {
        cbStops.checked = false;
        cbStops.disabled = true;
        cbStops.parentElement?.setAttribute("title", "Stops layer unavailable");
      }
    }

    // ---- GTFS Day Routes (Lines)
    try {
      layers.dayRoutes = await loadGeoJsonLayer("data/grtc_day_routes.geojson", {
        style: { color: "#0b3d91", weight: 3, opacity: 0.85 },
        onEachFeature: (feature, layer) => {
          const p = feature?.properties || {};
          const label = `${p.route_short_name || ""} ${p.route_long_name || ""}`.trim();
          if (label) layer.bindTooltip(label, { sticky: true });
        },
      });
      if (cbDayRoutes?.checked) layers.dayRoutes.addTo(map);
    } catch (e) {
      warnings.push(`Could not load GTFS day routes: ${e.message}`);
      if (cbDayRoutes) {
        cbDayRoutes.checked = false;
        cbDayRoutes.disabled = true;
        cbDayRoutes.parentElement?.setAttribute("title", "Day routes layer unavailable");
      }
    }

    // ---- GTFS Night Routes (Lines, purple dashed)
    try {
      layers.nightRoutes = await loadGeoJsonLayer("data/grtc_night_routes.geojson", {
        style: { color: "#6d28d9", weight: 3, opacity: 0.9, dashArray: "6 6" },
        onEachFeature: (feature, layer) => {
          const p = feature?.properties || {};
          const label = `${p.route_short_name || ""} ${p.route_long_name || ""}`.trim();
          if (label) layer.bindTooltip(`${label} (Night)`, { sticky: true });
        },
      });
      if (cbNightRoutes?.checked) layers.nightRoutes.addTo(map);
    } catch (e) {
      warnings.push(`Could not load GTFS night routes: ${e.message}`);
      if (cbNightRoutes) {
        cbNightRoutes.checked = false;
        cbNightRoutes.disabled = true;
        cbNightRoutes.parentElement?.setAttribute("title", "Night routes layer unavailable");
      }
    }

    // ---- Bike trails (optional)
    // If you add data/trails.geojson (or similar), it will show.
    const trailsCandidates = ["data/trails.geojson", "data/bike_trails.geojson", "data/biketrails.geojson"];
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
    } else if (cbTrails) {
      // trails are optional; leave checkbox enabled but show console note
      console.warn("Bike trails file not found. Add data/trails.geojson to enable.");
    }

    if (warnings.length) console.warn(warnings.join("\n"));
  }

  function bindLayerToggles() {
    cbStops?.addEventListener("change", () => {
      if (!layers.stops) return;
      cbStops.checked ? layers.stops.addTo(map) : map.removeLayer(layers.stops);
    });

    cbDayRoutes?.addEventListener("change", () => {
      if (!layers.dayRoutes) return;
      cbDayRoutes.checked ? layers.dayRoutes.addTo(map) : map.removeLayer(layers.dayRoutes);
    });

    cbNightRoutes?.addEventListener("change", () => {
      if (!layers.nightRoutes) return;
      cbNightRoutes.checked ? layers.nightRoutes.addTo(map) : map.removeLayer(layers.nightRoutes);
    });

    cbTrails?.addEventListener("change", () => {
      if (!layers.trails) return;
      cbTrails.checked ? layers.trails.addTo(map) : map.removeLayer(layers.trails);
    });
  }

  // -----------------------------
  // Events (supports events.geojson OR events.json)
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

  function getEventType(evt) {
    return (evt?.type || evt?.category || evt?.eventType || "other").toString().toLowerCase();
  }

  function getEventLabel(evt) {
    return evt?.name || evt?.title || evt?.event || evt?.venue || "Unnamed event";
  }

  function getEventLatLng(evt) {
    // Works with JSON or GeoJSON-normalized objects
    const lat = evt?.lat ?? evt?.latitude ?? evt?.location?.lat ?? evt?.location?.latitude;
    const lng = evt?.lng ?? evt?.lon ?? evt?.longitude ?? evt?.location?.lng ?? evt?.location?.lon ?? evt?.location?.longitude;
    if (typeof lat === "number" && typeof lng === "number") return [lat, lng];
    const latN = Number(lat);
    const lngN = Number(lng);
    if (!Number.isNaN(latN) && !Number.isNaN(lngN)) return [latN, lngN];
    return null;
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
      const ll = getEventLatLng(evt);
      const li = document.createElement("li");
      li.textContent = ll ? getEventLabel(evt) : `${getEventLabel(evt)} (missing coordinates)`;
      ul.appendChild(li);
    }

    elEventsList.appendChild(ul);
  }

  function populateDestinations(filteredEvents) {
    clearDestinations();
    if (!elDestinationSelect) return;

    for (const evt of filteredEvents) {
      const ll = getEventLatLng(evt);
      if (!ll) continue;

      const opt = document.createElement("option");
      opt.value = evt.id ?? evt.slug ?? getEventLabel(evt);
      opt.textContent = getEventLabel(evt);
      opt.dataset.lat = ll[0];
      opt.dataset.lng = ll[1];
      opt.dataset.type = getEventType(evt);
      elDestinationSelect.appendChild(opt);
    }
  }

  function drawEventsLayer(filteredEvents) {
    if (layers.eventsLayer) {
      map.removeLayer(layers.eventsLayer);
      layers.eventsLayer = null;
    }

    // Convert to GeoJSON on the fly for map display
    const feats = filteredEvents
      .map((evt) => {
        const ll = getEventLatLng(evt);
        if (!ll) return null;
        return {
          type: "Feature",
          properties: {
            id: evt.id ?? evt.slug ?? getEventLabel(evt),
            name: getEventLabel(evt),
            type: getEventType(evt),
            venue: evt.venue || "",
            address: evt.address || "",
          },
          geometry: {
            type: "Point",
            coordinates: [Number(ll[1]), Number(ll[0])], // [lng, lat]
          },
        };
      })
      .filter(Boolean);

    layers.eventsLayer = L.geoJSON(
      { type: "FeatureCollection", features: feats },
      {
        pointToLayer: (_, latlng) =>
          L.circleMarker(latlng, {
            radius: 6,
            weight: 2,
            color: "#b45309",
            fillColor: "#f59e0b",
            fillOpacity: 0.9,
          }),
        onEachFeature: (feature, layer) => {
          const p = feature.properties || {};
          const html = `
            <strong>${p.name || "Event"}</strong><br/>
            <span class="muted">${p.venue || ""}</span><br/>
            <span class="muted">${p.address || ""}</span>
          `;
          layer.bindPopup(html);
        },
      }
    ).addTo(map);
  }

  function applyEventFilterAndUpdateUI() {
    const filter = (elEventType?.value || "all").toLowerCase();
    const filtered = filter === "all" ? allEvents : allEvents.filter((e) => getEventType(e) === filter);

    populateDestinations(filtered);
    renderEventsList(filtered);
    drawEventsLayer(filtered);
  }

  async function loadEvents() {
    setStatus(elEventsList, "Loading events…", "info");
    clearDestinations();

    // Try GeoJSON first, then JSON
    try {
      const geo = await fetchJSON("data/events.geojson");
      const feats = geo?.features || [];
      allEvents = feats.map((f) => {
        const p = f.properties || {};
        const coords = f.geometry?.coordinates || [];
        const lng = Number(coords[0]);
        const lat = Number(coords[1]);
        return {
          id: p.id,
          name: p.name,
          type: p.type,
          venue: p.venue,
          address: p.address,
          lat,
          lng,
        };
      });

      if (!allEvents.length) throw new Error("events.geojson loaded but contained no features.");
      applyEventFilterAndUpdateUI();
      setStatus(elEventsList, `Loaded ${allEvents.length} events.`, "ok");
      return;
    } catch (eGeo) {
      console.warn("events.geojson not used:", eGeo.message);
    }

    // Fallback to JSON
    try {
      const data = await fetchJSON("data/events.json");
      allEvents = Array.isArray(data) ? data : data.events ?? [];
      if (!allEvents.length) throw new Error("events.json loaded but contained no events.");
      applyEventFilterAndUpdateUI();
      setStatus(elEventsList, `Loaded ${allEvents.length} events.`, "ok");
    } catch (e) {
      console.error(e);
      setStatus(elEventsList, `Could not load events (events.geojson or events.json). ${e.message}`, "error");
      clearDestinations();
    }
  }

  // -----------------------------
  // Routing (simple preview)
  // Walk/Bike/Bus: straight-line preview + markers
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
    // Nominatim geocoder (public OSM geocoder). For production, use a key-based geocoder.
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(query);
    const res = await fetch(url, { cache: "no-store" });
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
      setStatus(elRouteSummary, "Could not find that start location. Try a more specific address.", "warn");
      return;
    }

    const destLL = [destLat, destLng];

    layers.startMarker = L.marker(startLL).addTo(map).bindPopup("Start");
    layers.destMarker = L.marker(destLL).addTo(map).bindPopup("Destination");

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

    // If bus mode, ensure stops + day routes visible
    if (mode === "bus") {
      if (cbStops && !cbStops.disabled) cbStops.checked = true;
      if (cbDayRoutes && !cbDayRoutes.disabled) cbDayRoutes.checked = true;
      if (layers.stops) layers.stops.addTo(map);
      if (layers.dayRoutes) layers.dayRoutes.addTo(map);
    }

    setStatus(
      elRouteSummary,
      `${modeLabel} route (straight-line preview): ${formatDistance(dist)}.` +
        (mode === "bus"
          ? " Bus geometry is displayed via GTFS layers; this preview does not compute transfers."
          : ""),
      "ok"
    );
  }

  // -----------------------------
  // UI Wiring + Boot
  // -----------------------------
  function wireUI() {
    ensureBusModeOption();

    elLoadEventsBtn?.addEventListener("click", loadEvents);
    elEventType?.addEventListener("change", applyEventFilterAndUpdateUI);
    elRouteBtn?.addEventListener("click", buildRoute);

    elDestinationSelect?.addEventListener("change", () => {
      const opt = elDestinationSelect.selectedOptions?.[0];
      const lat = opt?.dataset?.lat ? Number(opt.dataset.lat) : NaN;
      const lng = opt?.dataset?.lng ? Number(opt.dataset.lng) : NaN;
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        map.setView([lat, lng], Math.max(map.getZoom(), 14));
      }
    });
  }

  window.addEventListener("DOMContentLoaded", async () => {
    try {
      wireUI();
      initMap();
      addLegend(map);
      bindLayerToggles();

      await loadLayers();
      await loadEvents(); // auto-load so dropdown isn’t empty
    } catch (e) {
      console.error(e);
      setStatus(elEventsList, "Startup error. Open DevTools Console for details.", "error");
    }
  });
})();

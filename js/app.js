/* Grid Trace — satellite map + GIS grid overlay + GPS visited-cell tracking (local storage) */

const DEFAULT_GRID_URL = 'data/rissho32654_5m.geojson';

// Source CRS of the GeoJSON grid. Leaflet/GPS only understand WGS84 (lon/lat),
// so files stored in a different CRS are converted automatically on load.
// EPSG:32654 = UTM Zone 54N (WGS84) — covers roughly 138–144°E (e.g. Kumagaya)
const SOURCE_CRS = 'EPSG:32654';
proj4.defs(SOURCE_CRS, '+proj=utm +zone=54 +datum=WGS84 +units=m +no_defs +type=crs');

const els = {
  map: document.getElementById('map'),
  gaugeFill: document.getElementById('gaugeFill'),
  gaugePct: document.getElementById('gaugePct'),
  visitedCount: document.getElementById('visitedCount'),
  totalCount: document.getElementById('totalCount'),
  cellSize: document.getElementById('cellSize'),
  gpsBadge: document.getElementById('gpsBadge'),
  gpsText: document.getElementById('gpsText'),
  startBtn: document.getElementById('startBtn'),
  startIcon: document.getElementById('startIcon'),
  followBtn: document.getElementById('followBtn'),
  resetBtn: document.getElementById('resetBtn'),
  exportBtn: document.getElementById('exportBtn'),
  gridFileInput: document.getElementById('gridFileInput'),
  toast: document.getElementById('toast'),
};

const GAUGE_CIRC = 2 * Math.PI * 52; // r=52

const state = {
  map: null,
  gridLayer: null,
  cellsById: new Map(),      // id -> { layer, feature, bbox:[minX,minY,maxX,maxY] }
  visited: new Set(),
  gridSig: null,
  watchId: null,
  tracking: false,
  following: true,
  posMarker: null,
  accCircle: null,
  lastFix: null,
};

// ---------- utils ----------

function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function storageKey(sig) {
  return `gridtrace:visited:${sig}`;
}

function gridSignature(fc) {
  try {
    const n = fc.features.length;
    const first = JSON.stringify(fc.features[0]?.geometry?.coordinates?.[0]?.[0] || '');
    const last = JSON.stringify(fc.features[n - 1]?.geometry?.coordinates?.[0]?.[0] || '');
    return `${n}_${first}_${last}`.slice(0, 120);
  } catch (e) {
    return `${fc.features.length}`;
  }
}

function loadVisitedFor(sig) {
  try {
    const raw = localStorage.getItem(storageKey(sig));
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (e) {
    return new Set();
  }
}

function saveVisited() {
  if (!state.gridSig) return;
  localStorage.setItem(storageKey(state.gridSig), JSON.stringify([...state.visited]));
}

function featureCellId(feature, index) {
  const p = feature.properties || {};
  return String(p.id ?? p.ID ?? p.cell_id ?? p.CELL_ID ?? index);
}

// True if a coordinate pair already looks like WGS84 (lon/lat).
// UTM coordinates are normally in the hundreds-of-thousands to millions range,
// well outside this window.
function looksLikeLonLat(x, y) {
  return Math.abs(x) <= 180 && Math.abs(y) <= 90;
}

// Recursively convert a coordinate array from SOURCE_CRS -> WGS84.
// Coordinates that already look like lon/lat are left untouched.
function reprojectCoordinates(coords) {
  if (typeof coords[0] === 'number') {
    const [x, y, z] = coords;
    if (looksLikeLonLat(x, y)) return coords; // already WGS84
    const [lon, lat] = proj4(SOURCE_CRS, 'WGS84', [x, y]);
    return z !== undefined ? [lon, lat, z] : [lon, lat];
  }
  return coords.map(reprojectCoordinates);
}

function reprojectFeatureCollection(fc) {
  let converted = 0;
  let skipped = 0;
  for (const f of fc.features) {
    if (!f.geometry || !f.geometry.coordinates) continue;
    const first = firstCoordPair(f.geometry.coordinates);
    if (first && !looksLikeLonLat(first[0], first[1])) converted++; else skipped++;
    f.geometry.coordinates = reprojectCoordinates(f.geometry.coordinates);
  }
  if (converted > 0) {
    toast(`Coordinates converted (${SOURCE_CRS} → WGS84, ${converted} geometries)`);
  }
  return fc;
}

function firstCoordPair(coords) {
  return typeof coords[0] === 'number' ? coords : firstCoordPair(coords[0]);
}

function approxCellSizeMeters(feature) {
  try {
    const ring = feature.geometry.type === 'Polygon'
      ? feature.geometry.coordinates[0]
      : feature.geometry.coordinates[0][0];
    const p0 = turf.point(ring[0]);
    const p1 = turf.point(ring[1]);
    const d = turf.distance(p0, p1, { units: 'meters' });
    return Math.round(d * 10) / 10;
  } catch (e) {
    return null;
  }
}

// ---------- map setup ----------

function initMap() {
  state.map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    maxZoom: 22,
  }).setView([36.1470, 139.3950], 18);

  L.control.zoom({ position: 'bottomright' }).addTo(state.map);

  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 21,
      maxNativeZoom: 19,
      attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
    }
  ).addTo(state.map);

  state.map.on('dragstart', () => setFollowing(false));
}

// ---------- grid rendering ----------

function styleForCell(isVisited) {
  return isVisited
    // Visited cell: filled red
    ? { color: '#ffb3b3', weight: 1.2, opacity: 1, fillColor: '#E23D3D', fillOpacity: 0.6 }
    // Unvisited cell: no fill, grid outline only
    : { color: '#ffffff', weight: 1, opacity: 0.6, fillColor: '#ffffff', fillOpacity: 0 };
}

function renderGrid(fc, fitToGrid = true) {
  if (state.gridLayer) {
    state.map.removeLayer(state.gridLayer);
  }
  state.cellsById.clear();

  reprojectFeatureCollection(fc); // SOURCE_CRS (e.g. EPSG:32654) -> WGS84, only when needed

  state.gridSig = gridSignature(fc);
  state.visited = loadVisitedFor(state.gridSig);

  // assign stable ids first so style()/onEachFeature can use them
  fc.features.forEach((f, i) => {
    f.properties = f.properties || {};
    f.properties.__id = featureCellId(f, i);
  });

  state.gridLayer = L.geoJSON(fc, {
    style: (feature) => styleForCell(state.visited.has(feature.properties.__id)),
    onEachFeature: (feature, layer) => {
      const bbox = turf.bbox(feature);
      state.cellsById.set(feature.properties.__id, { layer, feature, bbox });
    },
  }).addTo(state.map);

  if (fitToGrid) {
    try {
      state.map.fitBounds(state.gridLayer.getBounds(), { maxZoom: 19, padding: [30, 30] });
    } catch (e) { /* empty grid */ }
  }

  els.totalCount.textContent = fc.features.length;
  const size = approxCellSizeMeters(fc.features[0]);
  els.cellSize.textContent = size ? `${size}m` : '–';

  updateHud();
  toast(`Loaded grid: ${fc.features.length} cells`);
}

// Recursively convert a WGS84 coordinate array back to SOURCE_CRS (for export).
function toSourceCrsCoordinates(coords) {
  if (typeof coords[0] === 'number') {
    const [lon, lat, z] = coords;
    const [x, y] = proj4('WGS84', SOURCE_CRS, [lon, lat]);
    return z !== undefined ? [x, y, z] : [x, y];
  }
  return coords.map(toSourceCrsCoordinates);
}

// Export the current visit state as GeoJSON (coordinates saved in SOURCE_CRS,
// e.g. EPSG:32654). Adds simplestyle-spec properties so visited cells render
// red and unvisited cells render transparent out of the box in GitHub's
// preview, geojson.io, QGIS, etc.
function exportVisitedGeoJSON() {
  if (state.cellsById.size === 0) {
    toast('No grid data to export');
    return;
  }
  const features = [];
  for (const [id, cell] of state.cellsById) {
    const isVisited = state.visited.has(id);
    const props = { ...cell.feature.properties };
    delete props.__id;
    props.visited = isVisited;
    props.fill = isVisited ? '#E23D3D' : '#ffffff';
    props['fill-opacity'] = isVisited ? 0.6 : 0;
    props.stroke = isVisited ? '#ffb3b3' : '#ffffff';
    props['stroke-opacity'] = isVisited ? 1 : 0.6;
    props['stroke-width'] = isVisited ? 1.2 : 1;
    const geometry = {
      type: cell.feature.geometry.type,
      coordinates: toSourceCrsCoordinates(cell.feature.geometry.coordinates),
    };
    features.push({ type: 'Feature', properties: props, geometry });
  }

  const fc = {
    type: 'FeatureCollection',
    // RFC7946 (the GeoJSON spec) fixes WGS84, but most desktop GIS tools
    // (QGIS included) still honor this legacy crs member and will display
    // the coordinates correctly as SOURCE_CRS.
    crs: {
      type: 'name',
      properties: { name: `urn:ogc:def:crs:EPSG::${SOURCE_CRS.split(':')[1]}` },
    },
    features,
  };
  const blob = new Blob([JSON.stringify(fc)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `gridtrace_export_${SOURCE_CRS.replace(':', '')}_${ts}.geojson`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  toast(`Exported GeoJSON (${SOURCE_CRS} · ${features.length} cells · ${state.visited.size} visited)`);
}

function markVisited(id) {
  if (state.visited.has(id)) return false;
  state.visited.add(id);
  const cell = state.cellsById.get(id);
  if (cell) cell.layer.setStyle(styleForCell(true));
  saveVisited();
  updateHud();
  return true;
}

function updateHud() {
  const total = state.cellsById.size;
  const visited = state.visited.size;
  const pct = total > 0 ? visited / total : 0;
  els.visitedCount.textContent = visited;
  els.totalCount.textContent = total;
  els.gaugePct.textContent = `${Math.round(pct * 100)}%`;
  els.gaugeFill.style.strokeDashoffset = String(GAUGE_CIRC * (1 - pct));
}

// ---------- GPS / cell detection ----------

function findCellAt(lon, lat) {
  const pt = turf.point([lon, lat]);
  for (const [id, cell] of state.cellsById) {
    const [minX, minY, maxX, maxY] = cell.bbox;
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    if (turf.booleanPointInPolygon(pt, cell.feature.geometry)) return id;
  }
  return null;
}

function updatePositionMarker(lat, lon, accuracy) {
  const latlng = [lat, lon];
  if (!state.posMarker) {
    state.posMarker = L.marker(latlng, {
      icon: L.divIcon({ className: 'pos-marker', iconSize: [18, 18] }),
      zIndexOffset: 1000,
    }).addTo(state.map);
    state.accCircle = L.circle(latlng, {
      radius: accuracy,
      color: '#35C2FF',
      weight: 1,
      fillColor: '#35C2FF',
      fillOpacity: 0.08,
    }).addTo(state.map);
  } else {
    state.posMarker.setLatLng(latlng);
    state.accCircle.setLatLng(latlng);
    state.accCircle.setRadius(accuracy);
  }
  if (state.following) {
    state.map.panTo(latlng, { animate: true });
  }
}

function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  state.lastFix = { lat, lon, accuracy };

  setGpsBadge('active', `GPS ±${Math.round(accuracy)}m`);
  updatePositionMarker(lat, lon, accuracy);

  if (state.cellsById.size > 0) {
    const id = findCellAt(lon, lat);
    if (id !== null) {
      const isNew = markVisited(id);
      if (isNew) toast(`New cell visited · #${id}`);
    }
  }
}

function onPositionError(err) {
  setGpsBadge('error', err.code === 1 ? 'Location permission denied' : 'No GPS signal');
}

function setGpsBadge(mode, text) {
  els.gpsBadge.className = 'badge' + (mode === 'active' ? ' badge-active' : mode === 'error' ? ' badge-error' : ' badge-idle');
  els.gpsText.textContent = text;
}

function getCurrentPositionOnce() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  });
}

function startTracking() {
  if (!('geolocation' in navigator)) {
    toast('This browser does not support location services');
    return;
  }
  state.tracking = true;
  els.startBtn.classList.add('is-active');
  els.startIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" fill="currentColor" rx="2"/>';
  setGpsBadge('idle', 'Connecting to GPS…');

  state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 10000,
  });
}

function stopTracking() {
  state.tracking = false;
  els.startBtn.classList.remove('is-active');
  els.startIcon.innerHTML = '<path d="M6 4l14 8-14 8V4z" fill="currentColor"/>';
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  setGpsBadge('idle', 'GPS idle');
}

function setFollowing(on) {
  state.following = on;
  els.followBtn.classList.toggle('is-following', on);
  if (on && state.lastFix) {
    state.map.panTo([state.lastFix.lat, state.lastFix.lon], { animate: true });
  }
}

// ---------- wiring ----------

function wireControls() {
  els.startBtn.addEventListener('click', () => {
    state.tracking ? stopTracking() : startTracking();
  });

  els.followBtn.addEventListener('click', () => setFollowing(!state.following));

  els.exportBtn.addEventListener('click', exportVisitedGeoJSON);

  els.resetBtn.addEventListener('click', () => {
    if (state.visited.size === 0) { toast('Visit history is already empty'); return; }
    if (!confirm('Clear all visited (red) cells for this grid?')) return;
    state.visited.clear();
    saveVisited();
    for (const [, cell] of state.cellsById) cell.layer.setStyle(styleForCell(false));
    updateHud();
    toast('Visit history cleared');
  });

  els.gridFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const fc = JSON.parse(reader.result);
        if (fc.type !== 'FeatureCollection') throw new Error('Not a FeatureCollection');
        renderGrid(fc);
      } catch (err) {
        toast('Could not read the grid file (check it is valid GeoJSON)');
        console.error(err);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
}

// ---------- boot ----------

async function boot() {
  initMap();
  wireControls();
  setFollowing(true);

  // Start fetching the grid file at the same time as requesting location.
  const gridPromise = fetch(DEFAULT_GRID_URL, { cache: 'no-store' })
    .then((res) => { if (!res.ok) throw new Error('no default grid'); return res.json(); })
    .catch(() => null);

  // Center the map on the current GPS location on launch (single fix; tracking not started yet).
  const posResult = await getCurrentPositionOnce();
  const fc = await gridPromise;
  const hasFix = !!posResult;

  if (hasFix) {
    const { latitude: lat, longitude: lon, accuracy } = posResult.coords;
    state.lastFix = { lat, lon, accuracy };
    state.map.setView([lat, lon], 18);
    updatePositionMarker(lat, lon, accuracy);
    setGpsBadge('active', `GPS ±${Math.round(accuracy)}m`);
  } else {
    setGpsBadge('error', 'Could not get initial location');
  }

  if (fc) {
    // If we already centered on the user's location, don't re-fit to the grid bounds.
    renderGrid(fc, !hasFix);
  } else {
    toast(hasFix
      ? 'No default grid found. Use the button below to load a GeoJSON file'
      : 'Could not load the current location or the default grid');
  }
}

boot();

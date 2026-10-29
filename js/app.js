/* Isochrones Bourgogne — affectation des agents aux incidents
 * Carte : Leaflet + fond CARTO. Routage : Valhalla (isochrones, matrice, itinéraire), OSRM en secours.
 * Géocodage : Géoplateforme IGN / BAN (adresses françaises).
 */
(function () {
  'use strict';

  /* ---------------- Configuration ---------------- */
  const STORE_KEY = 'isoBourgogne.v1';
  const DEFAULTS = {
    valhalla: 'https://valhalla1.openstreetmap.de',
    osrm: 'https://router.project-osrm.org',
    dragMode: 'live'
  };
  const GEO_SEARCH = ['https://data.geopf.fr/geocodage/search', 'https://api-adresse.data.gouv.fr/search/'];
  const GEO_REVERSE = ['https://data.geopf.fr/geocodage/reverse', 'https://api-adresse.data.gouv.fr/reverse/'];
  const CONTOURS_FULL = [60, 50, 45, 40, 30, 20, 15, 10, 5];
  const CONTOURS_QUICK = [60, 45, 30, 15];
  const OUTLINES = [15, 30, 45, 60];
  const REQ_GAP = 1050; // ms entre deux requêtes au serveur public
  const STOPS = [[0, '#1a9641'], [10, '#7ac943'], [20, '#d9ef8b'], [30, '#fee08b'], [40, '#fdae61'], [50, '#f46d43'], [60, '#d73027']];

  /* ---------------- État ---------------- */
  let state = { agents: [], incidents: [], selected: null, settings: { ...DEFAULTS } };
  let times = {};            // times[incId][agentId] = {t: secondes|null, d: km|null}
  let tab = 'agents';
  let picking = false;
  let seq = 1;
  let maxContours = 99;      // ajusté automatiquement si le serveur limite
  let reverseOK = true;      // isochrone "à l'arrivée" supportée ?
  const isoCache = new Map();
  let dragging = null;
  let routeAgentFor = {};    // incId -> agentId dont on affiche l'itinéraire

  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      state.agents = s.agents || [];
      state.incidents = s.incidents || [];
      state.selected = s.selected || null;
      state.settings = { ...DEFAULTS, ...(s.settings || {}) };
      seq = s.seq || (state.agents.length + state.incidents.length + 1);
    }
  } catch (e) { /* stockage indisponible */ }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        agents: state.agents, incidents: state.incidents, selected: state.selected,
        settings: state.settings, seq
      }));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- Utilitaires ---------------- */
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const posKey = (p) => p.lat.toFixed(5) + ',' + p.lng.toFixed(5);

  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function colorAt(min) {
    const m = Math.max(0, Math.min(60, min));
    for (let i = 1; i < STOPS.length; i++) {
      if (m <= STOPS[i][0]) {
        const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i];
        const f = (m - a) / (b - a), A = hexToRgb(ca), B = hexToRgb(cb);
        return 'rgb(' + A.map((v, k) => Math.round(v + (B[k] - v) * f)).join(',') + ')';
      }
    }
    return STOPS[STOPS.length - 1][1];
  }
  function fmtTime(sec) {
    if (sec == null) return '—';
    const m = Math.round(sec / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), r = m % 60;
    return h + ' h ' + String(r).padStart(2, '0');
  }
  const fmtKm = (d) => (d == null ? '' : d.toFixed(1).replace('.', ',') + ' km');

  let stTimer;
  function status(msg, err, ms) {
    const el = $('#status');
    el.textContent = msg;
    el.className = 'status on' + (err ? ' err' : '');
    clearTimeout(stTimer);
    if (ms !== 0) stTimer = setTimeout(() => (el.className = 'status'), ms || 2500);
  }

  /* ---------------- Zone Bourgogne + 6 km ---------------- */
  const zoneRing = ZONE.geometry.coordinates[0]; // [lng, lat]
  function inZone(lat, lng) {
    let inside = false;
    for (let i = 0, j = zoneRing.length - 1; i < zoneRing.length; j = i++) {
      const xi = zoneRing[i][0], yi = zoneRing[i][1], xj = zoneRing[j][0], yj = zoneRing[j][1];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /* ---------------- Carte ---------------- */
  const latlngs = zoneRing.map((c) => [c[1], c[0]]);
  const zoneBounds = L.latLngBounds(latlngs);
  const map = L.map('map', {
    zoomControl: true, minZoom: 7, maxZoom: 17,
    maxBounds: zoneBounds.pad(0.25), maxBoundsViscosity: 0.8, preferCanvas: false
  });
  map.fitBounds(zoneBounds, { padding: [10, 10] });

  map.createPane('iso').style.zIndex = 380;
  map.getPane('iso').style.opacity = 0.62;
  map.createPane('isoLines').style.zIndex = 390;
  map.createPane('labels').style.zIndex = 395;
  map.getPane('labels').style.pointerEvents = 'none';
  map.createPane('route').style.zIndex = 420;
  map.createPane('mask').style.zIndex = 450;
  map.getPane('mask').style.pointerEvents = 'none';

  // Fonds de plan sans clé d'API (fonctionnent aussi en ouvrant index.html en local)
  const routing = ' · Routage <a href="https://valhalla.github.io/valhalla/">Valhalla</a>';
  const ign = (layer, fmt, style) => 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layer +
    '&STYLE=' + (style || 'normal') + '&TILEMATRIXSET=PM&FORMAT=' + fmt + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  const ignAttr = '&copy; <a href="https://geoservices.ign.fr/">IGN Géoplateforme</a>' + routing;
  const esriAttr = '&copy; Esri, HERE, Garmin, &copy; OpenStreetMap' + routing;
  const bases = {
    'Plan IGN (gris)': L.tileLayer(ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'), { maxZoom: 19, attribution: ignAttr, className: 'tiles-gray' }),
    'Plan IGN (couleur)': L.tileLayer(ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'), { maxZoom: 19, attribution: ignAttr }),
    'Photos aériennes IGN': L.tileLayer(ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), { maxZoom: 19, attribution: ignAttr }),
    'Esri gris clair': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: esriAttr }),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' + routing })
  };
  let baseName = 'Plan IGN (gris)';
  try { const b = localStorage.getItem(STORE_KEY + '.base'); if (b && bases[b]) baseName = b; } catch (e) { /* */ }
  bases[baseName].addTo(map);
  L.control.layers(bases, null, { position: 'topleft', collapsed: true }).addTo(map);
  map.on('baselayerchange', (e) => { try { localStorage.setItem(STORE_KEY + '.base', e.name); } catch (er) { /* */ } });
  // Bascule automatique si le fond choisi ne répond pas
  Object.entries(bases).forEach(([name, layer]) => {
    let errs = 0, oks = 0;
    layer.on('tileload', () => { oks++; });
    layer.on('tileerror', () => {
      errs++;
      if (errs === 6 && oks === 0 && map.hasLayer(layer)) {
        const next = Object.keys(bases)[(Object.keys(bases).indexOf(name) + 1) % Object.keys(bases).length];
        map.removeLayer(layer); bases[next].addTo(map);
        status('Fond « ' + name + ' » indisponible, passage à « ' + next + ' »', true, 4000);
      }
    });
  });

  // Transparence de l'isochrone réglable
  const opIn = document.getElementById('isoOpacity');
  if (opIn) {
    try { const o = localStorage.getItem(STORE_KEY + '.op'); if (o) opIn.value = o; } catch (e) { /* */ }
    const applyOp = () => { map.getPane('iso').style.opacity = opIn.value / 100; try { localStorage.setItem(STORE_KEY + '.op', opIn.value); } catch (e) { /* */ } };
    opIn.addEventListener('input', applyOp); applyOp();
  }

  // Masque blanc autour de la zone
  const world = [[89, -179], [89, 179], [-89, 179], [-89, -179]];
  L.polygon([world, latlngs], { pane: 'mask', stroke: false, fillColor: '#ffffff', fillOpacity: 0.8, interactive: false }).addTo(map);
  L.polygon(latlngs, { pane: 'mask', color: '#2e9e1f', weight: 2, dashArray: '6 5', fill: false, interactive: false }).addTo(map);
  // Limites départementales
  L.geoJSON(DEPTS, { pane: 'isoLines', interactive: false, style: { color: '#8a918c', weight: 1, opacity: 0.6, fill: false, dashArray: '2 4' } }).addTo(map);

  const isoRenderer = L.svg({ pane: 'iso' });
  const isoLayer = L.layerGroup().addTo(map);
  const isoLineLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const agentLayer = L.layerGroup().addTo(map);
  const incLayer = L.layerGroup().addTo(map);
  const markers = { agents: {}, incidents: {} };

  /* ---------------- File de requêtes (serveur public : ~1 req/s) ---------------- */
  const Q = { busy: false, last: 0, jobs: [] };
  function enqueue(key, fn) {
    return new Promise((res, rej) => {
      const job = { key, fn, res, rej };
      const i = Q.jobs.findIndex((j) => j.key === key);
      if (i >= 0) { Q.jobs[i].rej({ superseded: true }); Q.jobs[i] = job; } else Q.jobs.push(job);
      pump();
    });
  }
  async function pump() {
    if (Q.busy || !Q.jobs.length) return;
    Q.busy = true;
    const wait = Math.max(0, Q.last + REQ_GAP - Date.now());
    if (wait) await sleep(wait);
    const job = Q.jobs.shift();
    if (job) {
      try { job.res(await job.fn()); } catch (e) { job.rej(e); }
      Q.last = Date.now();
    }
    Q.busy = false;
    pump();
  }
  const quiet = (e) => { if (!e || !e.superseded) console.warn(e); };

  async function getJSON(url) {
    const r = await fetch(url);
    let body = null;
    try { body = await r.json(); } catch (e) { /* */ }
    if (!r.ok) { const err = new Error((body && (body.error || body.message)) || ('HTTP ' + r.status)); err.body = body; err.status = r.status; throw err; }
    return body;
  }
  const valhalla = (action, body) =>
    getJSON(state.settings.valhalla.replace(/\/$/, '') + '/' + action + '?json=' + encodeURIComponent(JSON.stringify(body)));

  /* ---------------- Géocodage ---------------- */
  async function geoSearch(q) {
    for (const base of GEO_SEARCH) {
      try {
        const d = await getJSON(base + '?q=' + encodeURIComponent(q) + '&limit=7&lat=47.1&lon=4.4&autocomplete=1');
        return (d.features || []).map((f) => ({
          label: f.properties.label, context: f.properties.context || '',
          lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0]
        }));
      } catch (e) { /* essai suivant */ }
    }
    throw new Error('Géocodage indisponible');
  }
  async function geoReverse(lat, lng) {
    for (const base of GEO_REVERSE) {
      try {
        const d = await getJSON(base + '?lat=' + lat + '&lon=' + lng + '&limit=1');
        if (d.features && d.features[0]) return d.features[0].properties.label;
        return null;
      } catch (e) { /* essai suivant */ }
    }
    return null;
  }

  /* ---------------- Isochrones ---------------- */
  async function fetchIso(p, contours) {
    const call = (cs, rev) => valhalla('isochrone', {
      locations: [{ lat: p.lat, lon: p.lng }], costing: 'auto',
      contours: cs.map((t) => ({ time: t })), polygons: true, denoise: 0.2, generalize: 60, reverse: rev
    });
    const chunks = [];
    const sorted = [...contours].sort((a, b) => b - a);
    for (let i = 0; i < sorted.length; i += Math.min(maxContours, sorted.length)) chunks.push(sorted.slice(i, i + Math.min(maxContours, sorted.length)));
    let feats = [];
    for (const cs of chunks) {
      let d;
      try { d = await call(cs, reverseOK); }
      catch (e) {
        const msg = String(e.message || '') + JSON.stringify(e.body || {});
        if (cs.length > 4) { maxContours = 4; return fetchIso(p, contours); }
        if (reverseOK && /reverse/i.test(msg)) { reverseOK = false; d = await call(cs, false); }
        else throw e;
      }
      feats = feats.concat(d.features || []);
      if (chunks.length > 1) await sleep(REQ_GAP);
    }
    return feats.filter((f) => f.geometry && /Polygon/.test(f.geometry.type));
  }

  function drawIso(feats) {
    isoLayer.clearLayers(); isoLineLayer.clearLayers();
    const cs = [...new Set(feats.map((f) => f.properties.contour))].sort((a, b) => a - b);
    const prev = (c) => { const i = cs.indexOf(c); return i > 0 ? cs[i - 1] : 0; };
    feats.sort((a, b) => b.properties.contour - a.properties.contour).forEach((f) => {
      const c = f.properties.contour;
      L.geoJSON(f, { renderer: isoRenderer, interactive: false, style: { stroke: false, fillColor: colorAt((c + prev(c)) / 2), fillOpacity: 1 } }).addTo(isoLayer);
      if (OUTLINES.includes(c)) {
        const g = L.geoJSON(f, { pane: 'isoLines', interactive: false, style: { color: '#ffffff', weight: 0.8, opacity: 0.45, fill: false } }).addTo(isoLineLayer);
        // étiquette sur le point le plus au nord
        let top = null;
        g.eachLayer((l) => { const b = l.getBounds(); if (!top || b.getNorth() > top.lat) top = { lat: b.getNorth(), lng: b.getCenter().lng }; });
        if (top) L.tooltip({ permanent: true, direction: 'center', className: 'iso-lbl', pane: 'isoLines' }).setLatLng(top).setContent(c === 60 ? '1 h' : c + ' min').addTo(isoLineLayer);
      }
    });
  }

  function showIsoFor(inc, quick) {
    if (!inc) { isoLayer.clearLayers(); isoLineLayer.clearLayers(); return; }
    const k = posKey(inc);
    const cached = isoCache.get(k + '|full') || (quick && isoCache.get(k + '|quick'));
    if (cached) { drawIso(cached); return; }
    if (!quick) status('Calcul de l\'isochrone…', false, 0);
    enqueue('iso', () => fetchIso(inc, quick ? CONTOURS_QUICK : CONTOURS_FULL))
      .then((feats) => {
        isoCache.set(k + (quick ? '|quick' : '|full'), feats);
        const cur = selectedInc();
        if (cur && posKey(cur) === k) drawIso(feats);
        if (!quick) status('Isochrone à jour', false, 1200);
      })
      .catch((e) => { if (!e.superseded) { quiet(e); status('Isochrone indisponible : ' + (e.message || 'erreur réseau'), true, 5000); } });
  }

  /* ---------------- Temps de trajet (matrice) ---------------- */
  async function matrixValhalla(srcs, tgts) {
    const d = await valhalla('sources_to_targets', {
      sources: srcs.map((p) => ({ lat: p.lat, lon: p.lng })),
      targets: tgts.map((p) => ({ lat: p.lat, lon: p.lng })), costing: 'auto', units: 'kilometers'
    });
    const m = d.sources_to_targets;
    if (!Array.isArray(m)) throw new Error('format matrice inattendu');
    return srcs.map((_, i) => tgts.map((_, j) => {
      const c = m[i] && m[i][j];
      return c && c.time != null ? { t: c.time, d: c.distance } : { t: null, d: null };
    }));
  }
  async function matrixOsrm(srcs, tgts) {
    const pts = srcs.concat(tgts).map((p) => p.lng.toFixed(6) + ',' + p.lat.toFixed(6)).join(';');
    const s = srcs.map((_, i) => i).join(';'), t = tgts.map((_, j) => srcs.length + j).join(';');
    const d = await getJSON(state.settings.osrm.replace(/\/$/, '') + '/table/v1/driving/' + pts + '?sources=' + s + '&destinations=' + t + '&annotations=duration,distance');
    return srcs.map((_, i) => tgts.map((_, j) => ({
      t: d.durations[i][j], d: d.distances ? d.distances[i][j] / 1000 : null
    })));
  }
  async function matrix(srcs, tgts) {
    try { return await matrixValhalla(srcs, tgts); }
    catch (e) { console.warn('Valhalla matrice KO, essai OSRM', e); return matrixOsrm(srcs, tgts); }
  }

  function computeTimes(incs) {
    incs = (incs || state.incidents).filter(Boolean);
    if (!state.agents.length || !incs.length) { renderRecap(); return Promise.resolve(); }
    const key = incs.length === 1 ? 'mx-' + incs[0].id : 'mx-all';
    const agents = state.agents.slice();
    return enqueue(key, () => matrix(agents, incs))
      .then((m) => {
        incs.forEach((inc, j) => {
          if (!state.incidents.includes(inc)) return;
          times[inc.id] = times[inc.id] || {};
          agents.forEach((a, i) => { times[inc.id][a.id] = m[i][j]; });
        });
        renderRecap(); renderIncCard();
      })
      .catch((e) => { if (!e.superseded) { quiet(e); status('Temps de trajet indisponibles : ' + (e.message || 'erreur réseau'), true, 5000); } });
  }

  /* ---------------- Itinéraire ---------------- */
  function decode6(str) {
    let i = 0, lat = 0, lng = 0; const out = [];
    while (i < str.length) {
      for (const k of [0, 1]) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const dv = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += dv; else lng += dv;
      }
      out.push([lat / 1e6, lng / 1e6]);
    }
    return out;
  }
  function showRoute() {
    routeLayer.clearLayers();
    const inc = selectedInc();
    if (!inc || !state.agents.length || dragging) return;
    const ranking = rank(inc);
    const agentId = routeAgentFor[inc.id] || (ranking[0] && ranking[0].t != null ? ranking[0].a.id : null);
    const a = state.agents.find((x) => x.id === agentId);
    if (!a) return;
    const k = posKey(inc) + '>' + posKey(a);
    enqueue('route', () => valhalla('route', {
      locations: [{ lat: a.lat, lon: a.lng }, { lat: inc.lat, lon: inc.lng }],
      costing: 'auto', directions_type: 'none', units: 'kilometers'
    })).then((d) => {
      const cur = selectedInc();
      const curA = cur && state.agents.find((x) => x.id === (routeAgentFor[cur.id] || (rank(cur)[0] || {}).a?.id));
      if (!cur || !curA || posKey(cur) + '>' + posKey(curA) !== k) return;
      routeLayer.clearLayers();
      const pts = [];
      d.trip.legs.forEach((l) => pts.push(...decode6(l.shape)));
      L.polyline(pts, { pane: 'route', color: '#fff', weight: 7, opacity: 0.9, interactive: false }).addTo(routeLayer);
      L.polyline(pts, { pane: 'route', color: '#a1157a', weight: 4, opacity: 0.95, interactive: false })
        .bindTooltip(a.name + ' → ' + inc.name + ' : ' + fmtTime(d.trip.summary.time), { sticky: true }).addTo(routeLayer);
    }).catch(quiet);
  }

  /* ---------------- Marqueurs ---------------- */
  const agentIcon = (a) => L.divIcon({ className: '', html: '<div class="mk mk-agent">' + esc(initials(a.name)) + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
  const incIcon = (inc, sel) => L.divIcon({ className: '', html: '<div class="mk mk-inc' + (sel ? ' sel' : '') + '"><span>' + (state.incidents.indexOf(inc) + 1) + '</span></div>', iconSize: sel ? [36, 36] : [32, 32], iconAnchor: sel ? [18, 36] : [16, 32] });
  function initials(n) { const p = String(n).trim().split(/\s+/); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : (p[0] || '').slice(1, 2))).toUpperCase(); }

  function addAgentMarker(a) {
    const m = L.marker([a.lat, a.lng], { icon: agentIcon(a), draggable: true, zIndexOffset: 100 })
      .bindTooltip(esc(a.name), { direction: 'top', offset: [0, -12], className: 'mk-lbl' })
      .addTo(agentLayer);
    let last = { lat: a.lat, lng: a.lng };
    m.on('dragend', async () => {
      const p = m.getLatLng();
      if (!inZone(p.lat, p.lng)) { m.setLatLng(last); status('Hors zone : la Bourgogne + 6 km uniquement', true); return; }
      a.lat = p.lat; a.lng = p.lng; last = { lat: p.lat, lng: p.lng };
      a.address = (await geoReverse(p.lat, p.lng)) || a.address;
      save(); renderLists(); computeTimes().then(showRoute);
    });
    markers.agents[a.id] = m;
  }

  function addIncMarker(inc) {
    const m = L.marker([inc.lat, inc.lng], { icon: incIcon(inc, inc.id === state.selected), draggable: true, zIndexOffset: 500 })
      .bindTooltip(esc(inc.name), { direction: 'top', offset: [0, -30], className: 'mk-lbl' })
      .addTo(incLayer);
    let lastValid = { lat: inc.lat, lng: inc.lng };
    let tick = 0;
    m.on('click', () => select(inc.id));
    m.on('dragstart', () => { dragging = inc.id; if (state.selected !== inc.id) select(inc.id, true); routeLayer.clearLayers(); });
    m.on('drag', () => {
      const p = m.getLatLng();
      if (!inZone(p.lat, p.lng)) return;
      inc.lat = p.lat; inc.lng = p.lng; lastValid = { lat: p.lat, lng: p.lng };
      if (state.settings.dragMode !== 'live') return;
      const now = Date.now();
      if (now - tick < 250) return; // la file regroupe ensuite à ~1 req/s
      tick = now;
      showIsoFor(inc, true);
      computeTimes([inc]);
    });
    m.on('dragend', async () => {
      dragging = null;
      const p = m.getLatLng();
      if (!inZone(p.lat, p.lng)) { m.setLatLng(lastValid); status('Hors zone : la Bourgogne + 6 km uniquement', true); }
      inc.lat = lastValid.lat; inc.lng = lastValid.lng;
      save();
      showIsoFor(inc, false);
      computeTimes([inc]).then(showRoute);
      inc.address = (await geoReverse(inc.lat, inc.lng)) || 'Point sur la carte';
      save(); renderLists(); renderRecap(); renderIncCard();
    });
    markers.incidents[inc.id] = m;
  }

  function redrawMarkers() {
    agentLayer.clearLayers(); incLayer.clearLayers();
    markers.agents = {}; markers.incidents = {};
    state.agents.forEach(addAgentMarker);
    state.incidents.forEach(addIncMarker);
  }

  /* ---------------- Sélection ---------------- */
  const selectedInc = () => state.incidents.find((i) => i.id === state.selected) || null;
  function select(id, quiet) {
    state.selected = id; save();
    state.incidents.forEach((inc) => markers.incidents[inc.id] && markers.incidents[inc.id].setIcon(incIcon(inc, inc.id === id)));
    renderLists(); renderRecap(); renderIncCard();
    if (!quiet) { showIsoFor(selectedInc(), false); showRoute(); }
  }

  /* ---------------- Ajout / suppression ---------------- */
  function addItem(kind, name, address, lat, lng) {
    if (!inZone(lat, lng)) { status('Adresse hors zone (Bourgogne + 6 km)', true, 3500); return null; }
    const isAgent = kind === 'agents';
    const list = isAgent ? state.agents : state.incidents;
    const item = { id: 'x' + (seq++), name: name || (isAgent ? 'Agent ' : 'Incident ') + (list.length + 1), address: address || 'Point sur la carte', lat, lng };
    list.push(item);
    if (isAgent) { addAgentMarker(item); computeTimes().then(showRoute); }
    else { addIncMarker(item); select(item.id); computeTimes([item]).then(showRoute); }
    save(); renderLists(); renderRecap();
    return item;
  }
  function removeItem(kind, id) {
    if (kind === 'agents') {
      state.agents = state.agents.filter((a) => a.id !== id);
      Object.values(times).forEach((t) => delete t[id]);
      state.incidents.forEach((i) => { if (i.assigned === id) i.assigned = null; if (routeAgentFor[i.id] === id) delete routeAgentFor[i.id]; });
    } else {
      state.incidents = state.incidents.filter((i) => i.id !== id);
      delete times[id];
      if (state.selected === id) state.selected = state.incidents[0] ? state.incidents[0].id : null;
    }
    save(); redrawMarkers(); renderLists(); renderRecap(); renderIncCard();
    showIsoFor(selectedInc(), false); showRoute();
  }

  /* ---------------- Rendu panneau ---------------- */
  function rank(inc) {
    const t = times[inc.id] || {};
    return state.agents.map((a) => ({ a, t: t[a.id] ? t[a.id].t : undefined, d: t[a.id] ? t[a.id].d : null }))
      .sort((x, y) => (x.t ?? Infinity) - (y.t ?? Infinity));
  }

  function renderLists() {
    $('#cntAgents').textContent = state.agents.length;
    $('#cntIncidents').textContent = state.incidents.length;
    const la = $('#listAgents'), li = $('#listIncidents');
    la.innerHTML = state.agents.length ? state.agents.map((a) =>
      '<li data-id="' + a.id + '"><span class="dot" style="background:var(--agent)">' + esc(initials(a.name)) + '</span>' +
      '<div class="meta"><div class="nm">' + esc(a.name) + '</div><div class="ad">' + esc(a.address) + '</div></div>' +
      '<button class="x" data-del="agents" title="Supprimer">✕</button></li>').join('')
      : '<li class="empty">Aucun agent. Ajoutez le domicile des agents ci-dessus.</li>';
    li.innerHTML = state.incidents.length ? state.incidents.map((inc, k) =>
      '<li data-id="' + inc.id + '" class="' + (inc.id === state.selected ? 'sel' : '') + '"><span class="dot" style="background:var(--incident)">' + (k + 1) + '</span>' +
      '<div class="meta"><div class="nm">' + esc(inc.name) + '</div><div class="ad">' + esc(inc.address) + '</div></div>' +
      '<button class="x" data-del="incidents" title="Supprimer">✕</button></li>').join('')
      : '<li class="empty">Aucun incident. Ajoutez une adresse ou placez un point.</li>';
  }

  function sentenceFor(inc, r) {
    const ok = r.filter((x) => x.t != null);
    if (!ok.length) return '';
    const parts = ok.map((x, i) => (i === 0 ? x.a.name + ' est à ' : x.a.name + ' à ') + fmtTime(x.t));
    return inc.name + ' : ' + parts.join(', ') + '.';
  }

  function renderRecap() {
    const el = $('#recap');
    if (!state.agents.length || !state.incidents.length) {
      el.innerHTML = '<p class="empty">Ajoutez au moins un agent et un incident pour voir le classement des agents les plus proches.</p>';
      return;
    }
    const assignedTo = {};
    state.incidents.forEach((i) => { if (i.assigned) (assignedTo[i.assigned] = assignedTo[i.assigned] || []).push(i); });
    el.innerHTML = state.incidents.map((inc, k) => {
      const r = rank(inc);
      const pending = r.every((x) => x.t === undefined);
      const best = r[0] && r[0].t != null ? r[0] : null;
      const assigned = state.agents.find((a) => a.id === inc.assigned);
      return '<div class="rc' + (inc.id === state.selected ? ' sel' : '') + '" data-inc="' + inc.id + '">' +
        '<h4><span class="dot chip" style="background:var(--incident);width:12px;height:12px"></span>' + (k + 1) + '. ' + esc(inc.name) +
        (assigned ? '<span class="assigned" style="margin-left:auto">✔ ' + esc(assigned.name) + '</span>' : '') + '</h4>' +
        '<div class="ad">' + esc(inc.address) + '</div>' +
        (pending ? '<div class="best">Calcul des temps de trajet…</div>' :
          (best ? '<div class="best">Agent le plus proche : <b>' + esc(best.a.name) + '</b> — ' + fmtTime(best.t) + '</div>' : '<div class="best">Aucun agent joignable par la route.</div>')) +
        '<ol>' + r.map((x, i) => {
          const other = (assignedTo[x.a.id] || []).filter((o) => o.id !== inc.id);
          return '<li data-agent="' + x.a.id + '" title="Cliquer pour afficher l\'itinéraire">' +
            '<span class="rk">' + (i + 1) + '</span>' +
            '<span class="chip" style="background:' + (x.t != null ? colorAt(x.t / 60) : '#ccc') + '"></span>' +
            '<span class="an">' + esc(x.a.name) + (other.length ? ' <small style="color:#b45309">(déjà sur ' + esc(other.map((o) => o.name).join(', ')) + ')</small>' : '') + '</span>' +
            '<span class="t">' + (x.t === undefined ? '…' : fmtTime(x.t)) + '</span>' +
            '<span class="km">' + fmtKm(x.d) + '</span>' +
            (inc.assigned === x.a.id ? '<button class="btn small assign" data-unassign="1">Retirer</button>' : '<button class="btn small assign" data-assign="' + x.a.id + '">Affecter</button>') +
            '</li>';
        }).join('') + '</ol>' +
        (!pending ? '<div class="sentence">' + esc(sentenceFor(inc, r)) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function renderIncCard() {
    const el = $('#incCard');
    const inc = selectedInc();
    if (!inc) { el.innerHTML = ''; return; }
    const r = rank(inc);
    const best = r[0] && r[0].t != null ? r[0] : null;
    el.innerHTML = '<div class="k">Incident ' + (state.incidents.indexOf(inc) + 1) + '</div><div style="font-weight:700">' + esc(inc.name) + '</div>' +
      '<div style="color:var(--muted);font-size:12px;margin-bottom:6px">' + esc(inc.address) + '</div>' +
      (best ? '<div class="k">Agent le plus proche</div><div class="big">' + fmtTime(best.t) + '</div><div>' + esc(best.a.name) + ' · ' + fmtKm(best.d) + '</div>' +
        (r.length > 1 ? '<div style="margin-top:6px;color:var(--muted)">' + r.slice(1, 4).filter((x) => x.t != null).map((x) => esc(x.a.name) + ' ' + fmtTime(x.t)).join(' · ') + '</div>' : '')
        : (state.agents.length ? '<div style="color:var(--muted)">Calcul…</div>' : '<div style="color:var(--muted)">Ajoutez des agents.</div>')) +
      '<div style="margin-top:8px;font-size:11px;color:var(--muted)">Déplacez le point rouge : l\'isochrone suit.</div>';
  }

  /* ---------------- Interactions panneau ---------------- */
  function setTab(t) {
    tab = t;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $('#listAgents').classList.toggle('hidden', t !== 'agents');
    $('#listIncidents').classList.toggle('hidden', t !== 'incidents');
    $('#adderLabel').textContent = t === 'agents' ? 'Ajouter un agent (domicile)' : 'Ajouter un incident';
    $('#nameInput').placeholder = t === 'agents' ? 'Nom de l\'agent (ex. Martin)' : 'Nom de l\'incident (ex. Fuite réseau)';
    setPicking(false);
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  function setPicking(on) {
    picking = on;
    document.body.classList.toggle('picking', on);
    const b = $('#btnPick');
    b.classList.toggle('armed', on);
    b.textContent = on ? 'Cliquez sur la carte… (Échap)' : '📍 Placer sur la carte';
  }
  $('#btnPick').addEventListener('click', () => setPicking(!picking));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setPicking(false); $('#suggest').innerHTML = ''; } });

  map.on('click', async (e) => {
    if (!picking) return;
    const { lat, lng } = e.latlng;
    if (!inZone(lat, lng)) { status('Hors zone : la Bourgogne + 6 km uniquement', true); return; }
    setPicking(false);
    const name = $('#nameInput').value.trim();
    const item = addItem(tab, name, 'Recherche de l\'adresse…', lat, lng);
    $('#nameInput').value = '';
    if (item) { item.address = (await geoReverse(lat, lng)) || 'Point sur la carte'; save(); renderLists(); renderRecap(); renderIncCard(); }
  });

  // Autocomplétion d'adresse
  let sugg = [], sTimer, sIdx = -1;
  const addr = $('#addrInput');
  addr.addEventListener('input', () => {
    clearTimeout(sTimer);
    const q = addr.value.trim();
    if (q.length < 3) { $('#suggest').innerHTML = ''; sugg = []; return; }
    sTimer = setTimeout(async () => {
      try { sugg = await geoSearch(q); } catch (e) { sugg = []; status('Service d\'adresses indisponible', true); }
      sIdx = -1; renderSugg();
    }, 250);
  });
  function renderSugg() {
    $('#suggest').innerHTML = sugg.map((s, i) => {
      const ok = inZone(s.lat, s.lng);
      return '<li data-i="' + i + '" class="' + (ok ? '' : 'out') + (i === sIdx ? ' on' : '') + '">' + esc(s.label) + '<br><small>' + esc(s.context) + (ok ? '' : ' · hors zone') + '</small></li>';
    }).join('');
  }
  function pickSugg(i) {
    const s = sugg[i];
    if (!s) return;
    if (!inZone(s.lat, s.lng)) { status('Adresse hors zone (Bourgogne + 6 km)', true); return; }
    const item = addItem(tab, $('#nameInput').value.trim(), s.label, s.lat, s.lng);
    if (item) { map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 11), { duration: 0.6 }); }
    addr.value = ''; $('#nameInput').value = ''; $('#suggest').innerHTML = ''; sugg = [];
  }
  $('#suggest').addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pickSugg(+li.dataset.i); } });
  addr.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sIdx = Math.min(sugg.length - 1, sIdx + 1); renderSugg(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sIdx = Math.max(0, sIdx - 1); renderSugg(); e.preventDefault(); }
    else if (e.key === 'Enter') { pickSugg(sIdx >= 0 ? sIdx : sugg.findIndex((s) => inZone(s.lat, s.lng))); }
  });
  addr.addEventListener('blur', () => setTimeout(() => ($('#suggest').innerHTML = ''), 150));

  // Import en lot
  $('#btnBulk').addEventListener('click', () => $('#bulkBox').classList.toggle('hidden'));
  $('#btnBulkGo').addEventListener('click', async () => {
    const lines = $('#bulkText').value.split('\n').map((l) => l.trim()).filter(Boolean);
    let ok = 0, ko = [];
    for (const [n, l] of lines.entries()) {
      const parts = l.split(/[;\t]/);
      const name = parts.length > 1 ? parts[0].trim() : '';
      const q = (parts.length > 1 ? parts.slice(1).join(' ') : parts[0]).trim();
      status('Géocodage ' + (n + 1) + '/' + lines.length + '…', false, 0);
      try {
        const r = (await geoSearch(q)).find((s) => inZone(s.lat, s.lng));
        if (r && addItem(tab, name, r.label, r.lat, r.lng)) ok++; else ko.push(l);
      } catch (e) { ko.push(l); }
      await sleep(120);
    }
    $('#bulkText').value = ko.join('\n');
    status(ok + ' ajouté(s)' + (ko.length ? ', ' + ko.length + ' non trouvé(s) ou hors zone (laissés dans la zone de texte)' : ''), !!ko.length, 5000);
    if (ok) {
      const all = state.agents.concat(state.incidents);
      map.fitBounds(L.latLngBounds(all.map((p) => [p.lat, p.lng])).pad(0.2), { maxZoom: 12 });
    }
  });

  // Listes
  function onListClick(kind) {
    return (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      const id = li.dataset.id;
      if (e.target.closest('[data-del]')) { removeItem(kind, id); return; }
      const it = (kind === 'agents' ? state.agents : state.incidents).find((x) => x.id === id);
      if (!it) return;
      map.flyTo([it.lat, it.lng], Math.max(map.getZoom(), 12), { duration: 0.6 });
      if (kind === 'incidents') select(id);
    };
  }
  $('#listAgents').addEventListener('click', onListClick('agents'));
  $('#listIncidents').addEventListener('click', onListClick('incidents'));

  // Récap
  $('#recap').addEventListener('click', (e) => {
    const card = e.target.closest('.rc');
    if (!card) return;
    const inc = state.incidents.find((i) => i.id === card.dataset.inc);
    if (!inc) return;
    const as = e.target.closest('[data-assign]');
    if (as) { inc.assigned = as.dataset.assign; save(); renderRecap(); return; }
    if (e.target.closest('[data-unassign]')) { inc.assigned = null; save(); renderRecap(); return; }
    const row = e.target.closest('li[data-agent]');
    if (row) routeAgentFor[inc.id] = row.dataset.agent;
    if (state.selected !== inc.id) select(inc.id); else showRoute();
  });

  function recapText() {
    return state.incidents.map((inc, k) => {
      const r = rank(inc);
      const assigned = state.agents.find((a) => a.id === inc.assigned);
      return (k + 1) + '. ' + inc.name + ' (' + inc.address + ')\n' +
        r.map((x, i) => '   ' + (i + 1) + '. ' + x.a.name + ' : ' + fmtTime(x.t) + (x.d != null ? ' (' + fmtKm(x.d) + ')' : '')).join('\n') +
        (assigned ? '\n   → Affecté à : ' + assigned.name : '');
    }).join('\n\n');
  }
  $('#btnCopy').addEventListener('click', async () => {
    const txt = 'Récapitulatif — temps d\'accès par la route\n\n' + recapText();
    try { await navigator.clipboard.writeText(txt); status('Récapitulatif copié'); }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); status('Récapitulatif copié'); } catch (e2) { status('Copie impossible', true); }
      ta.remove();
    }
  });

  $('#btnClear').addEventListener('click', () => {
    if (!confirm('Supprimer tous les agents et incidents ?')) return;
    state.agents = []; state.incidents = []; state.selected = null; times = {}; routeAgentFor = {};
    save(); redrawMarkers(); renderLists(); renderRecap(); renderIncCard(); showIsoFor(null); routeLayer.clearLayers();
  });

  // Paramètres
  $('#btnSettings').addEventListener('click', () => {
    $('#setValhalla').value = state.settings.valhalla;
    $('#setOsrm').value = state.settings.osrm;
    $('#setDragMode').value = state.settings.dragMode;
    $('#settings').classList.remove('hidden');
  });
  $('#setCancel').addEventListener('click', () => $('#settings').classList.add('hidden'));
  $('#setSave').addEventListener('click', () => {
    state.settings.valhalla = $('#setValhalla').value.trim() || DEFAULTS.valhalla;
    state.settings.osrm = $('#setOsrm').value.trim() || DEFAULTS.osrm;
    state.settings.dragMode = $('#setDragMode').value;
    maxContours = 99; reverseOK = true; isoCache.clear();
    save(); $('#settings').classList.add('hidden');
    showIsoFor(selectedInc(), false); computeTimes().then(showRoute);
  });

  /* ---------------- Logo ---------------- */
  const LOGO_KEY = STORE_KEY + '.logo.v2'; // v2 : ignore l'ancien logo personnalisé
  let logoData = null; // dataURL PNG (utilisable dans le PDF)
  function showLogo(src) {
    const img = $('#logoImg'), def = $('#logoDefault');
    if (src) { img.src = src; img.classList.remove('hidden'); def.classList.add('hidden'); }
    else { img.classList.add('hidden'); def.classList.remove('hidden'); }
  }
  function toPng(src, cb) {
    const im = new Image();
    im.onload = () => {
      try {
        const h = Math.min(160, im.naturalHeight || 160), w = Math.round((im.naturalWidth || 160) * h / (im.naturalHeight || 160));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0, w, h);
        cb(c.toDataURL('image/png'), w, h);
      } catch (e) { cb(null); } // image locale non exportable (sécurité navigateur)
    };
    im.onerror = () => cb(null);
    im.src = src;
  }
  try { logoData = localStorage.getItem(LOGO_KEY); } catch (e) { /* */ }
  if (logoData) showLogo(logoData);
  $('#setLogo').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => toPng(r.result, (d) => {
      if (!d) { status('Image illisible', true); return; }
      logoData = d; showLogo(d);
      try { localStorage.setItem(LOGO_KEY, d); } catch (er) { status('Logo affiché mais non mémorisé (image trop lourde)', true, 4000); }
      status('Logo mis à jour');
    });
    r.readAsDataURL(f);
  });
  $('#setLogoDel').addEventListener('click', () => {
    logoData = null; showLogo(null); $('#setLogo').value = '';
    try { localStorage.removeItem(LOGO_KEY); } catch (e) { /* */ }
  });

  /* ---------------- Export PDF du récapitulatif ---------------- */
  const rgbArr = (c) => (c.match(/\d+/g) || [200, 200, 200]).slice(0, 3).map(Number);
  const pdfTxt = (s) => String(s ?? '').replace(/[→✔]/g, '-').replace(/[’]/g, "'");
  $('#btnPdf').addEventListener('click', () => {
    if (!window.jspdf) { status('Module PDF introuvable', true); return; }
    if (!state.incidents.length) { status('Aucun incident à exporter', true); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(), M = 14;
    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
      ' à ' + now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

    let y = M;
    let lx = M;
    const L0 = window.LOGOS || {};
    const mainLogo = logoData || (L0.enedis && L0.enedis.src);
    const put = (src, x, h, alignRight) => {
      try {
        const p = doc.getImageProperties(src);
        const w = p.width * h / p.height;
        doc.addImage(src, 'PNG', alignRight ? x - w : x, y - 1, w, h);
        return w;
      } catch (e) { return 0; }
    };
    if (mainLogo) { const w = put(mainLogo, M, 15); if (w) lx = M + w + 5; }
    let rx = W - M;
    if (L0.geomatique) rx -= put(L0.geomatique.src, rx, 17, true) + 3;
    if (L0.van) put(L0.van.src, rx, 15, true);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(27, 31, 28);
    doc.text('Récapitulatif d\'affectation', lx, y + 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(107, 114, 109);
    doc.text('Temps d\'accès par la route — Bourgogne (+6 km)', lx, y + 11);
    doc.text('Édité le ' + dateStr, lx, y + 15.5);
    y += 22;

    // Synthèse
    const synth = state.incidents.map((inc, k) => {
      const r = rank(inc), best = r[0] && r[0].t != null ? r[0] : null;
      const as = state.agents.find((a) => a.id === inc.assigned);
      return [String(k + 1), pdfTxt(inc.name), pdfTxt(inc.address), best ? pdfTxt(best.a.name) + ' (' + fmtTime(best.t) + ')' : '—', as ? pdfTxt(as.name) : '—'];
    });
    doc.autoTable({
      startY: y, margin: { left: M, right: M },
      head: [['#', 'Incident', 'Adresse', 'Agent le plus proche', 'Affecté à']], body: synth,
      styles: { fontSize: 9, cellPadding: 2 }, headStyles: { fillColor: [27, 31, 28] },
      columnStyles: { 0: { cellWidth: 8 }, 1: { cellWidth: 32, fontStyle: 'bold' }, 3: { cellWidth: 42 }, 4: { cellWidth: 30 } }
    });
    y = doc.lastAutoTable.finalY + 10;

    // Détail par incident
    state.incidents.forEach((inc, k) => {
      const r = rank(inc);
      if (y > 250) { doc.addPage(); y = M; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(214, 51, 108);
      doc.text((k + 1) + '. ' + pdfTxt(inc.name), M, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(107, 114, 109);
      doc.text(pdfTxt(inc.address) + '   (' + inc.lat.toFixed(5) + ', ' + inc.lng.toFixed(5) + ')', M, y + 5);
      const sentence = sentenceFor(inc, r);
      let yy = y + 10;
      if (sentence) {
        doc.setTextColor(27, 31, 28);
        const lines = doc.splitTextToSize(pdfTxt(sentence), W - 2 * M);
        doc.text(lines, M, yy); yy += lines.length * 4.2 + 1;
      }
      doc.autoTable({
        startY: yy, margin: { left: M, right: M },
        head: [['Rang', '', 'Agent', 'Domicile', 'Temps', 'Distance', '']],
        body: r.map((x, i) => [String(i + 1), '', pdfTxt(x.a.name), pdfTxt(x.a.address), x.t == null ? '—' : fmtTime(x.t), x.d == null ? '—' : fmtKm(x.d), inc.assigned === x.a.id ? 'AFFECTÉ' : '']),
        styles: { fontSize: 9, cellPadding: 2 }, headStyles: { fillColor: [46, 158, 31] },
        columnStyles: { 0: { cellWidth: 12, halign: 'center' }, 1: { cellWidth: 6 }, 2: { cellWidth: 32, fontStyle: 'bold' }, 4: { cellWidth: 18, fontStyle: 'bold', halign: 'right' }, 5: { cellWidth: 20, halign: 'right' }, 6: { cellWidth: 20, textColor: [46, 158, 31], fontStyle: 'bold' } },
        didParseCell: (d) => { if (d.section === 'body' && r[d.row.index] && inc.assigned === r[d.row.index].a.id) d.cell.styles.fillColor = [232, 245, 228]; },
        didDrawCell: (d) => {
          if (d.section !== 'body' || d.column.index !== 1) return;
          const x = r[d.row.index];
          const c = x && x.t != null ? rgbArr(colorAt(x.t / 60)) : [204, 204, 204];
          doc.setFillColor(c[0], c[1], c[2]);
          doc.circle(d.cell.x + d.cell.width / 2, d.cell.y + d.cell.height / 2, 1.6, 'F');
        }
      });
      y = doc.lastAutoTable.finalY + 10;
    });

    // Pied de page
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFontSize(8); doc.setTextColor(140, 140, 140);
      doc.text('Estimation routière sans trafic temps réel (Valhalla / OpenStreetMap).', M, 290);
      doc.text('Page ' + i + ' / ' + n, W - M, 290, { align: 'right' });
    }
    const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
    doc.save('recap-affectation-' + stamp + '.pdf');
    status('PDF téléchargé');
  });

  /* ---------------- Démarrage ---------------- */
  redrawMarkers(); renderLists(); renderRecap(); renderIncCard();
  if (state.incidents.length && !selectedInc()) state.selected = state.incidents[0].id;
  if (selectedInc()) { showIsoFor(selectedInc(), false); }
  computeTimes().then(showRoute);
  if (state.agents.length + state.incidents.length) {
    const all = state.agents.concat(state.incidents);
    map.fitBounds(L.latLngBounds(all.map((p) => [p.lat, p.lng])).pad(0.3), { maxZoom: 11 });
  }
})();

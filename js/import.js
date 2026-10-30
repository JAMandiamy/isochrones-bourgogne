/* Import de données géographiques : Shapefile (zip ou .shp/.dbf/.prj), GeoJSON, KML, CSV X/Y.
 * Les données peuvent devenir une couche d'affichage, des agents ou des incidents.
 */
(function () {
  'use strict';
  const A = window.APP;
  if (!A) return;
  const $ = (s) => document.querySelector(s);
  const esc = A.esc;
  const LAYERS_KEY = A.STORE_KEY + '.layers';
  const PALETTE = ['#7c3aed', '#0891b2', '#db2777', '#ea580c', '#0d9488', '#4f46e5', '#65a30d', '#b91c1c'];

  /* ---------------- Projections ---------------- */
  const P = window.proj4;
  if (P) {
    P.defs('EPSG:2154', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
    P.defs('EPSG:3946', '+proj=lcc +lat_0=46 +lon_0=3 +lat_1=45.25 +lat_2=46.75 +x_0=1700000 +y_0=5200000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
    P.defs('EPSG:3947', '+proj=lcc +lat_0=47 +lon_0=3 +lat_1=46.25 +lat_2=47.75 +x_0=1700000 +y_0=6200000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
    P.defs('EPSG:3948', '+proj=lcc +lat_0=48 +lon_0=3 +lat_1=47.25 +lat_2=48.75 +x_0=1700000 +y_0=7200000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
    P.defs('EPSG:27572', '+proj=lcc +lat_1=46.8 +lat_0=46.8 +lon_0=0 +k_0=0.99987742 +x_0=600000 +y_0=2200000 +a=6378249.2 +b=6356515 +towgs84=-168,-60,320,0,0,0,0 +pm=paris +units=m +no_defs');
  }
  const CRS_LABEL = {
    'EPSG:4326': 'WGS84', 'EPSG:2154': 'Lambert 93', 'EPSG:3946': 'CC46', 'EPSG:3947': 'CC47',
    'EPSG:3948': 'CC48', 'EPSG:27572': 'Lambert II étendu', 'EPSG:3857': 'Web Mercator'
  };

  // Devine le système à partir d'une coordonnée (x, y)
  function guessCrs(x, y) {
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return 'EPSG:4326';
    if (x > 1300000 && x < 2300000) return y < 5700000 ? 'EPSG:3946' : (y < 6700000 ? 'EPSG:3947' : 'EPSG:3948');
    if (y > 6000000 && y < 7300000 && x > 0 && x < 1300000) return 'EPSG:2154';
    if (y > 1500000 && y < 2800000 && x > 0 && x < 1300000) return 'EPSG:27572';
    if (y > 5000000 && y < 6400000 && x > -600000 && x < 1200000) return 'EPSG:3857';
    return null;
  }
  function toWgs(crs, x, y) {
    if (!crs || crs === 'EPSG:4326') return [x, y];
    const r = P(crs, 'EPSG:4326', [x, y]);
    return [r[0], r[1]];
  }
  function mapCoords(c, fn) {
    if (typeof c[0] === 'number') { const r = fn(c[0], c[1]); return c.length > 2 ? [r[0], r[1], c[2]] : r; }
    return c.map((cc) => mapCoords(cc, fn));
  }
  function mapGeom(g, fn) {
    if (!g) return g;
    if (g.type === 'GeometryCollection') return { type: g.type, geometries: g.geometries.map((x) => mapGeom(x, fn)) };
    return { type: g.type, coordinates: mapCoords(g.coordinates, fn) };
  }
  function firstCoord(g) {
    if (!g) return null;
    if (g.type === 'GeometryCollection') { for (const x of g.geometries) { const c = firstCoord(x); if (c) return c; } return null; }
    let c = g.coordinates;
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
    return Array.isArray(c) && typeof c[0] === 'number' ? c : null;
  }
  function crsFromGeoJSON(gj) {
    const n = gj && gj.crs && gj.crs.properties && gj.crs.properties.name;
    if (!n) return null;
    if (/CRS84/i.test(n)) return 'EPSG:4326';
    const m = String(n).match(/EPSG:*:?(\d+)/i);
    if (!m) return null;
    const code = 'EPSG:' + m[1];
    return code === 'EPSG:4326' || CRS_LABEL[code] ? code : null;
  }
  // Reprojette une FeatureCollection en WGS84 si nécessaire
  function normalizeFC(fc, declared) {
    const feats = fc.features.filter((f) => f && f.geometry);
    let crs = declared;
    if (!crs) {
      const c = feats.map((f) => firstCoord(f.geometry)).find(Boolean);
      crs = c ? guessCrs(c[0], c[1]) : 'EPSG:4326';
    }
    if (!crs) throw new Error('Système de coordonnées non reconnu');
    if (crs !== 'EPSG:4326') feats.forEach((f) => { f.geometry = mapGeom(f.geometry, (x, y) => toWgs(crs, x, y)); });
    return { fc: { type: 'FeatureCollection', features: feats }, crs };
  }
  function toFC(gj) {
    if (Array.isArray(gj)) return { type: 'FeatureCollection', features: gj.flatMap((x) => toFC(x).features) };
    if (gj.type === 'FeatureCollection') return gj;
    if (gj.type === 'Feature') return { type: 'FeatureCollection', features: [gj] };
    if (gj.type && gj.coordinates) return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: gj }] };
    throw new Error('GeoJSON invalide');
  }

  /* ---------------- Lecture des fichiers ---------------- */
  const readText = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f); });
  const readBuf = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(f); });
  const ext = (f) => (f.name.split('.').pop() || '').toLowerCase();
  const baseName = (n) => n.replace(/\.[^.]+$/, '');

  let current = null; // { kind:'geo'|'csv', name, fc?, rows?, fields, crs }

  async function loadFiles(files) {
    files = [...files];
    const byExt = {};
    files.forEach((f) => { byExt[ext(f)] = f; });
    if (byExt.zip) {
      const buf = await readBuf(byExt.zip);
      const out = await window.shp(buf);
      const fc = toFC(Array.isArray(out) ? out : [out]);
      const n = normalizeFC(fc, fc.features.length && Math.abs((firstCoord(fc.features[0].geometry) || [0])[0]) <= 180 ? 'EPSG:4326' : null);
      return { kind: 'geo', name: baseName(byExt.zip.name), fc: n.fc, crs: n.crs };
    }
    if (byExt.shp) {
      const shpBuf = await readBuf(byExt.shp);
      const prj = byExt.prj ? await readText(byExt.prj) : undefined;
      const parts = [window.shp.parseShp(shpBuf, prj)];
      if (byExt.dbf) parts.push(window.shp.parseDbf(await readBuf(byExt.dbf), byExt.cpg ? await readBuf(byExt.cpg) : undefined));
      const fc = window.shp.combine(parts);
      const n = normalizeFC(toFC(fc), prj ? 'EPSG:4326' : null);
      const warn = !byExt.dbf ? 'Fichier .dbf absent : pas d\'attributs.' : (!prj ? 'Fichier .prj absent : système détecté automatiquement.' : '');
      return { kind: 'geo', name: baseName(byExt.shp.name), fc: n.fc, crs: n.crs, warn };
    }
    const f = files[0];
    const e = ext(f);
    if (e === 'geojson' || e === 'json') {
      const gj = JSON.parse(await readText(f));
      const n = normalizeFC(toFC(gj), crsFromGeoJSON(gj));
      return { kind: 'geo', name: baseName(f.name), fc: n.fc, crs: n.crs };
    }
    if (e === 'kml') {
      const doc = new DOMParser().parseFromString(await readText(f), 'text/xml');
      const fc = window.toGeoJSON.kml(doc);
      return { kind: 'geo', name: baseName(f.name), fc: normalizeFC(toFC(fc), 'EPSG:4326').fc, crs: 'EPSG:4326' };
    }
    if (e === 'csv' || e === 'txt') {
      let text = await readText(f);
      if (text.indexOf('�') >= 0) {
        // probablement encodé en Windows-1252 (export Excel)
        const buf = await readBuf(f);
        text = new TextDecoder('windows-1252').decode(buf);
      }
      const r = window.Papa.parse(text, { header: true, skipEmptyLines: 'greedy', delimitersToGuess: [';', ',', '\t', '|'] });
      const fields = (r.meta.fields || []).filter((x) => x !== '');
      if (!fields.length || !r.data.length) throw new Error('CSV vide ou sans ligne d\'en-tête');
      return { kind: 'csv', name: baseName(f.name), rows: r.data, fields, delimiter: r.meta.delimiter };
    }
    if (e === 'shx' || e === 'dbf' || e === 'prj') throw new Error('Sélectionnez aussi le fichier .shp (ou envoyez un .zip)');
    throw new Error('Format non pris en charge : .' + e);
  }

  /* ---------------- CSV → points ---------------- */
  const num = (v) => {
    if (v == null) return NaN;
    const s = String(v).trim().replace(/\s| /g, '').replace(',', '.');
    return s === '' ? NaN : Number(s);
  };
  function guessCol(fields, names) {
    const low = fields.map((f) => f.toLowerCase().trim());
    for (const n of names) { const i = low.indexOf(n); if (i >= 0) return fields[i]; }
    for (const n of names) { const i = low.findIndex((f) => f.includes(n)); if (i >= 0) return fields[i]; }
    return '';
  }
  function csvToFC(c, xCol, yCol, crsSel) {
    let crs = crsSel === 'auto' ? null : crsSel, swapped = false, bad = 0;
    const pts = [];
    c.rows.forEach((row) => {
      const x = num(row[xCol]), y = num(row[yCol]);
      if (!isFinite(x) || !isFinite(y)) { bad++; return; }
      pts.push({ x, y, row });
    });
    if (!pts.length) return { fc: { type: 'FeatureCollection', features: [] }, crs: crs || '?', bad, swapped };
    if (!crs) crs = guessCrs(pts[0].x, pts[0].y);
    if (!crs) return { fc: { type: 'FeatureCollection', features: [] }, crs: '?', bad: bad + pts.length, swapped, unknown: true };
    // X et Y inversés (lat dans X) : fréquent en degrés
    if (crs === 'EPSG:4326') {
      const p = pts[0];
      if (p.x > 40 && p.x < 52 && p.y > -6 && p.y < 10) swapped = true;
    }
    const feats = [];
    pts.forEach((p) => {
      let x = swapped ? p.y : p.x, y = swapped ? p.x : p.y;
      let ll;
      try { ll = toWgs(crs, x, y); } catch (e) { bad++; return; }
      if (!isFinite(ll[0]) || !isFinite(ll[1]) || Math.abs(ll[1]) > 90) { bad++; return; }
      feats.push({ type: 'Feature', properties: p.row, geometry: { type: 'Point', coordinates: ll } });
    });
    return { fc: { type: 'FeatureCollection', features: feats }, crs, bad, swapped };
  }

  /* ---------------- Fenêtre d'import ---------------- */
  const modal = $('#importModal');
  function fillSelect(sel, fields, value, withNone) {
    sel.innerHTML = (withNone ? '<option value="">— aucune —</option>' : '') + fields.map((f) => '<option' + (f === value ? ' selected' : '') + '>' + esc(f) + '</option>').join('');
  }
  function resetModal() {
    current = null;
    $('#impFile').value = '';
    $('#impInfo').innerHTML = '';
    $('#impPreview').innerHTML = '';
    $('#impCsv').classList.add('hidden');
    $('#impOpts').classList.add('hidden');
    $('#impGo').disabled = true;
  }
  $('#btnImport').addEventListener('click', () => {
    resetModal();
    const t = document.querySelector('.tab.active');
    const tab = t ? t.dataset.tab : 'agents';
    $('#impAs').value = tab === 'agents' || tab === 'incidents' ? tab : 'layer';
    $('#impColor').value = PALETTE[layers.length % PALETTE.length];
    modal.classList.remove('hidden');
  });
  $('#impCancel').addEventListener('click', () => modal.classList.add('hidden'));

  $('#impFile').addEventListener('change', (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    startLoad(() => loadFiles(files));
  });

  async function startLoad(loader) {
    $('#impInfo').innerHTML = 'Chargement…';
    $('#impPreview').innerHTML = '';
    $('#impGo').disabled = true;
    try {
      current = await loader();
    } catch (err) {
      console.warn(err);
      current = null;
      $('#impInfo').innerHTML = '<span class="warn">⚠ ' + esc(err.message || 'Fichier illisible') + '</span>';
      $('#impCsv').classList.add('hidden'); $('#impOpts').classList.add('hidden');
      return;
    }
    let fields;
    if (current.kind === 'csv') {
      fields = current.fields;
      const numeric = fields.filter((f) => current.rows.slice(0, 20).every((r) => r[f] == null || String(r[f]).trim() === '' || isFinite(num(r[f]))) && current.rows.slice(0, 20).some((r) => isFinite(num(r[f]))));
      let gx = guessCol(fields, ['x', 'lon', 'lng', 'long', 'longitude', 'coord_x', 'xcoord', 'est', 'easting']);
      let gy = guessCol(fields, ['y', 'lat', 'latitude', 'coord_y', 'ycoord', 'nord', 'northing']);
      const nonId = numeric.filter((f) => !/^(id|fid|objectid|num|n°|no)$/i.test(f.trim()));
      if (!gx) gx = nonId.find((f) => f !== gy) || '';
      if (!gy) gy = nonId.find((f) => f !== gx) || '';
      fillSelect($('#impX'), fields, gx);
      fillSelect($('#impY'), fields, gy);
      $('#impCrs').value = 'auto';
      $('#impCsv').classList.remove('hidden');
      $('#impInfo').innerHTML = '<b>' + esc(current.name) + '</b> — CSV, ' + current.rows.length + ' lignes, ' + fields.length + ' colonnes (séparateur « ' + esc(current.delimiter === '\t' ? 'tabulation' : current.delimiter) + ' »).';
    } else {
      const set = new Set();
      current.fc.features.slice(0, 200).forEach((f) => Object.keys(f.properties || {}).forEach((k) => set.add(k)));
      fields = [...set];
      current.fields = fields;
      $('#impCsv').classList.add('hidden');
      $('#impInfo').innerHTML = '<b>' + esc(current.name) + '</b> — ' + current.fc.features.length + ' entités, coordonnées converties en WGS84' + (current.crs !== 'EPSG:4326' ? ' depuis ' + esc(CRS_LABEL[current.crs] || current.crs) : '') + '.' +
        (current.warn ? '<br><span class="warn">' + esc(current.warn) + '</span>' : '');
    }
    const rowsOf = current.kind === 'csv' ? current.rows : current.fc.features.map((f) => f.properties || {});
    const textCols = fields.filter((f) => rowsOf.slice(0, 20).some((r) => r[f] != null && String(r[f]).trim() !== '' && !isFinite(num(r[f]))));
    fillSelect($('#impName'), fields, guessCol(fields, ['nom', 'name', 'libelle', 'libellé', 'label', 'agent', 'titre', 'nom_agent']) || textCols[0] || '', true);
    fillSelect($('#impDesc'), fields, guessCol(fields, ['adresse', 'address', 'adr', 'description', 'desc', 'texte', 'commentaire', 'libelle', 'commune']), true);
    $('#impLayerName').value = current.name;
    fillSelect($('#impColorBy'), fields, '', true);
    $('#impOpts').classList.remove('hidden');
    refreshPreview();
  }
  ['#impX', '#impY', '#impCrs', '#impAs', '#impName', '#impDesc'].forEach((s) => $(s).addEventListener('change', refreshPreview));

  function currentFC() {
    if (!current) return null;
    if (current.kind === 'csv') return csvToFC(current, $('#impX').value, $('#impY').value, $('#impCrs').value);
    return { fc: current.fc, crs: current.crs, bad: 0 };
  }
  function pointOf(f) {
    const g = f.geometry;
    if (!g) return null;
    if (g.type === 'Point') return g.coordinates;
    if (g.type === 'MultiPoint' && g.coordinates.length) return g.coordinates[0];
    return null;
  }
  function refreshPreview() {
    const r = currentFC();
    const as = $('#impAs').value;
    $('#impLayerOpts').classList.toggle('hidden', as !== 'layer');
    $('#impDescLbl').textContent = as === 'layer' ? 'Colonne description (infobulle)' : 'Colonne adresse / description';
    if (!r) return;
    const feats = r.fc.features;
    const types = { pts: 0, lines: 0, polys: 0 };
    let inside = 0;
    feats.forEach((f) => {
      const t = f.geometry.type;
      if (/Point/.test(t)) types.pts++; else if (/Line/.test(t)) types.lines++; else types.polys++;
      const p = pointOf(f);
      if (p && A.inZone(p[1], p[0])) inside++;
    });
    let html = '';
    if (current.kind === 'csv') {
      if (r.unknown) html += '<div class="warn">⚠ Système de coordonnées non reconnu : choisissez-le dans la liste.</div>';
      else html += '<div>Système utilisé : <b>' + esc(CRS_LABEL[r.crs] || r.crs) + '</b>' + (r.swapped ? ' <span class="warn">(colonnes X/Y inversées détectées et corrigées)</span>' : '') + '</div>';
      if (r.bad) html += '<div class="warn">' + r.bad + ' ligne(s) ignorée(s) : coordonnées vides ou invalides.</div>';
    }
    html += '<div><b>' + feats.length + '</b> entité(s) : ' + [types.pts && types.pts + ' point(s)', types.lines && types.lines + ' ligne(s)', types.polys && types.polys + ' polygone(s)'].filter(Boolean).join(', ') + '.</div>';
    if (as !== 'layer') {
      html += '<div>' + inside + ' point(s)' + (A.restricted() ? ' dans la zone Bourgogne + 6 km' : '') + ' seront ajoutés comme <b>' + (as === 'agents' ? 'agents' : 'incidents') + '</b>.</div>';
      if (types.pts - inside > 0) html += '<div class="warn">' + (types.pts - inside) + ' point(s) hors zone ignorés.</div>';
      if (types.lines + types.polys) html += '<div class="warn">Lignes et polygones ignorés (importez-les en couche d\'affichage).</div>';
      if (as === 'agents' && inside > 150) html += '<div class="warn">Beaucoup d\'agents : le calcul des temps sera plus long avec le serveur public.</div>';
    }
    // aperçu des premières lignes
    const nameCol = $('#impName').value, descCol = $('#impDesc').value;
    const sample = feats.slice(0, 4);
    if (sample.length) {
      html += '<table><tr><th>Nom</th><th>Description</th><th>Lat</th><th>Lon</th></tr>' + sample.map((f) => {
        const p = pointOf(f) || firstCoord(f.geometry) || [NaN, NaN];
        const pr = f.properties || {};
        return '<tr><td>' + esc(nameCol ? pr[nameCol] : '—') + '</td><td>' + esc(descCol ? pr[descCol] : '—') + '</td><td>' + (+p[1]).toFixed(5) + '</td><td>' + (+p[0]).toFixed(5) + '</td></tr>';
      }).join('') + '</table>';
    }
    $('#impPreview').innerHTML = html;
    $('#impGo').disabled = as === 'layer' ? !feats.length : !inside;
  }

  $('#impGo').addEventListener('click', () => {
    const r = currentFC();
    if (!r) return;
    const as = $('#impAs').value, nameCol = $('#impName').value, descCol = $('#impDesc').value;
    if (as === 'layer') {
      const lyr = {
        id: 'L' + Date.now(), name: $('#impLayerName').value.trim() || current.name,
        color: $('#impColor').value, visible: true, nameCol, descCol, fc: r.fc,
        colorBy: $('#impColorBy').value || '', cats: {},
        updated: Date.now()
      };
      layers.push(lyr);
      drawLayer(lyr);
      saveLayers();
      renderLayerList();
      try { A.map.fitBounds(lyr.leaflet.getBounds().pad(0.1), { maxZoom: 13 }); } catch (e) { /* */ }
      A.status('Couche « ' + lyr.name + ' » importée (' + r.fc.features.length + ' entités)', false, 3500);
      A.setTab('couches');
    } else {
      const rows = r.fc.features.map((f) => {
        const p = pointOf(f);
        if (!p) return null;
        const pr = f.properties || {};
        return {
          lat: p[1], lng: p[0],
          name: nameCol && pr[nameCol] != null && pr[nameCol] !== '' ? String(pr[nameCol]) : '',
          address: descCol && pr[descCol] ? String(pr[descCol]) : 'Importé (' + current.name + ')'
        };
      }).filter(Boolean);
      const n = A.addBatch(as, rows);
      A.status(n + ' ' + (as === 'agents' ? 'agent(s)' : 'incident(s)') + ' importé(s)', !n, 3500);
      A.setTab(as);
      const pts = rows.filter((x) => A.inZone(x.lat, x.lng));
      if (pts.length) A.map.fitBounds(L.latLngBounds(pts.map((x) => [x.lat, x.lng])).pad(0.2), { maxZoom: 12 });
    }
    modal.classList.add('hidden');
  });

  /* ---------------- Couches importées ---------------- */
  A.map.createPane('imported').style.zIndex = 410;
  let layers = [];
  try { layers = JSON.parse(localStorage.getItem(LAYERS_KEY) || '[]'); } catch (e) { layers = []; }

  function saveLayers() {
    try {
      localStorage.setItem(LAYERS_KEY, JSON.stringify(layers.map((l) => ({
        id: l.id, name: l.name, color: l.color, visible: l.visible, nameCol: l.nameCol, descCol: l.descCol, fc: l.fc,
        colorBy: l.colorBy, cats: l.cats, updated: l.updated
      }))));
    } catch (e) {
      A.status('Couche affichée mais trop volumineuse pour être mémorisée : à réimporter à la prochaine ouverture', true, 6000);
    }
  }
  function popupHtml(lyr, pr) {
    const keys = Object.keys(pr || {}).filter((k) => pr[k] !== null && pr[k] !== '' && typeof pr[k] !== 'object');
    const title = lyr.nameCol && pr[lyr.nameCol] != null ? pr[lyr.nameCol] : lyr.name;
    return '<div class="pop-title">' + esc(title) + '</div>' +
      (keys.length ? '<table class="pop-tbl">' + keys.slice(0, 15).map((k) => '<tr><td>' + esc(k) + '</td><td>' + esc(pr[k]) + '</td></tr>').join('') + '</table>' +
        (keys.length > 15 ? '<div style="color:#888;font-size:11px">+ ' + (keys.length - 15) + ' champ(s)</div>' : '') : '');
  }
  const CAT = ['#e11d48', '#2563eb', '#f59e0b', '#059669', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c'];
  function updateCats(lyr) {
    if (!lyr.colorBy) return;
    lyr.cats = lyr.cats || {};
    const counts = {};
    lyr.fc.features.forEach((f) => { const v = String((f.properties || {})[lyr.colorBy] ?? '—'); counts[v] = (counts[v] || 0) + 1; });
    Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach((v) => {
      const used = Object.keys(lyr.cats).length;
      if (!(v in lyr.cats) && used < CAT.length) lyr.cats[v] = CAT[used];
    });
    lyr.counts = counts;
  }
  function colorFor(lyr, f) {
    if (!lyr.colorBy) return lyr.color;
    return lyr.cats[String((f.properties || {})[lyr.colorBy] ?? '—')] || '#9ca3af';
  }
  function drawLayer(lyr) {
    if (lyr.leaflet) A.map.removeLayer(lyr.leaflet);
    updateCats(lyr);
    lyr.leaflet = L.geoJSON(lyr.fc, {
      pane: 'imported',
      style: (f) => { const c = colorFor(lyr, f); return { color: c, weight: /Line/.test(f.geometry.type) ? 4 : 2, opacity: 0.9, fillColor: c, fillOpacity: lyr.colorBy ? 0.1 : 0.15 }; },
      pointToLayer: (f, ll) => L.circleMarker(ll, { pane: 'imported', radius: 6, color: '#fff', weight: 1.5, fillColor: colorFor(lyr, f), fillOpacity: 0.95 }),
      onEachFeature: (f, l) => {
        const pr = f.properties || {};
        l.bindPopup(popupHtml(lyr, pr), { maxWidth: 320 });
        const tip = [lyr.nameCol && pr[lyr.nameCol], lyr.descCol && pr[lyr.descCol]].filter((x) => x != null && x !== '').join(' — ');
        if (tip) l.bindTooltip(esc(tip), { sticky: true });
      }
    });
    if (lyr.visible) lyr.leaflet.addTo(A.map);
  }
  const hhmm = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  function legendHtml(l) {
    if (!l.colorBy || !l.counts) return '';
    const vals = Object.keys(l.counts).sort((a, b) => l.counts[b] - l.counts[a]);
    const shown = vals.filter((v) => l.cats[v]);
    const others = vals.filter((v) => !l.cats[v]).reduce((s, v) => s + l.counts[v], 0);
    return '<div class="lyr-leg">' + shown.map((v) => '<span><i style="background:' + l.cats[v] + '"></i>' + esc(v) + ' (' + l.counts[v] + ')</span>').join('') +
      (others ? '<span><i style="background:#9ca3af"></i>autres (' + others + ')</span>' : '') + '</div>';
  }
  function renderLayerList() {
    $('#cntLayers').textContent = layers.length;
    const ul = $('#listLayers');
    ul.innerHTML = layers.length ? layers.map((l) =>
      '<li class="lyr" data-id="' + l.id + '">' + (l.colorBy ? '<span class="sw" style="font-size:16px;text-align:center">🎨</span>' : '<input type="color" class="sw" value="' + l.color + '" title="Couleur">') +
      '<div class="meta"><div class="nm">' + esc(l.name) + '</div><div class="ad">' + l.fc.features.length + ' entité(s)</div>' +
      legendHtml(l) + '</div>' +
      '<button class="eye' + (l.visible ? '' : ' off') + '" data-act="eye" title="Afficher / masquer">👁</button>' +
      '<button class="eye" data-act="zoom" title="Zoomer sur la couche">🔍</button>' +
      '<button class="x" data-act="del" title="Supprimer">✕</button></li>').join('')
      : '<li class="empty">Aucune couche. Cliquez sur « Importer un fichier » pour ajouter un Shapefile, GeoJSON, KML ou CSV.</li>';
  }
  $('#listLayers').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    const b = e.target.closest('[data-act]');
    if (!li || !b) return;
    const l = layers.find((x) => x.id === li.dataset.id);
    if (!l) return;
    const act = b.dataset.act;
    if (act === 'eye') { l.visible = !l.visible; if (l.visible) l.leaflet.addTo(A.map); else A.map.removeLayer(l.leaflet); }
    if (act === 'zoom') { try { A.map.fitBounds(l.leaflet.getBounds().pad(0.1), { maxZoom: 13 }); } catch (er) { /* */ } }
    if (act === 'del') { if (!confirm('Supprimer la couche « ' + l.name + ' » ?')) return; A.map.removeLayer(l.leaflet); layers = layers.filter((x) => x !== l); }
    saveLayers(); renderLayerList();
  });
  $('#listLayers').addEventListener('input', (e) => {
    if (!e.target.classList.contains('sw')) return;
    const l = layers.find((x) => x.id === e.target.closest('li').dataset.id);
    if (!l) return;
    l.color = e.target.value;
    l.leaflet.eachLayer((x) => { if (x instanceof L.CircleMarker) x.setStyle({ fillColor: l.color }); else x.setStyle({ color: l.color, fillColor: l.color }); });
  });
  $('#listLayers').addEventListener('change', (e) => { if (e.target.classList.contains('sw')) saveLayers(); });

  layers.forEach(drawLayer);
  renderLayerList();
})();

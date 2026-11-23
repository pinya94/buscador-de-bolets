/* Buscador de Bolets — mapa de zonas favorables para setas en Cataluña
 * Combina: bosques (OpenStreetMap/Overpass) + relieve (AWS Terrain Tiles)
 *          + lluvia reciente (Open-Meteo). Todo se calcula en el navegador.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------
  // 1. Perfiles de setas (valores orientativos)
  // ---------------------------------------------------------------
  // arboles: afinidad con con=coníferas (pinos), bro=planifolios (hayas, robles),
  //          mix=bosque mixto, unk=bosque sin tipo conocido
  // alt: [mínimo, óptimo desde, óptimo hasta, máximo] en metros
  // obaga: 0..1, cuánto le importa que la ladera mire al norte
  // meses: temporada principal (1 = enero)
  const SPECIES = [
    {
      id: 'rovello', nombre: 'Rovelló', alias: 'Níscalo', latin: 'Lactarius deliciosus / sanguifluus',
      arboles: { con: 1, mix: 0.8, bro: 0.1, unk: 0.55 }, alt: [0, 250, 1300, 1800], obaga: 0.5,
      meses: [9, 10, 11, 12],
      nota: 'Bajo pinos, en claros y márgenes de pinar con hierba corta.'
    },
    {
      id: 'cep', nombre: 'Cep', alias: 'Boleto', latin: 'Boletus edulis / pinophilus / aereus',
      arboles: { con: 0.85, mix: 1, bro: 0.9, unk: 0.6 }, alt: [300, 800, 1800, 2100], obaga: 0.45,
      meses: [8, 9, 10, 11],
      nota: 'Pinares de montaña, hayedos y robledales. Le gusta el calor húmedo tras tormentas.'
    },
    {
      id: 'camagroc', nombre: 'Camagroc', alias: 'Angula de monte', latin: 'Craterellus lutescens',
      arboles: { con: 1, mix: 0.85, bro: 0.4, unk: 0.55 }, alt: [200, 500, 1300, 1600], obaga: 0.85,
      meses: [10, 11, 12, 1],
      nota: 'Obagas muy húmedas, entre musgo y cerca de regueros. Sale en grupos.'
    },
    {
      id: 'rossinyol', nombre: 'Rossinyol', alias: 'Rebozuelo', latin: 'Cantharellus cibarius',
      arboles: { con: 0.7, mix: 1, bro: 0.9, unk: 0.6 }, alt: [200, 500, 1400, 1800], obaga: 0.6,
      meses: [6, 7, 8, 9, 10, 11],
      nota: 'Bosques mixtos y de robles/hayas, suelos ácidos y con musgo.'
    },
    {
      id: 'llenega', nombre: 'Llenega negra', alias: 'Babosa', latin: 'Hygrophorus latitatus',
      arboles: { con: 1, mix: 0.7, bro: 0.05, unk: 0.5 }, alt: [900, 1200, 1900, 2200], obaga: 0.6,
      meses: [10, 11, 12],
      nota: 'Pinares de pino rojo y pino negro, en zonas altas del Pirineo y Prepirineo.'
    },
    {
      id: 'fredolic', nombre: 'Fredolic', alias: 'Negrilla', latin: 'Tricholoma terreum',
      arboles: { con: 1, mix: 0.7, bro: 0.1, unk: 0.5 }, alt: [0, 200, 1100, 1500], obaga: 0.3,
      meses: [11, 12, 1],
      nota: 'Pinares, a final de temporada, cuando ya hace frío.'
    }
  ];
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  let current = SPECIES[0];

  // ---------------------------------------------------------------
  // 2. Utilidades
  // ---------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  let statusTimer = null;
  function status(msg, ms) {
    const el = $('status');
    clearTimeout(statusTimer);
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
    if (ms) statusTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }
  };

  // Proyección Web Mercator (píxeles globales a zoom z, tiles de 256)
  function project(lat, lon, z) {
    const s = 256 * Math.pow(2, z);
    const x = (lon + 180) / 360 * s;
    const sin = Math.sin(lat * Math.PI / 180);
    const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s;
    return [x, y];
  }
  function unproject(x, y, z) {
    const s = 256 * Math.pow(2, z);
    const lon = x / s * 360 - 180;
    const n = Math.PI - 2 * Math.PI * y / s;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lat, lon];
  }
  const metersPerPixel = (lat, z) => 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);

  // ---------------------------------------------------------------
  // 3. Modelo de puntuación
  // ---------------------------------------------------------------
  function altFactor(h, a) {
    const [min, o1, o2, max] = a;
    if (h <= min || h >= max) return 0;
    if (h < o1) return (h - min) / (o1 - min);
    if (h > o2) return (max - h) / (max - o2);
    return 1;
  }
  function slopeFactor(deg) {
    if (deg <= 25) return 1;
    if (deg >= 45) return 0.15;
    return lerp(1, 0.15, (deg - 25) / 20);
  }
  // northness: 1 = mira al norte (obaga), 0 = mira al sur (solana)
  function aspectFactor(northness, slopeDeg, w) {
    const n = slopeDeg < 3 ? 0.6 : northness; // en llano la orientación casi no cuenta
    return (1 - w) + w * n;
  }
  function score(sp, cls, h, slopeDeg, northness) {
    if (!cls) return 0;
    const t = sp.arboles[cls] || 0;
    if (t <= 0) return 0;
    return t * altFactor(h, sp.alt) * slopeFactor(slopeDeg) * aspectFactor(northness, slopeDeg, sp.obaga);
  }

  // ---------------------------------------------------------------
  // 4. Relieve: AWS Terrain Tiles (formato terrarium)
  // ---------------------------------------------------------------
  const DEM_MAX_Z = 14;
  const demCache = new Map();
  function loadDemTile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    if (demCache.has(key)) return demCache.get(key);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, 256, 256).data;
        const e = new Float32Array(256 * 256);
        for (let i = 0; i < e.length; i++) {
          e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        }
        resolve(e);
      };
      img.onerror = () => resolve(null);
      img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    });
    demCache.set(key, p);
    if (demCache.size > 400) demCache.delete(demCache.keys().next().value);
    return p;
  }

  // Devuelve una rejilla de elevaciones de (256+2*pad)^2 para el tile de mapa (z,x,y)
  async function elevationGrid(z, x, y, pad) {
    const dz = Math.min(z, DEM_MAX_Z);
    const f = Math.pow(2, z - dz);
    const N = 256 + 2 * pad;
    const out = new Float32Array(N * N);
    // Tiles DEM necesarios
    const gx0 = (x * 256 - pad) / f, gy0 = (y * 256 - pad) / f;
    const gx1 = (x * 256 + 256 + pad) / f, gy1 = (y * 256 + 256 + pad) / f;
    const tx0 = Math.floor(gx0 / 256), ty0 = Math.floor(gy0 / 256);
    const tx1 = Math.floor((gx1 - 1e-9) / 256), ty1 = Math.floor((gy1 - 1e-9) / 256);
    const tiles = {};
    const jobs = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      jobs.push(loadDemTile(dz, tx, ty).then((e) => { tiles[tx + ',' + ty] = e; }));
    }
    await Promise.all(jobs);
    const sample = (gx, gy) => {
      const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
      const e = tiles[tx + ',' + ty];
      if (!e) return NaN;
      const px = clamp(Math.floor(gx - tx * 256), 0, 255), py = clamp(Math.floor(gy - ty * 256), 0, 255);
      return e[py * 256 + px];
    };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        // bilineal en el espacio DEM
        const gx = (x * 256 - pad + i + 0.5) / f - 0.5;
        const gy = (y * 256 - pad + j + 0.5) / f - 0.5;
        if (f === 1) { out[j * N + i] = sample(gx + 0.5, gy + 0.5); continue; }
        const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
        const a = sample(x0, y0), b = sample(x0 + 1, y0), c = sample(x0, y0 + 1), d = sample(x0 + 1, y0 + 1);
        out[j * N + i] = lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
      }
    }
    return { grid: out, N };
  }

  // Pendiente (grados) y "northness" en un punto de la rejilla
  function terrainAt(grid, N, i, j, k, mpp) {
    const e = (a, b) => grid[clamp(b, 0, N - 1) * N + clamp(a, 0, N - 1)];
    const dzdx = (e(i + k, j) - e(i - k, j)) / (2 * k * mpp);   // hacia el este
    const dzdy = (e(i, j + k) - e(i, j - k)) / (2 * k * mpp);   // hacia el sur
    const g = Math.hypot(dzdx, dzdy);
    const slope = Math.atan(g) * 180 / Math.PI;
    // La ladera "mira" hacia donde baja. Si sube hacia el sur, baja hacia el norte -> obaga
    const north = g > 1e-6 ? dzdy / g : 0; // -1..1
    const aspect = (Math.atan2(-dzdx, dzdy) * 180 / Math.PI + 360) % 360; // 0 = N
    return { slope, northness: (north + 1) / 2, aspect };
  }

  // ---------------------------------------------------------------
  // 5. Bosques: OpenStreetMap vía Overpass
  // ---------------------------------------------------------------
  const forests = [];            // {id, cls, bbox:[s,w,n,e], rings:[[ [lat,lon]... ]], desc}
  const forestIds = new Set();
  const loadedBoxes = [];        // zonas ya descargadas [s,w,n,e]
  let loading = false;

  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  function classify(t) {
    const lt = t.leaf_type || '';
    const w = t.wood || '';
    const g = [t.genus, t.species, t.taxon, t['species:es'], t['species:ca'], t['genus:ca'], t['genus:es']]
      .filter(Boolean).join(' ').toLowerCase();
    if (lt === 'needleleaved' || w === 'coniferous' || /pinus|abies|picea|larix|pino|\bpi\b|avet|conif/.test(g)) return 'con';
    if (lt === 'broadleaved' || w === 'deciduous' || /fagus|quercus|castanea|betula|haya|faig|roble|roure|alzina|encina|castany|bedoll/.test(g)) return 'bro';
    if (lt === 'mixed' || w === 'mixed') return 'mix';
    return 'unk';
  }
  const CLS_TXT = { con: 'Coníferas (pinos)', bro: 'Planifolios (hayas, robles…)', mix: 'Bosque mixto', unk: 'Bosque (tipo sin especificar)' };

  // Une trozos de vía en anillos cerrados (para multipolígonos)
  function stitch(segments) {
    const rings = [];
    const segs = segments.filter((s) => s.length > 1).map((s) => s.slice());
    const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    while (segs.length) {
      let ring = segs.shift();
      let guard = 0;
      while (!same(ring[0], ring[ring.length - 1]) && guard++ < 5000) {
        const end = ring[ring.length - 1];
        const idx = segs.findIndex((s) => same(s[0], end) || same(s[s.length - 1], end));
        if (idx < 0) break;
        let s = segs.splice(idx, 1)[0];
        if (!same(s[0], end)) s = s.reverse();
        ring = ring.concat(s.slice(1));
      }
      if (ring.length > 3) rings.push(ring);
    }
    return rings;
  }

  function addForest(id, tags, rings) {
    if (forestIds.has(id) || !rings.length) return;
    forestIds.add(id);
    let s = 90, w = 180, n = -90, e = -180;
    for (const r of rings) for (const [la, lo] of r) {
      if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo;
    }
    const cls = classify(tags);
    const extra = [tags.name, tags.genus || tags.species || tags.taxon].filter(Boolean).join(' · ');
    forests.push({ id, cls, bbox: [s, w, n, e], rings, desc: extra });
  }

  async function fetchForests(b) {
    const bb = `${b[0].toFixed(5)},${b[1].toFixed(5)},${b[2].toFixed(5)},${b[3].toFixed(5)}`;
    const q = `[out:json][timeout:60][bbox:${bb}];
(
  way["landuse"="forest"];
  way["natural"="wood"];
  way["landcover"="trees"];
  relation["landuse"="forest"]["type"="multipolygon"];
  relation["natural"="wood"]["type"="multipolygon"];
);
out tags geom;`;
    let lastErr = null;
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        for (const el of data.elements || []) {
          const tags = el.tags || {};
          if (el.type === 'way' && el.geometry) {
            const ring = el.geometry.map((p) => [p.lat, p.lon]);
            addForest('w' + el.id, tags, [ring]);
          } else if (el.type === 'relation' && el.members) {
            const outer = [], inner = [];
            for (const m of el.members) {
              if (m.type !== 'way' || !m.geometry) continue;
              const seg = m.geometry.map((p) => [p.lat, p.lon]);
              (m.role === 'inner' ? inner : outer).push(seg);
            }
            addForest('r' + el.id, tags, stitch(outer).concat(stitch(inner)));
          }
        }
        return true;
      } catch (e) { lastErr = e; }
    }
    console.warn('Overpass falló', lastErr);
    return false;
  }

  const covered = (b) => loadedBoxes.some((L) => b[0] >= L[0] && b[1] >= L[1] && b[2] <= L[2] && b[3] <= L[3]);

  async function ensureForests() {
    if (map.getZoom() < 12) {
      status('Acércate más al mapa (zoom) para calcular las zonas de setas', 3500);
      return;
    }
    const bnd = map.getBounds();
    const view = [bnd.getSouth(), bnd.getWest(), bnd.getNorth(), bnd.getEast()];
    if (covered(view) || loading) return;
    const dLat = (view[2] - view[0]) * 0.25, dLon = (view[3] - view[1]) * 0.25;
    const box = [view[0] - dLat, view[1] - dLon, view[2] + dLat, view[3] + dLon];
    loading = true;
    status('🌲 Buscando bosques en esta zona…');
    const ok = await fetchForests(box);
    loading = false;
    if (ok) {
      loadedBoxes.push(box);
      status(`🍄 Zona analizada (${forests.length} bosques cargados)`, 2500);
      heatLayer.redraw();
      if (map.hasLayer(forestOutline)) drawOutlines();
      // si el usuario se ha movido mientras cargaba, completa
      setTimeout(ensureForests, 50);
    } else {
      status('No se han podido descargar los bosques (servidor ocupado). Prueba en unos segundos.', 5000);
    }
  }

  // Rasteriza los bosques del tile en un canvas (R=coníferas, G=planifolios, R+G=mixto, B=desconocido)
  function rasterForests(z, x, y, pad) {
    const N = 256 + 2 * pad;
    const ox = x * 256 - pad, oy = y * 256 - pad;
    const [nLat, wLon] = unproject(ox, oy, z);
    const [sLat, eLon] = unproject(ox + N, oy + N, z);
    const list = forests.filter((f) => !(f.bbox[0] > nLat || f.bbox[2] < sLat || f.bbox[1] > eLon || f.bbox[3] < wLon));
    if (!list.length) return null;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.globalCompositeOperation = 'lighter';
    const colors = { con: 'rgb(255,0,0)', bro: 'rgb(0,255,0)', mix: 'rgb(255,255,0)', unk: 'rgb(0,0,255)' };
    for (const f of list) {
      ctx.beginPath();
      for (const r of f.rings) {
        r.forEach(([la, lo], idx) => {
          const [px, py] = project(la, lo, z);
          if (idx === 0) ctx.moveTo(px - ox, py - oy); else ctx.lineTo(px - ox, py - oy);
        });
        ctx.closePath();
      }
      ctx.fillStyle = colors[f.cls];
      ctx.fill('evenodd');
    }
    return ctx.getImageData(0, 0, N, N).data;
  }
  function clsFromPixel(d, idx) {
    const r = d[idx] > 127, g = d[idx + 1] > 127, b = d[idx + 2] > 127;
    if (r && g) return 'mix';
    if (r) return 'con';
    if (g) return 'bro';
    if (b) return 'unk';
    return null;
  }

  // Color de la capa de calor (amarillo -> naranja -> rojo -> granate)
  const STOPS = [
    [0.0, [255, 230, 80, 0]],
    [0.3, [255, 220, 70, 90]],
    [0.55, [255, 150, 40, 160]],
    [0.75, [224, 50, 42, 200]],
    [1.0, [142, 14, 59, 225]]
  ];
  function heatColor(v) {
    for (let i = 1; i < STOPS.length; i++) {
      if (v <= STOPS[i][0]) {
        const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i];
        const t = (v - a) / (b - a);
        return [lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t), lerp(ca[3], cb[3], t)];
      }
    }
    return STOPS[STOPS.length - 1][1];
  }

  // ---------------------------------------------------------------
  // 6. Mapa y capas
  // ---------------------------------------------------------------
  const start = store.get('bolets_view', { c: [41.85, 1.65], z: 8 });
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(start.c, start.z);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

  const icgcAttr = '© <a href="https://www.icgc.cat">ICGC</a>, © OpenStreetMap';
  const bases = {
    'Topográfico (ICGC)': L.tileLayer('https://geoserveis.icgc.cat/servei/catalunya/mapa-base/wmts/topografic/MON3857NW/{z}/{x}/{y}.png', { maxZoom: 19, attribution: icgcAttr }),
    'Ortofoto (ICGC)': L.tileLayer('https://geoserveis.icgc.cat/servei/catalunya/mapa-base/wmts/orto/MON3857NW/{z}/{x}/{y}.png', { maxZoom: 19, attribution: icgcAttr }),
    'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' })
  };
  bases['Topográfico (ICGC)'].addTo(map);
  L.control.layers(bases, null, { position: 'topright' }).addTo(map);

  // Capa de probabilidad
  const PAD = 4;
  const HeatLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      renderHeat(tile, coords).then(() => done(null, tile)).catch((e) => { console.warn(e); done(null, tile); });
      return tile;
    }
  });
  async function renderHeat(tile, { x, y, z }) {
    if (z < 12) return;
    const fr = rasterForests(z, x, y, PAD);
    if (!fr) return;
    const { grid, N } = await elevationGrid(z, x, y, PAD);
    const [lat] = unproject(x * 256 + 128, y * 256 + 128, z);
    const mpp = metersPerPixel(lat, z);
    const k = clamp(Math.round(20 / mpp), 1, PAD); // ~20 m de separación para la pendiente
    const ctx = tile.getContext('2d');
    const img = ctx.createImageData(256, 256);
    const o = img.data;
    const sp = current;
    for (let j = 0; j < 256; j++) {
      for (let i = 0; i < 256; i++) {
        const gi = (j + PAD) * N + (i + PAD);
        const cls = clsFromPixel(fr, gi * 4);
        if (!cls) continue;
        const h = grid[gi];
        if (isNaN(h)) continue;
        const t = terrainAt(grid, N, i + PAD, j + PAD, k, mpp);
        const s = score(sp, cls, h, t.slope, t.northness);
        if (s < 0.12) continue;
        const c = heatColor(s);
        const p = (j * 256 + i) * 4;
        o[p] = c[0]; o[p + 1] = c[1]; o[p + 2] = c[2]; o[p + 3] = c[3];
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  const heatLayer = new HeatLayer({ minZoom: 12, maxZoom: 19, zIndex: 400, updateWhenIdle: true, keepBuffer: 1 });
  heatLayer.addTo(map);

  // Capa de obagas / solanas
  const AspectLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      renderAspect(tile, coords).then(() => done(null, tile)).catch(() => done(null, tile));
      return tile;
    }
  });
  async function renderAspect(tile, { x, y, z }) {
    if (z < 11) return;
    const { grid, N } = await elevationGrid(z, x, y, PAD);
    const [lat] = unproject(x * 256 + 128, y * 256 + 128, z);
    const mpp = metersPerPixel(lat, z);
    const k = clamp(Math.round(20 / mpp), 1, PAD);
    const ctx = tile.getContext('2d');
    const img = ctx.createImageData(256, 256);
    const o = img.data;
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const t = terrainAt(grid, N, i + PAD, j + PAD, k, mpp);
      if (t.slope < 4) continue;
      const a = clamp(t.slope / 30, 0.15, 1);
      const p = (j * 256 + i) * 4;
      const n = t.northness * 2 - 1; // -1 solana .. 1 obaga
      if (n > 0.15) { o[p] = 40; o[p + 1] = 90; o[p + 2] = 200; o[p + 3] = 150 * a * n; }
      else if (n < -0.15) { o[p] = 240; o[p + 1] = 150; o[p + 2] = 40; o[p + 3] = 120 * a * -n; }
    }
    ctx.putImageData(img, 0, 0);
  }
  const aspectLayer = new AspectLayer({ minZoom: 11, maxZoom: 19, zIndex: 350, updateWhenIdle: true });

  // Contornos de bosques
  const forestOutline = L.layerGroup();
  const OUT_COL = { con: '#1f6b2a', bro: '#7a9a2a', mix: '#3f8a5a', unk: '#555' };
  function drawOutlines() {
    forestOutline.clearLayers();
    const b = map.getBounds();
    const s = b.getSouth(), w = b.getWest(), n = b.getNorth(), e = b.getEast();
    let count = 0;
    for (const f of forests) {
      if (f.bbox[0] > n || f.bbox[2] < s || f.bbox[1] > e || f.bbox[3] < w) continue;
      if (++count > 1500) break;
      L.polygon(f.rings, { color: OUT_COL[f.cls], weight: 1.2, fill: false, interactive: false }).addTo(forestOutline);
    }
  }

  $('lyrHeat').addEventListener('change', (e) => e.target.checked ? heatLayer.addTo(map) : map.removeLayer(heatLayer));
  $('lyrAspect').addEventListener('change', (e) => e.target.checked ? aspectLayer.addTo(map) : map.removeLayer(aspectLayer));
  $('lyrForest').addEventListener('change', (e) => {
    if (e.target.checked) { drawOutlines(); forestOutline.addTo(map); } else map.removeLayer(forestOutline);
  });

  // ---------------------------------------------------------------
  // 7. Selector de setas
  // ---------------------------------------------------------------
  function inSeason(sp, m) { return sp.meses.includes(m); }
  function renderSpecies() {
    const box = $('species');
    box.innerHTML = '';
    for (const sp of SPECIES) {
      const b = document.createElement('button');
      b.className = 'chip' + (sp === current ? ' active' : '');
      b.textContent = sp.nombre;
      b.onclick = () => { current = sp; store.set('bolets_species', sp.id); renderSpecies(); heatLayer.redraw(); };
      box.appendChild(b);
    }
    const m = new Date().getMonth() + 1;
    const on = inSeason(current, m);
    $('speciesInfo').innerHTML =
      `<b>${current.nombre}</b> (${current.alias}) · <i>${current.latin}</i><br>` +
      `${current.nota}<br>` +
      `Altitud ideal ${current.alt[1]}–${current.alt[2]} m · Temporada: ${current.meses.map((x) => MESES[x - 1]).join(', ')} ` +
      `<span class="season ${on ? 'on' : 'off'}">${on ? 'En temporada' : 'Fuera de temporada'}</span>`;
  }
  const saved = store.get('bolets_species', null);
  current = SPECIES.find((s) => s.id === saved) || SPECIES[0];
  renderSpecies();

  // ---------------------------------------------------------------
  // 8. Lluvia y temperatura reciente (Open-Meteo)
  // ---------------------------------------------------------------
  const wxCache = new Map();
  let wxTimer = null;
  function updateWeatherSoon() {
    clearTimeout(wxTimer);
    wxTimer = setTimeout(updateWeather, 700);
  }
  async function updateWeather() {
    if (map.getZoom() < 10) return;
    const c = map.getCenter();
    const la = Math.round(c.lat * 10) / 10, lo = Math.round(c.lng * 10) / 10;
    const key = la + ',' + lo;
    let data = wxCache.get(key);
    if (!data) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}` +
          `&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&past_days=21&forecast_days=4&timezone=Europe%2FMadrid`;
        const r = await fetch(url);
        data = await r.json();
        wxCache.set(key, data);
      } catch (e) {
        $('weather').innerHTML = '<div class="muted">No se ha podido consultar el tiempo.</div>';
        return;
      }
    }
    renderWeather(data);
  }
  function renderWeather(d) {
    const days = d.daily.time;
    const rain = d.daily.precipitation_sum.map((v) => v || 0);
    const tmax = d.daily.temperature_2m_max, tmin = d.daily.temperature_2m_min;
    const today = new Date().toISOString().slice(0, 10);
    let ti = days.indexOf(today);
    if (ti < 0) ti = days.length - 5;
    const sum = (a, b) => rain.slice(Math.max(0, a), b).reduce((s, v) => s + v, 0);
    const r7 = sum(ti - 7, ti), r15 = sum(ti - 15, ti), r21 = sum(ti - 21, ti);
    const avg = (arr) => { const v = arr.filter((x) => x != null); return v.reduce((s, x) => s + x, 0) / (v.length || 1); };
    const tmin7 = avg(tmin.slice(ti - 7, ti)), tmax7 = avg(tmax.slice(ti - 7, ti));
    let lastBig = -1;
    for (let i = ti - 1; i >= 0; i--) if (rain[i] >= 10) { lastBig = ti - i; break; }
    const rFuture = sum(ti, ti + 4);

    let verdict, color;
    if (r15 >= 35 && tmin7 > 1 && tmax7 < 27) { verdict = '🟢 Buen momento: el bosque está húmedo'; color = '#2c5d1d'; }
    else if (r15 >= 15 && tmin7 > -1) { verdict = '🟡 Algo de humedad: mira en obagas y fondos de valle'; color = '#8a6a10'; }
    else if (tmin7 <= -1) { verdict = '🔵 Hace demasiado frío: las heladas frenan las setas'; color = '#1d4d8a'; }
    else { verdict = '🔴 Seco: ahora mismo es difícil encontrar'; color = '#8a2a16'; }
    if (tmax7 >= 27 && r15 >= 15) { verdict = '🟠 Hay agua pero hace calor: mejor en zonas altas'; color = '#8a4b16'; }

    const max = Math.max(5, ...rain.slice(ti - 21, ti + 4));
    const bars = rain.slice(Math.max(0, ti - 21), ti + 4).map((v, idx) => {
      const fut = Math.max(0, ti - 21) + idx >= ti;
      return `<div class="${fut ? 'future' : ''}" style="height:${Math.max(2, v / max * 100)}%" title="${v.toFixed(1)} mm"></div>`;
    }).join('');

    $('weather').innerHTML =
      `<div class="verdict" style="color:${color}">${verdict}</div>` +
      `Lluvia: <b>${r7.toFixed(0)} mm</b> en 7 días · <b>${r15.toFixed(0)} mm</b> en 15 · ${r21.toFixed(0)} mm en 21<br>` +
      `Temperaturas última semana: ${tmin7.toFixed(0)}° / ${tmax7.toFixed(0)}°` +
      (lastBig > 0 ? `<br>Última lluvia fuerte (≥10 mm): hace <b>${lastBig} día${lastBig > 1 ? 's' : ''}</b>` +
        (lastBig >= 5 && lastBig <= 15 ? ' → ¡ventana ideal!' : lastBig < 5 ? ' → espera unos días' : '') : '') +
      (rFuture >= 5 ? `<br>Previsión próximos días: ${rFuture.toFixed(0)} mm` : '') +
      `<div class="bars">${bars}</div><div class="axis"><span>hace 21 días</span><span>hoy</span><span>+3</span></div>` +
      `<div class="muted">Las setas suelen salir entre 7 y 15 días después de una buena lluvia.</div>`;
  }

  // ---------------------------------------------------------------
  // 9. Tocar el mapa: detalle de un punto
  // ---------------------------------------------------------------
  function pointInRings(lat, lon, rings) {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [yi, xi] = r[i], [yj, xj] = r[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }
  function forestAt(lat, lon) {
    const hits = forests.filter((f) => lat >= f.bbox[0] && lat <= f.bbox[2] && lon >= f.bbox[1] && lon <= f.bbox[3] && pointInRings(lat, lon, f.rings));
    if (!hits.length) return null;
    const pref = ['mix', 'con', 'bro', 'unk'];
    hits.sort((a, b) => pref.indexOf(a.cls) - pref.indexOf(b.cls));
    return hits[0];
  }
  const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

  async function pointInfo(lat, lon) {
    const z = 15;
    const [gx, gy] = project(lat, lon, z);
    const x = Math.floor(gx / 256), y = Math.floor(gy / 256);
    const { grid, N } = await elevationGrid(z, x, y, PAD);
    const i = Math.floor(gx - x * 256) + PAD, j = Math.floor(gy - y * 256) + PAD;
    const mpp = metersPerPixel(lat, z);
    const k = clamp(Math.round(20 / mpp), 1, PAD);
    const t = terrainAt(grid, N, i, j, k, mpp);
    return { h: grid[j * N + i], ...t };
  }

  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    const pop = L.popup({ maxWidth: 280 }).setLatLng(e.latlng).setContent('<div class="pop">Calculando…</div>').openOn(map);
    let info;
    try { info = await pointInfo(lat, lng); } catch (err) { pop.setContent('<div class="pop">No hay datos de relieve aquí.</div>'); return; }
    const analysed = loadedBoxes.some((b) => lat >= b[0] && lat <= b[2] && lng >= b[1] && lng <= b[3]);
    const f = forestAt(lat, lng);
    const cls = f ? f.cls : null;
    const dir = DIRS[Math.round(info.aspect / 45) % 8];
    const ori = info.slope < 3 ? 'Llano' : `${dir} ${info.northness > 0.7 ? '(obaga)' : info.northness < 0.3 ? '(solana)' : ''}`;
    const ranking = SPECIES.map((sp) => ({ sp, s: score(sp, cls, info.h, info.slope, info.northness) }))
      .sort((a, b) => b.s - a.s);
    const mine = Math.round(score(current, cls, info.h, info.slope, info.northness) * 100);
    const rows = ranking.map(({ sp, s }) =>
      `<tr><td>${sp.nombre}</td><td style="width:45%"><div class="bar"><div style="width:${Math.round(s * 100)}%"></div></div></td></tr>`).join('');
    const bosque = !analysed ? '<i>zona sin analizar (acércate)</i>' : f ? CLS_TXT[cls] + (f.desc ? `<br><span class="muted">${f.desc}</span>` : '') : 'Sin bosque';
    pop.setContent(
      `<div class="pop">
        <h3>${current.nombre}: <span class="score">${mine}%</span></h3>
        <table>
          <tr><td>Altitud</td><td>${Math.round(info.h)} m</td></tr>
          <tr><td>Pendiente</td><td>${Math.round(info.slope)}°</td></tr>
          <tr><td>Orientación</td><td>${ori}</td></tr>
          <tr><td>Bosque</td><td>${bosque}</td></tr>
        </table>
        ${cls ? `<div class="muted" style="margin:4px 0 2px">Todas las setas aquí:</div><table>${rows}</table>` : ''}
        <button id="btnSave">⭐ Guardar rincón</button>
        <div class="btnrow">
          <a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}">🚗 Cómo llegar</a>
          <a target="_blank" rel="noopener" href="https://www.instamaps.cat/geocatweb/visor.html#/${lat.toFixed(5)}/${lng.toFixed(5)}/16">🗺️ Instamaps</a>
        </div>
      </div>`
    );
    setTimeout(() => {
      const b = document.getElementById('btnSave');
      if (b) b.onclick = () => {
        const name = prompt('Nombre del rincón:', `${current.nombre} ${new Date().toLocaleDateString('es-ES')}`);
        if (name === null) return;
        spots.push({ id: Date.now(), name: name || 'Rincón', lat, lon: lng, sp: current.id, date: new Date().toISOString().slice(0, 10) });
        store.set('bolets_spots', spots);
        renderSpots();
        map.closePopup();
      };
    }, 0);
  });

  // ---------------------------------------------------------------
  // 10. Mis rincones
  // ---------------------------------------------------------------
  let spots = store.get('bolets_spots', []);
  const spotLayer = L.layerGroup().addTo(map);
  const spotIcon = L.divIcon({ className: 'spot-icon', html: '🍄', iconSize: [26, 26], iconAnchor: [13, 13] });
  function renderSpots() {
    spotLayer.clearLayers();
    const box = $('spots');
    if (!spots.length) { box.innerHTML = '<div class="muted">Toca el mapa y pulsa «Guardar rincón».</div>'; return; }
    box.innerHTML = '';
    for (const s of spots) {
      L.marker([s.lat, s.lon], { icon: spotIcon }).bindTooltip(s.name).addTo(spotLayer);
      const row = document.createElement('div');
      row.className = 'spot';
      const go = document.createElement('button');
      go.className = 'go';
      go.textContent = '🍄 ' + s.name;
      go.onclick = () => map.setView([s.lat, s.lon], 15);
      const del = document.createElement('button');
      del.textContent = '🗑️';
      del.title = 'Borrar';
      del.onclick = () => {
        if (!confirm(`¿Borrar «${s.name}»?`)) return;
        spots = spots.filter((x) => x.id !== s.id);
        store.set('bolets_spots', spots);
        renderSpots();
      };
      row.append(go, del);
      box.appendChild(row);
    }
  }
  renderSpots();

  // ---------------------------------------------------------------
  // 11. Eventos generales
  // ---------------------------------------------------------------
  let moveTimer = null;
  map.on('moveend', () => {
    const c = map.getCenter();
    store.set('bolets_view', { c: [c.lat, c.lng], z: map.getZoom() });
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (map.getZoom() >= 12) ensureForests();
      else if (map.getZoom() >= 9) status('Haz zoom en una zona para ver dónde puede haber setas', 2500);
      if (map.hasLayer(forestOutline)) drawOutlines();
    }, 600);
    updateWeatherSoon();
  });

  $('btnLocate').onclick = () => {
    if (!navigator.geolocation) return status('Tu navegador no permite ubicación', 3000);
    status('Buscando tu ubicación…');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        status(null);
        const ll = [p.coords.latitude, p.coords.longitude];
        map.setView(ll, 14);
        L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#2a7de1', fillOpacity: 1 }).addTo(map);
      },
      () => status('No se ha podido obtener tu ubicación', 3000),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  $('btnInfo').onclick = () => $('infoModal').classList.remove('hidden');
  $('btnCloseInfo').onclick = () => { $('infoModal').classList.add('hidden'); store.set('bolets_info_seen', true); };
  if (!store.get('bolets_info_seen', false)) $('infoModal').classList.remove('hidden');

  $('panelHandle').onclick = () => $('panel').classList.toggle('collapsed');

  // Arranque
  if (map.getZoom() >= 12) ensureForests();
  updateWeather();
  if (map.getZoom() < 12) status('Haz zoom en una zona boscosa para ver dónde puede haber setas', 4000);

  // Exponer para pruebas
  window.__bolets = { score, terrainAt, stitch, classify, SPECIES, forests };
})();

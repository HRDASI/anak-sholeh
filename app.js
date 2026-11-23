/* Anak Sholeh — foto dokumen, gabung jadi PDF, kirim ke WhatsApp/Telegram.
   Semua diproses di HP, tidak ada yang di-upload. */
'use strict';

const $ = (s) => document.querySelector(s);
const MAX_STORE = 2400;            // sisi terpanjang foto yang disimpan
const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]]; // tl, tr, br, bl (0..1)
const PRESETS = {
  kecil:  { max: 1240, q: 0.6 },
  sedang: { max: 1654, q: 0.72 },
  tinggi: { max: 2339, q: 0.85 },
};

const state = { pages: [], nextOrder: 1, lastFilter: 'cerah' };

/* ================= Util ================= */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toBlob(c, type, q) { return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Gagal membuat gambar'))), type, q)); }
async function decode(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (e) { return await createImageBitmap(blob); }
}
function isFull(c) { return c.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 1e-3 && Math.abs(p[1] - FULL[i][1]) < 1e-3); }
function fmtSize(n) { return n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB'; }

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function busy(on, text = 'Memproses…') { $('#busy').hidden = !on; $('#busyText').textContent = text; }

/* ================= Penyimpanan (IndexedDB) ================= */
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('anak-sholeh', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
const meta = (p) => ({ id: p.id, w: p.w, h: p.h, corners: p.corners, filter: p.filter, order: p.order });

async function dbPut(p, withBlob) {
  try {
    const t = (await db()).transaction(['pages', 'blobs'], 'readwrite');
    t.objectStore('pages').put(meta(p));
    if (withBlob) t.objectStore('blobs').put(p.blob, p.id);
    await txDone(t);
  } catch (e) { console.warn('simpan gagal', e); }
}
async function dbPutAllMeta() {
  try {
    const t = (await db()).transaction('pages', 'readwrite');
    state.pages.forEach((p) => t.objectStore('pages').put(meta(p)));
    await txDone(t);
  } catch (e) { console.warn(e); }
}
async function dbDelete(id) {
  try {
    const t = (await db()).transaction(['pages', 'blobs'], 'readwrite');
    t.objectStore('pages').delete(id); t.objectStore('blobs').delete(id);
    await txDone(t);
  } catch (e) { console.warn(e); }
}
async function dbClear() {
  try {
    const t = (await db()).transaction(['pages', 'blobs'], 'readwrite');
    t.objectStore('pages').clear(); t.objectStore('blobs').clear();
    await txDone(t);
  } catch (e) { console.warn(e); }
}
async function dbLoad() {
  try {
    const t = (await db()).transaction(['pages', 'blobs']);
    const [metas, keys, vals] = await Promise.all([
      reqP(t.objectStore('pages').getAll()),
      reqP(t.objectStore('blobs').getAllKeys()),
      reqP(t.objectStore('blobs').getAll()),
    ]);
    const blobs = new Map(keys.map((k, i) => [k, vals[i]]));
    return metas.filter((m) => blobs.has(m.id)).map((m) => ({ ...m, blob: blobs.get(m.id) })).sort((a, b) => a.order - b.order);
  } catch (e) { console.warn(e); return []; }
}

/* ================= Pengolahan gambar ================= */

// Selesaikan homografi: titik tujuan (x,y) -> titik sumber (u,v)
function homography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    const d = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * h[k];
    h[r] = s / (A[r][r] || 1e-12);
  }
  return h;
}

// Luruskan dokumen dari 4 sudut, lalu terapkan filter. Hasil: canvas.
function renderPage(bmp, corners, filter, maxLong) {
  const W = bmp.width, H = bmp.height;
  const c = corners.map(([x, y]) => [x * W, y * H]);
  let ow = Math.max(dist(c[0], c[1]), dist(c[3], c[2]));
  let oh = Math.max(dist(c[0], c[3]), dist(c[1], c[2]));
  const s = Math.min(1, maxLong / Math.max(ow, oh, 1));
  ow = Math.max(1, Math.round(ow * s)); oh = Math.max(1, Math.round(oh * s));
  const out = makeCanvas(ow, oh);
  const octx = out.getContext('2d');

  if (isFull(corners)) {
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(bmp, 0, 0, ow, oh);
    if (filter !== 'asli') {
      const img = octx.getImageData(0, 0, ow, oh);
      applyFilter(img, filter);
      octx.putImageData(img, 0, 0);
    }
    return out;
  }

  // Kecilkan sumber dulu agar cepat & tidak bergerigi
  const ss = Math.min(1, s * 1.4);
  const sw = Math.max(1, Math.round(W * ss)), sh = Math.max(1, Math.round(H * ss));
  const sc = makeCanvas(sw, sh);
  const sctx = sc.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(bmp, 0, 0, sw, sh);
  const src = sctx.getImageData(0, 0, sw, sh).data;
  const srcPts = corners.map(([x, y]) => [x * sw, y * sh]);
  const h = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], srcPts);

  const img = octx.createImageData(ow, oh);
  const d = img.data;
  let i = 0;
  for (let y = 0; y < oh; y++) {
    const yy = y + 0.5;
    for (let x = 0; x < ow; x++, i += 4) {
      const xx = x + 0.5;
      const den = h[6] * xx + h[7] * yy + 1;
      let u = (h[0] * xx + h[1] * yy + h[2]) / den - 0.5;
      let v = (h[3] * xx + h[4] * yy + h[5]) / den - 0.5;
      u = clamp(u, 0, sw - 1.001); v = clamp(v, 0, sh - 1.001);
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const p00 = (y0 * sw + x0) * 4, p10 = p00 + 4, p01 = p00 + sw * 4, p11 = p01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      d[i]     = src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11;
      d[i + 1] = src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
      d[i + 2] = src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
      d[i + 3] = 255;
    }
  }
  if (filter !== 'asli') applyFilter(img, filter);
  octx.putImageData(img, 0, 0);
  return out;
}

// Filter: Cerah (warna, latar diputihkan), Dokumen (hitam-putih tajam), Abu-abu
function applyFilter(img, filter) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];

  // Perkiraan terang kertas per blok (untuk menghilangkan bayangan)
  const bs = Math.max(8, Math.round(Math.max(w, h) / 40));
  const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
  let g = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const row = ((y / bs) | 0) * gw;
    for (let x = 0; x < w; x++) {
      const k = row + ((x / bs) | 0), v = gray[y * w + x];
      if (v > g[k]) g[k] = v;
    }
  }
  const pass = (fn) => {
    const o = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let acc = fn === 'max' ? 0 : 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
        const v = g[yy * gw + xx];
        if (fn === 'max') { if (v > acc) acc = v; } else { acc += v; cnt++; }
      }
      o[y * gw + x] = fn === 'max' ? acc : acc / cnt;
    }
    g = o;
  };
  pass('max'); pass('avg'); pass('avg');
  let gmax = 0; for (let k = 0; k < g.length; k++) if (g[k] > gmax) gmax = g[k];
  // batasi koreksi: area yang jauh lebih gelap dari kertas (meja, foto) tidak ikut diputihkan
  const floor = Math.max(40, gmax * 0.62);
  for (let k = 0; k < g.length; k++) if (g[k] < floor) g[k] = floor;

  for (let y = 0; y < h; y++) {
    let gy = (y + 0.5) / bs - 0.5; gy = clamp(gy, 0, gh - 1);
    const y0 = gy | 0, y1 = Math.min(gh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < w; x++) {
      let gx = (x + 0.5) / bs - 0.5; gx = clamp(gx, 0, gw - 1);
      const x0 = gx | 0, x1 = Math.min(gw - 1, x0 + 1), fx = gx - x0;
      const bg = (g[y0 * gw + x0] * (1 - fx) + g[y0 * gw + x1] * fx) * (1 - fy)
               + (g[y1 * gw + x0] * (1 - fx) + g[y1 * gw + x1] * fx) * fy;
      const i = y * w + x, j = i * 4;
      const k = 255 / bg;
      if (filter === 'dokumen') {
        let t = (gray[i] * k - 60) / 165; t = clamp(t, 0, 1);
        const v = 255 * Math.pow(t, 1.5);
        d[j] = d[j + 1] = d[j + 2] = v;
      } else if (filter === 'abu') {
        const v = clamp((gray[i] * k - 25) * 255 / 215, 0, 255);
        d[j] = d[j + 1] = d[j + 2] = v;
      } else { // cerah
        d[j]     = clamp((d[j] * k - 25) * 255 / 215, 0, 255);
        d[j + 1] = clamp((d[j + 1] * k - 25) * 255 / 215, 0, 255);
        d[j + 2] = clamp((d[j + 2] * k - 25) * 255 / 215, 0, 255);
      }
    }
  }
}

/* ================= Halaman ================= */
// Putar gambar n × 90° searah jarum jam
function rotateCanvas(src, n) {
  n = ((n % 4) + 4) % 4;
  const w = src.width, h = src.height;
  const c = makeCanvas(n % 2 ? h : w, n % 2 ? w : h);
  const x = c.getContext('2d');
  x.translate(c.width / 2, c.height / 2); x.rotate(n * Math.PI / 2); x.drawImage(src, -w / 2, -h / 2);
  return c;
}
// Sudut (0..1, urutan tl,tr,br,bl) ikut diputar n × 90° searah jarum jam
function rotateCorners(k, n) {
  n = ((n % 4) + 4) % 4;
  const r = ([px, py]) => [1 - py, px];
  for (let i = 0; i < n; i++) k = [r(k[3]), r(k[0]), r(k[1]), r(k[2])];
  return k;
}

// src: File/Blob atau ImageBitmap. opts.corners: sudut yang sudah dideteksi (null = seluruh foto).
// opts.rot: putaran hasil (× 90° searah jarum jam), dari posisi HP saat jepret.
async function addPage(src, opts = {}) {
  const order = opts.order || state.nextOrder++;
  const bmp = typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap ? src : await decode(src);
  const s = Math.min(1, MAX_STORE / Math.max(bmp.width, bmp.height));
  let w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  let c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  let auto = 'corners' in opts ? opts.corners : Detect.detectCorners(c);
  if (opts.rot) {
    c = rotateCanvas(c, opts.rot); w = c.width; h = c.height;
    if (auto) auto = rotateCorners(auto, opts.rot);
  }
  const blob = await toBlob(c, 'image/jpeg', 0.9);
  const p = { id: uid(), blob, w, h, corners: auto || FULL.map((x) => x.slice()), filter: state.lastFilter, order };
  state.pages.push(p);
  state.pages.sort((a, b) => a.order - b.order);
  renderGrid();
  dbPut(p, true);
  queueThumb(p);
  return p;
}

let thumbChain = Promise.resolve();
function queueThumb(p) {
  p.thumbBusy = true;
  thumbChain = thumbChain.then(async () => {
    if (!state.pages.includes(p)) return;
    try {
      const bmp = await decode(p.blob);
      const c = renderPage(bmp, p.corners, p.filter, 480);
      bmp.close && bmp.close();
      const b = await toBlob(c, 'image/jpeg', 0.75);
      if (p.thumb) URL.revokeObjectURL(p.thumb);
      p.thumb = URL.createObjectURL(b);
    } catch (e) { console.warn(e); }
    p.thumbBusy = false;
    const img = document.querySelector(`[data-id="${p.id}"] .thumb`);
    if (img) { img.src = p.thumb; img.classList.remove('loading'); }
  });
}

function renderGrid() {
  const grid = $('#grid');
  const n = state.pages.length;
  $('#empty').hidden = n > 0;
  $('#gridHint').hidden = n === 0;
  $('#btnClear').hidden = n === 0;
  $('#btnExport').hidden = n === 0;
  $('#btnExportText').textContent = `PDF (${n})`;
  grid.innerHTML = '';
  state.pages.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'card'; card.dataset.id = p.id;
    card.innerHTML = `
      <img class="thumb ${p.thumb ? '' : 'loading'}" alt="Halaman ${i + 1}" ${p.thumb ? `src="${p.thumb}"` : ''}>
      <span class="num">${i + 1}</span>
      <div class="moves">
        <button data-act="left" aria-label="Geser ke kiri" ${i === 0 ? 'disabled' : ''}>‹</button>
        <button data-act="right" aria-label="Geser ke kanan" ${i === n - 1 ? 'disabled' : ''}>›</button>
      </div>`;
    grid.appendChild(card);
  });
}

$('#grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card'); if (!card) return;
  const idx = state.pages.findIndex((p) => p.id === card.dataset.id); if (idx < 0) return;
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'left' || act === 'right') {
    const j = act === 'left' ? idx - 1 : idx + 1;
    if (j < 0 || j >= state.pages.length) return;
    const a = state.pages[idx], b = state.pages[j];
    [a.order, b.order] = [b.order, a.order];
    state.pages.sort((x, y) => x.order - y.order);
    renderGrid(); dbPutAllMeta();
    return;
  }
  openEditor(state.pages[idx]);
});

$('#btnClear').addEventListener('click', async () => {
  if (!confirm(`Hapus semua ${state.pages.length} halaman?`)) return;
  state.pages.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb));
  state.pages = [];
  renderGrid();
  await dbClear();
  toast('Semua halaman dihapus');
});

/* ================= Navigasi (tombol kembali Android) ================= */
const overlays = [];
function pushOverlay(close) { overlays.push(close); history.pushState({ ov: overlays.length }, ''); }
function back() { history.back(); }
window.addEventListener('popstate', () => { const close = overlays.pop(); if (close) close(); });

/* ================= Kamera ================= */
const cam = { stream: null, track: null, count: 0, torch: false };

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { $('#inCamera').click(); return; }
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (e) {
    console.warn(e);
    toast('Kamera di dalam aplikasi tidak bisa dibuka, memakai kamera HP.');
    $('#inCamera').click();
    return;
  }
  cam.track = cam.stream.getVideoTracks()[0];
  cam.count = 0; cam.torch = false;
  $('#camCount').textContent = '0'; $('#camCount').hidden = true;
  $('#camLast').hidden = true;
  const caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
  $('#camTorch').hidden = !caps.torch;
  $('#camTorch').classList.remove('on');
  try { cam.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); } catch (e) {}
  const v = $('#camVideo'); v.srcObject = cam.stream;
  $('#camera').hidden = false;
  markAuto();
  startOrient();
  pushOverlay(closeCamera);
  startLive();
}

function closeCamera() {
  stopLive();
  stopOrient();
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = cam.track = null;
  $('#camVideo').srcObject = null;
  $('#camera').hidden = true;
  if (cam.count) toast(`${cam.count} foto ditambahkan. Ketuk halaman bila perlu dirapikan.`);
}

// Hasil: ImageBitmap (tanpa encode JPEG di sini supaya cepat; encode sekali saat disimpan)
async function grabPhoto() {
  const v = $('#camVideo');
  const vw = v.videoWidth, vh = v.videoHeight;
  if ((!vw || Math.max(vw, vh) < 1900) && 'ImageCapture' in window) {
    try {
      const ic = new ImageCapture(cam.track);
      const blob = await Promise.race([
        ic.takePhoto(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);
      return await decode(blob);
    } catch (e) { console.warn('takePhoto gagal, pakai frame video', e); }
  }
  if (!vw) throw new Error('Kamera belum siap');
  return createImageBitmap(v);
}
function setLastThumb(bmp, rot) {
  const s = 112 / Math.max(bmp.width, bmp.height);
  let c = makeCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (rot) c = rotateCanvas(c, rot);
  const last = $('#camLast'); last.src = c.toDataURL('image/jpeg', 0.7); last.hidden = false;
}

/* ---- Arah HP (sensor kemiringan) → hasil foto otomatis tegak ---- */
// orient.dev: posisi HP (× 90° searah jarum jam yang perlu diterapkan ke foto). 0 = tegak.
// Saat HP hampir datar (memotret ke bawah), dipakai arah terakhir yang jelas.
const orient = { dev: 0, listening: false, ios: /iPhone|iPad|iPod/.test(navigator.userAgent) };
const ORIENT_CENTER = [0, -90, 180, 90]; // sudut tengah (derajat) untuk dev = 0,1,2,3
function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null) return;
  let x = g.x, y = g.y;
  if (orient.ios) { x = -x; y = -y; }
  if (Math.hypot(x, y) < 4) return; // HP hampir datar: tetap pakai arah terakhir
  const deg = Math.atan2(x, y) * 180 / Math.PI; // 0 tegak, +90 = atas HP ke kiri, -90 = atas HP ke kanan
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  if (diff(deg, ORIENT_CENTER[orient.dev]) <= 55) return; // histeresis supaya tidak bolak-balik
  let best = 0;
  for (let q = 1; q < 4; q++) if (diff(deg, ORIENT_CENTER[q]) < diff(deg, ORIENT_CENTER[best])) best = q;
  if (best !== orient.dev) { orient.dev = best; markOrient(); }
}
// putaran foto = posisi HP dikurangi putaran layar (kalau layar ikut berputar, video sudah tegak)
function photoRot() {
  const a = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  const scr = { 0: 0, 90: 3, 180: 2, 270: 1, '-90': 1 }[a] || 0;
  return (orient.dev - scr + 4) % 4;
}
function markOrient() {
  const r = photoRot();
  $('#camera').dataset.rot = r;
  $('#camHint').style.transform = r ? `rotate(${[0, 90, 180, -90][r] * -1}deg)` : '';
}
function startOrient() {
  if (!orient.listening && 'DeviceMotionEvent' in window) { window.addEventListener('devicemotion', onMotion); orient.listening = true; }
  markOrient();
}
function stopOrient() {
  if (orient.listening) { window.removeEventListener('devicemotion', onMotion); orient.listening = false; }
}

/* ---- Deteksi langsung di layar kamera ---- */
const live = {
  worker: null, reqId: 0, pending: new Map(), busy: false, timer: 0, raf: 0,
  raw: null, target: null, shown: null, misses: 0, stableSince: 0, state: 'none',
  armed: true, auto: false, lastShot: 0, vw: 0, vh: 0,
};
try { live.auto = localStorage.getItem('as.autoShot') === '1'; } catch (e) {}
const maxMove = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

function ensureWorker() {
  if (live.worker || !('Worker' in window) || typeof OffscreenCanvas === 'undefined') return;
  try {
    live.worker = new Worker('detect-worker.js');
    live.worker.onmessage = (e) => { const r = live.pending.get(e.data.id); if (r) { live.pending.delete(e.data.id); r(e.data.q); } };
    live.worker.onerror = (e) => { console.warn('worker', e); live.worker = null; live.pending.forEach((r) => r(null)); live.pending.clear(); };
  } catch (e) { live.worker = null; }
}
// deteksi di worker (latar belakang); kalau tidak ada worker, di halaman
function detectAsync(bmp, opts = {}) {
  if (!live.worker) {
    let q = null;
    try { const r = Detect.detectByLines(bmp, opts); if (r) q = r.q; } catch (e) {}
    bmp.close && bmp.close();
    return Promise.resolve(q);
  }
  return new Promise((res) => {
    const id = ++live.reqId;
    live.pending.set(id, res);
    live.worker.postMessage({ id, bmp, opts }, [bmp]);
    setTimeout(() => { if (live.pending.has(id)) { live.pending.delete(id); res(null); } }, 5000);
  });
}
async function smallBitmap(src, w, h) {
  const s = Math.min(1, 480 / Math.max(w, h));
  return createImageBitmap(src, { resizeWidth: Math.max(1, Math.round(w * s)), resizeHeight: Math.max(1, Math.round(h * s)), resizeQuality: 'medium' });
}

function startLive() {
  ensureWorker();
  Object.assign(live, { raw: null, target: null, shown: null, misses: 0, stableSince: 0, state: 'none', armed: true, busy: false, hist: [], consistent: false, lostSince: 0, shotQuad: null });
  updateLiveUi(performance.now());
  clearInterval(live.timer); live.timer = setInterval(liveTick, live.worker ? 160 : 450);
  cancelAnimationFrame(live.raf); live.raf = requestAnimationFrame(drawLive);
}
function stopLive() {
  clearInterval(live.timer); cancelAnimationFrame(live.raf);
  live.timer = live.raf = 0; live.target = live.shown = null;
  const c = $('#camOverlay'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
}
async function liveTick() {
  const v = $('#camVideo');
  if (!cam.stream || live.busy || !v.videoWidth || document.hidden) return;
  live.busy = true;
  try {
    live.vw = v.videoWidth; live.vh = v.videoHeight;
    const q = await detectAsync(await smallBitmap(v, v.videoWidth, v.videoHeight), { prior: live.raw, allowBorder: false });
    onLive(q);
  } catch (e) { console.warn(e); }
  live.busy = false;
}
// Penstabil: garis = nilai tengah dari hasil-hasil terakhir yang saling cocok.
// Hasil yang sesekali meleset diabaikan, jadi garis tidak lari-lari.
const median = (a) => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const medianQuad = (qs) => [0, 1, 2, 3].map((i) => [median(qs.map((q) => q[i][0])), median(qs.map((q) => q[i][1]))]);
function onLive(q) {
  if (!cam.stream) return;
  const now = performance.now();
  live.hist.push(q); if (live.hist.length > 5) live.hist.shift();
  const valid = live.hist.filter(Boolean);
  let stable = null;
  live.consistent = false;
  if (valid.length >= 2) {
    const m = medianQuad(valid);
    const inl = valid.filter((x) => maxMove(x, m) < 0.04);
    if (inl.length >= 2 && inl.length * 2 >= valid.length) {
      stable = medianQuad(inl);
      live.consistent = inl.length >= 3; // "Pas" hanya bila ≥3 hasil terakhir saling cocok
    }
  }
  // Jepret otomatis siap lagi hanya bila halaman benar-benar berganti:
  // garis hilang ≥1,5 detik (tangan membalik halaman) atau dokumen bergeser jauh dari posisi jepretan terakhir.
  if (!stable) {
    if (++live.misses >= 3) {
      live.raw = live.target = null; live.stableSince = 0;
      if (!live.lostSince) live.lostSince = now;
    }
    if (live.lostSince && now - live.lostSince >= 1500) live.armed = true;
  } else {
    live.misses = 0;
    if (live.lostSince && now - live.lostSince >= 1500) live.armed = true;
    live.lostSince = 0;
    if (live.shotQuad && maxMove(stable, live.shotQuad) > 0.08) live.armed = true;
    const moved = live.raw ? maxMove(stable, live.raw) : 1;
    live.raw = stable;
    if (moved > 0.04) live.stableSince = now;
    live.target = stable;
  }
  updateLiveUi(now);
}
function updateLiveUi(now) {
  const hint = $('#camHint'), shutter = $('#camShutter');
  const stableFor = live.raw ? now - live.stableSince : 0;
  live.state = !live.raw ? 'none' : stableFor >= 600 && live.consistent ? 'pas' : 'gerak';
  let text = 'Masukkan seluruh dokumen ke layar', cls = '';
  if (live.state === 'gerak') { text = 'Tahan HP agar diam…'; cls = 'wait'; }
  if (live.state === 'pas') {
    cls = 'ok';
    if (!live.auto) text = 'Pas! Silakan jepret';
    else if (!live.armed) text = 'Tersimpan ✓ Ganti halaman berikutnya';
    else text = 'Pas! Jepret otomatis…';
  } else if (live.auto && !live.armed && live.state === 'none') text = 'Tersimpan ✓ Arahkan ke halaman berikutnya';
  hint.textContent = text; hint.className = 'cam-hint ' + cls;
  shutter.classList.toggle('ready', live.state === 'pas');
  if (live.auto && live.state === 'pas' && live.armed && stableFor >= 1500 && !shooting && now - live.lastShot > 1500) shoot(true);
}
function drawLive() {
  live.raf = requestAnimationFrame(drawLive);
  const c = $('#camOverlay');
  const dpr = window.devicePixelRatio || 1, cw = c.clientWidth, ch = c.clientHeight;
  if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, ch);
  if (!live.target) { live.shown = null; return; }
  live.shown = live.shown
    ? live.shown.map((p, i) => [p[0] + (live.target[i][0] - p[0]) * 0.35, p[1] + (live.target[i][1] - p[1]) * 0.35])
    : live.target.map((p) => p.slice());
  if (!live.vw) return;
  // video tampil dengan object-fit: cover
  const s = Math.max(cw / live.vw, ch / live.vh), ox = (cw - live.vw * s) / 2, oy = (ch - live.vh * s) / 2;
  const pts = live.shown.map(([x, y]) => [ox + x * live.vw * s, oy + y * live.vh * s]);
  const ok = live.state === 'pas';
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
  g.fillStyle = ok ? 'rgba(46,230,160,.2)' : 'rgba(255,255,255,.08)'; g.fill();
  g.lineJoin = 'round'; g.lineWidth = ok ? 4 : 2.5; g.strokeStyle = ok ? '#2ee6a0' : 'rgba(255,255,255,.9)';
  g.setLineDash(ok ? [] : [10, 8]); g.stroke(); g.setLineDash([]);
  pts.forEach(([x, y]) => { g.beginPath(); g.arc(x, y, ok ? 7 : 5, 0, Math.PI * 2); g.fillStyle = ok ? '#2ee6a0' : '#fff'; g.fill(); });
}

function markAuto() {
  $('#camAuto').classList.toggle('on', live.auto);
  $('#camAuto').setAttribute('aria-pressed', String(live.auto));
  $('#camAutoText').textContent = live.auto ? 'Otomatis: Nyala' : 'Otomatis: Mati';
}
$('#camAuto').addEventListener('click', () => {
  live.auto = !live.auto;
  try { localStorage.setItem('as.autoShot', live.auto ? '1' : '0'); } catch (e) {}
  markAuto();
  toast(live.auto ? 'Jepret otomatis nyala: foto diambil sendiri saat garis hijau stabil.' : 'Jepret otomatis mati', 2600);
});

let shooting = 0;
async function shoot(isAuto) {
  if (!cam.stream || shooting > 2) return;
  shooting++;
  const order = state.nextOrder++; // urutan dikunci saat jepret
  const rot = photoRot();          // arah HP saat jepret → hasil otomatis tegak
  live.armed = false; live.lastShot = performance.now();
  const hint = live.raw ? live.raw.map((p) => p.slice()) : null;
  live.shotQuad = hint;
  const hintAspect = live.vw / live.vh;
  const feedback = () => {
    const f = $('#camFlash'); f.classList.add('go'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('go')));
    if (navigator.vibrate) navigator.vibrate(isAuto ? [20, 60, 20] : 30);
  };
  if (!isAuto) feedback();
  try {
    const full = await grabPhoto();
    // sudut: deteksi ulang pada foto yang benar-benar diambil (latar belakang)
    let corners = await detectAsync(await smallBitmap(full, full.width, full.height), { prior: hint, allowBorder: false });
    const sameView = hint && Math.abs(full.width / full.height - hintAspect) < 0.03 * hintAspect;
    const cocok = corners && sameView && maxMove(corners, hint) <= 0.05;
    if (isAuto && !cocok) {
      // Jepret otomatis yang telat (mis. tangan sudah menutupi / halaman sudah dibalik): buang, coba lagi nanti.
      full.close && full.close();
      state.nextOrder = Math.max(state.nextOrder, order + 1);
      live.armed = true; live.shotQuad = null;
      shooting--;
      return;
    }
    if (isAuto) feedback();
    // Yang tersimpan harus sama dengan garis hijau yang terlihat: kalau hasilnya beda jauh, pakai garis di layar.
    if (sameView && !cocok) corners = hint;
    cam.count++;
    $('#camCount').textContent = cam.count; $('#camCount').hidden = false;
    setLastThumb(full, rot);
    await addPage(full, { corners, order, rot });
  } catch (e) { toast('Gagal mengambil foto: ' + e.message); }
  shooting--;
}
$('#camShutter').addEventListener('click', () => shoot(false));
$('#camClose').addEventListener('click', back);
$('#camDone').addEventListener('click', back);
$('#camTorch').addEventListener('click', async () => {
  try {
    cam.torch = !cam.torch;
    await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] });
    $('#camTorch').classList.toggle('on', cam.torch);
  } catch (e) { toast('Lampu tidak bisa dinyalakan'); }
});

async function addFiles(files, label) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
  if (!list.length) return;
  busy(true, `Menambahkan ${list.length} foto…`);
  let ok = 0;
  for (const f of list) { try { await addPage(f); ok++; } catch (e) { console.warn(e); } }
  busy(false);
  toast(ok === list.length ? `${ok} ${label} ditambahkan` : `${ok} dari ${list.length} foto berhasil ditambahkan`);
}
$('#btnCamera').addEventListener('click', openCamera);
$('#btnGallery').addEventListener('click', () => $('#inGallery').click());
$('#inCamera').addEventListener('change', (e) => { addFiles(e.target.files, 'foto'); e.target.value = ''; });
$('#inGallery').addEventListener('change', (e) => { addFiles(e.target.files, 'foto'); e.target.value = ''; });

/* ================= Editor halaman ================= */
const cv = $('#edCanvas');
const cx = cv.getContext('2d');
const ed = { p: null, bmp: null, corners: null, filter: 'cerah', newBlob: null, deleted: false, drag: -1, off: [0, 0], fit: null, preview: false, previewUrl: null };

async function openEditor(p) {
  busy(true, 'Membuka halaman…');
  try { ed.bmp = await decode(p.blob); } catch (e) { busy(false); toast('Foto tidak bisa dibuka'); return; }
  busy(false);
  Object.assign(ed, { p, corners: p.corners.map((c) => c.slice()), filter: p.filter, newBlob: null, deleted: false, drag: -1 });
  $('#edTitle').textContent = `Halaman ${state.pages.indexOf(p) + 1} dari ${state.pages.length}`;
  setPreview(false);
  markFilter();
  $('#editor').hidden = false;
  pushOverlay(closeEditor);
  edLayout(); edDraw();
}

function closeEditor() {
  const p = ed.p;
  $('#editor').hidden = true;
  if (p && !ed.deleted) {
    const changed = ed.newBlob || ed.filter !== p.filter || JSON.stringify(ed.corners) !== JSON.stringify(p.corners);
    if (changed) {
      if (ed.newBlob) { p.blob = ed.newBlob; p.w = ed.bmp.width; p.h = ed.bmp.height; }
      p.corners = ed.corners; p.filter = ed.filter; state.lastFilter = ed.filter;
      dbPut(p, !!ed.newBlob);
      const img = document.querySelector(`[data-id="${p.id}"] .thumb`); if (img) img.classList.add('loading');
      queueThumb(p);
    }
  }
  if (ed.bmp && ed.bmp.close) ed.bmp.close();
  ed.bmp = null; ed.p = null;
  if (ed.previewUrl) { URL.revokeObjectURL(ed.previewUrl); ed.previewUrl = null; }
}

function edLayout() {
  if (!ed.bmp) return;
  const r = $('#edStage').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
  const pad = 26;
  const s = Math.min((r.width - 2 * pad) / ed.bmp.width, (r.height - 2 * pad) / ed.bmp.height);
  ed.fit = { s, dpr, ox: (r.width - ed.bmp.width * s) / 2, oy: (r.height - ed.bmp.height * s) / 2, cw: r.width, ch: r.height };
}
const toScreen = ([x, y]) => [ed.fit.ox + x * ed.bmp.width * ed.fit.s, ed.fit.oy + y * ed.bmp.height * ed.fit.s];
const fromScreen = (sx, sy) => [clamp((sx - ed.fit.ox) / (ed.bmp.width * ed.fit.s), 0, 1), clamp((sy - ed.fit.oy) / (ed.bmp.height * ed.fit.s), 0, 1)];

function edDraw() {
  if (!ed.bmp || !ed.fit) return;
  const { s, dpr, ox, oy, cw, ch } = ed.fit;
  const bw = ed.bmp.width * s, bh = ed.bmp.height * s;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, cw, ch);
  cx.drawImage(ed.bmp, ox, oy, bw, bh);
  const pts = ed.corners.map(toScreen);
  // gelapkan area di luar dokumen
  cx.beginPath();
  cx.rect(ox, oy, bw, bh);
  cx.moveTo(pts[0][0], pts[0][1]); for (let i = 3; i >= 1; i--) cx.lineTo(pts[i][0], pts[i][1]); cx.closePath();
  cx.fillStyle = 'rgba(0,0,0,.5)'; cx.fill('evenodd');
  cx.beginPath(); pts.forEach((p, i) => (i ? cx.lineTo(p[0], p[1]) : cx.moveTo(p[0], p[1]))); cx.closePath();
  cx.lineWidth = 2.5; cx.strokeStyle = '#2ee6a0'; cx.stroke();
  pts.forEach((p, i) => {
    cx.beginPath(); cx.arc(p[0], p[1], ed.drag === i ? 15 : 12, 0, Math.PI * 2);
    cx.fillStyle = ed.drag === i ? 'rgba(46,230,160,.55)' : 'rgba(255,255,255,.35)'; cx.fill();
    cx.lineWidth = 3; cx.strokeStyle = '#2ee6a0'; cx.stroke();
  });
  if (ed.drag >= 0) drawLoupe(pts[ed.drag], ed.corners[ed.drag]);
}

function drawLoupe(sp, np) {
  const R = 62, zoom = 3;
  const left = sp[0] > ed.fit.cw / 2 || sp[1] > ed.fit.ch / 2;
  const lx = left ? R + 14 : ed.fit.cw - R - 14, ly = R + 14;
  const ix = np[0] * ed.bmp.width, iy = np[1] * ed.bmp.height;
  const half = R / (ed.fit.s * zoom);
  cx.save();
  cx.beginPath(); cx.arc(lx, ly, R, 0, Math.PI * 2); cx.closePath();
  cx.fillStyle = '#000'; cx.fill(); cx.clip();
  cx.drawImage(ed.bmp, ix - half, iy - half, half * 2, half * 2, lx - R, ly - R, R * 2, R * 2);
  cx.strokeStyle = '#2ee6a0'; cx.lineWidth = 1.5;
  cx.beginPath(); cx.moveTo(lx - 12, ly); cx.lineTo(lx + 12, ly); cx.moveTo(lx, ly - 12); cx.lineTo(lx, ly + 12); cx.stroke();
  cx.restore();
  cx.beginPath(); cx.arc(lx, ly, R, 0, Math.PI * 2); cx.lineWidth = 3; cx.strokeStyle = '#fff'; cx.stroke();
}

function pos(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
cv.addEventListener('pointerdown', (e) => {
  if (!ed.fit) return;
  const [x, y] = pos(e);
  let best = -1, bd = 48;
  ed.corners.map(toScreen).forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
  if (best < 0) return;
  const p = toScreen(ed.corners[best]);
  ed.drag = best; ed.off = [p[0] - x, p[1] - y];
  cv.setPointerCapture(e.pointerId);
  edDraw();
});
cv.addEventListener('pointermove', (e) => {
  if (ed.drag < 0) return;
  const [x, y] = pos(e);
  ed.corners[ed.drag] = fromScreen(x + ed.off[0], y + ed.off[1]);
  edDraw();
});
const endDrag = () => { if (ed.drag >= 0) { ed.drag = -1; edDraw(); } };
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => { if (!$('#editor').hidden) { edLayout(); edDraw(); } });

function markFilter() { document.querySelectorAll('#edFilters button').forEach((b) => b.classList.toggle('on', b.dataset.f === ed.filter)); }
$('#edFilters').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  ed.filter = b.dataset.f; markFilter();
  if (ed.preview) showPreview(); else toast('Filter dipilih. Tekan "Lihat hasil" untuk melihat.', 1800);
});

// n = 1: putar kanan (searah jarum jam), n = 3: putar kiri
async function edRotate(n) {
  if (!ed.bmp) return;
  busy(true, 'Memutar…');
  try {
    const b = ed.bmp;
    const c = rotateCanvas(b, n);
    const blob = await toBlob(c, 'image/jpeg', 0.92);
    const nb = await createImageBitmap(c);
    b.close && b.close();
    ed.bmp = nb;
    ed.newBlob = blob;
    ed.corners = rotateCorners(ed.corners, n);
    edLayout(); edDraw();
    if (ed.preview) await showPreview();
  } catch (e) { toast('Gagal memutar'); }
  busy(false);
}
$('#edRotateL').addEventListener('click', () => edRotate(3));
$('#edRotateR').addEventListener('click', () => edRotate(1));
$('#edFull').addEventListener('click', () => { ed.corners = FULL.map((c) => c.slice()); edDraw(); if (ed.preview) showPreview(); });
$('#edAuto').addEventListener('click', () => {
  const q = ed.bmp && Detect.detectCorners(ed.bmp);
  if (!q) { toast('Tepi dokumen tidak terdeteksi. Geser titik secara manual.', 3000); return; }
  ed.corners = q; edDraw();
  if (ed.preview) showPreview(); else toast('Sudut terdeteksi. Geser titik bila kurang pas.', 2200);
});

function setPreview(on) {
  ed.preview = on;
  $('#edPreview').hidden = !on;
  $('#edPreviewText').textContent = on ? 'Atur sudut' : 'Lihat hasil';
  $('#edHint').textContent = on ? 'Ini hasil halaman di PDF' : 'Sudut dideteksi otomatis. Geser titik bulat bila kurang pas.';
}
async function showPreview() {
  busy(true, 'Menyiapkan hasil…');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const c = renderPage(ed.bmp, ed.corners, ed.filter, 1400);
    const b = await toBlob(c, 'image/jpeg', 0.85);
    if (ed.previewUrl) URL.revokeObjectURL(ed.previewUrl);
    ed.previewUrl = URL.createObjectURL(b);
    $('#edPreview').src = ed.previewUrl;
    setPreview(true);
  } catch (e) { toast('Gagal membuat pratinjau'); }
  busy(false);
}
$('#edPreviewBtn').addEventListener('click', () => { if (ed.preview) setPreview(false); else showPreview(); });
$('#edDone').addEventListener('click', back);
$('#edDelete').addEventListener('click', async () => {
  const p = ed.p; if (!p) return;
  if (!confirm('Hapus halaman ini?')) return;
  ed.deleted = true;
  state.pages = state.pages.filter((x) => x !== p);
  if (p.thumb) URL.revokeObjectURL(p.thumb);
  renderGrid();
  dbDelete(p.id);
  back();
  toast('Halaman dihapus');
});

/* ================= PDF ================= */
async function buildPdf(pages, preset, onProgress) {
  const enc = new TextEncoder();
  const parts = []; let len = 0; const offsets = [];
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (num, write) => { offsets[num] = len; push(`${num} 0 obj\n`); write(); push('\nendobj\n'); };
  const n = pages.length;
  push('%PDF-1.4\n%âãÏÓ\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${n} >>`));
  for (let i = 0; i < n; i++) {
    onProgress && onProgress(i + 1, n);
    await new Promise((r) => setTimeout(r, 0));
    const p = pages[i];
    const bmp = await decode(p.blob);
    const c = renderPage(bmp, p.corners, p.filter, preset.max);
    bmp.close && bmp.close();
    const jpg = new Uint8Array(await (await toBlob(c, 'image/jpeg', preset.q)).arrayBuffer());
    const pw = 595.28, ph = +(pw * c.height / c.width).toFixed(2);
    const po = 3 + 3 * i, co = po + 1, io = po + 2;
    const stream = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
    obj(po, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${io} 0 R >> >> /Contents ${co} 0 R >>`));
    obj(co, () => push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
    obj(io, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
      push(jpg);
      push('\nendstream');
    });
  }
  const size = 3 + 3 * n;
  const xref = len;
  let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let k = 1; k < size; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

const pdf = { blob: null, quality: 'sedang', token: 0 };
function defaultName() {
  const d = new Date(), z = (v) => String(v).padStart(2, '0');
  return `Dokumen ${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}.${z(d.getMinutes())}`;
}
function fileName() {
  const raw = $('#pdfName').value.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-');
  return (raw || defaultName()) + '.pdf';
}
function markQuality() { document.querySelectorAll('#pdfQuality button').forEach((b) => b.classList.toggle('on', b.dataset.q === pdf.quality)); }

async function preparePdf() {
  const token = ++pdf.token;
  pdf.blob = null;
  $('#pdfShare').disabled = $('#pdfSave').disabled = true;
  const pages = state.pages.slice();
  try {
    const blob = await buildPdf(pages, PRESETS[pdf.quality], (i, n) => {
      if (token === pdf.token) $('#pdfInfo').textContent = `Menyiapkan halaman ${i} dari ${n}…`;
    });
    if (token !== pdf.token) return;
    pdf.blob = blob;
    $('#pdfInfo').textContent = `${pages.length} halaman · ${fmtSize(blob.size)} · siap dikirim`;
    $('#pdfShare').disabled = $('#pdfSave').disabled = false;
  } catch (e) {
    if (token === pdf.token) $('#pdfInfo').textContent = 'Gagal membuat PDF: ' + e.message;
  }
}

function openSheet() {
  if (!state.pages.length) return;
  $('#pdfName').value = defaultName();
  markQuality();
  $('#sheet').hidden = false;
  pushOverlay(() => { $('#sheet').hidden = true; pdf.token++; });
  preparePdf();
}
$('#btnExport').addEventListener('click', openSheet);
$('#pdfCancel').addEventListener('click', back);
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') back(); });
$('#pdfQuality').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.dataset.q === pdf.quality) return;
  pdf.quality = b.dataset.q; markQuality(); preparePdf();
});

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$('#pdfSave').addEventListener('click', () => {
  if (!pdf.blob) return;
  download(pdf.blob, fileName());
  toast('PDF disimpan ke folder Download');
});
$('#pdfShare').addEventListener('click', async () => {
  if (!pdf.blob) return;
  const name = fileName();
  const file = new File([pdf.blob], name, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name.replace(/\.pdf$/, '') });
    } catch (e) {
      if (e.name !== 'AbortError') toast('Gagal membagikan: ' + e.message);
    }
  } else {
    download(pdf.blob, name);
    toast('HP/browser ini tidak bisa kirim langsung. PDF disimpan ke Download, kirim lewat lampiran WhatsApp/Telegram.', 5000);
  }
});

/* ================= Mulai ================= */
(async function init() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
  const pages = await dbLoad();
  state.pages = pages;
  state.nextOrder = pages.reduce((m, p) => Math.max(m, p.order), 0) + 1;
  renderGrid();
  pages.forEach(queueThumb);
})();

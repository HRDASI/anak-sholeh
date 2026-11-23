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

/* ================= Deteksi sudut dokumen otomatis ================= */
// Cari kertas (area terang & tidak berwarna) terbesar, lalu ambil segi empat terbesar di dalam batasnya.
// Hasil: [tl, tr, br, bl] dalam 0..1, atau null bila tidak yakin.

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0, cnt = 0; const row = y * w;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w && x + r >= 0) { acc += src[row + x + r]; cnt++; }
      if (x - r - 1 >= 0) { acc -= src[row + x - r - 1]; cnt--; }
      if (x >= 0) tmp[row + x] = acc / cnt;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, cnt = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h && y + r >= 0) { acc += tmp[(y + r) * w + x]; cnt++; }
      if (y - r - 1 >= 0) { acc -= tmp[(y - r - 1) * w + x]; cnt--; }
      if (y >= 0) out[y * w + x] = acc / cnt;
    }
  }
  return out;
}
// erosi (keepAll=true) / dilasi (keepAll=false) dengan kotak (2r+1)
function morph(m, w, h, r, keepAll) {
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = m[i];
  const b = boxBlur(f, w, h, r), o = new Uint8Array(w * h);
  for (let i = 0; i < o.length; i++) o[i] = keepAll ? (b[i] > 0.999 ? 1 : 0) : (b[i] > 0.001 ? 1 : 0);
  return o;
}
function otsu(v, lo, hi) {
  const bins = 256, hist = new Float64Array(bins), k = (bins - 1) / (hi - lo);
  for (let i = 0; i < v.length; i++) hist[Math.round((v[i] - lo) * k)]++;
  let sum = 0; for (let i = 0; i < bins; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = 0, t = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = v.length - wB; if (!wF) break;
    sB += i * hist[i];
    const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; }
  }
  return lo + (t + 0.5) / k;
}
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function convexHull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
function polyArea(q) { let a = 0; for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p[0] * n[1] - n[0] * p[1]; } return Math.abs(a) / 2; }
// segi empat dengan luas (hampir) terbesar yang titiknya ada di hull
function maxAreaQuad(hull) {
  const n = hull.length;
  const pick = (f) => { let bi = 0, bv = -Infinity; hull.forEach((p, i) => { const v = f(p); if (v > bv) { bv = v; bi = i; } }); return bi; };
  let idx = [pick((p) => -p[0] - p[1]), pick((p) => p[0] - p[1]), pick((p) => p[0] + p[1]), pick((p) => p[1] - p[0])];
  idx = [...new Set(idx)].sort((a, b) => a - b);
  if (idx.length < 4) return null;
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    for (let k = 0; k < 4; k++) {
      const a = hull[idx[(k + 3) % 4]], b = hull[idx[(k + 1) % 4]];
      let j = (idx[(k + 3) % 4] + 1) % n, best = idx[k], bestV = Math.abs(cross(a, b, hull[idx[k]]));
      while (j !== idx[(k + 1) % 4]) {
        const v = Math.abs(cross(a, b, hull[j]));
        if (v > bestV + 1e-9) { bestV = v; best = j; }
        j = (j + 1) % n;
      }
      if (best !== idx[k]) { idx[k] = best; changed = true; }
    }
    if (!changed) break;
  }
  return idx.map((i) => hull[i]);
}
function orderCorners(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const s = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0; s.forEach((p, i) => { if (p[0] + p[1] < s[start][0] + s[start][1]) start = i; });
  return [0, 1, 2, 3].map((i) => s[(start + i) % 4]);
}

function detectCorners(src) {
  try {
    const W = src.width, H = src.height;
    const sc = Math.min(1, 360 / Math.max(W, H));
    const w = Math.max(16, Math.round(W * sc)), h = Math.max(16, Math.round(H * sc));
    const c = makeCanvas(w, h); const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, n = w * h;
    let v = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = d[j], g = d[j + 1], b = d[j + 2];
      v[i] = 0.299 * r + 0.587 * g + 0.114 * b - 0.8 * (Math.max(r, g, b) - Math.min(r, g, b));
    }
    v = boxBlur(v, w, h, 2);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
    if (hi - lo < 30) return null;
    const t = otsu(v, lo, hi);
    let m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = v[i] > t ? 1 : 0;
    m = morph(morph(m, w, h, 2, true), w, h, 2, false); // opening: putus sambungan tipis

    // komponen terang terbesar
    const lab = new Int32Array(n), stack = new Int32Array(n);
    let bestLab = 0, bestSize = 0, cur = 0;
    for (let s = 0; s < n; s++) {
      if (!m[s] || lab[s]) continue;
      cur++; let sp = 0, size = 0; stack[sp++] = s; lab[s] = cur;
      while (sp) {
        const p = stack[--sp]; size++;
        const px = p % w;
        if (px > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack[sp++] = p - 1; }
        if (px < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack[sp++] = p + 1; }
        if (p >= w && m[p - w] && !lab[p - w]) { lab[p - w] = cur; stack[sp++] = p - w; }
        if (p < n - w && m[p + w] && !lab[p + w]) { lab[p + w] = cur; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestLab = cur; }
    }
    if (bestSize < 0.1 * n) return null;

    // bila komponen menutupi sebagian besar tepi foto, kemungkinan itu latar / kertas memenuhi foto
    let edge = 0, edgeOn = 0;
    for (let xx = 0; xx < w; xx++) { edge += 2; edgeOn += (lab[xx] === bestLab) + (lab[(h - 1) * w + xx] === bestLab); }
    for (let yy = 0; yy < h; yy++) { edge += 2; edgeOn += (lab[yy * w] === bestLab) + (lab[yy * w + w - 1] === bestLab); }
    if (edgeOn / edge > 0.5) return null;

    const pts = [];
    for (let yy = 0; yy < h; yy++) {
      let a = -1, b = -1;
      for (let xx = 0; xx < w; xx++) if (lab[yy * w + xx] === bestLab) { if (a < 0) a = xx; b = xx; }
      if (a >= 0) { pts.push([a, yy]); pts.push([b + 1, yy]); pts.push([a, yy + 1]); pts.push([b + 1, yy + 1]); }
    }
    const hull = convexHull(pts);
    if (hull.length < 4) return null;
    const q = maxAreaQuad(hull);
    if (!q) return null;
    const area = polyArea(q) / n;
    if (area < 0.1 || area > 0.97) return null;
    // sudut terlalu lancip = bukan dokumen
    const oc = orderCorners(q);
    for (let i = 0; i < 4; i++) {
      const a = oc[(i + 3) % 4], b = oc[i], c2 = oc[(i + 1) % 4];
      const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c2[0] - b[0], c2[1] - b[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-9);
      if (Math.abs(cos) > 0.75) return null; // di luar ~41°..139°
    }
    return oc.map(([px, py]) => [clamp(px / w, 0, 1), clamp(py / h, 0, 1)]);
  } catch (e) { console.warn('deteksi gagal', e); return null; }
}

/* ================= Halaman ================= */
async function addPage(fileOrBlob) {
  const order = state.nextOrder++;
  const bmp = await decode(fileOrBlob);
  const s = Math.min(1, MAX_STORE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  const auto = detectCorners(c);
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
  $('#camCount').textContent = '0 foto';
  $('#camLast').hidden = true;
  const caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
  $('#camTorch').hidden = !caps.torch;
  $('#camTorch').classList.remove('on');
  try { cam.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); } catch (e) {}
  const v = $('#camVideo'); v.srcObject = cam.stream;
  $('#camera').hidden = false;
  pushOverlay(closeCamera);
}

function closeCamera() {
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = cam.track = null;
  $('#camVideo').srcObject = null;
  $('#camera').hidden = true;
  if (cam.count) toast(`${cam.count} foto ditambahkan. Ketuk halaman untuk merapikan.`);
}

async function grabPhoto() {
  const v = $('#camVideo');
  const vw = v.videoWidth, vh = v.videoHeight;
  if ((!vw || Math.max(vw, vh) < 1900) && 'ImageCapture' in window) {
    try {
      const ic = new ImageCapture(cam.track);
      return await Promise.race([
        ic.takePhoto(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);
    } catch (e) { console.warn('takePhoto gagal, pakai frame video', e); }
  }
  if (!vw) throw new Error('Kamera belum siap');
  const c = makeCanvas(vw, vh);
  c.getContext('2d').drawImage(v, 0, 0, vw, vh);
  return toBlob(c, 'image/jpeg', 0.92);
}

let shooting = 0;
$('#camShutter').addEventListener('click', async () => {
  if (!cam.stream || shooting > 2) return;
  shooting++;
  const f = $('#camFlash'); f.classList.add('go'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('go')));
  if (navigator.vibrate) navigator.vibrate(30);
  try {
    const blob = await grabPhoto();
    cam.count++;
    $('#camCount').textContent = `${cam.count} foto`;
    const last = $('#camLast');
    if (last.src) URL.revokeObjectURL(last.src);
    last.src = URL.createObjectURL(blob); last.hidden = false;
    await addPage(blob);
  } catch (e) { toast('Gagal mengambil foto: ' + e.message); }
  shooting--;
});
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

$('#edRotate').addEventListener('click', async () => {
  if (!ed.bmp) return;
  busy(true, 'Memutar…');
  try {
    const b = ed.bmp;
    const c = makeCanvas(b.height, b.width);
    const x = c.getContext('2d');
    x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(b, 0, 0);
    const blob = await toBlob(c, 'image/jpeg', 0.92);
    const nb = await createImageBitmap(c);
    b.close && b.close();
    ed.bmp = nb;
    ed.newBlob = blob;
    const r = ([px, py]) => [1 - py, px];
    const k = ed.corners;
    ed.corners = [r(k[3]), r(k[0]), r(k[1]), r(k[2])];
    edLayout(); edDraw();
    if (ed.preview) await showPreview();
  } catch (e) { toast('Gagal memutar'); }
  busy(false);
});
$('#edFull').addEventListener('click', () => { ed.corners = FULL.map((c) => c.slice()); edDraw(); if (ed.preview) showPreview(); });
$('#edAuto').addEventListener('click', () => {
  const q = ed.bmp && detectCorners(ed.bmp);
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

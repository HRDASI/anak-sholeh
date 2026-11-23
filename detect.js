/* Anak Sholeh: deteksi sudut dokumen.
   Dipakai di halaman (window.Detect) dan di Web Worker kamera (self.Detect). */
(function (root) {
'use strict';
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}

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

function detectByBrightness(src) {
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

// ---- Deteksi utama: cari 4 garis lurus panjang (Hough) yang membentuk segi empat dengan tepi terkuat ----
function edgeMap(src, maxDim) {
  const W = src.width, H = src.height;
  const sc = Math.min(1, maxDim / Math.max(W, H));
  const w = Math.max(16, Math.round(W * sc)), h = Math.max(16, Math.round(H * sc));
  const c = makeCanvas(w, h); const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data, n = w * h;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0, j = 0; i < n; i++, j += 4) { ch[0][i] = d[j]; ch[1][i] = d[j + 1]; ch[2][i] = d[j + 2]; }
  for (let k = 0; k < 3; k++) ch[k] = boxBlur(boxBlur(ch[k], w, h, 1), w, h, 1);
  // gradien warna: per piksel pakai kanal dengan gradien terbesar
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let xx = 1; xx < w - 1; xx++) {
    const i = y * w + xx; let best = -1, bx = 0, by = 0;
    for (let k = 0; k < 3; k++) {
      const a = ch[k];
      const sx = (a[i - w + 1] + 2 * a[i + 1] + a[i + w + 1]) - (a[i - w - 1] + 2 * a[i - 1] + a[i + w - 1]);
      const sy = (a[i + w - 1] + 2 * a[i + w] + a[i + w + 1]) - (a[i - w - 1] + 2 * a[i - w] + a[i - w + 1]);
      const m = sx * sx + sy * sy;
      if (m > best) { best = m; bx = sx; by = sy; }
    }
    gx[i] = bx; gy[i] = by; mag[i] = Math.sqrt(best);
  }
  // ambang dari persentil
  const sample = []; for (let i = 0; i < n; i += 7) sample.push(mag[i]);
  sample.sort((a, b) => a - b);
  const T = Math.max(25, 0.3 * sample[Math.floor(sample.length * 0.98)]);
  return { w, h, gx, gy, mag, T };
}

function houghLines(E) {
  const { w, h, gx, gy, mag, T } = E;
  const NT = 180, diag = Math.ceil(Math.hypot(w, h)), NR = 2 * diag + 1;
  const acc = new Float32Array(NT * NR);
  const cosT = new Float32Array(NT), sinT = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { cosT[t] = Math.cos(t * Math.PI / NT); sinT[t] = Math.sin(t * Math.PI / NT); }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, m = mag[i];
    if (m < T) continue;
    // non-max suppression searah gradien (tepi tipis)
    const ux = gx[i] / m, uy = gy[i] / m;
    const xa = Math.round(x + ux), ya = Math.round(y + uy), xb = Math.round(x - ux), yb = Math.round(y - uy);
    if (mag[ya * w + xa] > m || mag[yb * w + xb] > m) continue;
    let th = Math.atan2(uy, ux); if (th < 0) th += Math.PI; if (th >= Math.PI) th -= Math.PI;
    const t0 = Math.round(th / Math.PI * NT);
    const wt = Math.min(2, m / T);
    for (let dt = -3; dt <= 3; dt++) {
      const t = (t0 + dt + NT) % NT;
      const r = Math.round(x * cosT[t] + y * sinT[t]) + diag;
      acc[t * NR + r] += wt;
    }
  }
  // puncak lokal
  const minVotes = 0.12 * Math.min(w, h);
  const peaks = [];
  for (let t = 0; t < NT; t++) for (let r = 2; r < NR - 2; r++) {
    const v = acc[t * NR + r]; if (v < minVotes) continue;
    let isMax = true;
    for (let dt = -2; dt <= 2 && isMax; dt++) for (let dr = -3; dr <= 3; dr++) {
      if (!dt && !dr) continue;
      const tt = (t + dt + NT) % NT, rr = r + dr;
      if (rr < 0 || rr >= NR) continue;
      if (acc[tt * NR + rr] > v) { isMax = false; break; }
    }
    if (isMax) peaks.push({ t, r: r - diag, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  const lines = [];
  for (const p of peaks) {
    const dup = lines.some((q) => {
      const dt = Math.abs(p.t - q.t);
      if (dt <= 4) return Math.abs(p.r - q.r) <= 7;
      if (dt >= NT - 4) return Math.abs(p.r + q.r) <= 7; // 0° ~ 180° dengan rho terbalik
      return false;
    });
    if (dup) continue;
    lines.push({ th: p.t * Math.PI / NT, r: p.r, v: p.v });
    if (lines.length >= 40) break;
  }
  return lines;
}

function intersect(a, b) {
  const c1 = Math.cos(a.th), s1 = Math.sin(a.th), c2 = Math.cos(b.th), s2 = Math.sin(b.th);
  const det = c1 * s2 - s1 * c2;
  if (Math.abs(det) < 1e-6) return null;
  return [(a.r * s2 - s1 * b.r) / det, (c1 * b.r - a.r * c2) / det];
}

// seberapa banyak titik di sepanjang sisi a→b yang benar-benar berupa tepi searah
function edgeSupport(E, a, b) {
  const { w, h, gx, gy, mag, T } = E;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 8) return 0;
  const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
  const N = Math.max(16, Math.round(len / 3));
  let hit = 0, tot = 0;
  for (let s = 0; s < N; s++) {
    const t = 0.06 + 0.88 * (s + 0.5) / N;
    const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
    if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue;
    tot++;
    for (let k = -2; k <= 2; k++) {
      const qx = Math.round(px + nx * k), qy = Math.round(py + ny * k);
      if (qx < 1 || qy < 1 || qx >= w - 1 || qy >= h - 1) continue;
      const i = qy * w + qx, m = mag[i];
      if (m < T * 0.8) continue;
      if (Math.abs((gx[i] * nx + gy[i] * ny) / m) > 0.88) { hit++; break; }
    }
  }
  return tot < N * 0.5 ? -1 : hit / tot; // -1 = sisi sebagian besar di luar foto
}

function quadOk(q, w, h) {
  const mx = 0.04 * w, my = 0.04 * h;
  for (const [x, y] of q) if (x < -mx || y < -my || x > w + mx || y > h + my) return false;
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    if (cross(a, b, c) <= 0) return false; // harus cembung (searah jarum jam di layar)
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-9);
    if (Math.abs(cos) > 0.7) return false; // sudut di luar ~45°..135°
  }
  return true;
}

function onBorder(a, b, w, h) {
  const e = 4;
  return (a[0] < e && b[0] < e) || (a[1] < e && b[1] < e) || (a[0] > w - 1 - e && b[0] > w - 1 - e) || (a[1] > h - 1 - e && b[1] > h - 1 - e);
}

function scoreQuad(E, q) {
  const { w, h } = E;
  const area = polyArea(q) / (w * h);
  if (area < 0.12) return null;
  let sum = 0, minS = 1, real = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    let s;
    if (onBorder(a, b, w, h)) s = 0.55;      // sisi = tepi foto (dokumen terpotong bingkai)
    else {
      s = edgeSupport(E, a, b);
      if (s < 0) s = 0.5; else real++;
    }
    sum += s; if (s < minS) minS = s;
  }
  if (minS < 0.35 || real < 2) return null;
  return { score: (sum / 4) * Math.sqrt(Math.min(area, 0.95)), area, minS, border: 4 - real };
}

// Haluskan: tiap sisi dicocokkan ulang ke titik tepi terdekat (sub-piksel), lalu sudut = perpotongan sisi.
function refineQuad(E, q) {
  const { w, h, gx, gy, mag, T } = E;
  const at = (x, y, nx, ny) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return 0;
    const i = yi * w + xi, m = mag[i];
    return m && Math.abs((gx[i] * nx + gy[i] * ny) / m) > 0.85 ? m : 0;
  };
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s], b = q[(s + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    const fallback = { nx, ny, c: nx * a[0] + ny * a[1] };
    if (onBorder(a, b, w, h)) { lines.push(fallback); continue; }
    const N = Math.max(12, Math.round(len / 2)), pts = [];
    for (let k = 0; k < N; k++) {
      const t = 0.08 + 0.84 * (k + 0.5) / N;
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      let bm = 0, bo = 0;
      for (let o = -3; o <= 3; o++) { const m = at(px + nx * o, py + ny * o, nx, ny); if (m > bm) { bm = m; bo = o; } }
      if (bm < T * 0.8) continue;
      const m0 = at(px + nx * (bo - 1), py + ny * (bo - 1), nx, ny), m2 = at(px + nx * (bo + 1), py + ny * (bo + 1), nx, ny);
      const den = m0 - 2 * bm + m2;
      const off = bo + (den < 0 ? clamp(0.5 * (m0 - m2) / den, -0.5, 0.5) : 0);
      pts.push([px + nx * off, py + ny * off]);
    }
    if (pts.length < N * 0.35) { lines.push(fallback); continue; }
    // garis terbaik (total least squares)
    let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0; for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // arah garis
    let lnx = -Math.sin(ang), lny = Math.cos(ang);
    if (lnx * nx + lny * ny < 0) { lnx = -lnx; lny = -lny; }
    if (lnx * nx + lny * ny < 0.97) { lines.push(fallback); continue; } // bergeser terlalu jauh → abaikan
    lines.push({ nx: lnx, ny: lny, c: lnx * mx + lny * my });
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const L1 = lines[(i + 3) % 4], L2 = lines[i];
    const det = L1.nx * L2.ny - L1.ny * L2.nx;
    if (Math.abs(det) < 1e-6) return q;
    out.push([(L1.c * L2.ny - L1.ny * L2.c) / det, (L1.nx * L2.c - L1.c * L2.nx) / det]);
  }
  for (let i = 0; i < 4; i++) if (Math.hypot(out[i][0] - q[i][0], out[i][1] - q[i][1]) > 8) return q;
  return quadOk(out, w, h) ? out : q;
}

// Profil satu garis: untuk tiap titik di sepanjang garis, apakah ada tepi searah (prefix sum → cek sisi O(1)).
function lineProfile(E, l) {
  const { w, h, gx, gy, mag, T } = E;
  const nx = Math.cos(l.th), ny = Math.sin(l.th), dx = -ny, dy = nx;
  const x0 = l.r * nx, y0 = l.r * ny;
  const D = Math.ceil(Math.hypot(w, h)), n = 2 * D + 1;
  const hit = new Uint16Array(n + 1), ins = new Uint16Array(n + 1);
  for (let k = 0; k < n; k++) {
    const t = k - D, px = x0 + dx * t, py = y0 + dy * t;
    let hv = 0, iv = 0;
    if (px >= 1 && py >= 1 && px < w - 1 && py < h - 1) {
      iv = 1;
      for (let o = -2; o <= 2; o++) {
        const qx = Math.round(px + nx * o), qy = Math.round(py + ny * o);
        if (qx < 1 || qy < 1 || qx >= w - 1 || qy >= h - 1) continue;
        const i = qy * w + qx, m = mag[i];
        if (m < T * 0.8) continue;
        if (Math.abs((gx[i] * nx + gy[i] * ny) / m) > 0.88) { hv = 1; break; }
      }
    }
    hit[k + 1] = hit[k] + hv; ins[k + 1] = ins[k] + iv;
  }
  return { x0, y0, dx, dy, D, n, hit, ins };
}
function segSupport(P, a, b) {
  let ta = (a[0] - P.x0) * P.dx + (a[1] - P.y0) * P.dy, tb = (b[0] - P.x0) * P.dx + (b[1] - P.y0) * P.dy;
  if (ta > tb) { const t = ta; ta = tb; tb = t; }
  const len = tb - ta; if (len < 8) return 0;
  const k0 = clamp(Math.round(ta + 0.06 * len) + P.D, 0, P.n), k1 = clamp(Math.round(tb - 0.06 * len) + P.D, 0, P.n);
  const tot = k1 - k0; if (tot <= 0) return 0;
  const ins = P.ins[k1] - P.ins[k0];
  if (ins < tot * 0.5) return -1; // sisi sebagian besar di luar foto
  return (P.hit[k1] - P.hit[k0]) / ins;
}

// Dukungan tepi per sepertiga sisi: tepi asli ada di sepanjang sisi, bukan hanya sebagian.
function segSupport3(P, a, b) {
  let ta = (a[0] - P.x0) * P.dx + (a[1] - P.y0) * P.dy, tb = (b[0] - P.x0) * P.dx + (b[1] - P.y0) * P.dy;
  if (ta > tb) { const t = ta; ta = tb; tb = t; }
  const len = tb - ta; if (len < 8) return [0, 0];
  const k0 = clamp(Math.round(ta + 0.06 * len) + P.D, 0, P.n), k1 = clamp(Math.round(tb - 0.06 * len) + P.D, 0, P.n);
  const tot = k1 - k0; if (tot <= 0) return [0, 0];
  const ins = P.ins[k1] - P.ins[k0];
  if (ins < tot * 0.5) return [-1, -1];
  let mn = 1;
  for (let s = 0; s < 3; s++) {
    const a0 = k0 + Math.round(tot * s / 3), a1 = k0 + Math.round(tot * (s + 1) / 3);
    const i3 = P.ins[a1] - P.ins[a0];
    if (i3 < (a1 - a0) * 0.5) continue; // bagian ini di luar foto
    const v = (P.hit[a1] - P.hit[a0]) / i3; if (v < mn) mn = v;
  }
  return [(P.hit[k1] - P.hit[k0]) / ins, mn];
}

// opts.prior: sudut hasil sebelumnya (0..1) → kandidat yang dekat diberi prioritas (garis tidak loncat-loncat)
function detectByLines(src, opts = {}) {
  const E = edgeMap(src, opts.maxDim || 480);
  const { w, h } = E;
  const lines = houghLines(E);
  const H = [], V = [];
  for (const l of lines) {
    const deg = l.th * 180 / Math.PI;
    (deg >= 45 && deg < 135 ? H : V).push(l);
  }
  const Hs = H.slice(0, 20), Vs = V.slice(0, 20);
  // tepi foto juga boleh jadi sisi (dokumen terpotong)
  Hs.push({ th: Math.PI / 2, r: 0, border: 1 }, { th: Math.PI / 2, r: h - 1, border: 1 });
  Vs.push({ th: 0, r: 0, border: 1 }, { th: 0, r: w - 1, border: 1 });
  for (const l of Hs.concat(Vs)) if (!l.border) l.P = lineProfile(E, l);
  const X = Hs.map((a) => Vs.map((c) => intersect(a, c)));
  const prior = opts.prior;
  const cands = [];
  // [dukungan rata-rata, sisi nyata?, dukungan terlemah per sepertiga]
  // Tepi foto hanya pilihan terakhir (nilai rendah), supaya kotak tidak "lari" ke pinggir layar.
  const side = (l, a, b) => {
    if (l.border) return [0.3, 0, 1];
    const [s, t3] = segSupport3(l.P, a, b);
    return s < 0 ? [0.5, 0, 1] : [s, 1, t3];
  };
  for (let a = 0; a < Hs.length; a++) for (let b = a + 1; b < Hs.length; b++) {
    for (let c = 0; c < Vs.length; c++) for (let d = c + 1; d < Vs.length; d++) {
      const pac = X[a][c], pad = X[a][d], pbd = X[b][d], pbc = X[b][c];
      if (!pac || !pad || !pbd || !pbc) continue;
      // cek murah dulu (luas, kekuatan tepi), baru cek bentuk
      const area = polyArea([pac, pad, pbd, pbc]) / (w * h);
      if (area < 0.12) continue;
      const ss = [side(Hs[a], pac, pad), side(Hs[b], pbc, pbd), side(Vs[c], pac, pbc), side(Vs[d], pad, pbd)];
      let sum = 0, minS = 1, real = 0, min3 = 1;
      for (const [s, r, t3] of ss) { sum += s; if (r && s < minS) minS = s; if (r && t3 < min3) min3 = t3; real += r; }
      // maksimal 1 sisi tepi foto; tiap sisi nyata harus bertepi di pangkal, tengah, dan ujungnya
      // (menolak kotak rakitan dari garis benda lain, mis. sisi laptop yang diperpanjang menembus buku)
      // opts.allowBorder === false (kamera): dokumen harus utuh di layar, tepi foto tidak boleh jadi sisi
      if (minS < 0.35 || real < (opts.allowBorder === false ? 4 : 3) || min3 < 0.35) continue;
      const q = orderCorners([pac, pad, pbd, pbc]);
      if (!quadOk(q, w, h)) continue;
      // bentuk masuk akal: sisi terpendek ≥ 20% sisi terpanjang (tolak kotak kurus dari garis isi halaman)
      const sl = [0, 1, 2, 3].map((i) => Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]));
      if (Math.min(...sl) < 0.2 * Math.max(...sl)) continue;
      let score = (sum / 4) * Math.pow(Math.min(area, 0.95), 0.3), near = false; // bonus luas dikurangi
      if (prior) {
        let mv = 0;
        for (let i = 0; i < 4; i++) mv = Math.max(mv, Math.hypot(q[i][0] / w - prior[i][0], q[i][1] / h - prior[i][1]));
        if (mv < 0.05) { score *= 1 + 0.4 * (1 - mv / 0.05); near = true; } // makin dekat, makin diutamakan
      }
      cands.push({ score, area, minS, border: 4 - real, q, near });
    }
  }
  if (!cands.length) return null;
  const top = cands.reduce((m, c) => (c.score > m.score ? c : m));
  let best = top;
  // skor hampir sama → pilih yang paling luar (tepi kertas, bukan bingkai gambar di dalamnya).
  // Tidak dipakai bila hasil sudah "terkunci" dekat posisi sebelumnya (supaya garis tidak loncat).
  if (!top.near) {
    for (const c of cands) {
      if (c.score >= top.score * 0.96 && c.border <= top.border && c.minS >= Math.min(0.6, top.minS - 0.1) && c.area > best.area) best = c;
    }
  }
  return { E, q: refineQuad(E, best.q).map(([x, y]) => [clamp(x / w, 0, 1), clamp(y / h, 0, 1)]), score: best.score };
}

function detectCorners(src) {
  try {
    const r = detectByLines(src);
    if (r) return r.q;
    // cadangan: metode terang/gelap, hanya dipakai kalau tepinya juga terbukti kuat
    const q = detectByBrightness(src);
    if (!q) return null;
    const E = edgeMap(src, 480);
    const qq = q.map(([x, y]) => [x * E.w, y * E.h]);
    const s = scoreQuad(E, qq);
    return s && s.minS >= 0.5 ? q : null;
  } catch (e) { console.warn('deteksi gagal', e); return null; }
}

root.Detect = { detectCorners, detectByLines, orderCorners };
})(typeof self !== 'undefined' ? self : window);

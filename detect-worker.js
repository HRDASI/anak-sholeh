// Worker: deteksi sudut di latar belakang supaya tampilan kamera tetap mulus.
importScripts('detect.js');
self.onmessage = (e) => {
  const { id, bmp, opts } = e.data;
  let q = null;
  try { const r = self.Detect.detectByLines(bmp, opts || {}); if (r) q = r.q; } catch (err) { /* abaikan */ }
  try { bmp.close(); } catch (err) { /* abaikan */ }
  self.postMessage({ id, q });
};

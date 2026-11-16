// 由 TDX Shape 下載檔產生 taichung-shapes.js (子路線|方向 → encoded polyline，Douglas-Peucker 簡化)
// 用法：OUT=tools/shape_all.json node tools/probe.js '/v2/Bus/Shape/City/Taichung?$format=JSON'
//       node tools/mk_shapes.js [簡化誤差公尺，預設 4，目前檔案用 3]
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
global.window = {};
require(path.join(ROOT, 'taichung-network.js'));
const N = window.TXG_NET;
const js = JSON.parse(fs.readFileSync(path.join(__dirname, 'shape_all.json'), 'utf8'));
const TOL = +(process.argv[2] || 4); // 公尺
function parse(g) { return g.replace(/^[A-Z]+\s*\(+|\)+$/g, '').split(/\)\s*,\s*\(/).map(p => p.split(',').map(q => { const [x, y] = q.trim().split(/\s+/).map(Number); return [y, x]; })); }
function dp(pts) {
  if (pts.length < 3) return pts;
  const k = [1, Math.cos(24.15 * Math.PI / 180)].map(v => v * 111000);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) { const [a, b] = st.pop(); const A = pts[a], B = pts[b];
    const bx = (B[1] - A[1]) * k[1], by = (B[0] - A[0]) * k[0], L2 = bx * bx + by * by;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) { const px = (pts[i][1] - A[1]) * k[1], py = (pts[i][0] - A[0]) * k[0];
      let t = L2 ? (px * bx + py * by) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - t * bx, py - t * by); if (d > md) { md = d; mi = i; } }
    if (md > TOL) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
  return pts.filter((_, i) => keep[i]);
}
function enc(pts) { let s = '', la = 0, ln = 0; const e = v => { v = v < 0 ? ~(v << 1) : v << 1; let o = ''; while (v >= 0x20) { o += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return o + String.fromCharCode(v + 63); };
  pts.forEach(([a, b]) => { const A = Math.round(a * 1e5), B = Math.round(b * 1e5); s += e(A - la) + e(B - ln); la = A; ln = B; }); return s; }
const out = {}; let nPts = 0, nRaw = 0;
js.forEach(x => { if (!x.Geometry) return; const sub = (x.SubRouteName && x.SubRouteName.Zh_tw) || x.RouteName.Zh_tw;
  const key = sub + '|' + (x.Direction ?? 'any');
  const lines = parse(x.Geometry); nRaw += lines.reduce((a, l) => a + l.length, 0);
  const e = lines.map(l => { const s = dp(l); nPts += s.length; return enc(s); });
  out[key] = (out[key] || []).concat(e); });
const subs = new Set(N.routes.map(r => r[0] + '|' + r[2]));
const miss = [...subs].filter(k => !out[k] && !out[k.split('|')[0] + '|any']);
console.log('shapes', Object.keys(out).length, 'routes', subs.size, 'missing', miss.length, miss.slice(0, 30).join(' '), 'pts', nRaw, '->', nPts);
const txt = '// 由 TDX Bus Shape/City/Taichung 產生 (' + new Date().toISOString().slice(0, 10) + ')：子路線|方向 → Google encoded polyline 陣列 (Douglas-Peucker ' + TOL + ' m)\nwindow.TXG_SHAPES = ' + JSON.stringify(out) + ';\n';
fs.writeFileSync(path.join(ROOT, 'taichung-shapes.js'), txt);
console.log('bytes', txt.length);

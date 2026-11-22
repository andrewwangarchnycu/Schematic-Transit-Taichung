// 路線群組靜態檔 data/groups.json：查詢頁「路線」分頁的群組按鈕 (例：藍線) 一鍵載入多選路線
//   規則：參考線 (GeoJSON 中指定名稱的 LineString) 兩側 BUF m 內，被公車線形覆蓋的參考線長度 ≥ MIN m 才納入
//     - 公車線形用 taichung-shapes.js (TDX Bus Shape 預先產生)；沒有線形的子路線改用站牌連線；不呼叫任何 API
//     - 子路線任一方向符合即納入；多選放重疊較長的方向
//     - 依子路線名稱 (數字) 由小到大排序
//   用法：node tools/mk_groups.js   (路網或線形更新後重跑)
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'groups.json');
const GROUPS = [
    { id: 'blue', name: '藍線', desc: '臺中捷運藍線 (規劃) 沿線', color: '#1f6fd1',
      src: path.join(ROOT, '..', 'metro route', 'BlueLine.geojson'), feature: '藍線', buf: 300, min: 3000 }
];

const win = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'taichung-network.js'), 'utf8') + ';' + fs.readFileSync(path.join(ROOT, 'taichung-shapes.js'), 'utf8'), { window: win });
const NET = win.TXG_NET, SHAPES = win.TXG_SHAPES || {};
const STOPS = NET.stops.map(([, , lat, lng]) => [lat, lng]);
const ROUTES = NET.routes.map(([sub, route, dir, seq]) => ({ sub, route, dir, seq }));

function decPoly(str) {
    let i = 0, la = 0, ln = 0; const out = [];
    const nx = () => { let b, sh = 0, r = 0; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
    while (i < str.length) { la += nx(); ln += nx(); out.push([la / 1e5, ln / 1e5]); }
    return out;
}
// 臺中緯度的近似平面座標 (m)，與前端距離計算相同係數
const KX = 101700, KY = 110900;
const meters = (a, b) => Math.hypot((b[1] - a[1]) * KX, (b[0] - a[0]) * KY);
function distSeg(p, a, b) {
    const ax = (a[1] - p[1]) * KX, ay = (a[0] - p[0]) * KY, bx = (b[1] - p[1]) * KX, by = (b[0] - p[0]) * KY;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
}
// 參考線每 25 m 取樣一點，每點代表前一段長度
function densify(line, step = 25) {
    const out = [];
    for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i], d = meters(a, b), n = Math.max(1, Math.ceil(d / step));
        for (let k = 1; k <= n; k++) out.push({ p: [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], w: d / n });
    }
    return out;
}
// 公車線形各段 (含外框) 先算好，加速最近距離
function segsOf(polys, buf) {
    const segs = [], dLat = buf / KY, dLng = buf / KX;
    for (const pl of polys) for (let i = 1; i < pl.length; i++) {
        const a = pl[i - 1], b = pl[i];
        segs.push({ a, b, s: Math.min(a[0], b[0]) - dLat, n: Math.max(a[0], b[0]) + dLat, w: Math.min(a[1], b[1]) - dLng, e: Math.max(a[1], b[1]) + dLng });
    }
    return segs;
}
function covered(samples, segs, buf) {
    let len = 0;
    for (const { p, w } of samples) {
        for (const g of segs) {
            if (p[0] < g.s || p[0] > g.n || p[1] < g.w || p[1] > g.e) continue;
            if (distSeg(p, g.a, g.b) <= buf) { len += w; break; }
        }
    }
    return len;
}

const r5 = v => Math.round(v * 1e5) / 1e5;
const out = { at: new Date().toISOString(), net: NET.gen, groups: [] };
for (const G of GROUPS) {
    const gj = JSON.parse(fs.readFileSync(G.src, 'utf8'));
    const f = (gj.features || []).find(x => x.properties && x.properties.Name === G.feature && x.geometry && x.geometry.type === 'LineString');
    if (!f) throw new Error(`${G.src} 找不到名稱為「${G.feature}」的 LineString`);
    const line = f.geometry.coordinates.map(c => [c[1], c[0]]);
    const samples = densify(line), total = samples.reduce((s, x) => s + x.w, 0);
    const best = new Map();   // sub → { dir, cov }
    let noShape = 0;
    for (const r of ROUTES) {
        const e = SHAPES[r.sub + '|' + r.dir] || SHAPES[r.sub + '|any'];
        if (!e) noShape++;
        const polys = e ? e.map(decPoly) : [r.seq.map(si => STOPS[si])];
        const cov = covered(samples, segsOf(polys, G.buf), G.buf);
        if (cov >= G.min && (!best.has(r.sub) || best.get(r.sub).cov < cov)) best.set(r.sub, { dir: r.dir, cov });
    }
    const routes = [...best].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hant', { numeric: true }))
        .map(([sub, x]) => [sub, x.dir, Math.round(x.cov)]);
    out.groups.push({ id: G.id, name: G.name, desc: G.desc, color: G.color, buf: G.buf, min: G.min, len: Math.round(total),
        line: line.map(p => [r5(p[0]), r5(p[1])]), routes });
    console.log(`${G.name}：參考線 ${(total / 1000).toFixed(1)} km，兩側 ${G.buf} m、重疊 ≥ ${G.min / 1000} km → ${routes.length} 條子路線 (無線形改用站牌連線 ${noShape} 個方向)`);
    console.log(routes.map(([s, , c]) => `${s}(${(c / 1000).toFixed(1)})`).join(' '));
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('寫入', path.relative(ROOT, OUT), fs.statSync(OUT).size, 'bytes');

// 路線群組靜態檔 data/groups.json：查詢頁「路線」分頁的群組按鈕 (例：藍線) 一鍵載入多選路線
//   規則：參考線 (GeoJSON 中指定名稱的 LineString) 兩側 BUF m 內，被公車線形覆蓋的參考線長度 ≥ MIN m 才納入
//     - 公車線形用 taichung-shapes.js (TDX Bus Shape 預先產生)；沒有線形的子路線改用站牌連線；不呼叫任何 API
//     - 子路線任一方向符合即納入；多選放重疊較長的方向
//     - 依子路線名稱 (數字) 由小到大排序
//     - 行駛方向：各方向在路廊內第一點與最後一點投影到參考線的里程差，> +500 m＝往參考線終點 (藍線：臺中車站)、< -500 m＝往起點 (臺中港)，其餘 0 (環狀等，前端改用公車方位角判斷)
//   輸出 routes：[子路線, 多選方向, 重疊 m, { 方向: +1 | -1 | 0 }]
//   車站 (參考線本身沒有車站點位，以沿線公車站位代替)：參考線 STA_BUF m 內、有群組路線停靠的站牌；
//     同名且相距 250 m 內合併為一站；沿線所有站都列入 (不篩站距、停靠路線數)
//     輸出 stations：[站名, lat, lng, 里程 m, 停靠子路線數, [StopUID (去 TXG)…]]，依里程排序
//   用法：node tools/mk_groups.js   (路網或線形更新後重跑)
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'groups.json');
const GROUPS = [
    { id: 'blue', name: '藍線', desc: '臺中捷運藍線 (規劃) 沿線', color: '#1E9CC2',
      src: path.join(ROOT, '..', 'metro route', 'BlueLine.geojson'), feature: '藍線', buf: 300, min: 3000,
      ends: ['臺中港', '臺中車站'] },   // 參考線 [起點, 終點] 方向名稱
    // 紫線：指定子路線 (analysis/purple_line_corridor.py 紫線 1 km 緩衝內、涵蓋紫線比例最高的前十條路線，含副線/繞駛)
    { id: 'purple', name: '紫線', desc: '臺中捷運紫線 屯區環狀線 (規劃) 沿線', color: '#8E5BB5', dash: true, kw: '紫|purple|屯區',
      src: path.join(ROOT, '..', 'metro route', 'PurpleLine.geojson'), feature: '紫線(屯區捷運環狀線)', buf: 1000, min: 0, staBuf: 1000,
      subs: ['3', '243', '133', '74', '74繞', '51', '51副', '249', '291', '綠3', '39', '158'], rule: '紫線 1 km 緩衝涵蓋最高的 10 條路線 (3、243、133、74、51、249、291、綠3、39、158)',
      ends: ['東山松竹', '大慶'] }
];

const win = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'taichung-network.js'), 'utf8') + ';' + fs.readFileSync(path.join(ROOT, 'taichung-shapes.js'), 'utf8'), { window: win });
const NET = win.TXG_NET, SHAPES = win.TXG_SHAPES || {};
const STOPS = NET.stops.map(([, , lat, lng]) => [lat, lng]);
const STA_BUF = 100;   // 車站：離參考線 m (群組可用 staBuf 另訂，例：紫線 1000)
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

// 點投影到參考線的里程 (m)；離線超過 buf 回 null
function chainage(p, line, cum, buf) {
    let best = null;
    for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        const ax = (a[1] - p[1]) * KX, ay = (a[0] - p[0]) * KY, dx = (b[1] - a[1]) * KX, dy = (b[0] - a[0]) * KY, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0, d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d <= buf && (!best || d < best.d)) best = { d, s: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
    }
    return best && best.s;
}
// 公車沿行駛順序在路廊內的里程變化 → +1 / -1 / 0
function sense(polys, line, cum, buf) {
    const ch = polys.flat().map(p => chainage(p, line, cum, buf)).filter(v => v !== null);
    if (ch.length < 2) return 0;
    const d = ch[ch.length - 1] - ch[0];
    return d > 500 ? 1 : d < -500 ? -1 : 0;
}
const r5 = v => Math.round(v * 1e5) / 1e5;
const out = { at: new Date().toISOString(), net: NET.gen, groups: [] };
for (const G of GROUPS) {
    const gj = JSON.parse(fs.readFileSync(G.src, 'utf8'));
    const f = (gj.features || []).find(x => x.properties && x.properties.Name === G.feature && x.geometry && x.geometry.type === 'LineString');
    if (!f) throw new Error(`${G.src} 找不到名稱為「${G.feature}」的 LineString`);
    const line = f.geometry.coordinates.map(c => [c[1], c[0]]);
    const samples = densify(line), total = samples.reduce((s, x) => s + x.w, 0);
    const cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + meters(line[i - 1], line[i]));
    const best = new Map();   // sub → { dir, cov }
    const polysOf = new Map();
    let noShape = 0;
    for (const r of ROUTES) {
        const e = SHAPES[r.sub + '|' + r.dir] || SHAPES[r.sub + '|any'];
        if (!e) noShape++;
        const polys = e ? e.map(decPoly) : [r.seq.map(si => STOPS[si])];
        polysOf.set(r.sub + '|' + r.dir, polys);
        const cov = covered(samples, segsOf(polys, G.buf), G.buf);
        if ((G.subs ? G.subs.includes(r.sub) : cov >= G.min) && (!best.has(r.sub) || best.get(r.sub).cov < cov)) best.set(r.sub, { dir: r.dir, cov });
    }
    if (G.subs) G.subs.filter(x => !best.has(x)).forEach(x => console.warn(`  ${G.name}：找不到子路線 ${x}`));
    const routes = [...best].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hant', { numeric: true }))
        .map(([sub, x]) => [sub, x.dir, Math.round(x.cov),
            Object.fromEntries(ROUTES.filter(r => r.sub === sub).map(r => [r.dir, sense(polysOf.get(r.sub + '|' + r.dir), line, cum, G.buf)]))]);
    // ---- 車站 ----
    const subsAt = new Map();   // 站牌索引 → Set(子路線)
    for (const [sub] of routes) ROUTES.filter(r => r.sub === sub).forEach(r => r.seq.forEach(si => { if (!subsAt.has(si)) subsAt.set(si, new Set()); subsAt.get(si).add(sub); }));
    const cands = [];
    for (const [si, subs] of subsAt) {
        const ch = chainage(STOPS[si], line, cum, G.staBuf || STA_BUF);
        if (ch === null) continue;
        const nm = NET.stops[si][1];
        let c = cands.find(x => x.name === nm && meters(x.pts[0], STOPS[si]) < 250);
        if (!c) cands.push(c = { name: nm, pts: [], uids: [], subs: new Set(), ch: [] });
        c.pts.push(STOPS[si]); c.uids.push(NET.stops[si][0]); c.ch.push(ch); subs.forEach(x => c.subs.add(x));
    }
    cands.forEach(c => { c.lat = c.pts.reduce((a, p) => a + p[0], 0) / c.pts.length; c.lng = c.pts.reduce((a, p) => a + p[1], 0) / c.pts.length; c.s = c.ch.reduce((a, b) => a + b, 0) / c.ch.length; });
    const picked = cands.slice().sort((a, b) => a.s - b.s);
    const stations = picked.map(c => [c.name, r5(c.lat), r5(c.lng), Math.round(c.s), c.subs.size, c.uids]);
    console.log(`  車站 ${stations.length} 站 (候選 ${cands.length})：${stations.map(x => `${x[0]}(${x[4]})`).join('、')}`);
    out.groups.push({ id: G.id, name: G.name, desc: G.desc, color: G.color, buf: G.buf, min: G.min, len: Math.round(total),
        ends: G.ends, dash: !!G.dash, kw: G.kw || '', rule: G.rule || '', line: line.map(p => [r5(p[0]), r5(p[1])]), routes, stations });
    console.log(`${G.name}：參考線 ${(total / 1000).toFixed(1)} km，兩側 ${G.buf} m、重疊 ≥ ${G.min / 1000} km → ${routes.length} 條子路線 (無線形改用站牌連線 ${noShape} 個方向)`);
    console.log(routes.map(([s, , c, d]) => `${s}(${(c / 1000).toFixed(1)} ${Object.values(d).map(v => v > 0 ? '→' : v < 0 ? '←' : '?').join('')})`).join(' '));
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('寫入', path.relative(ROOT, OUT), fs.statSync(OUT).size, 'bytes');

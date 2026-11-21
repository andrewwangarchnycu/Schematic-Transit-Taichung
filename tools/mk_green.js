// 騎車環境靜態檔 data/green.json：自行車道、公園綠地、河道 (OpenStreetMap)
//   用途：查詢頁路徑規劃的 YouBike 騎車段，沿自行車道／綠地／河道比例高的站對優先；選用公車＋YouBike 方案時畫自行車道圖層
//   來源：OpenStreetMap (Overpass API)，© OpenStreetMap 貢獻者 (ODbL)；不耗 TDX 流量
//   範圍：data/bike.json 所有 YouBike 站點外擴 1 km 的矩形，只留離任一站 3 km 內的圖徵 (騎車段最長約 5 km)
//   用法：node tools/mk_green.js   (先產生 data/bike.json；OSM 資料約每季重產一次)
const fs = require('fs'), path = require('path');
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const BIKE = path.join(__dirname, '..', 'data', 'bike.json'), OUT = path.join(__dirname, '..', 'data', 'green.json');
const NEAR_M = 3000, TOL_M = 8;   // 離站點距離上限、線形簡化容許誤差 (公尺)

const R = 6371000, rad = Math.PI / 180;
const dist = (a, b) => { const x = (b[1] - a[1]) * rad * Math.cos((a[0] + b[0]) / 2 * rad), y = (b[0] - a[0]) * rad; return Math.hypot(x, y) * R; };
// Douglas–Peucker (平面近似)
function simplify(pts, tol) {
    if (pts.length <= 2) return pts;
    const k = Math.cos(pts[0][0] * rad), P = pts.map(([la, ln]) => [ln * rad * k * R, la * rad * R]);
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
        const [a, b] = st.pop();
        const [ax, ay] = P[a], [bx, by] = P[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
        let mx = -1, mi = -1;
        for (let i = a + 1; i < b; i++) {
            const t = L ? Math.max(0, Math.min(1, ((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / L)) : 0;
            const d = Math.hypot(P[i][0] - ax - t * dx, P[i][1] - ay - t * dy);
            if (d > mx) { mx = d; mi = i; }
        }
        if (mx > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
}
// 座標 → 整數 (1e5) 差分編碼：[lat0, lng0, dlat1, dlng1, ...]
const enc = pts => { const o = []; let pa = 0, pn = 0; pts.forEach(([la, ln]) => { const a = Math.round(la * 1e5), n = Math.round(ln * 1e5); o.push(a - pa, n - pn); pa = a; pn = n; }); return o; };

(async () => {
    const st = JSON.parse(fs.readFileSync(BIKE, 'utf8')).s.map(x => [x[2], x[3]]);
    if (!st.length) throw new Error('data/bike.json 沒有站點');
    const pad = 0.01;
    const bb = [Math.min(...st.map(p => p[0])) - pad, Math.min(...st.map(p => p[1])) - pad, Math.max(...st.map(p => p[0])) + pad, Math.max(...st.map(p => p[1])) + pad].map(x => x.toFixed(4)).join(',');
    const q = `[out:json][timeout:300];
(
  way["highway"="cycleway"](${bb});
  way["cycleway"~"^(lane|track|opposite_lane|opposite_track)$"](${bb});
  way["cycleway:both"~"^(lane|track)$"](${bb});
  way["cycleway:left"~"^(lane|track)$"](${bb});
  way["cycleway:right"~"^(lane|track)$"](${bb});
  way["highway"~"^(path|footway|pedestrian)$"]["bicycle"~"^(designated|yes)$"](${bb});
  way["leisure"~"^(park|garden|recreation_ground)$"](${bb});
  relation["leisure"="park"](${bb});
  way["waterway"~"^(river|canal)$"](${bb});
  way["waterway"="stream"]["name"](${bb});
);
out geom;`;
    console.log('查詢 Overpass… 範圍 ' + bb);
    const r = await fetch(OVERPASS, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'transit-map-static-builder/1.0' }, body: new URLSearchParams({ data: q }) });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const js = await r.json();
    // 站點格網 (約 1 km)：判斷圖徵是否離站點 3 km 內
    const G = new Set(), ck = (la, ln) => `${Math.floor(la / 0.009)},${Math.floor(ln / 0.0099)}`;
    st.forEach(([la, ln]) => { const cy = Math.floor(la / 0.009), cx = Math.floor(ln / 0.0099); for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) G.add(`${cy + dy},${cx + dx}`); });
    const nearSt = pts => pts.some(([la, ln]) => G.has(ck(la, ln)) && st.some(s => Math.abs(s[0] - la) < 0.03 && dist(s, [la, ln]) <= NEAR_M));
    const out = { at: new Date().toISOString().slice(0, 10), src: 'OpenStreetMap (Overpass API) © OpenStreetMap contributors, ODbL', enc: 'int1e5-delta', bike: [], park: [], water: [] };
    let nIn = 0;
    const add = (k, g) => {
        const pts = g.map(p => [p.lat, p.lon]);
        if (pts.length < 2 || !nearSt(pts)) return;
        const s = simplify(pts, TOL_M);
        if (s.length >= 2) out[k].push(enc(s));
    };
    js.elements.forEach(e => {
        nIn++;
        const t = e.tags || {};
        if (e.type === 'relation') { (e.members || []).filter(m => m.role === 'outer' && m.geometry).forEach(m => add('park', m.geometry)); return; }
        if (!e.geometry) return;
        if (t.waterway) add('water', e.geometry);
        else if (t.leisure) add('park', e.geometry);
        else add('bike', e.geometry);
    });
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log(`data/green.json：OSM ${nIn} 筆 → 自行車道 ${out.bike.length}、公園綠地 ${out.park.length}、河道 ${out.water.length}，${Math.round(fs.statSync(OUT).size / 1024)} KB`);
})().catch(e => { console.error('失敗：' + e.message); process.exit(1); });

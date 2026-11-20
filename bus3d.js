// 3D 公車：共用車身幾何、塗裝資料 (data/livery.json) 載入與比對
//   taichung-query.html (導航) 與 tools/livery.html (塗裝編輯器) 共用
(function (root) {
    'use strict';
    const TIRE = '#1b1b1d';
    const HW = 1.25;   // 半車寬 (公尺)

    // 車頭下緣「閃電」分段：白底＋右側綠色閃電＋深藍邊
    const powerFront = (W, G, N) => [[-HW, 0.05, W], [0.05, 0.62, G], [0.62, 0.74, N], [0.74, HW, W]];

    // 車頂冷氣／電池箱預設位置 (x0, x1；x 往車頭)
    const AC_PRESET = { 0: [], 1: [[-2.0, 2.0]], 2: [[-3.4, -0.6], [1.0, 3.4]] };

    // 塗裝參數 → 方塊 [x0, x1, y0, y1, 底高, 頂高, 顏色]；x 往車頭 (公尺)、y 往車身左側
    //   c：skirt/skirtF 裙邊 (後段/近車頭)、lower/lowerF 下段、band 窗帶、rear 車尾條、upper 上段、
    //      glass 擋風玻璃、led 路線看板、frontTop 車頭頂緣、mirror 後照鏡、bumper 保險桿 (可省)、
    //      front 車頭下緣分段 [[y0, y1, 色]] 或 power [白, 綠, 藍] (閃電)、ac [[x0, x1, 色]] 車頂箱、L 車長
    function parts(c) {
        const L = c.L || 10.6, hw = HW, xr = -L / 2, xf = L / 2, xc = xf - 0.32, xw = xf - 1.4;
        const P = [
            // 輪胎
            [xr + 1.7, xr + 2.7, -hw + 0.02, -hw + 0.34, 0, 0.36, TIRE], [xr + 1.7, xr + 2.7, hw - 0.34, hw - 0.02, 0, 0.36, TIRE],
            [xf - 2.9, xf - 1.9, -hw + 0.02, -hw + 0.34, 0, 0.36, TIRE], [xf - 2.9, xf - 1.9, hw - 0.34, hw - 0.02, 0, 0.36, TIRE],
            // 車身側面：裙邊、下段 (近車頭一段可換色)、窗帶 (車尾留一條車身色)、上段
            [xr, xw, -hw, hw, 0.33, 0.55, c.skirt], [xw, xc, -hw, hw, 0.33, 0.55, c.skirtF || c.skirt],
            [xr, xw, -hw, hw, 0.55, 1.15, c.lower], [xw, xc, -hw, hw, 0.55, 1.15, c.lowerF || c.lower],
            [xr, xr + 0.18, -hw, hw, 1.15, 2.5, c.rear || c.upper], [xr + 0.18, xc, -hw, hw, 1.15, 2.5, c.band],
            [xr, xc, -hw, hw, 2.5, 3.0, c.upper],
            // 車頭：擋風玻璃、LED 路線看板、頂緣
            [xc, xf, -hw, hw, 1.2, 2.42, c.glass || '#22313a'], [xc, xf, -hw, hw, 2.42, 2.82, c.led || '#2a1a08'], [xc, xf, -hw, hw, 2.82, 3.0, c.frontTop || c.upper],
            // 後照鏡 (伸出車頭兩側)
            [xf - 0.05, xf + 0.32, hw + 0.08, hw + 0.38, 1.85, 2.55, c.mirror || c.upper], [xf - 0.05, xf + 0.32, -hw - 0.38, -hw - 0.08, 1.85, 2.55, c.mirror || c.upper]
        ];
        // 車頭下緣：保險桿＋分段 (閃電) 或單色
        const z0 = c.bumper ? 0.6 : 0.33;
        if (c.bumper) P.push([xc, xf, -hw, hw, 0.33, 0.6, c.bumper]);
        const front = c.power ? powerFront(...c.power) : c.front || [[-hw, hw, c.lowerF || c.lower]];
        front.forEach(([y0, y1, col]) => P.push([xc, xf, y0, y1, z0, 1.2, col]));
        (c.ac || []).forEach(([x0, x1, col]) => P.push([x0, x1, -0.85, 0.85, 3.0, 3.34, col]));
        return P;
    }

    // 方塊 → GeoJSON 多邊形 (p 位置 {lat,lng}、brg 方位角、k 放大倍數)
    function features(P, p, brg, k, props) {
        const b = brg * Math.PI / 180, fe = Math.sin(b), fn = Math.cos(b), le = -fn, ln = fe;   // 車頭、左側單位向量 (東, 北)
        const mLat = 110900, mLng = 111320 * Math.cos(p.lat * Math.PI / 180);
        const at = (x, y) => [p.lng + (x * fe + y * le) * k / mLng, p.lat + (x * fn + y * ln) * k / mLat];
        return P.map(([x0, x1, y0, y1, z0, z1, c]) => ({ type: 'Feature', properties: Object.assign({ c, b: z0 * k, h: z1 * k }, props),
            geometry: { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] } }));
    }

    // 2D canvas 預覽 (畫家演算法)：yaw 水平轉角、pitch 俯角 (負＝由上往下看)、S 每公尺像素
    function draw(ctx, P, yaw, pitch, ox, oy, S) {
        const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
        const V = (x, y, z) => { const u = x * cy - y * sy, w = x * sy + y * cy; return { x: ox + u * S, y: oy - (z * cp - w * sp) * S, d: w * cp + z * sp }; };
        const shade = (hex, f) => {
            const n = parseInt(String(hex).replace('#', ''), 16) || 0;
            return `rgb(${Math.min(255, (n >> 16) * f) | 0},${Math.min(255, ((n >> 8) & 255) * f) | 0},${Math.min(255, (n & 255) * f) | 0})`;
        };
        const faces = [];
        P.forEach(([x0, x1, y0, y1, z0, z1, c]) => {
            [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 1.0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], 0.92],
             [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], 0.8], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], 0.75],
             [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], 0.85]].forEach(q => {
                const pts = q.slice(0, 4).map(v => V(...v));
                faces.push({ pts, c: shade(c, q[4]), d: pts.reduce((a, v) => a + v.d, 0) / 4 });
            });
        });
        faces.sort((a, b) => b.d - a.d).forEach(f => {
            ctx.beginPath(); f.pts.forEach((v, i) => i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y)); ctx.closePath();
            ctx.fillStyle = f.c; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.15)'; ctx.stroke();
        });
    }

    // ---- 塗裝資料 ----
    //   data/livery.json：{ liveries: { id: { name, note, c } }, plates: { 車牌: id }, rules: [{ route, plate, op, livery }] }
    //   先查 plates (已確認車型的車牌，任何路線都適用)，查不到再比對 rules
    //   rules 由上往下比對，第一條符合的生效；route 可為字串或陣列 (完全相同)、plate 為正則、op 比對業者名稱 (包含) 或業者代碼 (相同)
    let DATA = null, loading = null, PLATES = new Map();
    const cache = {};
    // 車牌正規化：大寫、去空白、各種破折號統一成 -
    const normPlate = p => String(p || '').toUpperCase().replace(/\s+/g, '').replace(/[‐-―－_]/g, '-');
    function setData(d) {
        DATA = d && d.liveries ? d : { liveries: {}, rules: [] };
        DATA.rules = DATA.rules || [];
        PLATES = new Map(Object.entries(DATA.plates || {}).map(([p, id]) => [normPlate(p), id]));
        Object.keys(cache).forEach(k => delete cache[k]);
        DATA.rules.forEach(r => { if (r.plate) { try { r._re = new RegExp(r.plate, 'i'); } catch (e) { r._re = /(?!)/; } } });
        return DATA;
    }
    function load(url) {
        return loading || (loading = fetch(url || 'data/livery.json', { cache: 'no-cache' })
            .then(r => r.ok ? r.json() : null).catch(() => null).then(setData));
    }
    // 路線、車牌、業者 (代碼, 名稱) → 塗裝 id；沒有符合 → null (用公車圖示)
    function match(route, plate, opId, opName) {
        if (!DATA) return null;
        const byPlate = PLATES.get(normPlate(plate));
        if (byPlate && DATA.liveries[byPlate]) return byPlate;
        for (const r of DATA.rules) {
            if (r.route && !(Array.isArray(r.route) ? r.route.includes(route) : r.route === route)) continue;
            if (r._re && !r._re.test(plate || '')) continue;
            if (r.op && !(r.op === opId || (opName && opName.includes(r.op)))) continue;
            if (DATA.liveries[r.livery]) return r.livery;
        }
        return null;
    }
    const needsOp = () => !!(DATA && DATA.rules.some(r => r.op));
    function partsOf(id) {
        if (cache[id]) return cache[id];
        const L = DATA && DATA.liveries[id];
        return L ? (cache[id] = parts(L.c)) : null;
    }

    root.Bus3D = { parts, features, draw, load, setData, match, needsOp, partsOf, powerFront, normPlate, AC_PRESET, data: () => DATA };
})(typeof window !== 'undefined' ? window : globalThis);

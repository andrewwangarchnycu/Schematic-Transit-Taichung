// 規劃捷運路網版路線圖：由 taichung-legacy.html (舊路廊資料) + taichung-network.js (全市站序) 產生
//   新路線 (藍／橘／紅／紫線、綠線延伸) 的站序、行經公車、版面，寫回 taichung.html 的 DATA / MAP_DESIGN
//   並補齊 taichung-routes.js 中新路線會用到的子路線站序。
//   用法：node tools/mk_plan.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const legacy = rd('taichung-legacy.html');
const OLD = JSON.parse(legacy.match(/const DATA = (\{.*?\});\s*\n/s)[1]);
const OLD_MD = JSON.parse(legacy.match(/MAP_DESIGN = \/\*MAP_DESIGN_START\*\/(\{.*?\})\/\*MAP_DESIGN_END\*\//s)[1]);
const w = {}; new Function('window', rd('taichung-network.js'))(w);
const NET = w.TXG_NET;
const wr = {}; new Function('window', rd('taichung-routes.js'))(wr);
const ROUTES_JS = wr.TXG_ROUTES;

// ---------- 站名 → 站點物件 (同地點別名沿用舊資料的 aliases 群組) ----------
const ALIAS = new Map();   // 任一別名 → 代表站點物件
Object.values(OLD).forEach(L => L && L.stops && L.stops.forEach(s => { if (s.aliases) s.aliases.forEach(a => ALIAS.set(a, s)); }));
const geoOf = new Map();
NET.stops.forEach(([, nm, lat, lng]) => { if (!geoOf.has(nm)) geoOf.set(nm, { lat, lng }); });
const stopObj = nm => ALIAS.get(nm) || { name: nm, ...(geoOf.get(nm) || { lat: 0, lng: 0 }) };
const canon = nm => (ALIAS.get(nm) || { name: nm }).name;
const namesOf = s => s.aliases || [s.name];

// ---------- 由路線站序截取一段 ----------
const seqOf = (sub, dir) => { const r = NET.routes.find(x => x[0] === sub && x[2] === dir); if (!r) throw new Error('沒有路線 ' + sub + ' ' + dir); return r[3].map(i => NET.stops[i][1]); };
function seg(sub, dir, a, b) {
    const s = seqOf(sub, dir), i = s.indexOf(a), j = s.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error(`${sub}/${dir} 找不到 ${a} → ${b}`);
    return s.slice(i, j + 1);
}
const oldStops = (lid, i0 = 0, i1) => OLD[lid].stops.slice(i0, i1 === undefined ? undefined : i1 + 1).map(s => s.name);
function chain(...parts) {
    const out = [];
    parts.flat().forEach(nm => { const o = stopObj(nm); if (!out.length || out[out.length - 1].name !== o.name) out.push(o); });
    // 同一站點重複出現 (環狀繞行) 只留第一次
    const seen = new Set();
    return out.filter(o => !seen.has(o.name) && seen.add(o.name));
}

// ---------- 新路線站序 ----------
const NEW = {
    // 藍線：臺中港 → 臺灣大道 (300 系列) → 臺中車站 → 建成路 → 太平 → 東平
    bl: chain(seg('308', 0, '臺中港旅客服務中心', '靜宜大學(專用道)'), oldStops('tb'), seg('51', 0, '太平橋前', '東平國小(中興東路)')),
    // 橘線：臺中機場 → 中清路 → 水湳 → 中友／臺中科大 → 雙十路 → 臺中車站 → 建國路／國光路 → 中興路 → 霧峰
    or: chain(seg('500延', 0, '臺中國際機場2月台', '國立臺中科技大學'), oldStops('sl').reverse(), oldStops('gk'), seg('200', 1, '青年高中', '省議會')),
    // 紅線：豐原轉運中心 → 西勢路／承德路 → 崇德路 → 三民錦新 (700 路線)
    rd: chain(seg('700', 0, '豐原轉運中心(第5月台)', '三民錦新街口')),
    // 紫線 (屯區環狀)：大慶 → 高工路 (73) → 大里／仁化／太平 (3) → 東平／坪林／廍子 → 大坑 (51)
    pp: chain(seg('73', 0, '文心南大慶街口', '僑泰中學(高工路)'), seg('3', 1, '積善公園', '中太平'), seg('51', 0, '太平國小', '中臺科技大學')),
    // 綠線東延大坑 (大坑 → 東山路 → 北屯總站附近)，南延彰化 (101 路線)
    ge: chain(seg('1', 0, '中臺科技大學', '東山松竹路口')),
    gs: chain(seg('101', 0, '新烏日車站(A區)', '中庄子(中山路)')),
};
const KEEP = ['bt', 'xt', 'gy', 'hn', 'hd', 'zj', 'jm', 'yl', 'lm', 'mq'];
const PLAN_LINES = ['bl', 'or', 'rd', 'pp', 'ge', 'gs'];
const ALL = [...PLAN_LINES, ...KEEP];

// ---------- 行經公車：子路線站序與路線站序的連續重疊 (≥ 3 站) ----------
const baseRoute = name => /跳蛙/.test(name) ? name : ((name.match(/^[^\d]*\d+/) || [name])[0]);
const DEST = {};
NET.routes.forEach(([sub, , dir, seq]) => { (DEST[sub] = DEST[sub] || {})[dir] = NET.stops[seq[seq.length - 1]][1]; });
function routesOn(stops) {
    const idx = new Map(); stops.forEach((s, i) => namesOf(s).forEach(n => idx.set(n, i)));
    const bySub = new Map();
    NET.routes.forEach(([sub, , dir, seqI]) => {
        const seq = seqI.map(i => NET.stops[i][1]);
        const hits = seq.map(n => idx.has(n) ? idx.get(n) : -1);
        // 連續段：相鄰兩站都在路線上且站序差 1~3 (容許跳過不停的站)
        let best = null, cur = null;
        hits.forEach((h, k) => {
            if (h < 0) { cur = null; return; }
            if (cur && Math.abs(h - cur.last) >= 1 && Math.abs(h - cur.last) <= 3 && (cur.sgn === 0 || Math.sign(h - cur.last) === cur.sgn)) {
                cur.sgn = Math.sign(h - cur.last); cur.idx.push(h); cur.k1 = k; cur.last = h;
            } else cur = { idx: [h], k0: k, k1: k, last: h, sgn: 0 };
            if (!best || cur.idx.length > best.idx.length) best = { ...cur, idx: [...cur.idx] };
        });
        if (!best || best.idx.length < 3) return;
        if (!bySub.has(sub)) bySub.set(sub, {});
        const enter = best.idx[0], leave = best.idx[best.idx.length - 1];
        bySub.get(sub)[dir] = { to: DEST[sub][dir], enter, leave, before: best.k0 > 0 ? seq[best.k0 - 1] : null, after: best.k1 < seq.length - 1 ? seq[best.k1 + 1] : null, cov: best.idx };
    });
    // 依路線號碼合併子路線 (主子路線的方向資料；cov 取所有子路線聯集)
    const byBase = new Map();
    bySub.forEach((dirs, sub) => { const b = baseRoute(sub); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push([sub, dirs]); });
    const out = [];
    byBase.forEach((list, base) => {
        list.sort((a, b) => (a[0] === base ? -1 : b[0] === base ? 1 : 0) || a[0].length - b[0].length);
        const [mainSub, mainDirs] = list[0];
        const cov = new Set(); list.forEach(([, d]) => Object.values(d).forEach(x => { const lo = Math.min(...x.cov), hi = Math.max(...x.cov); for (let i = lo; i <= hi; i++) if (x.cov.includes(i) || true) cov.add(i); }));
        const dirs = {}; Object.entries(mainDirs).forEach(([d, x]) => { const { cov: _, ...rest } = x; dirs[d] = rest; });
        const r = { name: base, cov: [...cov].sort((a, b) => a - b), dirs };
        const variants = list.slice(1).map(x => x[0]).filter(s => s !== base);
        if (mainSub !== base) variants.unshift(mainSub);
        if (variants.length) r.variants = variants;
        out.push(r);
    });
    return out.sort((a, b) => b.cov.length - a.cov.length || a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }));
}

const DATA = {};
PLAN_LINES.forEach(lid => { DATA[lid] = { stops: NEW[lid], routes: routesOn(NEW[lid]) }; });
KEEP.forEach(lid => { DATA[lid] = OLD[lid]; });

// 離開某路線後接續的路線 (車輛閃爍顏色用)
const NEXT = {};
NET.routes.forEach(([sub, , dir, seqI]) => {
    const seq = seqI.map(i => NET.stops[i][1]);
    const lineAt = n => ALL.filter(l => DATA[l].stops.some(s => namesOf(s).includes(n)));
    let prev = null;
    seq.forEach(n => {
        const ls = lineAt(n);
        if (prev && !ls.includes(prev)) {
            const nx = ls.find(l => l !== prev);
            if (nx) { NEXT[prev] = NEXT[prev] || {}; if (!NEXT[prev][sub + '|' + dir]) NEXT[prev][sub + '|' + dir] = nx; }
        }
        if (ls.length) prev = ls.includes(prev) ? prev : ls[0];
    });
});
const destUsed = {};
ALL.forEach(l => DATA[l].routes.forEach(r => [r.name, ...(r.variants || [])].forEach(s => { if (DEST[s]) destUsed[s] = DEST[s]; })));
Object.assign(destUsed, OLD.DEST);

// ---------- 版面 (母版座標：x 往東、y 往南；沿用舊版路廊格線並向外延伸) ----------
const OM = OLD_MD.master;
const idxOf = (lid, nm) => { const i = DATA[lid].stops.findIndex(s => namesOf(s).includes(nm) || s.name === nm); if (i < 0) throw new Error(`${lid} 沒有站 ${nm}`); return i; };
// 舊路廊錨點 → 新路線 (同名站沿用座標)
function importAnchors(lid, fromLids, skip = []) {
    const out = [];
    fromLids.forEach(o => (OM[o].anchors || []).forEach(([i, x, y]) => {
        const nm = OLD[o].stops[i].name;
        if (skip.includes(nm)) return;
        const j = DATA[lid].stops.findIndex(s => s.name === nm);
        if (j >= 0) out.push([j, x, y]);
    }));
    return out;
}
const A = (lid, nm, x, y) => [idxOf(lid, nm), x, y];
const sortA = a => { const m = new Map(); a.forEach(x => m.set(x[0], x)); return [...m.values()].sort((p, q) => p[0] - q[0]); };

const LAYOUT = {
    mrt: { pts: [[2620, -190], [1110, -190], [1050, -130], [1050, 1700], [920, 1830], [480, 1830]],
           anchors: [...OM.mrt.anchors, [13, 1050, 1700]], title: null },
    bl: { pts: [[-760, 840], [3400, 840]],
          anchors: sortA([A('bl', '梧棲(朝元宮)', -560, 840), A('bl', '沙鹿高工(臺灣大道)', -230, 840), A('bl', '靜宜大學(專用道)', 80, 840),
                          ...importAnchors('bl', ['tb']), A('bl', '太平橋前', 3020, 840), A('bl', '中太平', 3200, 840)]), title: null },
    or: { pts: [[-560, -160], [-200, -160], [160, 200], [470, 200], [560, 200], [750, 390], [1900, 390], [2000, 290], [2160, 290], [2260, 390],
                [2260, 500], [2300, 500], [2580, 780], [2580, 1560], [2780, 1760], [2840, 1820], [2980, 1820], [3060, 1900], [3060, 2180]],
          anchors: sortA([A('or', '大雅', -200, -160), A('or', '中清環中路口', 470, 200),
                          ...importAnchors('or', ['zx', 'sl', 'gk'], ['第二市場(三民路)', '臺中州廳', '彰化銀行(自由路)']),
                          A('or', '干城站', 2580, 780), A('or', '草湖', 2980, 1820), A('or', '霧峰', 3060, 2020)]), title: null },
    rd: { pts: [[2380, -1100], [2380, -590], [2030, -240], [2030, 234.5], [1987.3, 277.3]],
          anchors: sortA([A('rd', '潭雅神綠園道(承德路)', 2380, -860), A('rd', '崇德環中路口', 2380, -590), ...importAnchors('rd', ['cd'])]), title: null },
    pp: { pts: [[1050, 1700], [1110, 1760], [2780, 1760], [3200, 1340], [3200, 800], [3400, 800], [3400, -200], [3150, -450]],
          anchors: sortA([A('pp', '僑泰中學(高工路)', 1600, 1760), A('pp', '市立大里高中', 2250, 1760), A('pp', '仁化中興路口', 2780, 1760),
                          A('pp', '修平科技大學', 3020, 1520), A('pp', '中太平', 3200, 840), A('pp', '東平國小(中興東路)', 3400, 800),
                          A('pp', '勤益科技大學', 3400, 420), A('pp', '屯區藝文中心(長安東路)', 3400, 40)]), title: null },
    ge: { pts: [[3150, -450], [2890, -190], [2620, -190]], anchors: [A('ge', '大坑圓環', 3040, -340)], title: null },
    gs: { pts: [[480, 1830], [480, 2060], [340, 2200], [340, 2330]], anchors: [A('gs', '成功車站(中山路)', 480, 2060)], title: null },
};
KEEP.forEach(l => { LAYOUT[l] = JSON.parse(JSON.stringify(OM[l])); });

// 預留路廊 (只畫虛線示意，沒有站點資料)
const RESERVE = [
    { id: 'rdx', name: '紅線延伸（預留）', color: '#E3002C', pts: [[1987.3, 277.3], [1900, 364.5], [1900, 1150], [1760, 1290], [380, 1290]], label: [1180, 1265] },
    { id: 'yl2', name: '黃線 豐科線（預留）', color: '#F5C400', pts: [[2380, -1100], [200, -1100], [-60, -840], [-60, -160], [-60, 420]], label: [1100, -1125] },
    { id: 'cy', name: '青線 科工線（預留）', color: '#00A8B5', pts: [[-60, 420], [-60, 1420]], label: [-60, 1450] },
];

// 正規化：全部座標平移到 0 以上，加邊界
const allPts = [...Object.values(LAYOUT).flatMap(L => [...L.pts, ...(L.title ? [L.title] : [])]), ...RESERVE.flatMap(r => r.pts)];
const minX = Math.min(...allPts.map(p => p[0])), minY = Math.min(...allPts.map(p => p[1]));
const maxX = Math.max(...allPts.map(p => p[0])), maxY = Math.max(...allPts.map(p => p[1]));
const M0 = 160, tx = p => [+(p[0] - minX + M0).toFixed(1), +(p[1] - minY + M0).toFixed(1)];
const master = { w: Math.round(maxX - minX + 2 * M0), h: Math.round(maxY - minY + 2 * M0), top: 0, shift: [0, 0] };
Object.entries(LAYOUT).forEach(([l, L]) => {
    master[l] = { pts: L.pts.map(tx), anchors: L.anchors.map(([i, x, y]) => [i, ...tx([x, y])]), title: L.title ? tx(L.title) : null };
    if (L.labelSide) master[l].labelSide = L.labelSide;
});
const reserve = RESERVE.map(r => ({ ...r, pts: r.pts.map(tx), label: tx(r.label) }));

// ---------- 轉乘站 ----------
const lineHas = (l, nm) => l === 'mrt' ? OLD.MRT.stations.findIndex(s => s.name === nm) : DATA[l].stops.findIndex(s => namesOf(s).includes(nm) || s.name === nm);
const OLD_TO_NEW = { tb: ['bl'], zx: ['or'], sl: ['or'], gk: ['or'], cd: ['rd'] };
const nameAt = (l, i) => l === 'mrt' ? OLD.MRT.stations[i].name : OLD[l].stops[i].name;
const inter = [];
const seenX = new Set();
const pushX = x => { const k = x.at.map(a => a.join(':')).sort().join('|'); if (seenX.has(k)) return; seenX.add(k); inter.push(x); };
[...OLD_MD.interchanges.common, ...OLD_MD.interchanges.base].forEach(x => {
    const at = [];
    x.at.forEach(([l, i]) => {
        if (l === 'mrt' || KEEP.includes(l)) { at.push([l, i]); return; }
        const nm = nameAt(l, i);
        (OLD_TO_NEW[l] || []).forEach(n => { const j = lineHas(n, nm); if (j >= 0) at.push([n, j]); });
    });
    const uniq = at.filter((a, k) => at.findIndex(b => b[0] === a[0]) === k);
    if (uniq.length >= 2) pushX({ ...x, at: uniq });
});
const X = (name, kind, ...members) => pushX({ name, kind, at: members.map(([l, nm]) => [l, l === 'mrt' ? OLD.MRT.stations.findIndex(s => s.name === nm) : idxOf(l, nm)]) });
X('北屯總站', 'rail', ['mrt', '北屯總站'], ['ge', '東山松竹路口']);
X('高鐵臺中站', 'rail', ['mrt', '高鐵臺中站'], ['gs', '新烏日車站(A區)']);
X('大坑', 'rail', ['ge', '中臺科技大學'], ['pp', '中臺科技大學']);
X('大慶', 'rail', ['mrt', '大慶'], ['pp', '文心南大慶街口']);
X('三民錦新', 'rail', ['or', '三民錦新街口'], ['rd', '三民錦新街口']);
X('臺中車站', 'rail', ['bl', '臺中車站'], ['or', '臺中車站']);
X('仁化', 'rail', ['or', '中興仁化路口'], ['pp', '仁化中興路口']);
X('中太平', 'rail', ['bl', '中太平'], ['pp', '中太平']);
X('東平', 'rail', ['bl', '東平國小(中興東路)'], ['pp', '東平國小(中興東路)']);
// 規劃路線之間的轉乘一律畫成捷運轉乘站
inter.forEach(x => { if (x.at.filter(([l]) => l === 'mrt' || PLAN_LINES.includes(l)).length >= 2 && x.kind === 'bus') x.kind = 'rail'; });

// ---------- 路線外觀 ----------
const LINE_META = {
    mrt: { kind: 'mrt', plan: true, code: 'G', name: '綠線', full: '臺中捷運綠線（營運中）', color: '#8CC540', ends: ['北屯端', '高鐵端'] },
    ge: { kind: 'bus', plan: true, code: 'G', name: '綠線東延', full: '綠線延伸大坑（規劃，以東山路公車呈現）', color: '#8CC540', ext: true, ends: ['大坑端', '北屯端'] },
    gs: { kind: 'bus', plan: true, code: 'G', name: '綠線南延', full: '綠線延伸彰化（規劃，以 101 等公車呈現）', color: '#8CC540', ext: true, ends: ['高鐵端', '彰化端'] },
    bl: { kind: 'bus', plan: true, code: 'BL', name: '藍線', full: '藍線 臺中港─臺灣大道─臺中車站─東平（以 300 系列等公車呈現）', color: '#0070BD', ends: ['臺中港端', '東平端'] },
    or: { kind: 'bus', plan: true, code: 'O', name: '橘線', full: '橘線 臺中機場─中清路─臺中車站─國光路─霧峰（以 500、200 等公車呈現）', color: '#F8B61C', ends: ['機場端', '霧峰端'] },
    rd: { kind: 'bus', plan: true, code: 'R', name: '紅線', full: '紅線 豐原─崇德路─三民錦新（以 700 等公車呈現）', color: '#E3002C', ends: ['豐原端', '三民端'] },
    pp: { kind: 'bus', plan: true, code: 'P', name: '紫線', full: '紫線 屯區環狀 大慶─大里─太平─大坑（以 73、3、51 等公車呈現）', color: '#8E5BB5', ends: ['大慶端', '大坑端'] },
};
const lines = { ...LINE_META };
KEEP.forEach(l => { lines[l] = { ...OLD_MD.lines[l], kind: 'bus' }; });
// 舊路廊顏色避開新路線色 (改用柔和灰階色系)
const SOFT = { bt: '#B07A5A', xt: '#7FB8A0', gy: '#7FB8A0', hn: '#9DBE8A', hd: '#9DBE8A', zj: '#C9B26A', jm: '#5E8C76', yl: '#B89C80', lm: '#D99AB0', mq: '#7FB8A0' };
Object.entries(SOFT).forEach(([l, c]) => { lines[l].color = c; });

// 關鍵站 (路線圖上畫站點的站；其餘小站只用來推算車輛位置)
const KEYS = {
    bl: ['臺中港旅客服務中心', '梧棲(朝元宮)', '沙鹿高工(臺灣大道)', '靜宜大學(專用道)', '榮總/東海大學(專用道)', '秋紅谷(專用道)', '科博館(專用道)', '太平橋前'],
    or: ['臺中國際機場2月台', '大雅', '中清環中路口', '水湳', '干城站', '中興大學(國光路)', '草湖', '霧峰', '省議會'],
    rd: ['豐原轉運中心(第5月台)', '潭雅神綠園道(承德路)', '崇德環中路口', '北屯區行政大樓'],
    pp: ['市立大里高中', '修平科技大學', '勤益科技大學', '屯區藝文中心(長安東路)'],
    ge: ['大坑圓環'], gs: ['成功車站(中山路)', '中庄子(中山路)'],
};
const keys = {};
Object.entries(KEYS).forEach(([l, ns]) => { keys[l] = ns.map(n => idxOf(l, n)); });

const MAP_DESIGN = { version: 2, lines, master, interchanges: { common: inter, base: [], center: [] }, reserve, keys };

// ---------- 寫回 taichung.html ----------
const F = path.join(ROOT, 'taichung.html');
let html = fs.readFileSync(F, 'utf8');
const NEWDATA = { ...DATA, DEST: destUsed, NEXT, MRT: OLD.MRT };
html = html.replace(/const DATA = \{.*?\};\s*\n/s, () => `const DATA = ${JSON.stringify(NEWDATA)};\n`);
html = html.replace(/MAP_DESIGN = \/\*MAP_DESIGN_START\*\/\{.*?\}\/\*MAP_DESIGN_END\*\//s, () => `MAP_DESIGN = /*MAP_DESIGN_START*/${JSON.stringify(MAP_DESIGN)}/*MAP_DESIGN_END*/`);
html = html.replace(/const ALL_BUS_LINES = \[[^\]]*\];/, () => `const ALL_BUS_LINES = ${JSON.stringify(ALL).replace(/"/g, "'").replace(/,/g, ', ')};`);
html = html.replace(/const CENTER_ONLY = \[[^\]]*\];/, `const CENTER_ONLY = [];`);
fs.writeFileSync(F, html);

// ---------- taichung-routes.js：補上新路線會用到的子路線 ----------
const hav = (a, b) => { const R = 6371000, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r; const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
let added = 0;
const need = new Set(); ALL.forEach(l => DATA[l].routes.forEach(r => [r.name, ...(r.variants || [])].forEach(s => need.add(s))));
need.forEach(sub => {
    if (ROUTES_JS[sub]) return;
    const rs = NET.routes.filter(x => x[0] === sub);
    if (!rs.length) return;
    const e = { r: rs[0][1] };
    rs.forEach(([, , dir, seqI]) => {
        const st = seqI.map(i => NET.stops[i]);
        let acc = 0;
        e[dir] = { s: st.map(x => x[1]), d: st.map((x, k) => { if (k) acc += hav({ lat: st[k - 1][2], lng: st[k - 1][3] }, { lat: x[2], lng: x[3] }) * 1.25; return Math.round(acc); }) };
    });
    ROUTES_JS[sub] = e; added++;
});
const rjs = rd('taichung-routes.js');
const head = rjs.slice(0, rjs.indexOf('window.TXG_ROUTES'));
fs.writeFileSync(path.join(ROOT, 'taichung-routes.js'), head + 'window.TXG_ROUTES = ' + JSON.stringify(ROUTES_JS) + ';\n');

console.log('路線站數', ALL.map(l => l + ':' + DATA[l].stops.length + '/' + DATA[l].routes.length + '線').join(' '));
console.log('轉乘站', inter.length, '新增子路線站序', added, '母版', master.w, 'x', master.h);

// 一次抓取全部路線的 TDX 站站推估班表 (V3 Estimation Schedule)，存成網站靜態檔 est/*.json
//   網頁 (taichung-query.html) 先讀 est/index.json，有這條路線就讀靜態檔，不再對 TDX 呼叫 V3 → 訪客端零 V3 流量
//   V3 是近 3 個月逐站歷史到站時間，變化慢：建議每月重跑一次
//
// 用法 (repo 根目錄)：
//   node tools/mk_est.js              抓全部 (已抓過且未過期的跳過，可中斷後續跑)
//   node tools/mk_est.js 300 51 U1    只抓指定路線
//   node tools/mk_est.js --force      全部重抓
//   環境變數 TDX_INTERVAL=秒 調整呼叫間隔 (預設 21 秒＝每分鐘 3 次，含取 token)
// 金鑰：環境變數 TDX_CLIENT_ID / TDX_CLIENT_SECRET，或 repo 根目錄的 tdx-key.local.js (不進版控)
// 原始回應快取在 tools/est_cache/ (不進版控)；輸出 est/index.json 與 est/r*.json
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'est'), CACHE = path.join(__dirname, 'est_cache');
const INTERVAL = (+process.env.TDX_INTERVAL || 21) * 1000;
const V3 = 'https://tdx.transportdata.tw/api/premium/V3/Map/Estimation/Bus/Schedule/City/Taichung/RouteName/';
const AUTH = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

function key() {
    if (process.env.TDX_CLIENT_ID && process.env.TDX_CLIENT_SECRET) return [process.env.TDX_CLIENT_ID, process.env.TDX_CLIENT_SECRET];
    const t = fs.readFileSync(path.join(ROOT, 'tdx-key.local.js'), 'utf8');
    return [t.match(/id:\s*"([^"]+)"/)[1], t.match(/secret:\s*"([^"]+)"/)[1]];
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0, token = null;
async function pace() { const w = last + INTERVAL - Date.now(); if (w > 0) await sleep(w); last = Date.now(); }
async function getToken() {
    if (token && token.exp > Date.now() + 300000) return token.v;
    const f = path.join(CACHE, 'token.json');
    if (!token && fs.existsSync(f)) { token = JSON.parse(fs.readFileSync(f, 'utf8')); if (token.exp > Date.now() + 300000) return token.v; }
    await pace();
    const [id, secret] = key();
    const r = await fetch(AUTH, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
    const txt = await r.text();
    let js; try { js = JSON.parse(txt); } catch (e) { throw new Error(`取 token 失敗 HTTP ${r.status} (非 JSON 回應，TDX 可能暫時故障)`); }
    if (!js.access_token) throw new Error('取 token 失敗：' + (js.error_description || js.error || r.status));
    token = { v: js.access_token, exp: Date.now() + (js.expires_in || 3600) * 1000 };
    fs.writeFileSync(f, JSON.stringify(token));
    return token.v;
}
async function fetchV3(route) {
    for (let a = 1; a <= 4; a++) {
        const tk = await getToken();
        await pace();
        const r = await fetch(V3 + encodeURIComponent(route) + '?$format=JSON', { headers: { authorization: 'Bearer ' + tk, 'accept-encoding': 'gzip' } });
        const txt = await r.text();
        if (r.status === 200) return JSON.parse(txt);
        if (r.status === 401) token = null;                      // token 失效 → 重取
        if (r.status === 404) return [];                         // 沒有這條路線的推估班表
        console.log(`  ${route} HTTP ${r.status}，第 ${a} 次重試… ${txt.slice(0, 80).replace(/\s+/g, ' ')}`);
        await sleep(a * 30000);
    }
    throw new Error(`${route} 多次失敗`);
}
// 與 taichung-query.html loadEst() 相同的壓縮格式：subs[子路線][方向][wd|we] = { stops: [站名], trips: [[分鐘|null]] }
const hm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
function compress(js) {
    const v = { exp: null, subs: {} }, raw = new Map();
    js.forEach(r => {
        if (r.ExpireDate) v.exp = String(r.ExpireDate).slice(0, 10);
        (r.Schedules || []).forEach(s => {
            const sub = typeof s.SubRouteName === 'string' ? s.SubRouteName : (s.SubRouteName && s.SubRouteName.Zh_tw) || (typeof r.RouteName === 'string' ? r.RouteName : r.RouteName.Zh_tw);
            (s.Timetables || []).forEach(t => {
                const tag = t.ServiceDay && /末|假/.test(t.ServiceDay.ServiceTag || '') ? 'we' : 'wd';
                const st = (t.StopTimes || []).filter(x => x.HistoricalEstArrivalTime).sort((a, b) => a.StopSequence - b.StopSequence)
                    .map(x => [x.StopName.Zh_tw, hm(x.HistoricalEstArrivalTime)]);
                if (st.length < 2) return;
                for (let i = 1; i < st.length; i++) if (st[i][1] < st[i - 1][1] - 600) st[i][1] += 1440;   // 跨午夜
                const k = `${sub}\u0000${s.Direction}\u0000${tag}`;
                if (!raw.has(k)) raw.set(k, []);
                raw.get(k).push(st);
            });
        });
    });
    raw.forEach((trips, k) => {
        const [sub, dir, tag] = k.split('\u0000');
        const stops = trips.reduce((a, t) => t.length > a.length ? t.map(x => x[0]) : a, []);
        const pos = new Map(); stops.forEach((n, i) => { if (!pos.has(n)) pos.set(n, i); });
        const rows = trips.map(t => { const row = new Array(stops.length).fill(null); t.forEach(([n, m]) => { const i = pos.get(n); if (i !== undefined && row[i] === null) row[i] = m; }); return row; })
            .sort((a, b) => (a.find(x => x !== null) ?? 0) - (b.find(x => x !== null) ?? 0));
        ((v.subs[sub] = v.subs[sub] || {})[dir] = v.subs[sub][dir] || {})[tag] = { stops, trips: rows };
    });
    return v;
}
(async () => {
    fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true });
    global.window = {};
    require(path.join(ROOT, 'taichung-network.js'));
    const all = [...new Set(window.TXG_NET.routes.map(r => r[1]))].sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true }));
    const args = process.argv.slice(2), force = args.includes('--force'), only = args.filter(a => !a.startsWith('--'));
    const todo = only.length ? only : all;
    const idxF = path.join(OUT, 'index.json');
    const index = fs.existsSync(idxF) ? JSON.parse(fs.readFileSync(idxF, 'utf8')) : { routes: {} };
    const today = new Date().toISOString().slice(0, 10);
    let n = 0, fail = 0;
    for (const route of todo) {
        n++;
        const cur = index.routes[route];
        if (!force && cur && (!cur.exp || cur.exp >= today) && Date.now() - Date.parse(cur.at) < 30 * 86400000) { continue; }
        const file = 'r' + (all.indexOf(route) >= 0 ? all.indexOf(route) : 'x' + Buffer.from(route).toString('hex')) + '.json';
        try {
            const rawF = path.join(CACHE, file);
            const js = await fetchV3(route);
            fs.writeFileSync(rawF, JSON.stringify(js));
            const v = compress(js);
            const body = JSON.stringify({ route, at: new Date().toISOString(), exp: v.exp, subs: v.subs });
            fs.writeFileSync(path.join(OUT, file), body);
            index.routes[route] = { f: file, at: new Date().toISOString(), exp: v.exp, n: Object.keys(v.subs).length };
            index.gen = new Date().toISOString();
            fs.writeFileSync(idxF, JSON.stringify(index));   // 每條都寫入，可隨時中斷續跑
            console.log(`[${n}/${todo.length}] ${route} → est/${file} (${(body.length / 1024).toFixed(1)} KB, 原始 ${(JSON.stringify(js).length / 1024).toFixed(0)} KB)`);
        } catch (e) {
            fail++;
            console.log(`[${n}/${todo.length}] ${route} 失敗：${e.message}`);
            if (/token/.test(e.message)) { console.log('取 token 失敗，先停止；TDX 恢復後重跑即可從中斷處繼續。'); break; }
        }
    }
    console.log(`完成：${Object.keys(index.routes).length} 條路線有靜態檔，本次失敗 ${fail} 條。`);
})();

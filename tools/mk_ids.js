// 路線 UID 與英文名稱靜態檔 (多語言準備＋公車位置合併查詢用)
//   taichung-ids.js (查詢頁同步載入，約 20 KB)：子路線名 → [RouteUID, SubRouteUID, 路線英文名, 子路線英文名]
//   data/stops_en.json (目前前端未載入，供日後英文版)：StopUID (去 TXG) → 站名英文
//   來源 (依序補齊)：
//     1. analysis/cache/schedule_taichung.json (QGIS 分析已下載的 Schedule，不耗流量)
//     2. tools/cache/route_taichung.json、stop_taichung.json (TDX Route / Stop 全市各 1 次；30 天內的快取直接用)
//   加 --api 才向 TDX 抓第 2 項 (缺快取或超過 30 天時)；沒加只用已有資料，缺的列出來
//   用法 (repo 根目錄)：node tools/mk_ids.js [--api]
//   金鑰：環境變數 TDX_CLIENT_ID / TDX_CLIENT_SECRET，或 tdx-key.local.js (不進版控)
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..'), CACHE = path.join(__dirname, 'cache');
const AUTH = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const BASE = 'https://tdx.transportdata.tw/api/basic/v2/Bus/';
const API = process.argv.includes('--api');
const MAX_AGE = 30 * 86400000;

function key() {
    if (process.env.TDX_CLIENT_ID && process.env.TDX_CLIENT_SECRET) return [process.env.TDX_CLIENT_ID, process.env.TDX_CLIENT_SECRET];
    const t = fs.readFileSync(path.join(ROOT, 'tdx-key.local.js'), 'utf8');
    return [t.match(/id:\s*"([^"]+)"/)[1], t.match(/secret:\s*"([^"]+)"/)[1]];
}
let token = null;
async function getToken() {
    if (token) return token;
    const [id, secret] = key();
    const r = await fetch(AUTH, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
    const js = await r.json().catch(() => ({}));
    if (!js.access_token) throw new Error(`取 token 失敗 HTTP ${r.status} ${js.error_description || js.error || ''}`);
    return (token = js.access_token);
}
// 讀快取；--api 且快取缺或過期時才打 TDX
async function cached(file, p) {
    const f = path.join(CACHE, file);
    const fresh = fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < MAX_AGE;
    if (fresh || (fs.existsSync(f) && !API)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!API) return null;
    const r = await fetch(BASE + p + '&$format=JSON', { headers: { authorization: 'Bearer ' + await getToken(), 'accept-encoding': 'gzip' } });
    const txt = await r.text();
    if (r.status !== 200) throw new Error(`${p} HTTP ${r.status} ${txt.slice(0, 80)}`);
    fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, txt);
    console.log(`  TDX ${p.split('?')[0]}：${(txt.length / 1024).toFixed(0)} KB → tools/cache/${file}`);
    return JSON.parse(txt);
}

(async () => {
    const win = {};
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'taichung-network.js'), 'utf8'), { window: win });
    const NET = win.TXG_NET;
    const subs = [...new Set(NET.routes.map(r => r[0]))];
    const route = new Map(NET.routes.map(r => [r[0], r[1]]));
    const ids = new Map(), stopEn = new Map();
    const zh = n => n && n.Zh_tw, en = n => n && n.En;
    const put = (sub, ru, su, re, se) => { if (!ids.has(sub) && route.has(sub)) ids.set(sub, [ru, su, re || '', se || '']); };

    // 1. Schedule 快取
    const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis/cache/schedule_taichung.json'), 'utf8'));
    S.forEach(r => {
        put(zh(r.SubRouteName) || zh(r.RouteName), r.RouteUID, r.SubRouteUID || r.RouteUID, en(r.RouteName), en(r.SubRouteName) || en(r.RouteName));
        (r.Timetables || []).forEach(t => (t.StopTimes || []).forEach(s => { if (en(s.StopName)) stopEn.set(s.StopUID, en(s.StopName)); }));
    });
    const fromSched = ids.size;
    // 2. Route 全市 (含子路線)
    const R = await cached('route_taichung.json', 'Route/City/Taichung?$select=RouteUID,RouteName,SubRoutes');
    if (R) R.forEach(r => (r.SubRoutes || []).forEach(s => put(zh(s.SubRouteName) || zh(r.RouteName), r.RouteUID, s.SubRouteUID || r.RouteUID, en(r.RouteName), en(s.SubRouteName) || en(r.RouteName))));
    if (R) R.forEach(r => put(zh(r.RouteName), r.RouteUID, r.RouteUID, en(r.RouteName), en(r.RouteName)));
    // 3. Stop 全市
    const ST = await cached('stop_taichung.json', 'Stop/City/Taichung?$select=StopUID,StopName');
    if (ST) ST.forEach(s => { if (en(s.StopName)) stopEn.set(s.StopUID, en(s.StopName)); });

    // 同一路線的 RouteUID 要一致 (合併查詢以 RouteUID 為準)
    const byRoute = new Map();
    for (const [sub, v] of ids) { const rt = route.get(sub), u = byRoute.get(rt); if (u && u !== v[0]) console.warn(`  注意：路線 ${rt} 有兩個 RouteUID ${u} / ${v[0]}`); byRoute.set(rt, v[0]); }

    const r = {};
    subs.slice().sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true })).forEach(s => { if (ids.has(s)) r[s] = ids.get(s); });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(ROOT, 'taichung-ids.js'),
        '// 由 tools/mk_ids.js 產生 (TDX Schedule / Route)：子路線名 → [RouteUID, SubRouteUID, 路線英文名, 子路線英文名]\n' +
        `window.TXG_IDS = ${JSON.stringify({ gen: at.slice(0, 10), r })};\n`);
    const se = {};
    NET.stops.forEach(([uid]) => { const v = stopEn.get('TXG' + uid); if (v) se[uid] = v; });
    fs.writeFileSync(path.join(ROOT, 'data', 'stops_en.json'), JSON.stringify({ at, n: Object.keys(se).length, s: se }));

    const miss = subs.filter(s => !ids.has(s));
    console.log(`子路線 ${subs.length}：有 UID ${ids.size} (排程快取 ${fromSched}、Route ${ids.size - fromSched})${miss.length ? `，缺 ${miss.length}：${miss.join('、')}` : ''}`);
    console.log(`站牌 ${NET.stops.length}：有英文名 ${Object.keys(se).length}`);
    if ((miss.length || !ST) && !API) console.log('加 --api 向 TDX 補抓 Route / Stop (各 1 次)');
    console.log('寫入 taichung-ids.js', fs.statSync(path.join(ROOT, 'taichung-ids.js')).size, 'bytes；data/stops_en.json', fs.statSync(path.join(ROOT, 'data', 'stops_en.json')).size, 'bytes');
})().catch(e => { console.error(e.message); process.exit(1); });

#!/usr/bin/env node
// 公車實際發車紀錄 (GitHub Actions 每 15 分鐘執行一次，見 .github/workflows/dispatch-watch.yml)
//   監測路線：--routes 或環境變數 DISPATCH_ROUTES (預設 45,51,35,23,19,326)，自動含支線／副線
//     (TDX 的支線多半是另一個路線名稱：45延、45區、45延1、51副…；依 taichung-routes.js 展開「路線號＋非數字字尾」)
//   只記錄，不判定：前端開路線時載入當日每日營運時刻表，再與這份紀錄比對早發／誤點／脫班／漏班
//
// TDX 流量最小化：車輛班次 RealTimeNearStop (A2) 用 OData 只取監測路線、且 TripStartTime 在上次抓取之後的車
//   (TripStartTime 是字串，同格式可直接比大小)；每次 1 次 API，回應通常只有幾十～幾百 bytes
// 輸出 (--out，workflow 指到 data 分支 departures/)：
//   YYYY-MM-DD/<路線名稱>.csv：plate,sub,dir,start,stop,seen (start＝車機回報的發車時刻，臺北時間 YYYY-MM-DDTHH:MM:SS；依發車日期分檔；同車牌同發車只記一次)
//     stop,seen＝第一次抓到這一趟時車在哪一站、GPS 時間：司機發車時刻按錯時，前端用「站＋時間」依時刻表站間時間反推實際發車
//     type＝TripStartTimeType (TDX：0 實際發車時間、1 預估發車時間、2 無法推估 → start 空白)
//     seq,ev,bus,duty＝StopSequence、A2EventType、BusStatus (99＝非營運)、DutyStatus (2＝到終點結束)
//   無法推估發車時間 (type 2) 的車也抓 (同車牌同方向 150 分內只記第一次)；非營運／已結束的不記
//   YYYY-MM-DD/_polls.txt：每次成功抓取的時間 (前端據此判斷資料有沒有中斷，中斷時段不判漏班)
'use strict';
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = arg('--out', 'departures');
const API = 'https://tdx.transportdata.tw/api/basic/v2/Bus/', AUTH = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TZ = 8 * 3600000, MIN = 60000;
const dkey = ms => new Date(ms + TZ).toISOString().slice(0, 10);
const local = ms => new Date(ms + TZ).toISOString().slice(0, 19);   // 臺北時間 YYYY-MM-DDTHH:MM:SS
const subOf = r => (r.SubRouteName && r.SubRouteName.Zh_tw) || (r.RouteName && r.RouteName.Zh_tw) || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 監測路線＋支線／副線
const WATCH = (() => {
    const base = String(arg('--routes', process.env.DISPATCH_ROUTES || '45,51,35,23,19,326')).split(',').map(x => x.trim()).filter(Boolean), all = new Set(base);
    try {
        const src = fs.readFileSync(path.join(__dirname, '..', 'taichung-routes.js'), 'utf8'), R = JSON.parse(src.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/)[1]);
        Object.values(R).forEach(x => { const n = x.r; if (n && base.some(w => n.startsWith(w) && !/^[0-9]/.test(n.slice(w.length)))) all.add(n); });
    } catch (e) { console.log('讀不到 taichung-routes.js，只監測指定路線'); }
    return [...all];
})();
const RT_F = '(' + WATCH.map(r => `RouteName/Zh_tw eq '${r.replace(/'/g, "''")}'`).join(' or ') + ')';

async function api(q, token) {
    for (let k = 0; ; k++) {
        const r = await fetch(API + q + '&$format=JSON', { headers: { authorization: 'Bearer ' + token, 'accept-encoding': 'gzip' } });
        if (r.ok) return r.json();
        if ((r.status === 429 || r.status >= 500) && k < 3) { await sleep(20000 * (k + 1)); continue; }
        throw new Error(`HTTP ${r.status}`);
    }
}
const readLines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };

(async () => {
    const now = Date.now(), id = process.env.TDX_CLIENT_ID, sec = process.env.TDX_CLIENT_SECRET;
    if (!id || !sec) throw new Error('缺少 TDX_CLIENT_ID / TDX_CLIENT_SECRET');
    const tr = await fetch(AUTH, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: sec }) });
    if (!tr.ok) throw new Error('TDX 授權失敗 HTTP ' + tr.status);
    const token = (await tr.json()).access_token;
    // 上次抓取 (今天或昨天的 _polls.txt 最後一行) 往前 10 分；沒有紀錄或中斷很久時最多往前 2 小時
    const lastTxt = [dkey(now), dkey(now - 86400000)].map(d => readLines(path.join(OUT, d, '_polls.txt')).pop()).find(Boolean);
    const last = lastTxt ? Date.parse(lastTxt + '+08:00') : 0;
    const since = Math.max(now - 120 * MIN, Math.min(now - 30 * MIN, last - 10 * MIN));
    const js = await api(`RealTimeNearStop/City/Taichung?$filter=${encodeURIComponent(`${RT_F} and (TripStartTime ge '${local(since)}+08:00' or TripStartTimeType eq 2)`)}&$select=PlateNumb,RouteName,SubRouteName,Direction,TripStartTime,TripStartTimeType,StopName,StopSequence,A2EventType,BusStatus,DutyStatus,GPSTime`, token);
    let added = 0;
    const files = new Map();   // 檔名 → { have: Set, lines: [] }
    js.forEach(v => {
        if (!v.PlateNumb || v.PlateNumb === '-1') return;
        if (v.BusStatus === 99 || v.DutyStatus === 2) return;   // 非營運／已到終點結束
        const g = v.GPSTime ? Date.parse(v.GPSTime) : NaN, s = v.TripStartTime ? Date.parse(v.TripStartTime) : NaN;
        const none = !isFinite(s);   // 無法推估發車時間 (type 2)
        if (none && !isFinite(g)) return;
        if (!none && s > now + 5 * MIN) return;
        const route = v.RouteName && v.RouteName.Zh_tw;
        if (!route) return;
        const t = none ? g : s, f = path.join(OUT, dkey(t), route.replace(/[\\/:*?"<>|]/g, '_') + '.csv');
        if (!files.has(f)) files.set(f, { rows: readLines(f).slice(1).map(l => l.split(',')), lines: [] });
        const F = files.get(f);
        if (none) {
            // 同車牌同方向：150 分內已有記錄 (有發車時刻或也是無法推估) → 視為同一趟
            if (F.rows.some(r => r[0] === v.PlateNumb && +r[2] === v.Direction && (() => { const x = Date.parse((r[3] || r[5]) + '+08:00'); return isFinite(x) && g - x >= -5 * MIN && g - x <= 150 * MIN; })())) return;
        } else if (F.rows.some(r => r[0] === v.PlateNumb && r[3] === local(s))) return;
        const stop = ((v.StopName && v.StopName.Zh_tw) || '').replace(/[,\r\n]/g, ' ');
        const row = [v.PlateNumb, subOf(v), v.Direction, none ? '' : local(s), stop, isFinite(g) ? local(g) : '',
            v.TripStartTimeType === undefined ? '' : v.TripStartTimeType, v.StopSequence === undefined ? '' : v.StopSequence,
            v.A2EventType === undefined ? '' : v.A2EventType, v.BusStatus === undefined ? '' : v.BusStatus, v.DutyStatus === undefined ? '' : v.DutyStatus];
        F.rows.push(row.map(String)); F.lines.push(row.join(','));
        added++;
    });
    files.forEach((F, f) => {
        if (!F.lines.length) return;
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tk = l => { const c = l.split(','); return c[3] || c[5]; };
        fs.appendFileSync(f, (fs.existsSync(f) ? '' : 'plate,sub,dir,start,stop,seen,type,seq,ev,bus,duty\n') + F.lines.sort((a, b) => tk(a).localeCompare(tk(b))).join('\n') + '\n');
    });
    const pf = path.join(OUT, dkey(now), '_polls.txt');
    fs.mkdirSync(path.dirname(pf), { recursive: true });
    fs.appendFileSync(pf, local(now) + '\n');
    console.log(`監測 ${WATCH.join(',')}；自 ${local(since)} 起回應 ${js.length} 筆，新增發車 ${added} 筆`);
})().catch(e => { console.error('失敗：', e.message); process.exit(1); });

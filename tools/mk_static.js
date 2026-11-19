// 產生查詢頁的靜態時刻資料 data/：每條路線一個檔 (路線班表＋站間旅行時間)，網頁讀靜態檔，不必每次打 TDX
//   路線班表 (Schedule)：預設讀 analysis/cache/schedule_taichung.json (QGIS 分析已下載，不耗流量)；加 --sched-api 改向 TDX 重抓 (約 4 MB)
//   站間旅行時間 (S2STravelTime)：TDX 只能逐條路線查，約 390 次、總傳輸約 1 MB；已抓 (30 天內) 的跳過，可中斷續跑；
//     加 --no-s2s 只用 tools/cache/s2s/ 已有的資料；環境變數 TDX_INTERVAL=秒 調整呼叫間隔 (預設 21 秒＝每分鐘約 3 次；太快會被 TDX 回 429)
// 用法 (repo 根目錄)：node tools/mk_static.js [--sched-api] [--no-s2s]
// 金鑰：環境變數 TDX_CLIENT_ID / TDX_CLIENT_SECRET，或 tdx-key.local.js (不進版控)
// 輸出：data/index.json、data/r*.json (檔名序號與 est/ 相同：全部路線名排序後的索引)
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'data'), CACHE = path.join(__dirname, 'cache');
const AUTH = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const BASE = 'https://tdx.transportdata.tw/api/basic/v2/Bus/';
const args = process.argv.slice(2);

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
    const txt = await r.text(); let js;
    try { js = JSON.parse(txt); } catch (e) { throw new Error(`取 token 失敗 HTTP ${r.status}`); }
    if (!js.access_token) throw new Error('取 token 失敗：' + (js.error_description || js.error));
    return (token = js.access_token);
}
async function tdx(p) {
    const r = await fetch(BASE + p + (p.includes('?') ? '&' : '?') + '$format=JSON', { headers: { authorization: 'Bearer ' + await getToken(), 'accept-encoding': 'gzip' } });
    const txt = await r.text();
    if (r.status !== 200) throw new Error(`${p} HTTP ${r.status} ${txt.slice(0, 80)}`);
    console.log(`  ${p.split('?')[0]}：解壓後 ${(txt.length / 1024).toFixed(0)} KB${r.headers.get('content-length') ? `，傳輸 ${(r.headers.get('content-length') / 1024).toFixed(0)} KB` : ''}`);
    return JSON.parse(txt);
}
const hm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const WD_KEY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

(async () => {
    fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true });
    global.window = {};
    require(path.join(ROOT, 'taichung-network.js'));
    const N = window.TXG_NET;
    const all = [...new Set(N.routes.map(r => r[1]))].sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true }));
    const out = new Map(all.map(rt => [rt, { sch: {}, s2s: {} }]));

    // ---- 路線班表 (與 taichung-query.html loadSchedule() 相同的精簡格式) ----
    let S;
    if (args.includes('--sched-api')) S = await tdx('Schedule/City/Taichung?$select=RouteName,SubRouteName,Direction,Timetables,Frequencys');
    else S = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis/cache/schedule_taichung.json'), 'utf8'));
    const days = sd => WD_KEY.map(k => sd ? (sd[k] ? 1 : 0) : 1);
    S.forEach(r => {
        const route = r.RouteName.Zh_tw, o = out.get(route);
        if (!o) return;
        const sub = (r.SubRouteName && r.SubRouteName.Zh_tw) || route;
        (o.sch[sub] = o.sch[sub] || {})[r.Direction] = {
            trips: (r.Timetables || []).map((t, k) => ({ id: t.TripID || String(k + 1), days: days(t.ServiceDay),
                st: (t.StopTimes || []).slice().sort((a, b) => a.StopSequence - b.StopSequence).map(s => [s.StopName.Zh_tw, hm(s.DepartureTime || s.ArrivalTime)]) })).filter(t => t.st.length),
            freq: (r.Frequencys || []).map(f => ({ days: days(f.ServiceDay), s: hm(f.StartTime), e: hm(f.EndTime), min: f.MinHeadwayMins, max: f.MaxHeadwayMins }))
        };
    });
    const schAt = S.reduce((a, r) => r.UpdateTime && r.UpdateTime > a ? r.UpdateTime : a, '');

    // ---- 站間旅行時間：TDX 沒有全市查詢，逐條路線抓 (路徑查詢為精確比對)；每條存 tools/cache/s2s/，可中斷續跑 ----
    const s2sDir = path.join(CACHE, 's2s'); fs.mkdirSync(s2sDir, { recursive: true });
    const INTERVAL = (+process.env.TDX_INTERVAL || 21) * 1000, sleep = ms => new Promise(r => setTimeout(r, ms));
    let T = [], fetched = 0, wire = 0;
    for (const [i, rt] of all.entries()) {
        const f = path.join(s2sDir, 'r' + i + '.json');
        if (fs.existsSync(f) && (args.includes('--no-s2s') || Date.now() - fs.statSync(f).mtimeMs < 30 * 86400000)) { T = T.concat(JSON.parse(fs.readFileSync(f, 'utf8'))); continue; }
        if (args.includes('--no-s2s')) continue;
        for (let a = 1; ; a++) {
            await sleep(INTERVAL);
            const r = await fetch(BASE + 'S2STravelTime/City/Taichung/' + encodeURIComponent(rt) + '?$format=JSON&$select=RouteID,SubRouteID,Direction,TravelTimes,UpdateTime',
                { headers: { authorization: 'Bearer ' + await getToken(), 'accept-encoding': 'gzip' } });
            const txt = await r.text();
            if (r.status === 200) { const js = JSON.parse(txt); fs.writeFileSync(f, txt); T = T.concat(js); fetched++; wire += +(r.headers.get('content-length') || txt.length); break; }
            if (r.status === 404) { fs.writeFileSync(f, '[]'); break; }
            if (r.status === 401) token = null;
            if (a >= 4) { console.log(`  ${rt} 失敗 HTTP ${r.status}，略過`); break; }
            console.log(`  ${rt} HTTP ${r.status}，${a * 60} 秒後重試`); await sleep(a * 60000);
        }
        if (fetched && fetched % 50 === 0) console.log(`  已抓 ${fetched} 條，傳輸約 ${(wire / 1024).toFixed(0)} KB`);
    }
    console.log(`站間旅行時間：本次抓 ${fetched} 條，傳輸約 ${(wire / 1024).toFixed(0)} KB`);
    // S2S 沒有子路線名稱 → 依「相鄰站牌代碼」與站牌資料比對出最吻合的子路線方向
    const pairsOf = new Map();
    N.routes.forEach(([sub, route, dir, seq], i) => pairsOf.set(i, new Set(seq.slice(1).map((si, k) => N.stops[seq[k]][0] + '>' + N.stops[si][0]))));
    let matched = 0, unmatched = 0;
    T.forEach(rec => {
        (rec.TravelTimes || []).forEach(tt => {
            const segs = (tt.S2STimes || []).map(x => [x.FromStopID, x.ToStopID, x.RunTime]);
            if (!segs.length) return;
            let best = -1, score = 0;
            N.routes.forEach((r, i) => {
                if (r[2] !== rec.Direction) return;
                const P = pairsOf.get(i); let c = 0;
                segs.forEach(([a, b]) => { if (P.has(a + '>' + b)) c++; });
                if (c > score) { score = c; best = i; }
            });
            if (best < 0 || score < Math.max(1, segs.length * 0.5)) { unmatched++; return; }
            matched++;
            const [sub, route, dir] = N.routes[best], o = out.get(route);
            const cur = o.s2s[sub] && o.s2s[sub][dir];
            const band = { wd: tt.Weekday, h: [tt.StartHour, tt.EndHour], seg: segs };
            ((o.s2s[sub] = o.s2s[sub] || {})[dir] = cur || []).push(band);
        });
    });

    // ---- 輸出 ----
    const index = { gen: new Date().toISOString(), schAt, s2sAt: T.reduce((a, r) => r.UpdateTime && r.UpdateTime > a ? r.UpdateTime : a, ''), routes: {} };
    let bytes = 0;
    all.forEach((rt, i) => {
        const o = out.get(rt);
        if (!Object.keys(o.sch).length && !Object.keys(o.s2s).length) return;
        const f = 'r' + i + '.json', body = JSON.stringify({ route: rt, sch: o.sch, s2s: o.s2s });
        fs.writeFileSync(path.join(OUT, f), body); bytes += body.length;
        index.routes[rt] = { f, sch: Object.keys(o.sch).length > 0, s2s: Object.keys(o.s2s).length > 0 };
    });
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));

    // ---- 路徑規劃用全市精簡檔 data/plan.json (查詢頁「規劃」第一次使用時才載入) ----
    //   r[i] 對應 taichung-network.js routes 的索引：
    //     d＝預排發車 [分鐘, 星期遮罩 (bit0＝週日 … bit6＝週六)]、f＝班距 [起, 迄, 班距分, 遮罩] (只有班距的路線)
    //     o＝各站相對發車的分鐘數 (TDX 站間旅行時間＋每站停靠 10 秒；缺段依該路線平均車速以直線距離×1.3 估)、s＝1 有站間旅行時間
    const DWELL = 10, mask = days => days.reduce((m, v, k) => m | (v ? 1 << k : 0), 0);
    const dm = (a, b) => Math.hypot((a[3] - b[3]) * 101700, (a[2] - b[2]) * 110900);
    const plan = { gen: index.gen, r: [] };
    let withS2S = 0;
    // 沒有站間旅行時間的路段：用有資料路線的實測車速中位數 (以直線距離×1.3 計)
    const speeds = [];
    N.routes.forEach(([sub, route, dir, seq]) => {
        const o = out.get(route), bands = o && o.s2s[sub] && o.s2s[sub][dir], band = bands && (bands.find(b => b.wd === 99) || bands[0]);
        if (!band) return;
        const m = new Map(band.seg.map(([a, b, x]) => [a + '>' + b, x]));
        let kd = 0, ks = 0;
        seq.slice(1).forEach((si, k) => { const x = m.get(N.stops[seq[k]][0] + '>' + N.stops[si][0]); if (x !== undefined) { kd += dm(N.stops[seq[k]], N.stops[si]) * 1.3; ks += x; } });
        if (ks > 300) speeds.push(kd / ks);
    });
    speeds.sort((a, b) => a - b);
    const V0 = speeds.length ? speeds[speeds.length >> 1] : 5.5;
    console.log(`備援車速 (實測中位數)：${(V0 * 3.6).toFixed(1)} km/h，樣本 ${speeds.length}`);
    N.routes.forEach(([sub, route, dir, seq], i) => {
        const o = out.get(route), sc = o && o.sch[sub] && o.sch[sub][dir], bands = o && o.s2s[sub] && o.s2s[sub][dir];
        const d = sc ? sc.trips.map(t => [t.st[0][1], mask(t.days)]).sort((a, b) => a[0] - b[0]) : [];
        const f = sc ? sc.freq.map(x => [x.s, x.e, x.min || x.max || 15, mask(x.days)]) : [];
        const uid = seq.map(si => N.stops[si][0]), dist = seq.slice(1).map((si, k) => dm(N.stops[seq[k]], N.stops[si]) * 1.3);
        const band = bands ? (bands.find(b => b.wd === 99) || bands[0]) : null;
        const m = new Map(band ? band.seg.map(([a, b, s]) => [a + '>' + b, s]) : []);
        let kd = 0, ks = 0;
        const sec = uid.slice(1).map((u, k) => { const x = m.get(uid[k] + '>' + u); if (x !== undefined) { kd += dist[k]; ks += x; } return x; });
        const v = ks ? kd / ks : V0;   // m/s
        const off = [0];
        sec.forEach((x, k) => off.push(off[k] + ((x !== undefined ? x : dist[k] / v) + (k >= 1 ? DWELL : 0)) / 60));
        if (band) withS2S++;
        plan.r[i] = { d, f, o: off.map(x => Math.round(x * 10) / 10), s: band ? 1 : 0 };
    });
    const planBody = JSON.stringify(plan);
    fs.writeFileSync(path.join(OUT, 'plan.json'), planBody);
    console.log(`規劃檔 data/plan.json：${(planBody.length / 1024).toFixed(0)} KB，${withS2S}/${N.routes.length} 個子路線方向有站間旅行時間`);
    const n = Object.keys(index.routes).length, ns = Object.values(index.routes).filter(x => x.s2s).length;
    console.log(`完成：${n} 條路線 (${ns} 條有站間旅行時間)，data/ 共 ${(bytes / 1024).toFixed(0)} KB；站間旅行時間對應 ${matched} 筆、無法對應 ${unmatched} 筆`);
})().catch(e => { console.error('失敗：', e.message); process.exit(1); });

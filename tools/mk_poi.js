// 地標／店名靜態檔 data/poi.json：查詢頁路徑規劃起訖可搜尋地標、學校、醫院、商場、景點、店家
//   來源：OpenStreetMap (Overpass API)，© OpenStreetMap 貢獻者 (ODbL)；不耗 TDX 流量，前端不打外部服務
//   範圍：臺中市 (ISO3166-2 TW-TXG) 內有名稱的地點；行政區由 OSM 區界 (admin_level 7) 判斷
//   格式：{ at, src, d: [行政區名], c: [類別名], p: [[名稱, lat×1e5, lng×1e5, 類別索引, 行政區索引 (-1＝不明), 別名 (選填，| 分隔)], ...] }
//   用法：node tools/mk_poi.js   (OSM 資料約每季重產一次)
const fs = require('fs'), path = require('path');
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const OUT = path.join(__dirname, '..', 'data', 'poi.json');
const AREA = 'area["ISO3166-2"="TW-TXG"]->.tc;';

// 類別 (前端顯示用)；依 OSM 標籤判斷，先符合者為準
const CATS = ['車站', '學校', '醫療', '政府機關', '景點', '公園運動', '購物', '餐飲', '住宿', '宗教', '社區', '其他'];
function catOf(t) {
    const a = t.amenity, s = t.shop, to = t.tourism, l = t.leisure;
    if (t.railway === 'station' || a === 'bus_station') return 0;
    if (/^(school|university|college|kindergarten|library)$/.test(a)) return 1;
    if (/^(hospital|clinic|doctors|pharmacy)$/.test(a)) return 2;
    if (/^(townhall|police|fire_station|post_office|courthouse|community_centre|social_facility)$/.test(a) || t.office === 'government') return 3;
    if (/^(attraction|museum|gallery|viewpoint|theme_park|zoo)$/.test(to) || t.historic || t.natural || /^(cinema|theatre|arts_centre)$/.test(a)) return 4;
    if (l) return 5;
    if (s || a === 'marketplace' || a === 'bank') return 6;
    if (/^(restaurant|cafe|fast_food|food_court)$/.test(a)) return 7;
    if (/^(hotel|hostel|motel|guest_house)$/.test(to)) return 8;
    if (a === 'place_of_worship') return 9;
    if (t.place) return 10;
    return 11;
}

// 伺服器滿載 (429／502／504) 時輪流換備援伺服器重試，間隔逐次加長
const SERVERS = [OVERPASS, 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function overpass(q) {
    let last;
    for (let i = 0; i < 6; i++) {
        const url = SERVERS[i % SERVERS.length];
        try {
            const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'transit-map-static-builder/1.0' }, body: new URLSearchParams({ data: q }) });
            if (r.ok) return r.json();
            last = new Error(`${url} HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
            if (![429, 502, 503, 504].includes(r.status)) throw last;
        } catch (e) { last = e; }
        console.log(`  重試 (${last.message.split('\n')[0]})`);
        await new Promise(ok => setTimeout(ok, 5000 * (i + 1)));
    }
    throw last;
}
// 點在多邊形內 (奇偶規則，不需要把 way 接成環：所有外框／內框線段一起算)
function inside(segs, la, ln) {
    let c = false;
    for (const [a, b] of segs) if ((a[0] > la) !== (b[0] > la) && ln < (b[1] - a[1]) * (la - a[0]) / (b[0] - a[0]) + a[1]) c = !c;
    return c;
}

(async () => {
    console.log('查詢 Overpass：臺中市行政區界…');
    const dj = await overpass(`[out:json][timeout:300];${AREA}rel(area.tc)["boundary"="administrative"]["admin_level"="7"];out geom;`);
    const D = dj.elements.filter(e => e.tags && e.tags.name).map(e => {
        const segs = [];
        (e.members || []).filter(m => m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === 'inner'))
            .forEach(m => { for (let i = 1; i < m.geometry.length; i++) segs.push([[m.geometry[i - 1].lat, m.geometry[i - 1].lon], [m.geometry[i].lat, m.geometry[i].lon]]); });
        const la = segs.flatMap(s => [s[0][0], s[1][0]]), ln = segs.flatMap(s => [s[0][1], s[1][1]]);
        return { name: e.tags.name, segs, bb: [Math.min(...la), Math.min(...ln), Math.max(...la), Math.max(...ln)] };
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    console.log(`行政區 ${D.length} 個`);
    const distOf = (la, ln) => D.findIndex(d => la >= d.bb[0] && la <= d.bb[2] && ln >= d.bb[1] && ln <= d.bb[3] && inside(d.segs, la, ln));

    console.log('查詢 Overpass：有名稱的地點…');
    const q = `[out:json][timeout:600];${AREA}
(
  nwr(area.tc)["name"]["amenity"~"^(school|university|college|kindergarten|library|hospital|clinic|doctors|pharmacy|townhall|police|fire_station|post_office|courthouse|community_centre|social_facility|place_of_worship|marketplace|cinema|theatre|arts_centre|bus_station|bank|restaurant|cafe|fast_food|food_court)$"];
  nwr(area.tc)["name"]["shop"];
  nwr(area.tc)["name"]["tourism"~"^(attraction|museum|gallery|viewpoint|theme_park|zoo|hotel|hostel|motel|guest_house)$"];
  nwr(area.tc)["name"]["leisure"~"^(park|stadium|sports_centre|garden|swimming_pool|playground)$"];
  nwr(area.tc)["name"]["historic"];
  nwr(area.tc)["name"]["natural"~"^(wetland|beach|peak|water)$"];
  nwr(area.tc)["name"]["office"="government"];
  nwr(area.tc)["name"]["railway"="station"];
  node(area.tc)["name"]["place"~"^(neighbourhood|quarter|suburb|village)$"];
);
out center tags;`;
    const js = await overpass(q);
    const seen = new Map(), P = [];
    let nIn = 0, nDup = 0;
    js.elements.forEach(e => {
        nIn++;
        const t = e.tags || {}, la = e.lat ?? (e.center && e.center.lat), ln = e.lon ?? (e.center && e.center.lon);
        if (la === undefined || ln === undefined) return;
        const name = String(t['name:zh-Hant'] || t['name:zh'] || t.name).trim();
        if (!name || name.length > 40) return;
        // 同名 150 m 內視為同一地點 (建物＋點重複標記)
        const key = name, A = Math.round(la * 1e5), N = Math.round(ln * 1e5);
        const prev = seen.get(key) || [];
        if (prev.some(([a, n]) => Math.abs(a - A) < 140 && Math.abs(n - N) < 150)) { nDup++; return; }
        prev.push([A, N]); seen.set(key, prev);
        const alt = [...new Set([t.name, t.alt_name, t.short_name, t.official_name, t['name:en']].filter(Boolean).flatMap(x => String(x).split(';')).map(x => x.trim()).filter(x => x && x !== name))].join('|');
        P.push(alt ? [name, A, N, catOf(t), distOf(la, ln), alt] : [name, A, N, catOf(t), distOf(la, ln)]);
    });
    // 類別 (車站、學校…優先)、名稱排序，前端依此順序列出
    P.sort((a, b) => a[3] - b[3] || a[0].localeCompare(b[0], 'zh-Hant'));
    const out = { at: new Date().toISOString().slice(0, 10), src: 'OpenStreetMap (Overpass API) © OpenStreetMap contributors, ODbL', d: D.map(d => d.name), c: CATS, p: P };
    fs.writeFileSync(OUT, JSON.stringify(out));
    const byC = CATS.map((c, i) => `${c} ${P.filter(p => p[3] === i).length}`).join('、');
    console.log(`data/poi.json：OSM ${nIn} 筆 → ${P.length} 個地點 (同名重複 ${nDup})，${Math.round(fs.statSync(OUT).size / 1024)} KB；${byC}；行政區不明 ${P.filter(p => p[4] < 0).length}`);
})().catch(e => { console.error('失敗：' + e.message); process.exit(1); });

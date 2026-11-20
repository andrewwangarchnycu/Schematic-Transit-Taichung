// YouBike 2.0 站點靜態檔 data/bike.json
//   來源：臺中市政府開放資料「臺中市公共自行車(YouBike2.0)租借站&即時車位資料」(data.gov.tw 136781)，不耗 TDX 流量
//   網頁的可借／可還數另外即時讀同一份資料 (taichung-query.html ybLive)；這裡只留站點 (代碼、名稱、座標、車柱數、地址)
//   用法：node tools/mk_bike.js   (站點很少變動，約每月重產一次)
const fs = require('fs'), path = require('path');
const URL = 'https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=bf0fee92-9980-418c-a095-2eacf2eb49f6';
const OUT = path.join(__dirname, '..', 'data', 'bike.json');

(async () => {
    const r = await fetch(URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const js = JSON.parse(await r.text());
    if (!Array.isArray(js) || !js.length) throw new Error('資料格式不符');
    const r5 = x => Math.round(x * 1e5) / 1e5;
    const s = js.filter(x => x.sno && isFinite(+x.lat) && isFinite(+x.lng))
        .map(x => [x.sno, (x.sna || '').replace(/^YouBike\d(\.\d)?_/, ''), r5(+x.lat), r5(+x.lng), +x.tot || 0, x.ar || ''])
        .sort((a, b) => a[0].localeCompare(b[0]));
    const out = { at: new Date().toISOString().slice(0, 10), src: 'data.gov.tw/dataset/136781', f: ['sno', 'name', 'lat', 'lng', 'tot', 'addr'], s };
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log(`data/bike.json：${s.length} 站，${Math.round(fs.statSync(OUT).size / 1024)} KB`);
})().catch(e => { console.error('失敗：' + e.message); process.exit(1); });

// 各公車路線線形 → 一條路線 (RouteID) 一個 GeoJSON：analysis/route_geojson/{RouteID}.geojson
//   資料：tools/shape_all.json (先前下載的 TDX /v2/Bus/Shape/City/Taichung，原始精度，不另打 API)
//   每個 Feature＝一個子路線的一個方向 (LineString，WGS84)；另輸出 index.json (RouteID → 路線名稱、子路線)
//   node tools/mk_route_geojson.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'shape_all.json');
const OUT = path.join(ROOT, 'analysis', 'route_geojson');
const zh = v => (v && (v.Zh_tw || v.Zh_TW)) || '';
const parse = g => g.replace(/^\s*LINESTRING\s*\(/i, '').replace(/\)\s*$/, '').split(',').map(p => p.trim().split(/\s+/).map(Number));

const js = JSON.parse(fs.readFileSync(SRC, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
fs.readdirSync(OUT).filter(f => f.endsWith('.geojson')).forEach(f => fs.unlinkSync(path.join(OUT, f)));   // 清掉舊檔 (路線停駛時不留殘檔)
const byRoute = new Map();
js.forEach(x => {
    if (!x.Geometry || !/^\s*LINESTRING/i.test(x.Geometry)) { console.warn('略過非 LINESTRING：', x.RouteID, zh(x.SubRouteName)); return; }
    if (!byRoute.has(x.RouteID)) byRoute.set(x.RouteID, []);
    byRoute.get(x.RouteID).push({
        type: 'Feature',
        properties: {
            RouteUID: x.RouteUID, RouteID: x.RouteID, RouteName: zh(x.RouteName),
            SubRouteUID: x.SubRouteUID || '', SubRouteID: x.SubRouteID || '', SubRouteName: zh(x.SubRouteName) || zh(x.RouteName),
            Direction: x.Direction === undefined ? null : x.Direction, UpdateTime: x.UpdateTime || ''
        },
        geometry: { type: 'LineString', coordinates: parse(x.Geometry) }
    });
});
const index = {};
[...byRoute].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true })).forEach(([id, feats]) => {
    feats.sort((a, b) => a.properties.SubRouteName.localeCompare(b.properties.SubRouteName, 'zh-Hant') || (a.properties.Direction ?? 9) - (b.properties.Direction ?? 9));
    fs.writeFileSync(path.join(OUT, id + '.geojson'), JSON.stringify({ type: 'FeatureCollection', name: String(id), crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features: feats }));
    index[id] = { name: feats[0].properties.RouteName, subs: [...new Set(feats.map(f => f.properties.SubRouteName))] };
});
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ gen: new Date().toISOString(), source: 'TDX /v2/Bus/Shape/City/Taichung (tools/shape_all.json)', routes: index }, null, 1));
console.log(`${byRoute.size} 條路線、${js.length} 筆線形 → ${path.relative(ROOT, OUT)}`);

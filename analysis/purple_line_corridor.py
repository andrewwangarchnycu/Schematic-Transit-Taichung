# -*- coding: utf-8 -*-
"""
捷運紫線 (屯區捷運環狀線) 路廊 1 km 內的公車路線 (QGIS Python Script)
====================================================================

在 QGIS 的 Python 主控台 → 顯示編輯器 → 開啟本檔 → 執行。
也可獨立執行 (不開介面，只輸出檔案)：
  "C:\\Program Files\\QGIS 3.44.13\\bin\\python-qgis.bat" analysis\\purple_line_corridor.py

資料 (不打 API)
---------------
- 紫線：PURPLE (GeoJSON，WGS84；多個 Feature 會合併)
- 公車：analysis/route_geojson/{RouteID}.geojson
        (node tools/mk_route_geojson.js 由 tools/shape_all.json 產生；每個 Feature＝子路線的一個方向)

方法 (EPSG:3826 TWD97，公尺)
---------------------------
1. 紫線緩衝 BUFFER_M (1 km)。
2. 每條子路線方向：
   - in_len   ＝ 落在紫線緩衝內的長度
   - in_ratio ＝ in_len ÷ 子路線總長
   - cover    ＝ 紫線落在「該子路線緩衝 BUFFER_M」內的長度 ÷ 紫線總長 (沿紫線涵蓋多少)
3. 路線 (RouteID) 取各子路線方向中最好的一筆 (in_len 最大)。
4. 相近＝ in_len >= MIN_IN_M 且 cover >= MIN_COVER (只是穿越緩衝的路線 in_len 短、cover 小，會被排除)。

輸出 analysis/output/purple_line_corridor.gpkg
- purple_buffer   紫線緩衝區
- routes_near     相近路線的全部子路線方向 (完整線形) ＋指標
- routes_clip     相近路線在緩衝區內的部分
以及 analysis/output/purple_line_corridor.csv (所有碰到緩衝的路線，含是否相近)。
在 QGIS 內執行時會載入專案 (群組「紫線路廊 1km」)。
"""
import csv
import glob
import json
import os

from qgis.core import (
    Qgis,
    QgsApplication,
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsFeature,
    QgsField,
    QgsFields,
    QgsFillSymbol,
    QgsGeometry,
    QgsLineSymbol,
    QgsProject,
    QgsVectorFileWriter,
    QgsVectorLayer,
)

if Qgis.QGIS_VERSION_INT >= 33800:  # QGIS 3.38+ 欄位型別改用 QMetaType
    from qgis.PyQt.QtCore import QMetaType
    T_STR, T_INT, T_DBL = QMetaType.Type.QString, QMetaType.Type.Int, QMetaType.Type.Double
else:
    from qgis.PyQt.QtCore import QVariant
    T_STR, T_INT, T_DBL = QVariant.String, QVariant.Int, QVariant.Double

# ---------------------------------------------------------------- 參數
BUFFER_M = 1000.0      # 紫線緩衝 (公尺)
MIN_IN_M = 2000.0      # 緩衝內長度下限 (公尺)
MIN_COVER = 0.10       # 沿紫線涵蓋比例下限
SEGMENTS = 16          # 緩衝圓弧細分

# ---------------------------------------------------------------- 路徑
try:
    ANALYSIS_DIR = os.path.dirname(os.path.abspath(__file__))
except NameError:  # QGIS 主控台 exec() 時可能沒有 __file__
    ANALYSIS_DIR = r"C:\Users\user\Desktop\Transport Data\metro_style_transit_info_web\analysis"
PURPLE = r"C:\Users\user\Desktop\Transport Data\metro route\PurpleLine.geojson"
ROUTE_DIR = os.path.join(ANALYSIS_DIR, "route_geojson")
OUT_DIR = os.path.join(ANALYSIS_DIR, "output")
GPKG = os.path.join(OUT_DIR, "purple_line_corridor.gpkg")
CSV = os.path.join(OUT_DIR, "purple_line_corridor.csv")
GROUP = "紫線路廊 1km"


def log(*a):
    print("[purple]", *a)
    try:
        QgsApplication.processEvents()
    except Exception:
        pass


def xform():
    return QgsCoordinateTransform(QgsCoordinateReferenceSystem("EPSG:4326"),
                                  QgsCoordinateReferenceSystem("EPSG:3826"), QgsProject.instance())


def to_3826(geom, xf):
    g = QgsGeometry(geom)
    g.get().dropZValue()
    g.get().dropMValue()
    g.transform(xf)
    return g


def load_purple(xf):
    lyr = QgsVectorLayer(PURPLE, "purple", "ogr")
    if not lyr.isValid():
        raise RuntimeError("讀不到紫線：%s" % PURPLE)
    geoms = [to_3826(f.geometry(), xf) for f in lyr.getFeatures() if f.hasGeometry()]
    line = QgsGeometry.unaryUnion(geoms)
    log("紫線 %d 段，總長 %.1f km" % (len(geoms), line.length() / 1000))
    return line


def load_routes(xf):
    """→ [(props dict, QgsGeometry EPSG:3826)]，每筆＝子路線一個方向"""
    files = sorted(glob.glob(os.path.join(ROUTE_DIR, "*.geojson")))
    if not files:
        raise RuntimeError("沒有路線 GeoJSON，先執行 node tools/mk_route_geojson.js (%s)" % ROUTE_DIR)
    out = []
    for fn in files:
        with open(fn, encoding="utf-8") as fh:
            fc = json.load(fh)
        for ft in fc["features"]:
            coords = ft["geometry"]["coordinates"]
            if len(coords) < 2:
                continue
            wkt = "LINESTRING(%s)" % ",".join("%f %f" % (c[0], c[1]) for c in coords)
            out.append((ft["properties"], to_3826(QgsGeometry.fromWkt(wkt), xf)))
    log("公車 %d 條路線、%d 筆子路線方向" % (len(files), len(out)))
    return out


def measure(routes, purple, buf):
    """各子路線方向的指標；只算碰到緩衝的"""
    plen, bb = purple.length(), buf.boundingBox()
    rows = []
    for p, g in routes:
        if not bb.intersects(g.boundingBox()) or not g.intersects(buf):
            continue
        clip = g.intersection(buf)
        in_len = clip.length()
        cover = purple.intersection(g.buffer(BUFFER_M, SEGMENTS)).length() / plen if plen else 0.0
        rows.append({"p": p, "g": g, "clip": clip, "len": g.length(), "in_len": in_len,
                     "in_ratio": in_len / g.length() if g.length() else 0.0, "cover": cover})
    return rows


def pick(rows):
    """RouteID → 最佳子路線方向 (in_len 最大)，並標記是否相近"""
    best = {}
    for r in rows:
        rid = r["p"]["RouteID"]
        if rid not in best or r["in_len"] > best[rid]["in_len"]:
            best[rid] = r
    for r in best.values():
        r["near"] = r["in_len"] >= MIN_IN_M and r["cover"] >= MIN_COVER
    return best


def route_key(rid):
    s = str(rid)
    n = "".join(ch for ch in s if ch.isdigit())
    return (int(n) if n else 10 ** 9, s)


def fields():
    fs = QgsFields()
    for name, t in (("RouteID", T_STR), ("RouteName", T_STR), ("SubRouteID", T_STR), ("SubRouteName", T_STR),
                    ("Direction", T_INT), ("len_m", T_DBL), ("in_len_m", T_DBL), ("in_ratio", T_DBL),
                    ("cover", T_DBL), ("best", T_INT)):
        fs.append(QgsField(name, t))
    return fs


def attrs(r, best):
    p = r["p"]
    return [p["RouteID"], p["RouteName"], p["SubRouteID"], p["SubRouteName"],
            p["Direction"] if p["Direction"] is not None else None,
            round(r["len"], 1), round(r["in_len"], 1), round(r["in_ratio"], 4), round(r["cover"], 4), int(best)]


def write(layer, name):
    opt = QgsVectorFileWriter.SaveVectorOptions()
    opt.driverName = "GPKG"
    opt.layerName = name
    opt.fileEncoding = "UTF-8"
    opt.actionOnExistingFile = (QgsVectorFileWriter.CreateOrOverwriteLayer if os.path.exists(GPKG)
                                else QgsVectorFileWriter.CreateOrOverwriteFile)
    res = QgsVectorFileWriter.writeAsVectorFormatV3(layer, GPKG, QgsProject.instance().transformContext(), opt)
    if res[0] != QgsVectorFileWriter.NoError:
        raise RuntimeError("寫入 %s 失敗：%s" % (name, res[1]))


def save(buf, rows, best):
    os.makedirs(OUT_DIR, exist_ok=True)
    if os.path.exists(GPKG):
        os.remove(GPKG)

    bl = QgsVectorLayer("Polygon?crs=EPSG:3826", "purple_buffer", "memory")
    bl.dataProvider().addAttributes([QgsField("buffer_m", T_DBL)])
    bl.updateFields()
    f = QgsFeature(bl.fields())
    f.setGeometry(buf)
    f.setAttributes([BUFFER_M])
    bl.dataProvider().addFeatures([f])
    write(bl, "purple_buffer")

    near = {rid for rid, r in best.items() if r["near"]}
    for name, use_clip in (("routes_near", False), ("routes_clip", True)):
        lyr = QgsVectorLayer("MultiLineString?crs=EPSG:3826", name, "memory")
        lyr.dataProvider().addAttributes(fields().toList())
        lyr.updateFields()
        feats = []
        for r in rows:
            rid = r["p"]["RouteID"]
            if rid not in near:
                continue
            g = QgsGeometry(r["clip"] if use_clip else r["g"])
            if g.isEmpty():
                continue
            g.convertToMultiType()
            ft = QgsFeature(lyr.fields())
            ft.setGeometry(g)
            ft.setAttributes(attrs(r, r is best[rid]))
            feats.append(ft)
        lyr.dataProvider().addFeatures(feats)
        write(lyr, name)

    with open(CSV, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["near", "RouteID", "RouteName", "best_SubRouteName", "Direction", "len_km", "in_len_km", "in_ratio", "cover"])
        for rid, r in sorted(best.items(), key=lambda x: (not x[1]["near"], -x[1]["cover"], route_key(x[0]))):
            p = r["p"]
            w.writerow([int(r["near"]), rid, p["RouteName"], p["SubRouteName"], p["Direction"],
                        round(r["len"] / 1000, 2), round(r["in_len"] / 1000, 2), round(r["in_ratio"], 3), round(r["cover"], 3)])


def add_to_project():
    try:
        from qgis.utils import iface
    except ImportError:
        iface = None
    if iface is None:  # 獨立執行：只輸出檔案
        return
    proj = QgsProject.instance()
    root = proj.layerTreeRoot()
    old = root.findGroup(GROUP)
    if old:
        for lyr in old.findLayers():
            proj.removeMapLayer(lyr.layerId())
        root.removeChildNode(old)
    grp = root.insertGroup(0, GROUP)
    styles = {
        "routes_clip": ("緩衝內路段", QgsLineSymbol.createSimple({"color": "#e4007f", "width": "0.9"}), True),
        "routes_near": ("相近路線 (完整)", QgsLineSymbol.createSimple({"color": "#1f78b4", "width": "0.4"}), False),
        "purple_buffer": ("紫線緩衝 %d m" % BUFFER_M, QgsFillSymbol.createSimple(
            {"color": "128,0,128,40", "outline_color": "#800080", "outline_width": "0.4"}), True),
    }
    for name in ("routes_clip", "routes_near", "purple_buffer"):
        title, sym, vis = styles[name]
        lyr = QgsVectorLayer("%s|layername=%s" % (GPKG, name), title, "ogr")
        if not lyr.isValid():
            continue
        lyr.renderer().setSymbol(sym)
        proj.addMapLayer(lyr, False)
        grp.addLayer(lyr).setItemVisibilityChecked(vis)
    pl = QgsVectorLayer(PURPLE, "紫線", "ogr")
    if pl.isValid():
        pl.renderer().setSymbol(QgsLineSymbol.createSimple({"color": "#800080", "width": "1.4"}))
        proj.addMapLayer(pl, False)
        grp.insertLayer(0, pl)


# ================================================================ main
def main():
    if QgsApplication.instance() is None:  # 獨立執行 (python-qgis)
        global _qgs
        _qgs = QgsApplication([], False)
        _qgs.initQgis()
    xf = xform()
    purple = load_purple(xf)
    buf = purple.buffer(BUFFER_M, SEGMENTS)
    rows = measure(load_routes(xf), purple, buf)
    best = pick(rows)
    near = sorted((rid for rid, r in best.items() if r["near"]), key=route_key)
    log("碰到緩衝 %d 條，相近 (緩衝內 >= %.1f km 且涵蓋紫線 >= %d%%) %d 條："
        % (len(best), MIN_IN_M / 1000, MIN_COVER * 100, len(near)))
    for rid in sorted(near, key=lambda k: -best[k]["cover"]):
        r = best[rid]
        log("  %-8s %-10s 緩衝內 %5.1f km (%3d%%)  涵蓋紫線 %3d%%"
            % (r["p"]["RouteName"], r["p"]["SubRouteName"], r["in_len"] / 1000, r["in_ratio"] * 100, r["cover"] * 100))
    save(buf, rows, best)
    add_to_project()
    log("完成：", GPKG, CSV)


main()

# -*- coding: utf-8 -*-
"""
臺中市公車路線 發車頻率分類 (QGIS Python Script)
=================================================

在 QGIS 的 Python 主控台 → 顯示編輯器 → 開啟本檔 → 執行。
(也可用 QGIS 內附的 python-qgis 獨立執行，見檔尾。)

流程
----
1. 資料 (TDX 運輸資料流通服務，臺中市)
   - 線形  /v2/Bus/Shape/City/Taichung
   - 班表  /v2/Bus/Schedule/City/Taichung
   下載結果快取在 analysis/cache/，再次執行不耗 API。
   若 tools/shape_all.json 存在 (網站工具已下載的線形) 會直接使用。

2. 每條路線 (RouteName) 的每日「單向」發車班次
   - 各子路線取班次較多的方向，再加總子路線 (TDX 部分路線只有單方向班表)。
   - Timetables：ServiceDay 含當天者算 1 班。
   - 只有 Frequencys (班距) 的路線：Σ(時段長 ÷ 平均班距) + 1 (推估)。
   - ServiceTag：平日只用 平常日/無標記，假日只用 節假日/無標記；
     春節、寒暑假、臨時調度不列入。
   - 平日 = 週一~週五每日班次的平均；假日 = 週六、週日的平均。

3. 路線合併 (同一走廊算一組)
   - 線形轉 TWD97 (EPSG:3826)，兩方向線形合成一條路線幾何。
   - A 的重合率 = A 落在 B 緩衝區 (BUFFER_M) 內的長度 ÷ A 總長。
   - OVERLAP_MODE = "both"   : A、B 互相重合率都 >= 80% 才合併 (預設，走廊幾乎相同)
                    "either" : 任一方 >= 80% 即合併 (短的區間車/支線會併入較長的主線)
   - 主支線 (105 / 105副 / 105延) 與不同編號路線用同一規則判斷；
     以 union-find 取連通組 (A~B、B~C → A、B、C 同組)。
   - 一組的班次 = 組內各路線班次加總。

4. 五級分類：對「組」的班次做 Fisher-Jenks 自然斷點 (CLASS_METHOD 可改 "quantile")。
   班次為 0 的組不參與分級，class = 0。

5. 輸出 analysis/output/taichung_bus_frequency.gpkg
   - weekday_groups / weekend_groups : 每組一筆 (合併線形)，含 class 1~5
   - weekday_routes / weekend_routes : 每條路線一筆，帶所屬組與分級
   並輸出同名 CSV，載入目前 QGIS 專案且套用分級圖例。
"""

import csv
import gzip
import json
import os
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict

from qgis.core import (
    QgsApplication,
    QgsCategorizedSymbolRenderer,
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsFeature,
    QgsFeatureRequest,
    QgsField,
    QgsFields,
    QgsGeometry,
    QgsLineSymbol,
    QgsProject,
    QgsRendererCategory,
    QgsSpatialIndex,
    QgsVectorFileWriter,
    QgsVectorLayer,
)
from qgis.core import Qgis

if Qgis.QGIS_VERSION_INT >= 33800:  # QGIS 3.38+ 欄位型別改用 QMetaType
    from qgis.PyQt.QtCore import QMetaType
    T_STR, T_INT, T_DBL = QMetaType.Type.QString, QMetaType.Type.Int, QMetaType.Type.Double
else:
    from qgis.PyQt.QtCore import QVariant
    T_STR, T_INT, T_DBL = QVariant.String, QVariant.Int, QVariant.Double

# ---------------------------------------------------------------- 參數
OVERLAP_THRESHOLD = 0.80     # 重合率門檻
OVERLAP_MODE = "both"        # "both" 或 "either" (見上方說明)
BUFFER_M = 30.0              # 視為同一道路的距離 (公尺)，涵蓋雙向車道分隔
N_CLASSES = 5
CLASS_METHOD = "jenks"       # "jenks" (自然斷點) 或 "quantile" (分位數)
REFRESH_CACHE = False        # True：忽略快取重新下載 TDX 資料
TDX_MIN_INTERVAL = 21.0      # 秒；TDX 金鑰限制每分鐘 3 次 (含取 token)，每次呼叫至少間隔此秒數
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
WEEKEND = ["Saturday", "Sunday"]

# TDX 金鑰：環境變數 TDX_CLIENT_ID / TDX_CLIENT_SECRET 優先，
# 其次讀 repo 根目錄 tdx-key.local.js，再其次填在這裡 (勿上傳版控)。
TDX_CLIENT_ID = ""
TDX_CLIENT_SECRET = ""

# ---------------------------------------------------------------- 路徑
try:
    ANALYSIS_DIR = os.path.dirname(os.path.abspath(__file__))
except NameError:  # QGIS 主控台 exec() 時可能沒有 __file__
    ANALYSIS_DIR = r"C:\Users\user\Desktop\Transport Data\metro_style_transit_info_web\analysis"
REPO_DIR = os.path.dirname(ANALYSIS_DIR)
CACHE_DIR = os.path.join(ANALYSIS_DIR, "cache")
OUT_DIR = os.path.join(ANALYSIS_DIR, "output")
GPKG = os.path.join(OUT_DIR, "taichung_bus_frequency.gpkg")

TDX_AUTH = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
TDX_BASE = "https://tdx.transportdata.tw/api/basic/v2/Bus"

CLASS_COLORS = ["#fee391", "#fec44f", "#fe9929", "#d95f0e", "#993404"]  # 低 → 高頻
CLASS_WIDTHS = [0.4, 0.7, 1.1, 1.6, 2.2]


def log(*a):
    print("[bus-freq]", *a)
    try:
        QgsApplication.processEvents()
    except Exception:
        pass


# ================================================================ TDX
def tdx_key():
    cid = os.environ.get("TDX_CLIENT_ID") or TDX_CLIENT_ID
    sec = os.environ.get("TDX_CLIENT_SECRET") or TDX_CLIENT_SECRET
    if cid and sec:
        return cid, sec
    f = os.path.join(REPO_DIR, "tdx-key.local.js")
    if os.path.exists(f):
        txt = open(f, encoding="utf-8").read()
        m1, m2 = re.search(r'id:\s*"([^"]+)"', txt), re.search(r'secret:\s*"([^"]+)"', txt)
        if m1 and m2:
            return m1.group(1), m2.group(1)
    raise RuntimeError("找不到 TDX 金鑰：請設定 TDX_CLIENT_ID / TDX_CLIENT_SECRET")


_token = {}
_last_call = [0.0]
TOKEN_CACHE = os.path.join(CACHE_DIR, "token.json")  # token 有效約 1 天，存檔避免每次執行都取


def throttle():
    wait = _last_call[0] + TDX_MIN_INTERVAL - time.time()
    if wait > 0:
        log("TDX 限速，等待 %.0f 秒…" % wait)
        time.sleep(wait)
    _last_call[0] = time.time()


def tdx_token():
    if not _token and os.path.exists(TOKEN_CACHE):
        try:
            _token.update(json.load(open(TOKEN_CACHE, encoding="utf-8")))
        except ValueError:
            pass
    if _token.get("exp", 0) > time.time() + 300:
        return _token["v"]
    cid, sec = tdx_key()
    throttle()
    body = urllib.parse.urlencode({"grant_type": "client_credentials",
                                   "client_id": cid, "client_secret": sec}).encode()
    req = urllib.request.Request(TDX_AUTH, data=body,
                                 headers={"content-type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            js = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError("TDX 金鑰驗證失敗 (%s)：%s" % (e.code, e.read()[:200])) from e
    _token.update(v=js["access_token"], exp=time.time() + js.get("expires_in", 3600))
    os.makedirs(CACHE_DIR, exist_ok=True)
    json.dump(_token, open(TOKEN_CACHE, "w", encoding="utf-8"))
    return _token["v"]


def tdx_get(path, params):
    url = "%s/%s?%s" % (TDX_BASE, path, urllib.parse.urlencode(dict(params, **{"$format": "JSON"})))
    for attempt in range(3):
        token = tdx_token()
        throttle()
        req = urllib.request.Request(url, headers={"authorization": "Bearer " + token,
                                                   "accept-encoding": "gzip"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:            # 頻率上限：等一下再試
                log("TDX 429，等待 60 秒…")
                time.sleep(60)
                continue
            if e.code == 401:
                _token.clear()
                if os.path.exists(TOKEN_CACHE):
                    os.remove(TOKEN_CACHE)
                continue
            raise
    raise RuntimeError("TDX 重試失敗：" + url)


def tdx_all(path):
    """一次抓完整資料集 (不分頁，省 API 次數)"""
    log("下載 %s …" % path)
    rows = tdx_get(path, {})
    log("%s：%d 筆" % (path, len(rows)))
    return rows


def cached(name, fetch, fallback=None):
    os.makedirs(CACHE_DIR, exist_ok=True)
    f = os.path.join(CACHE_DIR, name)
    if not REFRESH_CACHE:
        for p in (f, fallback):
            if p and os.path.exists(p):
                log("使用快取", p)
                return json.load(open(p, encoding="utf-8"))
    data = fetch()
    json.dump(data, open(f, "w", encoding="utf-8"), ensure_ascii=False)
    return data


# ================================================================ 班次
def zh(x):
    return (x or {}).get("Zh_tw") or ""


# ServiceTag：平日只採 平常日/無標記，假日只採 節假日/無標記；
# 春節、寒暑假、臨時調度屬特殊時期班表，不列入一般日。
SPECIAL_TAGS = {"春節", "寒暑假", "臨時調度"}


def runs_on(service_day, day):
    # 沒有 ServiceDay 視為每日行駛
    if service_day is None:
        return True
    tag = service_day.get("ServiceTag")
    if tag in SPECIAL_TAGS:
        return False
    if tag == "節假日" and day in WEEKDAYS:
        return False
    if tag == "平常日" and day in WEEKEND:
        return False
    return bool(service_day.get(day))


def to_min(hhmm):
    h, m = hhmm.split(":")[:2]
    return int(h) * 60 + int(m)


def record_trips(rec, day):
    """一筆 Schedule (子路線 + 方向) 在某星期的發車班次"""
    tt = rec.get("Timetables") or []
    seen, n = set(), 0
    for t in tt:
        if not runs_on(t.get("ServiceDay"), day):
            continue
        tid = t.get("TripID")
        if tid:
            if tid in seen:
                continue
            seen.add(tid)
        n += 1
    if n:
        return float(n), "timetable"
    est, any_period = 0.0, False
    for f in rec.get("Frequencys") or []:
        if not runs_on(f.get("ServiceDay"), day):
            continue
        try:
            s, e = to_min(f["StartTime"]), to_min(f["EndTime"])
        except (KeyError, ValueError):
            continue
        if e <= s:
            e += 1440
        hw = [v for v in (f.get("MinHeadwayMins"), f.get("MaxHeadwayMins")) if v]
        if not hw:
            continue
        est += (e - s) / (sum(hw) / len(hw))   # 時段長 ÷ 平均班距
        any_period = True
    if any_period:
        est = float(int(est) + 1)              # 首班 +1 (相鄰時段不重複計)
    return est, ("frequency" if est else "")


def daily_trips(schedule):
    """RouteName → {day: 單向每日發車班次}, RouteName → 資料來源

    單向班次：各子路線取班次較多的方向 (TDX 部分路線只列一個方向，
    兩方向相加會讓只有單方向資料的路線被低估)，再加總子路線。
    """
    by_sub = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    src = defaultdict(set)
    for rec in schedule:
        route = zh(rec.get("RouteName"))
        if not route:
            continue
        sub = zh(rec.get("SubRouteName")) or route
        for day in WEEKDAYS + WEEKEND:
            n, s = record_trips(rec, day)
            by_sub[(route, sub)][day][rec.get("Direction")] += n
            if s:
                src[route].add(s)
    by_route = defaultdict(lambda: defaultdict(float))
    for (route, _), days in by_sub.items():
        for day, dirs in days.items():
            by_route[route][day] += max(dirs.values())
    return by_route, {k: "+".join(sorted(v)) for k, v in src.items()}


# ================================================================ 線形與重合
def route_geometries(shapes):
    """RouteName → QgsGeometry (EPSG:3826，各子路線、兩方向合併)"""
    xf = QgsCoordinateTransform(QgsCoordinateReferenceSystem("EPSG:4326"),
                                QgsCoordinateReferenceSystem("EPSG:3826"), QgsProject.instance())
    parts = defaultdict(list)
    for s in shapes:
        route, wkt = zh(s.get("RouteName")), s.get("Geometry")
        if not route or not wkt:
            continue
        g = QgsGeometry.fromWkt(wkt)
        if g.isNull() or g.isEmpty():
            continue
        g.transform(xf)
        parts[route].append(g)
    return {r: QgsGeometry.unaryUnion(gs) if len(gs) > 1 else gs[0] for r, gs in parts.items()}


class UnionFind:
    def __init__(self, items):
        self.p = {i: i for i in items}

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb, key=route_sort_key)] = min(ra, rb, key=route_sort_key)


def route_sort_key(name):
    m = re.match(r"(\d+)(.*)", name)
    return (0, int(m.group(1)), m.group(2)) if m else (1, 0, name)


def overlap_pairs(geoms):
    """回傳 [(A, B, A在B的重合率, B在A的重合率)]，只列有空間交集的配對"""
    names = sorted(geoms, key=route_sort_key)
    buf = {r: geoms[r].buffer(BUFFER_M, 4) for r in names}
    length = {r: geoms[r].length() for r in names}
    idx = QgsSpatialIndex()
    for i, r in enumerate(names):
        idx.addFeature(i, buf[r].boundingBox())  # QGIS >= 3.30：addFeature(id, rect)
    def ratio(a, b):
        if length[a] <= 0:
            return 0.0
        return geoms[a].intersection(buf[b]).length() / length[a]
    out = []
    for i, a in enumerate(names):
        if i % 50 == 0:
            log("計算重合 %d / %d" % (i, len(names)))
        for j in idx.intersects(buf[a].boundingBox()):
            if j <= i:
                continue
            b = names[j]
            if not buf[a].intersects(buf[b]):
                continue
            rab = ratio(a, b)
            if OVERLAP_MODE == "both" and rab < OVERLAP_THRESHOLD:
                continue  # 已不可能合併，省掉反向計算
            out.append((a, b, rab, ratio(b, a)))
    return out


def group_routes(names, pairs):
    uf = UnionFind(names)
    for a, b, rab, rba in pairs:
        ok = (min(rab, rba) if OVERLAP_MODE == "both" else max(rab, rba)) >= OVERLAP_THRESHOLD
        if ok:
            uf.union(a, b)
    groups = defaultdict(list)
    for n in names:
        groups[uf.find(n)].append(n)
    return {k: sorted(v, key=route_sort_key) for k, v in groups.items()}


# ================================================================ 分級
def jenks_breaks(values, k):
    """Fisher-Jenks 自然斷點 (最佳化組內變異)，回傳 k+1 個邊界"""
    data = sorted(values)
    n = len(data)
    if n == 0:
        return []
    k = min(k, len(set(data)))
    lower = [[0] * (k + 1) for _ in range(n + 1)]
    var = [[float("inf")] * (k + 1) for _ in range(n + 1)]
    for j in range(1, k + 1):
        lower[1][j] = 1
        var[1][j] = 0.0
    for l in range(2, n + 1):
        s1 = s2 = w = 0.0
        for m in range(1, l + 1):
            i3 = l - m + 1
            v = data[i3 - 1]
            s2 += v * v
            s1 += v
            w += 1
            cost = s2 - (s1 * s1) / w
            i4 = i3 - 1
            if i4:
                for j in range(2, k + 1):
                    if var[l][j] >= cost + var[i4][j - 1]:
                        lower[l][j] = i3
                        var[l][j] = cost + var[i4][j - 1]
        lower[l][1] = 1
        var[l][1] = cost
    breaks = [0.0] * (k + 1)
    breaks[k], breaks[0] = data[-1], data[0]
    cnt = n
    for j in range(k, 1, -1):
        idx = lower[cnt][j] - 2
        breaks[j - 1] = data[idx]
        cnt = lower[cnt][j] - 1
    return breaks


def quantile_breaks(values, k):
    data = sorted(values)
    k = min(k, len(set(data)))
    return [data[0]] + [data[min(len(data) - 1, int(round(len(data) * q / k)) - 1)]
                        for q in range(1, k)] + [data[-1]]


def classify(v, breaks):
    if v <= 0 or not breaks:
        return 0
    for c in range(1, len(breaks)):
        if v <= breaks[c]:
            return c
    return len(breaks) - 1


# ================================================================ 輸出
def make_fields(kind):
    f = QgsFields()
    if kind == "groups":
        defs = [("group_id", T_STR), ("routes", T_STR), ("n_routes", T_INT)]
    else:
        defs = [("route", T_STR), ("group_id", T_STR),
                ("group_routes", T_STR), ("route_trips", T_DBL),
                ("source", T_STR)]
    defs += [("trips", T_DBL), ("class", T_INT), ("class_label", T_STR),
             ("length_km", T_DBL)]
    for n, t in defs:
        f.append(QgsField(n, t))
    return f


def write_layer(name, kind, rows):
    layer = QgsVectorLayer("MultiLineString?crs=EPSG:3826", name, "memory")
    pr = layer.dataProvider()
    pr.addAttributes(make_fields(kind).toList())
    layer.updateFields()
    feats = []
    for geom, attrs in rows:
        ft = QgsFeature(layer.fields())
        g = QgsGeometry(geom)
        g.convertToMultiType()
        ft.setGeometry(g)
        for k, v in attrs.items():
            ft[k] = v
        feats.append(ft)
    pr.addFeatures(feats)

    opt = QgsVectorFileWriter.SaveVectorOptions()
    opt.driverName = "GPKG"
    opt.layerName = name
    opt.fileEncoding = "UTF-8"
    opt.actionOnExistingFile = (QgsVectorFileWriter.CreateOrOverwriteLayer if os.path.exists(GPKG)
                                else QgsVectorFileWriter.CreateOrOverwriteFile)
    res = QgsVectorFileWriter.writeAsVectorFormatV3(layer, GPKG, QgsProject.instance().transformContext(), opt)
    if res[0] != QgsVectorFileWriter.NoError:
        raise RuntimeError("寫入 %s 失敗：%s" % (name, res[1]))
    with open(os.path.join(OUT_DIR, name + ".csv"), "w", encoding="utf-8-sig", newline="") as fh:
        keys = [f.name() for f in make_fields(kind)]
        w = csv.DictWriter(fh, keys)
        w.writeheader()
        for _, attrs in sorted(rows, key=lambda r: (-r[1]["trips"], r[1].get("group_id", ""))):
            w.writerow({k: attrs.get(k) for k in keys})


def style_layer(layer, labels):
    cats = []
    sym0 = QgsLineSymbol.createSimple({"color": "#bdbdbd", "width": "0.3", "line_style": "dash"})
    cats.append(QgsRendererCategory(0, sym0, "0 無班次"))
    for c in range(1, len(labels) + 1):
        sym = QgsLineSymbol.createSimple({"color": CLASS_COLORS[c - 1], "width": str(CLASS_WIDTHS[c - 1]),
                                          "capstyle": "round", "joinstyle": "round"})
        cats.append(QgsRendererCategory(c, sym, labels[c - 1]))
    r = QgsCategorizedSymbolRenderer("class", cats)
    # 高頻畫在上層
    r.setOrderBy(QgsFeatureRequest.OrderBy([QgsFeatureRequest.OrderByClause("class", True)]))
    r.setOrderByEnabled(True)
    layer.setRenderer(r)


def run_period(tag, days, trips_by_route, src, geoms, groups):
    title = "平日 (一~五)" if tag == "weekday" else "假日 (六日)"
    route_trips = {r: sum(trips_by_route.get(r, {}).get(d, 0.0) for d in days) / len(days) for r in geoms}
    group_trips = {gid: sum(route_trips[r] for r in rs) for gid, rs in groups.items()}

    vals = [v for v in group_trips.values() if v > 0]
    breaks = (jenks_breaks if CLASS_METHOD == "jenks" else quantile_breaks)(vals, N_CLASSES)
    labels = ["%d  %s%.1f – %.1f 班/日" % (c, ">" if c > 1 else "", breaks[c - 1], breaks[c])
              for c in range(1, len(breaks))]
    log("%s 斷點：%s" % (title, ", ".join("%.1f" % b for b in breaks)))

    g_rows, r_rows = [], []
    for gid, rs in groups.items():
        v = round(group_trips[gid], 1)
        c = classify(group_trips[gid], breaks)
        lab = labels[c - 1] if c else "0 無班次"
        geom = QgsGeometry.unaryUnion([geoms[r] for r in rs]) if len(rs) > 1 else geoms[rs[0]]
        g_rows.append((geom, {"group_id": gid, "routes": ", ".join(rs), "n_routes": len(rs),
                              "trips": v, "class": c, "class_label": lab,
                              "length_km": round(geom.length() / 1000, 2)}))
        for r in rs:
            r_rows.append((geoms[r], {"route": r, "group_id": gid, "group_routes": ", ".join(rs),
                                      "route_trips": round(route_trips[r], 1), "source": src.get(r, ""),
                                      "trips": v, "class": c, "class_label": lab,
                                      "length_km": round(geoms[r].length() / 1000, 2)}))

    write_layer(tag + "_groups", "groups", g_rows)
    write_layer(tag + "_routes", "routes", r_rows)
    for c in range(len(labels) + 1):
        n = sum(1 for _, a in g_rows if a["class"] == c)
        log("  class %d：%d 組  %s" % (c, n, labels[c - 1] if c else "無班次"))
    return labels, title


def add_to_project(results):
    try:
        from qgis.utils import iface
    except ImportError:
        iface = None
    if iface is None:  # 獨立執行：只輸出檔案
        return
    proj = QgsProject.instance()
    root = proj.layerTreeRoot()
    old = root.findGroup("臺中公車發車頻率")
    if old:
        for lyr in old.findLayers():
            proj.removeMapLayer(lyr.layerId())
        root.removeChildNode(old)
    grp = root.insertGroup(0, "臺中公車發車頻率")
    for tag, (labels, title) in results.items():
        sub = grp.addGroup(title)
        for kind, vis in (("groups", True), ("routes", False)):
            lyr = QgsVectorLayer("%s|layername=%s_%s" % (GPKG, tag, kind),
                                 "%s %s" % (title, "路線組 (分級)" if kind == "groups" else "個別路線"), "ogr")
            if not lyr.isValid():
                continue
            style_layer(lyr, labels)
            proj.addMapLayer(lyr, False)
            node = sub.addLayer(lyr)
            node.setItemVisibilityChecked(vis)
        sub.setItemVisibilityChecked(tag == "weekday")


# ================================================================ main
def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    if QgsApplication.instance() is None:  # 獨立執行 (python-qgis)
        global _qgs
        _qgs = QgsApplication([], False)
        _qgs.initQgis()
    shapes = cached("shape_taichung.json", lambda: tdx_all("Shape/City/Taichung"),
                    fallback=os.path.join(REPO_DIR, "tools", "shape_all.json"))
    schedule = cached("schedule_taichung.json", lambda: tdx_all("Schedule/City/Taichung"))

    geoms = route_geometries(shapes)
    trips_by_route, src = daily_trips(schedule)
    no_shape = sorted(set(trips_by_route) - set(geoms), key=route_sort_key)
    no_sched = sorted(set(geoms) - set(trips_by_route), key=route_sort_key)
    log("路線：線形 %d 條，班表 %d 條" % (len(geoms), len(trips_by_route)))
    if no_shape:
        log("有班表無線形 (不納入)：", ", ".join(no_shape))
    if no_sched:
        log("有線形無班表 (班次 0)：", ", ".join(no_sched))

    pairs = overlap_pairs(geoms)
    groups = group_routes(list(geoms), pairs)
    merged = {g: rs for g, rs in groups.items() if len(rs) > 1}
    log("重合 >= %d%% (%s) 合併：%d 組含多條路線" % (OVERLAP_THRESHOLD * 100, OVERLAP_MODE, len(merged)))
    for g, rs in sorted(merged.items(), key=lambda x: route_sort_key(x[0])):
        log("  ", " + ".join(rs))
    with open(os.path.join(OUT_DIR, "overlap_pairs.csv"), "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["route_a", "route_b", "a_in_b", "b_in_a"])
        for a, b, rab, rba in sorted(pairs, key=lambda p: -min(p[2], p[3])):
            if max(rab, rba) >= 0.5:
                w.writerow([a, b, round(rab, 3), round(rba, 3)])

    results = {
        "weekday": run_period("weekday", WEEKDAYS, trips_by_route, src, geoms, groups),
        "weekend": run_period("weekend", WEEKEND, trips_by_route, src, geoms, groups),
    }
    add_to_project(results)
    log("完成：", GPKG)


main()

# 獨立執行 (不開 QGIS 介面)：
#   "C:\Program Files\QGIS 3.44.13\bin\python-qgis.bat" analysis\taichung_bus_frequency_classes.py
# 只輸出 GPKG / CSV (不套圖例)，之後在 QGIS 開啟 GPKG。

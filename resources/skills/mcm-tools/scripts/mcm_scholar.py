#!/usr/bin/env python3
"""文献检索。

数据源（都无需 API Key）:
    openalex   主源，覆盖广、有引用数与被引关系
    crossref   备用源，DOI 权威

用法:
    python mcm_scholar.py search "vehicle routing problem multi-objective" --limit 8
    python mcm_scholar.py search "城市配送 路径规划" --limit 5 --year-from 2018 --json
    python mcm_scholar.py get 10.1016/j.ejor.2019.01.001

输出会带 **可直接粘进参考文献的条目**（按常见竞赛要求的句式）。
⚠️ 生成的是**待核对草稿** —— 作者名、卷期页码必须对着原文核一遍再进论文。

退出码: 0 成功 / 1 参数问题 / 2 网络或解析失败
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

UA = "mcm-tools/1.0 (mailto:noreply@example.com)"
TIMEOUT = 30


def _proxy_opener():
    """尊重 http_proxy / https_proxy 环境变量（沙箱里出网要靠代理）。"""
    proxy = os.environ.get("https_proxy") or os.environ.get("http_proxy")
    if proxy:
        h = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        return urllib.request.build_opener(h)
    return urllib.request.build_opener()


def fetch_json(url, tries=2):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with _proxy_opener().open(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:
            last = e
    raise last


# ---------------------------------------------------------------- openalex

def oa_search(query, limit=8, year_from=None, year_to=None):
    params = {
        "search": query,
        "per_page": str(min(limit, 50)),
        "select": "id,doi,title,publication_year,authorships,primary_location,"
                  "cited_by_count,type",
    }
    if year_from or year_to:
        lo = year_from or 1900
        hi = year_to or 2100
        params["filter"] = "publication_year:%d-%d" % (lo, hi)
    url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params)
    data = fetch_json(url)
    out = []
    for w in data.get("results", []):
        authors = []
        for a in (w.get("authorships") or [])[:6]:
            nm = (a.get("author") or {}).get("display_name")
            if nm:
                authors.append(nm)
        loc = w.get("primary_location") or {}
        src = (loc.get("source") or {}).get("display_name")
        out.append({
            "title": w.get("title") or "(无标题)",
            "year": w.get("publication_year"),
            "authors": authors,
            "venue": src,
            "doi": (w.get("doi") or "").replace("https://doi.org/", "") or None,
            "cited_by": w.get("cited_by_count"),
            "openalex_id": (w.get("id") or "").split("/")[-1],
        })
    return out


def to_citation(rec):
    """按常见竞赛参考文献句式生成草稿（标点照官方，不改成文献管理工具的格式）。"""
    au = "，".join(rec.get("authors") or [])
    if len(rec.get("authors") or []) > 3:
        au = "，".join(rec["authors"][:3]) + "，等"
    au = au or "（作者待补）"
    title = rec.get("title") or ""
    venue = rec.get("venue") or "（期刊/会议待补）"
    year = rec.get("year") or "（年待补）"
    if rec.get("doi"):
        return "[编号] %s，%s，%s，%s。DOI: %s" % (au, title, venue, year, rec["doi"])
    return "[编号] %s，%s，%s，%s。" % (au, title, venue, year)


# ---------------------------------------------------------------- crossref

def cr_search(query, limit=8):
    url = "https://api.crossref.org/works?" + urllib.parse.urlencode(
        {"query": query, "rows": str(min(limit, 50))})
    data = fetch_json(url)
    out = []
    for it in (data.get("message") or {}).get("items", []):
        au = []
        for a in (it.get("author") or [])[:6]:
            nm = " ".join(x for x in [a.get("given"), a.get("family")] if x)
            if nm:
                au.append(nm)
        out.append({
            "title": (it.get("title") or ["(无标题)"])[0],
            "year": ((it.get("issued") or {}).get("date-parts") or [[None]])[0][0],
            "authors": au,
            "venue": (it.get("container-title") or [None])[0],
            "doi": it.get("DOI"),
            "cited_by": it.get("is-referenced-by-count"),
        })
    return out


# ---------------------------------------------------------------- cmd

def cmd_search(args):
    try:
        if args.source == "crossref":
            recs = cr_search(args.query, args.limit)
        else:
            recs = oa_search(args.query, args.limit, args.year_from, args.year_to)
    except Exception as e:
        print("[mcm-scholar] 检索失败: %s" % e, file=sys.stderr)
        print("[mcm-scholar] 检查网络/代理（需要能访问 api.openalex.org）", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps({"query": args.query, "source": args.source, "results": recs},
                         ensure_ascii=False))
    else:
        print("检索「%s」 · 来源 %s · %d 条" % (args.query, args.source, len(recs)))
        print()
        for i, r in enumerate(recs, 1):
            au = "、".join(r.get("authors") or []) or "（作者未知）"
            print("%d. %s" % (i, r["title"]))
            print("   %s  %s  %s" % (au, r.get("venue") or "", r.get("year") or ""))
            extra = []
            if r.get("cited_by") is not None:
                extra.append("被引 %s" % r["cited_by"])
            if r.get("doi"):
                extra.append("DOI %s" % r["doi"])
            if extra:
                print("   " + " · ".join(extra))
            print("   参考文献草稿: %s" % to_citation(r))
            print()
    return 0


def cmd_get(args):
    doi = args.doi.replace("https://doi.org/", "")
    try:
        d = fetch_json("https://api.crossref.org/works/" + urllib.parse.quote(doi))
    except Exception as e:
        print("[mcm-scholar] 查询失败: %s" % e, file=sys.stderr)
        return 2
    m = d.get("message") or {}
    rec = {
        "title": (m.get("title") or ["(无标题)"])[0],
        "year": ((m.get("issued") or {}).get("date-parts") or [[None]])[0][0],
        "authors": [" ".join(x for x in [a.get("given"), a.get("family")] if x)
                    for a in (m.get("author") or [])],
        "venue": (m.get("container-title") or [None])[0],
        "doi": m.get("DOI"),
        "volume": m.get("volume"), "issue": m.get("issue"), "page": m.get("page"),
    }
    if args.json:
        print(json.dumps(rec, ensure_ascii=False))
    else:
        for k, v in rec.items():
            print("  %-8s %s" % (k, v))
        print()
        print("  参考文献草稿: %s" % to_citation(rec))
    return 0


def main():
    ap = argparse.ArgumentParser(description="文献检索（OpenAlex / Crossref，无需 Key）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("search", help="按关键词检索")
    p1.add_argument("query")
    p1.add_argument("--limit", type=int, default=8)
    p1.add_argument("--source", choices=["openalex", "crossref"], default="openalex")
    p1.add_argument("--year-from", type=int, default=None)
    p1.add_argument("--year-to", type=int, default=None)
    p1.add_argument("--json", action="store_true")
    p1.set_defaults(func=cmd_search)

    p2 = sub.add_parser("get", help="按 DOI 查详情")
    p2.add_argument("doi")
    p2.add_argument("--json", action="store_true")
    p2.set_defaults(func=cmd_get)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()

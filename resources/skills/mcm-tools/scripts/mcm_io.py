#!/usr/bin/env python3
"""读入工具：PDF 文本 / Excel / CSV。

设计要点（踩过的坑）：
  - **不要用 pandas.read_excel() 的默认 header=0**。表头结构未知时，
    第一行数据会被当成列名，后面全错。这里默认不做表头推断。
  - 读进来要能**断言行数**，跟题目声明的记录数对上才继续。
  - PDF 按页读，题目的「附件1 第 3 页」这种指代要能精确定位。

用法:
    python mcm_io.py pdf   input/赛题.pdf --pages 1-3
    python mcm_io.py xlsx  input/附件1.xlsx --sheet 0 --head 10
    python mcm_io.py xlsx  input/附件1.xlsx --expect-rows 7470
    python mcm_io.py csv   input/data.csv --head 5
    python mcm_io.py info  input/          # 列出目录下所有可读材料

退出码: 0 成功 / 1 参数或依赖问题 / 2 读取失败 / 3 断言不符
"""

import argparse
import csv
import json
import os
import sys


def fail(code, msg):
    print("[mcm-io] 错误: %s" % msg, file=sys.stderr)
    sys.exit(code)


# ---------------------------------------------------------------- PDF

def read_pdf(path, pages=None, max_chars=None):
    """按页抽文本。返回 [(页码从1起, 文本)]。"""
    if not os.path.isfile(path):
        fail(2, "文件不存在: %s" % path)
    try:
        from pypdf import PdfReader
    except ImportError:
        fail(1, "缺少 pypdf，请先安装：pip install pypdf")

    reader = PdfReader(path)
    total = len(reader.pages)
    idxs = range(total)
    if pages:
        lo, hi = pages
        idxs = [i for i in range(total) if lo <= i + 1 <= hi]

    out = []
    for i in idxs:
        try:
            text = reader.pages[i].extract_text() or ""
        except Exception as e:                      # 单页失败不该拖垮整篇
            text = "<<该页抽取失败: %s>>" % e
        if max_chars and len(text) > max_chars:
            text = text[:max_chars] + "\n…（已截断）"
        out.append((i + 1, text))
    return total, out


def cmd_pdf(args):
    pages = None
    if args.pages:
        try:
            a, _, b = args.pages.partition("-")
            pages = (int(a), int(b) if b else int(a))
        except ValueError:
            fail(1, "--pages 格式应为 3 或 1-3")

    total, items = read_pdf(args.path, pages, args.max_chars)
    print("[mcm-io] %s  共 %d 页，抽取 %d 页" % (args.path, total, len(items)), file=sys.stderr)

    if args.json:
        print(json.dumps({"path": args.path, "total_pages": total,
                          "pages": [{"page": p, "text": t} for p, t in items]},
                         ensure_ascii=False))
    else:
        for p, t in items:
            print("=" * 60)
            print("第 %d 页" % p)
            print("=" * 60)
            print(t.strip() or "（该页无可抽取文本，可能是扫描件/图片）")
            print()
    return 0


# ---------------------------------------------------------------- XLSX

def read_xlsx(path, sheet=0, header=False, expect_rows=None, head=None):
    """读 XLSX。默认不做表头推断 —— 表头结构未知时默认推断会让第一行数据变列名。"""
    if not os.path.isfile(path):
        fail(2, "文件不存在: %s" % path)
    try:
        from openpyxl import load_workbook
    except ImportError:
        fail(1, "缺少 openpyxl，请先安装：pip install openpyxl")

    wb = load_workbook(path, read_only=True, data_only=True)
    names = wb.sheetnames
    if isinstance(sheet, int):
        if sheet >= len(names):
            fail(1, "工作表索引 %d 超出范围，本文件有 %d 个表：%s" % (sheet, len(names), names))
        ws = wb.worksheets[sheet]
    else:
        if sheet not in names:
            fail(1, "工作表 %s 不存在，本文件有：%s" % (sheet, names))
        ws = wb[sheet]

    rows = [tuple(r) for r in ws.iter_rows(values_only=True)]
    while rows and not any(v is not None for v in rows[-1]):   # 去掉尾部空行
        rows.pop()
    wb.close()

    cols = None
    if header:
        if rows:
            cols = list(rows.pop(0))
    if expect_rows is not None and len(rows) != expect_rows:
        fail(3, "工作表实际 %d 行，题目声明 %d 行 —— 行数不符，不要继续建模"
             % (len(rows), expect_rows))

    return {"sheets": names, "sheet": ws.title, "n_rows": len(rows),
            "n_cols": len(rows[0]) if rows else 0, "columns": cols,
            "rows": rows[:head] if head else rows}


def cmd_xlsx(args):
    d = read_xlsx(args.path, args.sheet, args.header, args.expect_rows, args.head)
    print("[mcm-io] %s  工作表=%s  共 %d 个表 %s"
          % (args.path, d["sheet"], len(d["sheets"]), d["sheets"]), file=sys.stderr)
    print("[mcm-io] 数据 %d 行 × %d 列" % (d["n_rows"], d["n_cols"]), file=sys.stderr)

    if args.json:
        print(json.dumps(d, ensure_ascii=False, default=str))
    else:
        if d["columns"]:
            print("列名: %s" % d["columns"])
        for i, r in enumerate(d["rows"]):
            print("  [%d] %s" % (i, " | ".join("" if v is None else str(v) for v in r)))
        if args.head and d["n_rows"] > args.head:
            print("  …（共 %d 行，只显示前 %d 行）" % (d["n_rows"], args.head))
    return 0


# ---------------------------------------------------------------- CSV

def cmd_csv(args):
    if not os.path.isfile(args.path):
        fail(2, "文件不存在: %s" % args.path)

    # 编码：中文 CSV 常见 utf-8-sig / gbk，两个都试
    text = None
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            with open(args.path, encoding=enc, newline="") as f:
                text = f.read()
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        fail(2, "编码无法识别（试过 utf-8-sig / utf-8 / gbk）")

    rows = [tuple(r) for r in csv.reader(text.splitlines())]
    while rows and not any(v.strip() for v in rows[-1]):
        rows.pop()

    cols = None
    if args.header and rows:
        cols = list(rows.pop(0))
    if args.expect_rows is not None and len(rows) != args.expect_rows:
        fail(3, "CSV 实际 %d 行，期望 %d 行" % (len(rows), args.expect_rows))

    print("[mcm-io] %s  %d 行 × %d 列"
          % (args.path, len(rows), len(rows[0]) if rows else 0), file=sys.stderr)
    if args.json:
        print(json.dumps({"columns": cols, "n_rows": len(rows),
                          "rows": rows[:args.head] if args.head else rows},
                         ensure_ascii=False))
    else:
        if cols:
            print("列名: %s" % cols)
        for i, r in enumerate(rows[:args.head] if args.head else rows):
            print("  [%d] %s" % (i, " | ".join(r)))
    return 0


# ---------------------------------------------------------------- info

def cmd_info(args):
    """列出目录下可读的材料，方便 Agent 清点四类输入。"""
    d = args.path
    if not os.path.isdir(d):
        fail(2, "不是目录: %s" % d)
    kinds = {".pdf": "PDF", ".xlsx": "Excel", ".xls": "Excel", ".csv": "CSV",
             ".docx": "Word", ".doc": "Word", ".tex": "LaTeX", ".txt": "文本",
             ".md": "文本", ".zip": "压缩包", ".rar": "压缩包", ".png": "图片",
             ".jpg": "图片", ".jpeg": "图片", ".json": "JSON"}
    items = []
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        ext = os.path.splitext(name)[1].lower()
        items.append({"name": name, "kind": kinds.get(ext, "其他"),
                      "bytes": os.path.getsize(p) if os.path.isfile(p) else 0,
                      "is_dir": os.path.isdir(p)})
    if args.json:
        print(json.dumps(items, ensure_ascii=False))
    else:
        print("材料清点 · %s" % d)
        for it in items:
            print("  %-10s %10s  %s" % (it["kind"], "%.1f KB" % (it["bytes"] / 1024), it["name"]))
    return 0


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="读入工具：PDF / Excel / CSV")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("pdf", help="抽取 PDF 文本")
    p1.add_argument("path")
    p1.add_argument("--pages", help="页码范围，如 1-3 或 5")
    p1.add_argument("--max-chars", type=int, default=None, help="每页最多输出多少字符")
    p1.add_argument("--json", action="store_true")
    p1.set_defaults(func=cmd_pdf)

    p2 = sub.add_parser("xlsx", help="读 Excel")
    p2.add_argument("path")
    p2.add_argument("--sheet", default=0, help="工作表名或索引（默认 0）")
    p2.add_argument("--header", action="store_true", help="显式声明首行是表头（默认不推断）")
    p2.add_argument("--expect-rows", type=int, default=None, help="断言数据行数，不符即报错")
    p2.add_argument("--head", type=int, default=None, help="只显示前 N 行")
    p2.add_argument("--json", action="store_true")
    p2.set_defaults(func=cmd_xlsx)

    p3 = sub.add_parser("csv", help="读 CSV")
    p3.add_argument("path")
    p3.add_argument("--header", action="store_true")
    p3.add_argument("--expect-rows", type=int, default=None)
    p3.add_argument("--head", type=int, default=None)
    p3.add_argument("--json", action="store_true")
    p3.set_defaults(func=cmd_csv)

    p4 = sub.add_parser("info", help="列出目录下的材料")
    p4.add_argument("path")
    p4.add_argument("--json", action="store_true")
    p4.set_defaults(func=cmd_info)

    args = ap.parse_args()
    if args.cmd == "xlsx" and isinstance(args.sheet, str):
        args.sheet = int(args.sheet) if args.sheet.isdigit() else args.sheet
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()

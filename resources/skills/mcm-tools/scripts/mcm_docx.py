#!/usr/bin/env python3
"""Word 论文生成。

三个动作:
    inspect  读模板结构（样式、已有章节、可替换的占位符）—— 拿到客户模板先跑这个
    build    按结构化 spec 生成论文（可基于模板，也可从零）
    check    检查产出：标题层级、图/表编号是否连续、有无未替换占位符

用法:
    python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" inspect input/论文模板.docx
    python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" build paper.docx --spec reports/paper_spec.json
    python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" build paper.docx --template input/论文模板.docx --spec reports/paper_spec.json
    python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" check paper.docx

spec 格式（JSON）:
    {
      "title": "论文题目",
      "abstract": {"text": "摘要正文…", "keywords": ["关键词1", "关键词2"]},
      "sections": [
        {"heading": "一、问题重述", "level": 1, "blocks": [
          {"type": "para",  "text": "段落文字"},
          {"type": "list",  "items": ["条目1", "条目2"]},
          {"type": "figure","path": "figures/result_q1_1.png", "caption": "图1 各方案对比"},
          {"type": "table", "caption": "表1 参数设置",
           "header": ["参数", "取值"], "rows": [["α", "0.5"]]},
          {"type": "equation", "text": "y = ax + b", "number": "(1)"},
          {"type": "pagebreak"}
        ]}
      ],
      "references": ["[1] 作者，书名，出版社，页码，年。"]
    }

退出码: 0 成功 / 1 参数或依赖问题 / 2 读取失败 / 3 校验不通过
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys


def fail(code, msg):
    print("[mcm-docx] 错误: %s" % msg, file=sys.stderr)
    sys.exit(code)


def need_docx():
    try:
        import docx  # noqa: F401
        return docx
    except ImportError:
        fail(1, "缺少 python-docx，请先安装：pip install python-docx")


# ---------------------------------------------------------------- 字体

# 中文论文常用：正文小四宋体、标题黑体。模板里有样式就优先用模板的。
CN_BODY = "宋体"
CN_HEAD = "黑体"
EN_FONT = "Times New Roman"


def set_run_font(run, cn=CN_BODY, size_pt=12, bold=False):
    """同时设中英文字体 —— python-docx 不设 eastAsia 的话中文会回落成默认字体。"""
    from docx.oxml.ns import qn
    from docx.shared import Pt
    run.font.name = EN_FONT
    run.font.size = Pt(size_pt)
    run.bold = bold
    rpr = run._element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rf)
    rf.set(qn("w:eastAsia"), cn)
    rf.set(qn("w:ascii"), EN_FONT)
    rf.set(qn("w:hAnsi"), EN_FONT)


# ---------------------------------------------------------------- inspect

def cmd_inspect(args):
    need_docx()
    from docx import Document

    if not os.path.isfile(args.path):
        fail(2, "文件不存在: %s" % args.path)

    doc = Document(args.path)
    paras = doc.paragraphs

    # 章节骨架：按样式名或"看起来像标题"的段落
    outline = []
    for p in paras:
        t = (p.text or "").strip()
        if not t:
            continue
        style = (p.style.name or "") if p.style else ""
        if style.lower().startswith(("heading", "标题")) or re.match(r"^[一二三四五六七八九十]+[、.]", t):
            outline.append({"style": style, "text": t[:80]})

    # 占位符：{{xxx}} / 【xxx】 / XXX 这类
    joined = "\n".join((p.text or "") for p in paras)
    ph = sorted(set(re.findall(r"\{\{\s*([^}]{1,40})\s*\}\}", joined)))
    ph += sorted(set(re.findall(r"【([^】]{1,40})】", joined)))

    styles = sorted({(p.style.name or "") for p in paras if p.style})

    info = {
        "path": args.path,
        "paragraphs": len(paras),
        "tables": len(doc.tables),
        "inline_shapes": len(doc.inline_shapes),
        "styles_used": styles,
        "outline": outline,
        "placeholders": ph,
    }

    if args.json:
        print(json.dumps(info, ensure_ascii=False))
    else:
        print("模板结构 · %s" % args.path)
        print("  段落 %d · 表格 %d · 内嵌图 %d" % (info["paragraphs"], info["tables"], info["inline_shapes"]))
        print("  用到的样式: %s" % (", ".join(styles[:12]) or "（无）"))
        print("\n  章节骨架:")
        for o in outline[:40]:
            print("    [%s] %s" % (o["style"][:14], o["text"]))
        if ph:
            print("\n  占位符: %s" % ", ".join(ph[:30]))
        else:
            print("\n  占位符: （未发现 {{…}} 或【…】形式的占位符）")
    return 0


# ---------------------------------------------------------------- build

def _add_blocks(doc, blocks, stats):
    from docx.shared import Pt, Inches

    for b in blocks:
        t = b.get("type", "para")
        if t == "para":
            p = doc.add_paragraph()
            r = p.add_run(b.get("text", ""))
            set_run_font(r, CN_BODY, 12)
            p.paragraph_format.first_line_indent = Pt(24)      # 首行缩进两字符
            p.paragraph_format.line_spacing = 1.0              # 单倍行距

        elif t == "list":
            for it in b.get("items", []):
                p = doc.add_paragraph(style="List Bullet")
                r = p.add_run(it)
                set_run_font(r, CN_BODY, 12)

        elif t == "figure":
            path = b.get("path", "")
            if not os.path.isfile(path):
                print("[mcm-docx] ⚠ 图不存在，已跳过: %s" % path, file=sys.stderr)
                stats["missing"].append(path)
                continue
            doc.add_picture(path, width=Inches(b.get("width_in", 5.6)))
            doc.paragraphs[-1].alignment = 1                   # 居中
            cap = doc.add_paragraph()
            cap.alignment = 1
            r = cap.add_run(b.get("caption", ""))
            set_run_font(r, CN_BODY, 10.5)
            stats["figures"] += 1

        elif t == "table":
            header = b.get("header") or []
            rows = b.get("rows") or []
            tbl = doc.add_table(rows=0, cols=len(header) or 1)
            tbl.style = "Table Grid"
            if header:
                cells = tbl.add_row().cells
                for i, h in enumerate(header):
                    cells[i].text = ""
                    r = cells[i].paragraphs[0].add_run(str(h))
                    set_run_font(r, CN_HEAD, 10.5, bold=True)
            for row in rows:
                cells = tbl.add_row().cells
                for i, v in enumerate(row):
                    if i >= len(cells):
                        break
                    cells[i].text = ""
                    r = cells[i].paragraphs[0].add_run("" if v is None else str(v))
                    set_run_font(r, CN_BODY, 10.5)             # 表内文字也要小四→这里用五号更紧凑
            if b.get("caption"):
                cap = doc.add_paragraph()
                cap.alignment = 1
                r = cap.add_run(b["caption"])
                set_run_font(r, CN_BODY, 10.5)
            stats["tables"] += 1

        elif t == "equation":
            p = doc.add_paragraph()
            p.alignment = 1
            r = p.add_run(b.get("text", ""))
            set_run_font(r, CN_BODY, 12)
            if b.get("number"):
                r2 = p.add_run("    " + b["number"])
                set_run_font(r2, CN_BODY, 12)
            stats["equations"] += 1

        elif t == "pagebreak":
            doc.add_page_break()


# ---------------------------------------------------------------- 体验版水印

WATERMARK_DEFAULT = "体验版 · 抖音/B站 @汉谟拉比法典"

#: Word 真水印（页眉里的 VML 艺术字，斜排 315°、居中、淡灰）
#: python-docx 没有水印 API，只能把这段原始 XML 注入页眉。
_WM_VML = (
    '<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:v="urn:schemas-microsoft-com:vml" '
    'xmlns:o="urn:schemas-microsoft-com:office:office">'
    '<w:r><w:rPr><w:noProof/></w:rPr><w:pict>'
    '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" '
    'path="m@7,l@8,m@5,21600l@6,21600e">'
    '<v:formulas>'
    '<v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/>'
    '<v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/>'
    '<v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/>'
    '<v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/>'
    '<v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/>'
    '</v:formulas>'
    '<v:path textpathok="t" o:connecttype="custom" '
    'o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" '
    'o:connectangles="270,180,90,0"/>'
    '<v:textpath on="t" fitshape="t"/>'
    '<v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles>'
    '<o:lock v:ext="edit" text="t" shapetype="t"/>'
    '</v:shapetype>'
    '<v:shape id="McmTrialWatermark" o:spid="_x0000_s2049" type="#_x0000_t136" '
    'style="position:absolute;left:0;text-align:left;margin-left:0;margin-top:0;'
    'width:420pt;height:150pt;rotation:315;z-index:-251658752;'
    'mso-position-horizontal:center;mso-position-horizontal-relative:margin;'
    'mso-position-vertical:center;mso-position-vertical-relative:margin" '
    'o:allowincell="f" fillcolor="#c8c8c8" stroked="f">'
    '<v:fill opacity=".45"/>'
    '<v:textpath style="font-family:&quot;宋体&quot;;font-size:1pt" string="__TEXT__"/>'
    '</v:shape>'
    '</w:pict></w:r></w:p>'
)


def is_trial():
    """是不是体验版。由主进程注入环境变量，脚本自己判断 —— 不依赖调用方记得传参。"""
    return os.environ.get("MCM_TRIAL") == "1"


def watermark_text():
    return os.environ.get("MCM_WATERMARK") or WATERMARK_DEFAULT


def apply_watermark(doc):
    """给每个 section 的页眉注入斜排水印。正式版什么都不做。"""
    if not is_trial():
        return False
    from docx.oxml.ns import qn
    import copy

    text = watermark_text().replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
    xml = _WM_VML.replace("__TEXT__", text)
    for sec in doc.sections:
        header = sec.header
        header.is_linked_to_previous = False
        # 清掉已有段落，避免重复叠加
        for p in list(header.paragraphs):
            p._element.getparent().remove(p._element)
        from docx.oxml import parse_xml
        header._element.append(parse_xml(xml))
    return True


def cmd_build(args):
    need_docx()
    from docx import Document

    if not os.path.isfile(args.spec):
        fail(2, "spec 文件不存在: %s" % args.spec)
    try:
        spec = json.load(open(args.spec, encoding="utf-8"))
    except Exception as e:
        fail(2, "spec 不是合法 JSON: %s" % e)

    if args.template:
        if not os.path.isfile(args.template):
            fail(2, "模板不存在: %s" % args.template)
        doc = Document(args.template)
        print("[mcm-docx] 基于模板: %s" % args.template, file=sys.stderr)
    else:
        doc = Document()
        print("[mcm-docx] 从零生成（未用模板）", file=sys.stderr)

    stats = {"figures": 0, "tables": 0, "equations": 0, "missing": []}

    # 题目
    if spec.get("title"):
        p = doc.add_paragraph()
        p.alignment = 1
        r = p.add_run(spec["title"])
        set_run_font(r, CN_HEAD, 16, bold=True)                # 三号黑体居中

    # 摘要
    ab = spec.get("abstract")
    if ab:
        p = doc.add_paragraph()
        p.alignment = 1
        r = p.add_run("摘  要")
        set_run_font(r, CN_HEAD, 14, bold=True)
        if ab.get("text"):
            pp = doc.add_paragraph()
            rr = pp.add_run(ab["text"])
            set_run_font(rr, CN_BODY, 12)
            pp.paragraph_format.first_line_indent = 24
        if ab.get("keywords"):
            pp = doc.add_paragraph()
            rr = pp.add_run("关键词：" + "，".join(ab["keywords"]))
            set_run_font(rr, CN_BODY, 12)
        doc.add_page_break()

    # 正文章节
    for sec in spec.get("sections", []):
        lvl = sec.get("level", 1)
        if sec.get("heading"):
            h = doc.add_heading("", level=lvl)
            r = h.add_run(sec["heading"])
            # 一级标题四号黑体居中；其余层级略小
            set_run_font(r, CN_HEAD, 14 if lvl == 1 else 12, bold=True)
            if lvl == 1:
                h.alignment = 1
        _add_blocks(doc, sec.get("blocks", []), stats)

    # AI 工具使用声明 —— **必须排在参考文献之前**。
    # 依据：全国大学生数学建模竞赛《人工智能工具使用规定（2026 年试行）》第 3 条：
    # 「参赛队应在论文参考文献之前设置"AI工具使用声明"」。
    # 位置写错（比如放文末）等于不符合规定，可能被按违规处理。
    ai = spec.get("ai_declaration")
    if ai:
        h = doc.add_heading("", level=1)
        r = h.add_run("AI 工具使用声明")
        set_run_font(r, CN_HEAD, 14, bold=True)
        h.alignment = 1
        if ai.get("used") is False:
            # 未使用 AI：规定给了固定句式，照抄即可
            p = doc.add_paragraph()
            rr = p.add_run("本参赛队在竞赛过程中未使用任何 AI 工具。")
            set_run_font(rr, CN_BODY, 12)
            p.paragraph_format.first_line_indent = 24
        else:
            purpose = ai.get("purpose") or "语言润色、代码调试等"
            p = doc.add_paragraph()
            rr = p.add_run(
                "本参赛队在竞赛过程中使用了 AI 工具，主要用于【%s】，"
                "详细使用情况见支撑材料。" % purpose
            )
            set_run_font(rr, CN_BODY, 12)
            p.paragraph_format.first_line_indent = 24
            # 使用详情（名称/版本、环节、提示方式、人工核验）—— 规定第 4 条要求
            for item in ai.get("details") or []:
                pp = doc.add_paragraph()
                rr = pp.add_run("· " + item)
                set_run_font(rr, CN_BODY, 12)
                pp.paragraph_format.left_indent = 24

    # 参考文献
    refs = spec.get("references") or []
    if refs:
        h = doc.add_heading("", level=1)
        r = h.add_run("参考文献")
        set_run_font(r, CN_HEAD, 14, bold=True)
        h.alignment = 1
        for it in refs:
            p = doc.add_paragraph()
            rr = p.add_run(it)
            set_run_font(rr, CN_BODY, 12)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    # ⚠️ 水印要在 doc.save() 之前注入，否则文件里没有
    if apply_watermark(doc):
        print("[mcm-docx] 体验版：已加水印", file=sys.stderr)

    doc.save(args.out)

    print("[mcm-docx] 已写出 %s" % args.out, file=sys.stderr)
    print("[mcm-docx] 图 %d · 表 %d · 公式 %d" % (stats["figures"], stats["tables"], stats["equations"]),
          file=sys.stderr)
    for m in stats["missing"]:
        print("[mcm-docx] ⚠ 缺失的图: %s" % m, file=sys.stderr)
    return 0


# ---------------------------------------------------------------- check

def cmd_check(args):
    need_docx()
    from docx import Document

    if not os.path.isfile(args.path):
        fail(2, "文件不存在: %s" % args.path)

    doc = Document(args.path)
    text = "\n".join((p.text or "") for p in doc.paragraphs)

    problems = []

    # 1) 未替换的占位符
    ph = re.findall(r"\{\{\s*[^}]{1,40}\s*\}\}", text) + re.findall(r"【[^】]{1,40}】", text)
    if ph:
        problems.append("还有 %d 处未替换的占位符：%s" % (len(ph), "、".join(ph[:6])))

    # 2) 图/表编号是否连续
    fig_nums = [int(n) for n in re.findall(r"图\s*(\d+)", text)]
    tbl_nums = [int(n) for n in re.findall(r"表\s*(\d+)", text)]
    for label, nums in (("图", fig_nums), ("表", tbl_nums)):
        uniq = sorted(set(nums))
        if uniq and uniq != list(range(uniq[0], uniq[0] + len(uniq))):
            problems.append("%s编号不连续：%s" % (label, uniq))

    # 3) 图片数与图注数是否对得上
    n_pics = len(doc.inline_shapes)
    n_caps = len(set(fig_nums))
    if n_pics and n_caps and n_pics != n_caps:
        problems.append("内嵌图 %d 张，但图注只有 %d 个编号" % (n_pics, n_caps))

    # 4) 参考文献存在性
    if "参考文献" not in text:
        problems.append("没有找到「参考文献」章节")

    # 5) AI 工具使用声明（国赛 2026 起强制，且**必须排在参考文献之前**）
    ai_idx = text.find("AI 工具使用声明")
    if ai_idx < 0:
        ai_idx = text.find("AI工具使用声明")
    ref_idx = text.find("参考文献")
    if ai_idx < 0:
        problems.append("缺少「AI 工具使用声明」章节（国赛 2026 规定：须在参考文献之前声明）")
    elif ref_idx >= 0 and ai_idx > ref_idx:
        problems.append("「AI 工具使用声明」排在参考文献之后 —— 规定要求在参考文献**之前**")
    else:
        # 声明里不能留着模板占位符，那等于没填
        seg = text[ai_idx:ref_idx if ref_idx > ai_idx else ai_idx + 400]
        if "【" in seg and "】" in seg:
            problems.append("「AI 工具使用声明」里还有未填写的【用途】占位符")

    print("产出检查 · %s" % args.path)
    print("  段落 %d · 表格 %d · 内嵌图 %d" % (len(doc.paragraphs), len(doc.tables), n_pics))
    if problems:
        for p in problems:
            print("  ✗ %s" % p)
        return 3
    print("  ✓ 未发现明显问题")
    return 0


# ---------------------------------------------------------------- main

# ---------------------------------------------------------------------------
# PDF 导出
# ---------------------------------------------------------------------------

def find_soffice():
    """找 LibreOffice。首选 —— 不需要任何额外 Python 依赖。"""
    for name in ("soffice", "soffice.exe"):
        p = shutil.which(name)
        if p:
            return p
    for c in (
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/usr/bin/soffice",
        "/usr/local/bin/soffice",
    ):
        if os.path.exists(c):
            return c
    return None


def find_word():
    """找 Word（Windows COM 转换用，需要 pywin32）。"""
    for c in (
        r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE",
        r"C:\Program Files (x86)\Microsoft Office\root\Office16\WINWORD.EXE",
        r"C:\Program Files\Microsoft Office\Office16\WINWORD.EXE",
    ):
        if os.path.exists(c):
            return c
    return None


def _pdf_via_soffice(docx_path, out_dir):
    """LibreOffice 无头转换。"""
    soffice = find_soffice()
    if not soffice:
        return None, "没找到 LibreOffice（soffice）"
    try:
        r = subprocess.run(
            [soffice, "--headless", "--norestore", "--convert-to", "pdf",
             "--outdir", out_dir, docx_path],
            capture_output=True, text=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        return None, "LibreOffice 转换超时（180 秒）"
    out = os.path.join(out_dir, os.path.splitext(os.path.basename(docx_path))[0] + ".pdf")
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return out, None
    return None, "LibreOffice 未产出 PDF。stderr: " + (r.stderr or "").strip()[:200]


def _pdf_via_word(docx_path, out_dir):
    """Word COM 转换。版式与 Word 完全一致，但需要 pywin32。"""
    try:
        import win32com.client  # noqa: F401
    except ImportError:
        return None, "没装 pywin32，无法用 Word 转换"
    if not find_word():
        return None, "没找到 Word"
    try:
        import win32com.client
        word = win32com.client.Dispatch("Word.Application")
        word.Visible = False
        try:
            doc = word.Documents.Open(os.path.abspath(docx_path), ReadOnly=True)
            out = os.path.join(out_dir, os.path.splitext(os.path.basename(docx_path))[0] + ".pdf")
            doc.SaveAs(os.path.abspath(out), FileFormat=17)   # 17 = wdFormatPDF
            doc.Close(False)
            if os.path.exists(out) and os.path.getsize(out) > 0:
                return out, None
            return None, "Word 未产出 PDF"
        finally:
            word.Quit()
    except Exception as e:                                   # noqa: BLE001
        return None, "Word 转换失败：" + str(e)[:200]


def cmd_pdf(args):
    """把 .docx 转成 .pdf。"""
    src = args.path
    if not os.path.exists(src):
        fail(2, "文件不存在：" + src)
    if not src.lower().endswith(".docx"):
        fail(2, "只支持 .docx，收到：" + src)

    out_dir = args.out or os.path.dirname(os.path.abspath(src))
    os.makedirs(out_dir, exist_ok=True)

    engines = []
    if args.engine in ("auto", "soffice"):
        engines.append(("soffice", _pdf_via_soffice))
    if args.engine in ("auto", "word"):
        engines.append(("word", _pdf_via_word))
    if not engines:
        fail(2, "未知引擎：" + args.engine)

    errors = []
    for name, fn in engines:
        path, err = fn(src, out_dir)
        if path:
            print("退出码：0")
            print("--- stdout ---")
            print("已生成 PDF：" + path)
            print("引擎：" + name)
            print("大小：%.1f KB" % (os.path.getsize(path) / 1024))
            return 0
        errors.append("%s: %s" % (name, err))

    fail(1, "所有转换引擎都失败了：\n  " + "\n  ".join(errors))


def main():
    ap = argparse.ArgumentParser(description="Word 论文生成")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("inspect", help="读模板结构")
    p1.add_argument("path")
    p1.add_argument("--json", action="store_true")
    p1.set_defaults(func=cmd_inspect)

    p2 = sub.add_parser("build", help="按 spec 生成论文")
    p2.add_argument("out")
    p2.add_argument("--spec", required=True)
    p2.add_argument("--template", default=None)
    p2.set_defaults(func=cmd_build)

    p3 = sub.add_parser("check", help="检查产出")
    p3.add_argument("path")
    p3.set_defaults(func=cmd_check)

    p4 = sub.add_parser("pdf", help="把 .docx 转成 PDF")
    p4.add_argument("path")
    p4.add_argument("--out", default=None, help="输出目录，默认与源文件同目录")
    p4.add_argument("--engine", choices=["auto", "soffice", "word"], default="auto")
    p4.set_defaults(func=cmd_pdf)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()

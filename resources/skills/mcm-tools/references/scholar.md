# 检索文献

```bash
python skills/mcm-tools/scripts/mcm_scholar.py search "vehicle routing multi-objective" --limit 8
python skills/mcm-tools/scripts/mcm_scholar.py search "城市配送 路径规划" --limit 5 --year-from 2018
python skills/mcm-tools/scripts/mcm_scholar.py get 10.1016/j.ejor.2007.05.055
```

**无需 API Key。** 主源 OpenAlex，备用 Crossref。

---

## ⚠️ 生成的是「草稿」，必须核对

工具会按常见竞赛句式生成参考文献条目：

```
[编号] 作者，论文名，杂志名，卷期号：起止页码，出版年。
```

**但这是草稿，不是终稿。** 进论文前必须核对：

| 核对项 | 为什么 |
|---|---|
| **作者名** | API 返回的是英文原名，中文论文里可能要改写法 |
| **卷期页码** | 检索接口常常**不返回**卷期页码，需要去原文补 |
| **出版年** | 有的记在线年，有的记正式出版年 |
| **标点** | 竞赛规范对句式的标点有硬要求，**照官方句式，不要照文献管理工具的导出格式** |

> 用 Zotero / EndNote 导出常见问题：逗号被换成句点。
> **逐条对照官方句式改回来。**

---

## 常见用法

### 找方法相关的经典文献

```bash
python skills/mcm-tools/scripts/mcm_scholar.py search "multi-objective optimization NSGA-II" --limit 6
```

看 `被引` 数挑经典的（被引高的通常是奠基性工作）。

### 找近年工作

```bash
python skills/mcm-tools/scripts/mcm_scholar.py search "urban delivery route optimization" --limit 8 --year-from 2020
```

### 拿到 DOI 后查完整信息

```bash
python skills/mcm-tools/scripts/mcm_scholar.py get 10.1016/j.ejor.2007.05.055
```

`get` 会返回 `volume` / `issue` / `page` —— 这些正是 `search` 常缺的字段。

---

## 中文关键词

OpenAlex 以英文文献为主，**中文关键词直接搜命中率低**。建议：

1. 先用英文术语搜（`城市配送` → `urban delivery` / `vehicle routing`）
2. 确实需要中文文献时，工具会尽力匹配，但结果有限
3. 中文文献可以从知网 / 万方手动补，再按规范句式录入

---

## 网络

需要能访问 `api.openalex.org` / `api.crossref.org`。

- 有代理时会自动读取 `http_proxy` / `https_proxy` 环境变量
- 离线或网络受限时返回退出码 2，**如实报告阻塞**，不要编造文献

> **绝不编造文献。** 检索不到就说明检索不到，或者让客户提供他手上已有的参考文献列表。
> 编一条看起来很像的假文献，是最容易出事的一类错误。

---

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 参数错误 |
| 2 | 网络或解析失败（含离线） |

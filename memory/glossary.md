# daima — 术语表

> 项目术语速查。首次出现新术语时在这里追加一行。

| 术语 | 含义 |
|------|------|
| **透视王 / Toushiwang** | 本项目逆向/重建的 Chrome 扩展（中英文双名，内容一致）|
| **pdd-library** | 透视王里的拼多多商品数据采集子模块，位于 `ts/source/pdd-library/` |
| **ts/** | TypeScript 版主开发目录，当前版本 5.1.65，包含完整源码 + 构建 |
| **5.1.6x-unpacked** | Chrome 扩展解包目录，每个版本一份，根目录保留 5.1.63/64/65 作为历史快照 |
| **legacy-snapshots** | 删除大目录前抢救的差异文件归档目录，位于 `ts/legacy-snapshots/<version>-diff/` |
| **memory/** | 双层记忆第一层：`mistakes.md` / `decisions.md` / `glossary.md`（追加式）|
| **knowledge/** | 双层记忆第二层：LanceDB 向量库 + `api-maps/crypto/obfuscation/...` 领域知识 |
| **workbench/** | 单个逆向目标的工作目录，每个目标一个子目录 |
| **king** | ZCode 项目脚手架 Skill，本项目用 v0.2.0 结构初始化 |

---

（新术语按上面格式追加）

## [2026-06-25] 汇策 AG-Grid 利润表结构

汇策 ERP (hjy.huice.com) 的「每日利润分析」用 AG-Grid (`v-ag-grid ag-theme-newstyle`)，结构：
- **pinned-left**: 核算项目名（49项，固定列，col-id 是 hash）
- **center**: 数值（本日/昨日/环比/上月同日/同比，5列）
- **店铺选择**: 不是 el-select，是自定义 `.select-tags-box` → 弹出 `.dc-shop` popover → `.level2-item` 列表
- **店铺名格式**: `平台【店名`（如 `拼【周贝瑞`、`淘【童年食光零食店`），前缀标识平台

利润核算 49 项分 10 大类：
1. 销售收入（正向/退款/特殊单/退款费比）
2. 邮费收入
3. 销售成本（赠品/特殊单/商品成本）
4. **毛利** + **销售毛利率**（= (收入-成本) ÷ 收入）
5. 仓库物流费用（快递费/包材费/仓租/仓人工/其他）← 包材费=打包+纸箱
6. 运营推广费用（各平台细分）
7. 平台固定费用（佣金/保险/罚款）
8. 人工成本（运营人员/分摊/其他）
9. 其它费用（房租/水电/行政）
10. 净利润（底部汇总）

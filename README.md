# JK

JK 项目统一维护所有 JK 相关项目的现行规则、已确认设计、可复用小结构、模型 JSON 与验证依据。JK_NET、JK_LOGIC、ModelShow 及其他相关 JK 项目均以本项目为规则和设计主来源；后续先在此处维护规则，再对齐消费者。

节点与执行契约集中在 [JKRD](docs/JKRD.md)，各专题记录具体结构和适用边界。项目 README、代码、测试、生成器、技能及历史模型如有偏离，应记录差异并按现行 JKRD 对齐，旧实现不能反向定义规则。

## JK 项目协作规范

本项目是全部 JK 相关项目的规则、设计、模型参考及验证材料的统一主源。先读 [JKRD](docs/JKRD.md)，再读对应专题。用户最新明确指令优先。必须得到明确指令后再进行修改 README.md 或 JKRD.md 内容，且明确列出修改内容差异对比。

- 规则修改先在本项目完成，再更新消费者实现与依赖；其它项目的 README、代码、测试、生成器及历史模型不能反向定义 JKRD。
- provenance/ 保存迁移证据；当前维护 docs/，不反向编辑原文归档。

## 阅读入口

先读本文件了解项目定位，再读 JKRD 掌握计算契约；随后从逻辑单元库进入所需专题，结合参考模型与验证记录理解适用范围。

| 文档 | 内容 |
| --- | --- |
| [JKRD 规则与设计](docs/JKRD.md) | 唯一计算契约：模型组成、节点状态、J/K 与 EX 顺序、触发和传播、FIFO、快照、指纹及优化边界 |
| [逻辑单元库](docs/logic_units/logic-units.md) | 基础门、MUX、触发恒值与高阻能力边界 |
| [计数器与事件组合](docs/logic_units/counters-events.md) | 2bit/8bit 全量与进位传播计数器、changed 等前后值判定、Q7/Q8/Q9 状态分离及 Q10i 许可模式 |
| [锁存与动态等待区](docs/logic_units/latch-dynamic-waiting.md) | 持续接收、逐项独立保存、按需扩缩、FIFO 递交确认及计算前后接入；动态管理待实现 |
| [异步结构静态原型](docs/logic_units/static-prototypes.md) | 6/17/40/43 节点有限原型、完整 43 节点 JSON、Q39/Q41 接口及验证边界 |

## 目录职责

- `docs/JKRD.md` 保存统一计算契约，`docs/logic_units/` 保存专题结构与设计。
- `assets/` 保存历史参考模型、验证脚本和报告，保留原始内容与哈希。
- `provenance/` 保存原始页面、导出数据、迁移清单和核验记录，用于追溯来源。

## 维护与依赖

入口和主要文件列表集中在 [jk.config.json](jk.config.json)。文档与参考附件直接引用，避免各自复制维护。

## 迁移状态与证据边界

2026-10-03 已迁入 JK 空间全部 8 个页面正文，包括 447 个原始块与 5 个 Mermaid 源图；原层级、版本、块元数据和维护说明保存在 [原始导出](provenance/space-export-2026-10-03.json)。9 个可读取附件保持 UTF-8 内容与 SHA-256，见 [迁移清单](provenance/migration-manifest.json)。

原空间入口的内容概览已合并到本文件，迁移前原文仍保存在 [原入口归档](provenance/original-pages/page_6abc4b5e3dd88191a1d99ee9d2d4255f.md)。迁移清单记录迁移时的文件位置，后续现行入口以 `jk.config.json` 为准。


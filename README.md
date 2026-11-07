# JK · JKRD7

本项目只维护 **JKRD7（7.0.0）**：JKI／JKS 的设计规则、已批准的模型示例、核对工具与串行参考解释器。不兼容、不维护此前版本。

唯一规则入口是 [JKRD7.md](JKRD7.md)。尚未确定的选择集中在 JKRD7 §9.3。当前没有生产执行器；参考解释器只实现单 queue 的串行参考语义，用作将来并行（CUDA）实现的对照基准。

## 设计要点

- **JKI**：每个节点保存 q；trigger 为 any 或 all；EX 由 J（AND）、K（XOR）组成，在执行入口读取来源的 q；publish 有七种模式。通知不携带值。
- **JKS**：members 递归保存完整的 JKI 与子 JKS；跨层引用写绝对路径。trigger 登记本结构的前置成员，按类型整合它们的通知：any 不整合，all 到齐后同步放行，transaction 到齐后形成事务任务，transaction_any 每条通知形成一个事务任务。
- **事务**：范围是除前置成员以外的全部成员；事务内按 publish 结果沿连接传播；发往范围外的通知在结束时统一提交；不设失败与回滚；多个事务任务按任务 FIFO 顺序逐个执行。
- **执行模型**：一次处理一个单元；事件优先；同一通知按订阅者绝对路径的顺序投递。任何并行实现对同一运行脚本必须产生与串行参考相同的执行记录；JKRD7 §7.5 给出了可以直接并行的任务批。
- **运行脚本与快照**：运行脚本规定输入批与输出观察，执行记录按串行顺序逐条列出；快照保存两个处理单元之间的全部运行状态。
- **JKM**：模型封装，包含版本、queue 声明与根 JKS。

## 阅读入口

| 内容 | 入口 |
| --- | --- |
| 规则 | [JKRD7](JKRD7.md)：字段、触发、整合、事务、执行模型、寻址、模块边界、示例与验收案例 |
| 十选一 ASCII 模型 | [digits.jkm.json](assets/ascii-bit-design/digits.jkm.json)：完整 JKM，一个数字选择转换为 8 个 ASCII bit |
| 工厂模块（待适配） | [factory-pending.md](docs/modules/factory-pending.md) 及 [assets/jks-factory-v7-design/](assets/jks-factory-v7-design/JKI.FACTORY.json) 中的附件 |
| 维护记录 | [jkrd7-maintenance.md](docs/jkrd7-maintenance.md)：各次修改的依据与前后差异 |
| CUDA 运行方案 | [CUDA.md](CUDA.md)：由 JKRD7 推导的 GPU 实现设计（实现设计，不是规则来源）；[jk_cuda_model.py](scripts/jk_cuda_model.py) 是它的 Python 执行模型 |
| 补充提案 | [第一轮](docs/jkrd7-proposal-2026-11-05.md)（P1—P9）、[第二轮](docs/jkrd7-proposal-2026-11-06.md)（P10—P17），均已批准 |
| 核对报告 | [静态检查](reports/static-validation.json)、[参考解释器](reports/reference-run.json) |

[jk.config.json](jk.config.json) 保存入口索引；[AGENTS.md](AGENTS.md) 保存协作要求。

## 核对

使用 Python 3 标准库：

```sh
python3 scripts/validate_jkrd7.py
python3 scripts/jk_reference.py
```

- `validate_jkrd7.py` 做静态检查：JKRD7 中的 JSON、模型附件、正例与负例、待适配附件的 JSON 语法、本地链接和索引。
- `jk_reference.py` 执行 JKRD7 第 10 节的模型与十选一附件，核对 §11.2 的验收案例，包括批执行模式、运行脚本、快照，以及 CUDA 执行模型与串行参考的对拍。
- 加 `--write-report` 时更新 `reports/` 下的报告。
- `python3 scripts/jk_reference.py --script <运行脚本>` 输出 JKRD7 §9.4 的执行记录，供并行实现逐条比对；可加 `--batch`、`--start <快照>`、`--save <快照>`。

两者通过不等于生产执行器、CUDA 实现、恢复或硬件行为已经验证。

## 维护要求

修改 README 或 JKRD7 正文须有用户明确指令，并在维护记录中列出修改前后差异。新增或改变行为必须有批准依据；尚未确定的选择留在 JKRD7 §9.3，不从旧版本或代码补默认规则。

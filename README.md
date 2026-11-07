# JK · JKRD7

本项目只维护 **JKRD7（7.0.0）** 的设计规则、已批准的 JKI／JKS 定义、工厂模块附件及设计核对工具。不兼容、不维护此前版本，也不保留旧执行器作为本版规则的依据。

唯一规则入口是 [JKRD7.md](JKRD7.md)。其已批准部分保持有效；尚待定义的通用机制集中在第 11 节。当前范围是设计与定义核对，尚未实现 JKRD7 执行器，静态检查通过不代表事务、动态安装、恢复或硬件执行已经验证。本轮不制作 Web 页面。

JKS.members 递归保存完整 JKI／子 JKS 对象；跨层连接采用绝对 JKI 路径，节点任务目标及通知来源入队也使用绝对路径。同层短 Q 编号仅用于连接配置，不作为队列中的完整身份。

JKS.trigger 的所有类型均按内部连接结构需要登记，同一 trigger 对象中的事件源整体去重。all 与 transaction 都在全部前置通知到齐后触发任务入队并清空本轮记录，排队或执行期间的新通知属于下一轮；transaction 还保证完整执行失败时回滚、取消本次全部计算。可编辑入口的登记资格不限定为 any，其他控制类型或用途按需增加。当前工具可核对注册格式，JKS 齐备触发与事务回滚执行仍未实现。

## 阅读入口

| 内容 | 入口与职责 |
| --- | --- |
| JKI／JKS 规则 | [JKRD7](JKRD7.md)：状态、触发、计算来源、发布、嵌套事务、运行记录及工厂模块 |
| 节点工厂 | [JKI.FACTORY.json](assets/jks-factory-v7-design/JKI.FACTORY.json)：F1 的六位配置输入、真实 JKI 与局部事务 |
| RAM 工厂 | [RAM.FACTORY.json](assets/jks-factory-v7-design/RAM.FACTORY.json)：R1、RAM1、阶段、动态模板及生命周期 |
| 操作契约 | [design-contract.json](assets/jks-factory-v7-design/design-contract.json)：模块操作、参数与交接边界 |
| 生成示例 | [generation-example.json](assets/jks-factory-v7-design/generation-example.json)：未安装草稿及输入消费结果 |
| 核对证据 | [verification.json](assets/jks-factory-v7-design/verification.json)：本版有限静态检查及源码摘要 |
| 十选一 ASCII 结构 | [完整 JSON](assets/ascii-bit-design/digits.paired-state.proposal.json)：一个 JKS 对象，members 包含 Q1—Q28 完整定义 |
| ASCII 参考验证 | [报告](assets/ascii-bit-design/digits.paired-state.verification.json)：有限串行输入、嵌套路径检查及重叠反例 |
| 本次整理差异 | [维护记录](docs/jkrd7-maintenance.md)：升级范围、保留内容、删除范围与验证边界 |

[jk.config.json](jk.config.json) 保存本版入口索引；[AGENTS.md](AGENTS.md) 保存协作要求。规则正文、附件和索引有各自职责，不能通过修改展示代码反向定义规则。

## 设计核对

使用 Python 3 标准库执行定义、示例和本地链接检查：

```sh
python3 scripts/validate_jkrd7.py
```

需要更新静态报告时，明确执行 `python3 scripts/validate_jkrd7.py --write-report`。报告仅覆盖工具实际检查的条款，不是执行器合规证明。

使用 `python3 scripts/verify_ascii_digits.py` 核对十选一结构的有限参考轨迹；加 `--write-report` 更新其报告。该参考工具仅执行 JKS 空注册／any 的普通节点连接，明确拒绝尚未实现的 JKS all、transaction 等控制注册，JKI.all 的节点到达规则仍受支持。工厂附件仍待适配，`digits.shared.invalid.json` 保留为无效反例，均不作为递归 members 的合法示例。

## 维护要求

修改 README 或 JKRD7 正文须有用户明确指令，并列出修改前后差异。新增或改变行为必须有批准依据；尚未确定的选择留在 JKRD7 的待补充清单，不从旧版本或代码补默认规则。


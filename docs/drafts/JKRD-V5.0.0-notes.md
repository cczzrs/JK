# V5 草案加载说明与补充设计

> 当前状态（2026-10-19）：JKRD 已按用户授权升级为 V5；下文仍保留原加载记录和 46 条历史补充提案，不能整份视为现行规范。逐项采纳、延后及否决见 [V5 更新对照](JKRD-V5.0.0-integration.md)；模块当前设计统一见 [异步结构存储草稿](../logic_units/async-structural-storage-draft.md)。

## 本次裁定覆盖历史提案

- 输入副本、逐次 Xi 锁存、目标归属与原子执行边界已整理进 JKRD。
- 链式自动延伸属于既有规则下的使用方法；链尾、池节点、停用节点的引用豁免全部否决。下文 `node-refs` 的空闲池豁免不适用。
- 模块采用 FRAME_OUT 完成后才建立 ACK 保留 q 与有效状态；ACK0 复用保留 q，ACK1 消费后立即撤销旧资格；旧批次完成不得恢复已消费帧。
- 整块回收还须本世代接纳满 8 帧；部分使用的空块继续剩余槽。`storage-recycle` 原文只作为旧提案。
- 环许可、判定、DAG.CARE、定时队列，以及快照、恢复、格式校验和指纹全部延后。原稿的允许反馈环不在本次启用；V4 无环约束继续适用。
- 下文“尚未合并”“本次只加载”“当前格式”等描述均属于 2026-10-18 加载时的历史上下文。本次用户授权改变了合并状态，没有把旧实现、旧测试或所有提案一并批准。

## 延后内容的待处理文件

完整工作分类见 [V5 待处理总清单](JKRD-V5.0.0-pending-index.md)，另包含异步结构存储内部设计、实现核验、消费者迁移及文档引用，不把它们新增为运行模块。

延后设计已分别整理，保留原文及后续补充，后续工作从对应文件继续：

| 主题 | 待处理稿 | 已迁入内容 |
| --- | --- | --- |
| 环判定、DAG.CARE 与定时队列 | [环监督待处理稿](JKRD-V5.0.0-ring-supervision-pending.md) | JKRD 延后清单、原稿环相关条款、全部 5 条 ring-* 原文与待定边界 |
| 快照、恢复、格式校验与指纹 | [快照恢复待处理稿](JKRD-V5.0.0-snapshot-recovery-pending.md) | JKRD 延后清单、原稿格式及恢复条款、全部 6 条 snapshot-* 原文、完整 V4 基线及算例 |

下方 46 条历史补充仍完整保留；移动整理不表示将其全部批准为现行规则，也不恢复已否决的节点豁免。

## 原加载状态（历史）

> 2026-10-18 当时仅加载独立草案与协作规则，尚未合并 JKRD，也未实现或修复 V5 执行器。

## 来源与文件边界

- 加载日期：2026-10-18（America/Los_Angeles）。
- 来源对话：[设计异步块链存储模型](thread://01a13e30-a6a2-78f1-b722-3b96bb9c3be0?hostId=local)。已读取对话中原稿审查、补齐展示、后续纠正及 AGENTS.md 建议。
- [原始差异草案](JKRD-V5.0.0-diff.md)：从 `/Users/cong/Desktop/# JKRD 修订差异对比V5.0.0.md` 按字节复制，包含 E01–E67 共 67 条修订；保留全部修改前、修改后、待设计与待确认内容。
- 原稿标题“待确认，尚未写入”表示未写入正式 JKRD；原行号、行数统计、版本号和验证叙述均属于原稿当时的上下文。本次导入不重新确认其与当前 JKRD 的逐项匹配，也不执行其中的修订。
- 原稿保留 V4.0.0 标记，并在 E65 将版本与 format 变更列为待确认；文件名中的 V5 不代表这些事项已批准。
- 后续补充来源：`/Users/cong/Desktop/VSCode/CODEX/JK_LOGIC/web/v5/design.mjs`。下文保留其中 46 条规则的原始标题、正文与关联，仅转换展示格式；其状态为 `design-preview`。用户授权补齐和展示，不等于这些提案已经成为现行规范。
- AGENTS.md 来源：上述对话最后一轮建议的“语义一致性与验证”7 条规则。本次按用户指令追加到 [项目 AGENTS.md](../../AGENTS.md)，保留原有两条约束。
- 现行计算契约仍是 [docs/JKRD.md](../JKRD.md)。开展 V5 工作须明确适用草案和本次授权；V5 草案不覆盖现行契约，也不表示模型、生成器、验证器或历史测试已兼容 V5。

## 后续纠正优先于旧解释

以下是来源对话后段纠正的解释与实现偏差，不是对原稿新增规范：

1. **任务归属按目标节点确定。** 原稿 E25、E63 规定 RAM 成员节点的任务进入 `RAM.FIFO`（优先值 2），即使节点处于环中。该异步存储模型中，承担 F1 输出的节点属于 RAM 成员，其求值任务应进入 `RAM.FIFO`；不能统一放进 `Qi.FIFO`。
2. **入队的是输出节点的求值任务。** 原稿 E29 不允许把独立 Yi 输出任务放入这些队列；E63 规定输出节点任务触发时锁存数据，执行后发布 Yi。直接携带 bit 并更新输出的演示动作，不能替代真实节点的 EX 求值与发布语义。
3. **撤回依赖错误队列归属的时序推论。** 对话曾根据“F1 输出进入 Qi.FIFO、ACK 进入更高优先级 RAM.FIFO”解释提前 ACK 的问题，后来明确撤回。保留原稿 ACK 语义 L（执行时作用于队首）；“连续 ACK 能否在某帧输出完成前消费它”等具体结果，应按正确成员归属和实际入队顺序重新推导，不能沿用旧模拟器的结论。
4. **旧测试记录不是草案一致性证明。** 对话末尾确认 V5 演示器的固定 Qi 归属错误尚未修复，配套测试也沿用该错误。因此历史“18 项测试通过”和 Chrome 检查只保留为当时的展示验证记录，不能证明对应语义正确。本次未导入模拟器、HTML 页面或测试报告，也未修复 JK_LOGIC。

## 后续补充的适用范围与待定事项

- FRAME_IN 负责输入整帧锁存；FRAME_OUT 表示本批数据发齐；ACK 负责队首重发或消费。这是后续展示设计对名称和职责的区分，不把 FRAME_IN 改作消费触发。
- 每帧 1–8 bit、每块 8 槽、W bit 对应 W 个数据 Q 是该异步存储模型配置；块的节点数随帧宽变化，不能成为所有 V5 模型的固定限制。
- 展示配置记录四队列优先值 `Xi=1 / RAM=2 / DAG=3 / Qi=5`、ACK 模式 `execution-head`、事务事件按来源 Q 编号升序，以及环预算 `6`。其中 `6` 是可配置的演示值，不是通用 V5 强制值。
- 后续设计提出 FRAME_IN 原子封帧、ACK 译码互斥、事务发布顺序、节点世代、环挂起恢复和完整运行快照。下方按原文保存，仍属待定稿的补充设计，不能据此宣称执行器已经实现。
- 后续设计使用 `jk-logic-structure-V5.0.0` 与 `jk-logic-runtime-V5.0.0` 两个格式名；正式逐字段格式、规范化载荷、指纹参与字段及有效/无效样例仍需完成，不能把名称或原则当作完整格式契约。
- 后续工作还需明确：RAM 动作与真实节点 EX/任务参数的绑定；失败任务的存放、重试和后续推进；环预算的计数与重置、挂起恢复顺序、SCC 合并拆分；持续高优先级输入下的推进边界。这里记录未完成范围，不自动采用前一轮所有缺陷推断。
- 对输出批次、提前 ACK 或快照问题的进一步判断，必须同时核对原稿、后续提案与上述纠正；不能用旧展示代码反向定义设计。

## 后续设计原文：46 条规则及关联

以下文字保留来源数据的标题和正文，**统一属于补充设计提案，未定稿**。其中 `ack-burst` 保留为历史原文，具体时序结论受上面的撤回说明约束；它不是已验证行为。

<a id="node-state"></a>

### `node-state` · q 保存状态；结构表保存关系

有状态节点由 initial_q 声明，q 保存 0/1。无状态节点每次从 J0 起算。帧数据与控制状态都保存在 JK 节点 q；成员表、槽链、节点世代属于结构元数据，不用外部缓存替代长期数据保存。

关联：[`storage-data`](#storage-data)、[`snapshot-runtime`](#snapshot-runtime)。

<a id="node-ex"></a>

### `node-ex` · EX 顺序求值，完整原子执行

J(x) 为 q AND x，K(x) 为 q XOR x；扁平 EX 从左到右完成。保留 V4 的表达式、显式自引用与纯常量节点约束。单个 EX 及其结果传播完成后才选下一任务。

关联：[`schedule-boundary`](#schedule-boundary)、[`transaction-commit`](#transaction-commit)。

<a id="node-source"></a>

### `node-source` · 参数引用与触发原因分开记录

EX 中的非自身来源建立数据引用和事件关系；自身 q 仅作为求值起点。引发任务的 FRAME、ACK 或事务原因不自动成为 EX 参数。图上只把真实 EX 引用画作数据连线，任务另记 cause。

关联：[`task-identity`](#task-identity)、[`output-latch`](#output-latch)。

<a id="node-pro"></a>

### `node-pro` · pro 只决定是否发布结果

EX 完成后，以最终 q 判断 q=0/1、q=0、q=1 或 q=。不满足条件时不传播，不补发 0。pro 不是事务动作的执行许可，ACK 互斥必须使用锁存值单独判断。

关联：[`ack-decode`](#ack-decode)、[`transaction-publish`](#transaction-publish)。

<a id="node-refs"></a>

### `node-refs` · 活动节点维持引用；池节点静默

> 已否决：下段“空闲池节点允许被引用数量为 0”不适用。所有现存 Q 均遵守相同节点规则。 以下保留历史原文。

活动普通节点的非自身来源数量与被引用数量均至少 1；q_y 输出绑定计入被引用数量。空闲池节点允许被引用数量为 0，但不得执行 EX。重新激活前恢复并校验完整关系。

关联：[`storage-recycle`](#storage-recycle)、[`transaction-validate`](#transaction-validate)。

<a id="input-latch"></a>

### `input-latch` · 每次 Xi 到达独立锁存

Xi 唯一对应同编号输入副本，EX 固定 J0K(Xi)。输入副本可有状态或无状态。每次输入复制任务保存该次值；执行使用自己的载荷，不回读最新 Xi，因此后到值不会覆盖旧任务。

关联：[`input-copy`](#input-copy)、[`task-payload`](#task-payload)。

<a id="input-frame"></a>

### `input-frame` · FRAME_IN=1 原子封存整帧

外部提交本帧 1–8 bit 有序数组，FRAME_IN=1 同时锁存数组、帧 ID 与输入序号。数组长度就是帧宽，不增加长度位节点。每帧参数互相独立；越界或非 bit 输入在接入前明确拒绝。

关联：[`input-handoff`](#input-handoff)、[`storage-slot`](#storage-slot)。

<a id="input-clear"></a>

### `input-clear` · FRAME_IN=0 只清空当前输入

清除尚未提交的输入暂态；已经锁存的 Xi 任务、RAM 存储任务、JK 数据槽和待输出载荷均不受影响。FRAME_IN 不参与 ACK 消费、重发或下一帧递交。

关联：[`ack-head`](#ack-head)、[`output-marker`](#output-marker)。

<a id="input-copy"></a>

### `input-copy` · 输入副本作为事件型来源

输入副本的事件与无状态来源一起计入到达集合，并在满足触发条件时锁存到任务。普通多来源集合仍可能被同来源的后一次到达覆盖；因此它只能服务一般 EX 触发，不能承担业务帧的拼装。

关联：[`input-handoff`](#input-handoff)、[`task-arrival`](#task-arrival)。

<a id="input-handoff"></a>

### `input-handoff` · 复制完成后原样移交 RAM 存储任务

每帧 Xi 复制批次保留同一帧 ID、顺序及独立数组。复制完成后将该载荷移交第一个 RAM.FIFO 存储任务，接力持有直到写入 JK q 后释放参数；不得从输入副本最新值或多来源到达集合重新拼帧。

关联：[`queue-ram`](#queue-ram)、[`storage-data`](#storage-data)。

<a id="queue-priority"></a>

### `queue-priority` · 四条 FIFO：1 → 2 → 3 → 5

Xi.FIFO 优先值 1；RAM.FIFO 为 2；DAG.FIFO 为 3；Qi.FIFO 为 5。每次选取最高优先级的非空队首，各队内部先进先出。优先级只选择下一任务，不中断正在执行的 EX 或事务。

关联：[`schedule-boundary`](#schedule-boundary)、[`ring-budget`](#ring-budget)。

<a id="queue-ram"></a>

### `queue-ram` · RAM 成员归属优先于环归属

RAM.FACTORY 成员节点及存储、释放、ACK 动作任务均进入 RAM.FIFO；即使 RAM 成员在环内，也留在 RAM.FIFO。其他环内节点进入 DAG.FIFO；普通节点进入 Qi.FIFO；输入复制进入 Xi.FIFO。

关联：[`ring-classify`](#ring-classify)、[`storage-factory`](#storage-factory)。

<a id="schedule-boundary"></a>

### `schedule-boundary` · 当前任务 → 完整传播 → 安全边界

任务完整执行、全部直接来源事件处理及后继入队完成，外部输入交接结束后，先处理快照请求，再选择下一任务。缺少未来来源的到达集合可继续等待，不阻止其他就绪任务执行。

关联：[`snapshot-boundary`](#snapshot-boundary)、[`task-arrival`](#task-arrival)。

<a id="task-identity"></a>

### `task-identity` · 任务身份、EX 版本和目标世代冻结

每项任务记录序号、类别、queue、目标节点、targetGeneration、EX 版本与触发 cause。执行前校验身份与世代；旧世代任务不能命中新复用节点。已存在任务或到达集合的节点，不得被静默重写 EX、删除或改队列。

关联：[`transaction-generation`](#transaction-generation)、[`ring-reassign`](#ring-reassign)。

<a id="task-payload"></a>

### `task-payload` · 载荷类别明确，生命周期独立

区分 Xi 锁存值、整帧数组、无状态来源数据和输出锁存数据。每个任务独立持有；移交完成后才释放上一持有者。普通有状态参数仍按 EX 执行时读取；输出任务是显式锁存例外。

关联：[`output-latch`](#output-latch)、[`snapshot-tasks`](#snapshot-tasks)。

<a id="task-arrival"></a>

### `task-arrival` · 到达集合属于目标节点的待完成状态

含事件型来源的目标收齐全部不同来源才入队，入队同时锁存并清空这一组。来源未齐时保留已有数据；同来源的新到达覆盖本组旧值。输入副本按事件型来源处理；有状态普通来源不单独完成该组。

关联：[`input-copy`](#input-copy)、[`transaction-validate`](#transaction-validate)。

<a id="storage-factory"></a>

### `storage-factory` · RAM.FACTORY 维护结构与成员表

工厂负责分配、连接、登记、激活、释放和回收。结构修改只通过 RAM 事务入口；成员表是 RAM 归属依据。业务控制标志存 JK q，编号、槽成员与链顺序存结构表，两者一起原子提交。

关联：[`transaction-commit`](#transaction-commit)、[`queue-ram`](#queue-ram)。

<a id="storage-block"></a>

### `storage-block` · 每块固定 8 槽；不固定节点数量

A、B、C…每个块世代依次接纳最多 8 帧。一个槽承载一帧，槽宽随该帧变化。因此一块存储数据节点随已接纳帧的宽度而变，满块为 8–64 个数据 Q，辅助控制 Q 另计。

关联：[`storage-slot`](#storage-slot)、[`storage-growth`](#storage-growth)。

<a id="storage-slot"></a>

### `storage-slot` · W bit → W 个数据 Q

本帧 W∈[1,8]，存入一个槽中恰好 W 个数据 Q。槽成员表的有序节点集合给出帧宽与位序，无长度位节点；写入对应数量的 q 并更新必要 EX、pro 和辅助关系。

关联：[`input-frame`](#input-frame)、[`storage-data`](#storage-data)。

<a id="storage-data"></a>

### `storage-data` · 任务参数只接入，JK q 负责长期保存

RAM 存储任务执行时把独立帧参数写入槽的 JK q，然后释放输入参数。未消费帧的原始数据保留在这些 Q 中；结构表只记录帧 ID、位序及成员，不额外长期保存一份 bit 数组。

关联：[`input-handoff`](#input-handoff)、[`output-latch`](#output-latch)。

<a id="storage-growth"></a>

### `storage-growth` · 顺序写槽；优先复用全释放块

写入顺序为 A 的 8 槽 → B 的 8 槽 → C…；当前块的本世代接纳名额耗尽时，先取已整块释放且引用安全的块，否则新增一个 8 槽块。资源允许时按需增长，不因固定块数等待。

关联：[`storage-recycle`](#storage-recycle)、[`transaction-failure`](#transaction-failure)。

<a id="storage-recycle"></a>

### `storage-recycle` · 槽先标记释放，整块安全后复用

> 已收紧：除全消费和依赖解除，还必须本世代已接纳满 8 帧，才能整块回收。 以下保留历史原文。

消费只释放当前槽的活帧；本世代已经使用过的槽不提前回填。全块活帧为 0 且无未完成依赖后，整块进入可复用池；下一次激活时 generation 加 1。复用可重新组合待存 Q 为新槽，节点池不足再按宽度补充。

关联：[`transaction-generation`](#transaction-generation)、[`output-detach`](#output-detach)。

<a id="ack-head"></a>

### `ack-head` · ACK 采用 L：执行时作用于队首

> 已补充：仍按执行时队首，但必须当前队首已完成 FRAME_OUT 且独立保留 q 有效，否则 ACK0/ACK1 都忽略。 以下保留历史原文。

每次 ACK 经过 Xi 独立锁存，并按到达顺序追加到 RAM.FIFO。执行时选取当时存储帧队列的队首；空队列时无副作用。它是对执行时队首的消费指令，不声明“确认已经完整递交的帧”。

关联：[`ack-burst`](#ack-burst)、[`ack-decode`](#ack-decode)。

<a id="ack-decode"></a>

### `ack-decode` · ACK0 / ACK1 译码动作互斥

两个内部译码节点可因同次锁存 ACK 都形成 RAM 任务，但仅与该次锁存值匹配者执行动作；另一个明确无副作用。不得用 pro 代替动作许可，也不得执行时回读最新 ACK 值。

关联：[`node-pro`](#node-pro)、[`input-latch`](#input-latch)。

<a id="ack-replay"></a>

### `ack-replay` · ACK=0 重新捕获并重发队首

> 已替换：当前模块从已完成输出的独立 ACK 保留 q 重发，不采用下段重新捕获原槽的方案。 以下保留历史原文。

匹配的 ACK0 事务执行时，从当前队首的存储 Q 捕获一份新的输出载荷并追加输出批次。帧、槽与消费位置保持不变；该批输出执行时使用自身锁存值，不再依赖原槽。

关联：[`output-latch`](#output-latch)、[`output-marker`](#output-marker)。

<a id="ack-consume"></a>

### `ack-consume` · ACK=1 释放队首并递交下一帧

匹配的 ACK1 事务原子释放当前槽、推进 FIFO 队首、更新 JK 控制状态，随后为新队首捕获并追加首发输出批次。第一次存储形成非空队列时，也自动递交第一帧；都不触发 FRAME_IN。

关联：[`storage-recycle`](#storage-recycle)、[`output-latch`](#output-latch)。

<a id="ack-burst"></a>

### `ack-burst` · 连续两个 1 可以消费 F1、F2

> 纠正提示：本条关于未完成输出时连续消费的具体推论不能作为已确认结论；应按正确的 RAM 成员归属与实际入队顺序重新推导。以下仅保留来源原文。

若 F1、F2 已存储，连续两个 ACK=1 可在输出尚未执行完时依次消费 F1、F2。已经排队的 F1、F2 输出批次保留并按顺序完成。这是本版 L 语义的明确结果，不应展示成逐帧送达确认。

关联：[`ack-head`](#ack-head)、[`output-detach`](#output-detach)。

<a id="output-latch"></a>

### `output-latch` · 触发时锁存整批输出载荷

首发或重发触发时，按槽的有序成员读取 W 个存储 Q，为输出任务固定对应数据、帧 ID、输出批次、位序、EX 版本及输出目标世代。W 个数据任务与帧完成任务作为同队列连续批次入队，禁止混帧。

关联：[`task-payload`](#task-payload)、[`snapshot-tasks`](#snapshot-tasks)。

<a id="output-detach"></a>

### `output-detach` · 输出载荷可脱离数据槽，目标仍受保护

批次锁存完成后，输出任务无需再读取存储槽，因此原槽释放或整块复用不会改写旧输出。输出任务仍须校验目标节点的世代与 EX 版本；未完成输出不得被重配置或静默取消。

关联：[`transaction-generation`](#transaction-generation)、[`output-marker`](#output-marker)。

<a id="output-marker"></a>

### `output-marker` · W 个 Yi 后发布 FRAME_OUT

仅发送本帧对应的 W 个数据 Yi，按位序完成后发布独立 FRAME_OUT：首发为 1，重发为 0。FRAME_OUT 表达该输出批次已经发齐，不反馈为输入 FRAME_IN，也不代替消费 ACK。

关联：[`input-clear`](#input-clear)、[`snapshot-progress`](#snapshot-progress)。

<a id="transaction-validate"></a>

### `transaction-validate` · 先校验，再提交所有结构与 q

校验工厂操作权限、成员关系、槽宽、目标世代、EX 引用和 q_y，并检查 pending 任务与到达集合。只有全部满足才进入提交；有活跃依赖的节点不能改 EX、删除或改变队列归属。

关联：[`node-refs`](#node-refs)、[`task-identity`](#task-identity)。

<a id="transaction-commit"></a>

### `transaction-commit` · 验证 → 结构/q 提交 → 事件发布

一个 RAM 事务可原子完成节点分配与连线、多个 q 写入、槽链和成员表修改、控制状态提交。事务内部不插入其他任务；事件必须在全部结构与 q 成功提交之后发布。

关联：[`transaction-publish`](#transaction-publish)、[`storage-factory`](#storage-factory)。

<a id="transaction-publish"></a>

### `transaction-publish` · 来源 Q 按编号升序发布一次最终值

同一事务中某来源被多次写入，只按最终 q 和 pro 判定一次发布。多个来源按 Q 的数值编号升序发布；每一来源按目标数值编号升序处理后继入队。输出帧批次维持自己的位序与完成标记次序。

关联：[`queue-priority`](#queue-priority)、[`output-latch`](#output-latch)。

<a id="transaction-generation"></a>

### `transaction-generation` · generation 隔离旧任务与新节点

节点和块均携带世代；回收复用后递增。任务身份、到达集合与结构引用带对应世代，执行前必须一致。已锁存输出解除对数据槽的引用，但不解除对输出目标的保护。

关联：[`output-detach`](#output-detach)、[`snapshot-runtime`](#snapshot-runtime)。

<a id="transaction-failure"></a>

### `transaction-failure` · 失败全部回滚，任务和载荷可恢复

校验、资源分配或提交失败时，结构、q、成员表和待发布事件一起回滚，不产生半帧或部分释放。保留任务及其载荷并记录明确失败状态，允许显式重试；资源耗尽不得默默丢帧。

关联：[`storage-growth`](#storage-growth)、[`snapshot-tasks`](#snapshot-tasks)。

<a id="ring-classify"></a>

### `ring-classify` · 加载与结构提交后重算 SCC

> 延后处理：下列 ring-* 均为历史设计方向，不启用反馈环、不放宽现行无环约束。 以下保留历史原文。

由完整 Q 引用图计算强连通分量 SCC，排除合法有状态自引用；多节点反馈形成环。加载时判定，RAM 结构事务提交时重新判定。静态图确定环成员，传播过滤不豁免结构上的环。

关联：[`queue-ram`](#queue-ram)、[`ring-reassign`](#ring-reassign)。

<a id="ring-reassign"></a>

### `ring-reassign` · 阶段一：活跃任务不跨队列迁移

如果结构变更会改变某节点的队列归属，而该节点有 pending 任务或未收齐的到达集合，则拒绝该变更并回滚。只有安全边界的空闲节点可更新归属，避免旧任务顺序与优先级被重排。

关联：[`task-identity`](#task-identity)、[`transaction-failure`](#transaction-failure)。

<a id="ring-budget"></a>

### `ring-budget` · DAG 与 RAM 内环共用预算监督

DAG.CARE 对每个 SCC 的连续任务推进计数，包括留在 RAM.FIFO 的环内节点。达到预算即暂停该 SCC 的后续任务；演示预算为 6，可配置。预算只是安全界限，不把长时间运行判为死环。

关联：[`ring-suspend`](#ring-suspend)、[`queue-priority`](#queue-priority)。

<a id="ring-suspend"></a>

### `ring-suspend` · 挂起 SCC，让低优先任务继续

保留挂起 SCC 的任务、载荷、顺序、到达集合与预算状态，放入监督等待区；挂起期间新形成的该 SCC 任务也进入此区。等待区不参与就绪优先级竞争，其他 SCC 与普通 Qi 任务仍可执行。

关联：[`ring-resume`](#ring-resume)、[`snapshot-runtime`](#snapshot-runtime)。

<a id="ring-resume"></a>

### `ring-resume` · 显式恢复，不自动删除结构

操作者或明确的控制条件请求恢复，重新校验世代与结构，并为该 SCC 开始下一预算段。监督只暂停与恢复，不能依据超时自动删除节点、取消帧或丢任务；完整快照必须能还原挂起状态。

关联：[`snapshot-runtime`](#snapshot-runtime)、[`transaction-generation`](#transaction-generation)。

<a id="snapshot-static"></a>

### `snapshot-static` · 静态结构快照不冒充运行检查点

> 延后处理：下列 snapshot-* 的字段、格式名、校验与指纹均未定稿，不是 V5 格式契约。 以下保留历史原文。

静态 V5 保存节点、initial_q、EX、pro、q_y、结构成员与初始世代，以及格式身份。它用于加载结构，不携带尚未完成的输入、输出或任务历史；不能宣称继续未中断的执行轨迹。

关联：[`snapshot-runtime`](#snapshot-runtime)、[`snapshot-format`](#snapshot-format)。

<a id="snapshot-runtime"></a>

### `snapshot-runtime` · 完整现场覆盖状态、结构与监督

运行快照保存全部有状态 q、控制 q、成员表、槽链、帧序、节点与块世代、输入暂态、未完成到达集合、各队任务和监督等待区、环预算、序号分配器及输出进度，恢复时验证引用闭合。

关联：[`snapshot-tasks`](#snapshot-tasks)、[`snapshot-progress`](#snapshot-progress)。

<a id="snapshot-tasks"></a>

### `snapshot-tasks` · 任务格式显式允许输出锁存载荷

每项序列化任务包含类别、序号、queue、目标世代、EX 版本与 cause；按类别保存 Xi 值、整帧数组、事件型来源数据或 outputPayload。输出锁存可来自有状态存储 Q，不再套用 V4 禁止保存普通状态来源值的限制。

关联：[`task-payload`](#task-payload)、[`output-latch`](#output-latch)。

<a id="snapshot-progress"></a>

### `snapshot-progress` · 输出批次保存精确发送进度

保存批次帧 ID、首发/重发类型、W 个锁存 bit、下一位索引、FRAME_OUT 是否已发布及输出序号。恢复后只续发未完成部分；避免重放已经发出的位或漏掉帧完成标记。

关联：[`output-marker`](#output-marker)、[`snapshot-boundary`](#snapshot-boundary)。

<a id="snapshot-boundary"></a>

### `snapshot-boundary` · 完整任务边界保存与恢复

仅在当前 EX 或 RAM 事务与全部传播完成的安全边界保存。恢复先校验结构、世代、任务与引用，再按原队列顺序继续；测试比较后续 Yi、FRAME_OUT、消费顺序与状态，而非只比较最终 bit。

关联：[`schedule-boundary`](#schedule-boundary)、[`snapshot-format`](#snapshot-format)。

<a id="snapshot-format"></a>

### `snapshot-format` · V5 格式与指纹使用新载荷契约

结构格式为 jk-logic-structure-V5.0.0；完整现场为 jk-logic-runtime-V5.0.0。format_md5 对格式、规范节点、initial_q、q_y、结构元数据及队列/监督配置计算 MD5；md5 在同一载荷上增加完整任务与运行现场。规范 JSON 使用 UTF-8、对象键排序、数组保序，排除指纹字段本身与纯展示字段；不复用 V4 指纹。

关联：[`snapshot-static`](#snapshot-static)、[`snapshot-runtime`](#snapshot-runtime)。

## 导入完整性记录

| 来源 | SHA-256 | 本次处理 |
| --- | --- | --- |
| 桌面 V5 差异原稿 | `b89fd4fa6e3d3fbc0998a1b2b5b3ab6357dfc6863b943f9d0098b8b8dba95f8a` | 按字节复制，67 条修订完整保留 |
| JK_LOGIC `web/v5/design.mjs` | `551269cbb08aac7f14f08d09875d59c3d07e353c92ca1959c96c1cd969237dc6` | 提取 46 条规则标题、正文和关联；不执行展示代码 |

上述摘要仅用于确认本次读取的来源版本，不证明草案语义正确或实现兼容。AGENTS.md 的 7 条规则从引用对话的最终建议原文提取；本次文档加载不视为批准合并 JKRD。

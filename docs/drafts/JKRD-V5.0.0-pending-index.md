# JKRD V5.0.0 待处理总清单（复核稿）

> 2026-10-19。依据用户“再核对一遍，并整理所有需要待处理的模块或内容”的要求建立。本清单覆盖当前 JKRD、异步结构存储模块、环与快照待处理稿、原稿 E01–E67、46 条补充及本地实验；记录 31 项待设计、待实现或待验证工作。它是工作索引，不新增计算规则，也不把已确认行为重新列作待批准。

异步结构存储仍由 **JK 节点组合的异步处理结构、FIFO 队列组、RAM.FACTORY** 三部分协作。下表的八类是工作范围，不是八个新的运行模块。

| 工作范围 | 清单 | 当前状态 |
| --- | --- | --- |
| JK 节点结构与业务接入 | A01–A05 | 完整合法拓扑及计算接入待补；输入/输出/ACK 等行为已确认，仍需完整实现与验证 |
| RAM.FACTORY 操作与事务 | F01–F02 | 原子边界已确认；通用操作、权限和 EX 绑定待补 |
| 失败、回滚与重试 | F03–F04 | 完整协议待设计与实现 |
| 环判定、DAG.CARE、定时队列 | R01–R07 | 明确延后，未启用 |
| 快照、恢复、校验与指纹 | S01–S09 | 明确延后，格式与完整恢复未定稿 |
| 消费者与模型验证 | V01–V04 | 已有局部证据；通用验证、迁移状态及旧模型 V5 复核待做 |
| 交互页面 | U01 | 已有页面和画框操作代码；完整界面验收待做 |
| 文档与证据引用 | D01 | 本轮发现的旧专题引用待修整 |

状态口径：“待设计/确认”表示尚未确定具体协议；“已确认/待实现”表示规则不再悬而未决；“已有定向实验/待完整验证”表示不能扩大现有测试的证明范围；“外部未复核”不等于断言外部未实现。

详细设计入口：[异步结构存储模块](../logic_units/async-structural-storage-draft.md)、[环监督待处理稿](JKRD-V5.0.0-ring-supervision-pending.md)、[快照恢复待处理稿](JKRD-V5.0.0-snapshot-recovery-pending.md)。

<a id="storage"></a>

## 一、异步结构存储：JK 节点结构与业务接入

| 编号 | 内容 | 状态与剩余工作 | 来源与验证出口 |
| --- | --- | --- | --- |
| <a id="a01"></a>A01 | 完整合法拓扑 | **待设计；现有实验有明确偏差**。为输入、S/C、存储保持、控制、输出与 ACK 给出逐节点合法图；维持全部引用约束及当前 DAG 要求。 | [模块实现边界](../logic_units/async-structural-storage-draft.md#implementation-boundary)、[JKRD 节点规则](../JKRD.md)。验收逐节点检查真实 EX、引用及事件序列；不能用 pro=q= 或成员身份豁免。 |
| <a id="a02"></a>A02 | 整帧接力、输入及参数生命周期 | **规则已确认；待完整实现核验**。核对 Xi → 第一个 RAM 任务 → W 个 JK q 的独立接力；身份、宽度、顺序、任务参数和移交释放时机全部保持。Xi 与帧参数使用 Qi_J0 的锁存方式。 | [input-handoff](JKRD-V5.0.0-notes.md#input-handoff)、[模块输入设计](../logic_units/async-structural-storage-draft.md)。验收连续输入、重复 bit、0、W=1/8、FRAME_IN 清除与迟到任务，且不从最新输入重拼旧帧。 |
| <a id="a03"></a>A03 | 计算前后接入及 Q7/Q8/Q9/Q10i | **角色与目标已确认；动态连接待构造**。计算前保存原始输入、计算后保存每次结果；明确 Q9 回写完成与下一轮释放、首轮启动及同时安装两处等待区的连接。 | [锁存与动态等待区](../logic_units/latch-dynamic-waiting.md)。验收相同结果也产生完成确认，连续计算读到正确的上一轮状态，逐项结果不被覆盖。 |
| <a id="a04"></a>A04 | 节点生命周期、块槽回收和链式展开 | **回收条件与无豁免已确认；通用构造及验证待补**。补齐创建初值、可见时刻、连接/登记、编号/容量维护、链式展开、依赖保护、世代及删除/复用方案；既有实验只覆盖指定流程。 | [模块工厂及生命周期](../logic_units/async-structural-storage-draft.md#factory)、[task-identity](JKRD-V5.0.0-notes.md#task-identity)。验收满 8 帧且全消费、无依赖才复用；部分使用空块继续剩余槽；旧任务不命中新世代且无零引用池 Q。 |
| <a id="a05"></a>A05 | 输出、FRAME_OUT 与 ACK 全链路 | **规则已确认；已有定向实验，待合法拓扑下完整验收**。保留固定中转与输出 EX/q_y、按序准备、任务锁存、独立 ACK 保留 q、执行时队首以及旧批次完成的身份检查。 | [输出与 ACK](../logic_units/async-structural-storage-draft.md#output-ack)。验收完成前执行的 ACK0/1 忽略；消费后新队首重新等待 FRAME_OUT；重发/消费交错不混帧、不覆盖旧输出、不复活已消费帧。 |

<a id="factory"></a>

## 二、RAM.FACTORY：操作、权限与失败处理

| 编号 | 内容 | 状态与剩余工作 | 来源与验证出口 |
| --- | --- | --- | --- |
| <a id="f01"></a>F01 | 工厂操作清单与权限 | **待设计**。列明可分配/连接/登记/改 EX/pro/q_y/写 q/删除/复用的动作、参数、权限和合法前置条件；不能凭工厂身份增加 J/K 操作或引用豁免。 | [E63 原稿](JKRD-V5.0.0-diff.md)、[模块工厂](../logic_units/async-structural-storage-draft.md#factory)。验收每种动作的允许与拒绝案例、成员归属及动态引用闭合。 |
| <a id="f02"></a>F02 | 真实节点 EX、事务提交与发布的绑定 | **原子边界已确认；通用动作绑定待补**。为每类工厂动作对应真实目标任务、求值参数和本节点 EX；明确多 q/结构提交、最终 pro 判定及来源/目标发布次序。其他节点 EX 仍各自执行。 | [JKRD 原子边界](../JKRD.md)、[transaction-commit](JKRD-V5.0.0-notes.md#transaction-commit)、[transaction-publish](JKRD-V5.0.0-notes.md#transaction-publish)。验收事务前后可见性、每步实际 EX 以及完整提交后一次发布；具体发布规则逐动作定稿。 |
| <a id="f03"></a>F03 | 失败原子回滚与资源不足 | **待设计；完整协议未实现**。定义校验失败、分配失败、提交失败时，结构、q、成员、控制状态、任务载荷及待发布事件的统一处理，不能半提交或默默丢帧。 | [transaction-failure](JKRD-V5.0.0-notes.md#transaction-failure)、[模块工厂](../logic_units/async-structural-storage-draft.md#factory)。局部 EX 改写回滚不代表工厂事务回滚；验收各失败阶段的状态及事件不泄漏。 |
| <a id="f04"></a>F04 | 失败任务保存、重试与后续推进 | **待设计；未实现**。确定失败任务放在哪里、保留哪些参数、何时允许显式重试、如何保持顺序、重复执行的效果，以及后继任务在失败期间如何推进。 | [补充待定范围](JKRD-V5.0.0-notes.md)、[模块剩余边界](../logic_units/async-structural-storage-draft.md)。验收重复重试不重复消费/发布、不乱序、不丢载荷；存放位置与推进策略不得自行定案。 |

<a id="rings"></a>

## 三、环判定、DAG.CARE 与定时队列

| 编号 | 内容 | 状态与剩余工作 | 来源与验证出口 |
| --- | --- | --- | --- |
| <a id="r01"></a>R01 | 允许多节点反馈环的扩展 | **明确延后；未启用**。环许可需与判定、归属、监督和验证成套处理；目前仍遵守既有无环约束。 | [环待处理稿](JKRD-V5.0.0-ring-supervision-pending.md#e08)。后续批准后再验证可运行环，不能先用实验互引解除当前约束。 |
| <a id="r02"></a>R02 | SCC 判定及重算时机 | **明确延后；待设计/确认**。明确加载时与结构提交后如何检查完整 Q 引用图，SCC 合并、拆分、成员身份及合法自引用的处理。 | [ring-classify](JKRD-V5.0.0-ring-supervision-pending.md#ring-classify)、[E65](JKRD-V5.0.0-ring-supervision-pending.md#e65)。验收静默节点、RAM 节点、互引、自引用及动态结构变化；pro 不过滤真实引用。 |
| <a id="r03"></a>R03 | 环内任务归属与动态变更 | **明确延后；待设计**。保留输入/成员归属优先次序；定义非 RAM 环的 DAG.FIFO=3 启用条件，以及存在任务或到达集合时如何拒绝/处理改变归属的事务。 | [E15](JKRD-V5.0.0-ring-supervision-pending.md#e15)、[ring-reassign](JKRD-V5.0.0-ring-supervision-pending.md#ring-reassign)。验收不静默重排旧任务，RAM 环任务不迁入 DAG，候选方案不提前变成现行队列。 |
| <a id="r04"></a>R04 | DAG.CARE 的权限和预算 | **明确延后；待设计**。监督范围是否包括 RAM 内环、按 SCC 计数的起止、重置、预算耗尽行为以及监督/重构权限需定稿；6 仅为演示配置。 | [ring-budget](JKRD-V5.0.0-ring-supervision-pending.md#ring-budget)。验收跨 RAM/DAG 的同一 SCC 计数，不能把预算耗尽视为死环证明。 |
| <a id="r05"></a>R05 | 环挂起、监督等待区与恢复 | **明确延后；未实现**。定义任务/载荷/顺序/到达集合/预算的挂起保留，新任务去向、恢复请求、世代重校验和恢复次序。 | [ring-suspend](JKRD-V5.0.0-ring-supervision-pending.md#ring-suspend)、[ring-resume](JKRD-V5.0.0-ring-supervision-pending.md#ring-resume)。与 S02/S06 联合验收，不丢任务、不自动删除业务数据。 |
| <a id="r06"></a>R06 | 定时队列 | **明确延后；职责与优先值待设计/确认**。明确计时对象、触发条件、队列职责、优先值以及与监督等待区的关系；尚未新增执行 FIFO。 | [E08](JKRD-V5.0.0-ring-supervision-pending.md#e08)、[E25](JKRD-V5.0.0-ring-supervision-pending.md#e25)、[E65](JKRD-V5.0.0-ring-supervision-pending.md#e65)。验收超时、唤醒、并行来源到达和已有任务顺序，不能仅因等待时长取消任务。 |
| <a id="r07"></a>R07 | 活环/死环判定、重构与优化移除 | **明确延后；待设计**。保留活环与死环的原始定义，补齐可观察判据、终止边界、重构/删除权限及依赖保护。 | [E08](JKRD-V5.0.0-ring-supervision-pending.md#e08)、[E67](JKRD-V5.0.0-ring-supervision-pending.md#e67)。验收长但可结束的环、长期等待触发以及仍有外部使用者的结构，避免误删。 |

<a id="snapshots"></a>

## 四、快照、恢复、格式校验与指纹

| 编号 | 内容 | 状态与剩余工作 | 来源与验证出口 |
| --- | --- | --- | --- |
| <a id="s01"></a>S01 | 快照分层与格式名称 | **明确延后；待设计/确认**。区分结构加载、有限状态快照与完整运行检查点的用途；V5 两个格式名仍为提案，文档版本批准不等于格式批准。 | [snapshot-static](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-static)、[snapshot-format](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-format)。为每类格式明确能恢复什么，禁止用结构加载宣称完整续算。 |
| <a id="s02"></a>S02 | 结构、状态、元数据与监督现场 | **明确延后；字段待设计**。定义节点、initial_q/运行 q、EX/pro/q_y、成员表、块槽/帧序、容量、世代、控制 q、编号分配器以及环挂起/预算的保存范围。 | [snapshot-runtime](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-runtime)。验收结构与状态属于同一边界、成员及引用闭合、池容量记录不冒充现存 Q。 |
| <a id="s03"></a>S03 | 任务、Qi_J0 载荷与到达集合格式 | **明确延后；字段待设计**。定义各队任务序列与重复项、类别/序号/归属/世代/EX 版本/cause，Qi_J0 锁存参数、整帧及输出载荷和未收齐到达集合；不套用旧简单对象为完整 schema。 | [E50–E51](JKRD-V5.0.0-snapshot-recovery-pending.md#e50)、[snapshot-tasks](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-tasks)。验收连续 Xi、相同数据的重复任务、缺来源与后续到达均能恢复。 |
| <a id="s04"></a>S04 | 输出批次、FRAME_OUT 和 ACK 进度 | **明确延后；未实现**。保存帧/批次身份、首发/重发、W 位数据、下一位位置、完成标记、独立 ACK 保留 q 与有效状态及消费位置。 | [snapshot-progress](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-progress)、[模块 ACK](../logic_units/async-structural-storage-draft.md#output-ack)。验收只续发未完成部分，已消费旧批次不在恢复后重新授予资格。 |
| <a id="s05"></a>S05 | 保存请求与一致边界 | **明确延后；协议待设计**。定义 EX/RAM 事务、传播和当前外部输入交接结束后的保存时机；包括首任务前及因参数不足结束的任务；不等待未来缺少来源。 | [E13](JKRD-V5.0.0-snapshot-recovery-pending.md#e13)、[E26](JKRD-V5.0.0-snapshot-recovery-pending.md#e26)、[snapshot-boundary](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-boundary)。验收同一时刻的状态/队列/进度，禁止拼接不同边界。 |
| <a id="s06"></a>S06 | 加载恢复及 V4 兼容/迁移策略 | **明确延后；待设计/确认**。恢复先校验再继续原队列；不能初始化补发事件；旧版本接受/拒绝/显式迁移范围及外部 Xi/Yi 历史衔接需明确。 | [E34](JKRD-V5.0.0-snapshot-recovery-pending.md#e34)、[E48–E49](JKRD-V5.0.0-snapshot-recovery-pending.md#e48)、[snapshot-boundary](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-boundary)。验收无外部 Xi 也使用已锁存参数，新输入独立入队，不重放已发输出。 |
| <a id="s07"></a>S07 | 逐字段格式与完整合法性校验 | **明确延后；待设计**。明确字段集合、类型、未知字段策略、接口/统计、引用、状态、成员、队列及世代的一致性，并提供有效与无效样例。 | [E52–E54](JKRD-V5.0.0-snapshot-recovery-pending.md#e52)。验收缺队列、错误归属/世代、非法 EX/pro/q_y、悬空引用和未知字段；格式延后不取消当前节点合法性。 |
| <a id="s08"></a>S08 | 规范 JSON 和双指纹 | **明确延后；载荷与实算待定稿**。明确 UTF-8、对象键排序、数组保序、字段参与范围、状态范围和排除字段，再定义 format_md5/md5 及独立复算。 | [snapshot-format](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-format)、[V4 基线](JKRD-V4.0.0-snapshot-reference.md)。验收非 ASCII、默认 pro、任务顺序/重复项、状态和展示字段变化；不复用旧指纹。 |
| <a id="s09"></a>S09 | 正式 JSON、恢复算例和续算等价验证 | **明确延后；尚未完成**。依据定稿格式建立新样例、异常样例与独立参考结果，比较恢复前后剩余任务、状态、Yi/FRAME_OUT 和消费序列。 | [E41](JKRD-V5.0.0-snapshot-recovery-pending.md#e41)、[E55–E57](JKRD-V5.0.0-snapshot-recovery-pending.md#e55)。历史 V4 算例和原稿“实算”不作为 V5 完整恢复通过记录。 |

<a id="verification"></a>

## 五、消费者迁移与完整验证

| 编号 | 内容 | 状态与剩余工作 | 来源与验证出口 |
| --- | --- | --- | --- |
| <a id="v01"></a>V01 | 消费者执行器、生成器与校验器迁移 | **待实现状态复核；本次未检查外部项目**。分别检查 JK_NET、JK_LOGIC、ModelShow 及相关消费者对 V5 输入锁存、参数、任务归属、事务/动态结构的支持；延后机制不得提前标为完成。 | [JKRD 来源与实现边界](../JKRD.md)、[更新对照](JKRD-V5.0.0-integration.md)。各项目按实际版本独立取证，本地文档升级不证明外部消费者已兼容。 |
| <a id="v02"></a>V02 | 任意网络中的 FIFO 与触发规则 | **规则已确认；通用场景待验证**。覆盖 Xi/RAM/普通 Qi 混合网络、收齐触发、同源覆盖、目标编号入队、跨队优先级、参数固定和不抢占的任务边界。 | [JKRD](../JKRD.md)、[模块验证边界](../logic_units/async-structural-storage-draft.md#implementation-boundary)。本模型缺少非 RAM 普通计算路径，17 项实验不能证明通用路由；跨队先后依赖是结构设计所需。 |
| <a id="v03"></a>V03 | 独立预期与端到端反例覆盖 | **已有定向实验；完整验收待补**。将适用条款对应到实现位置与正常/反例；综合连续输入、输入/ACK 交错、增长、依赖、回收及世代，不能用被测判断函数生成预期。 | [AGENTS](../../AGENTS.md)、[模块验证表](../logic_units/async-structural-storage-draft.md)。本次仅复核初始图，未重跑 17 项测试，未验证任意交错穷举、恢复、环监督或失败重试。 |
| <a id="v04"></a>V04 | 旧逻辑单元、计数器与静态原型复核 | **待按 V5 复核；保留历史证据**。复核基础门、MUX/恒值、计数器、changed 等结构及 6/17/40/43 节点原型的来源规则、接口、pro/publication 与输入协议；新结果另记，原附件不改写。 | [逻辑单元库](../logic_units/logic-units.md)、[计数器](../logic_units/counters-events.md)、[静态原型](../logic_units/static-prototypes.md)。旧串行、有限容量测试不证明动态输入与任意交错；不要求把所有旧原型都改造成最终模块。 |

<a id="ui"></a>

## 六、交互页面验收

| 编号 | 内容 | 状态与剩余工作 | 来源与验证出口 |
| --- | --- | --- | --- |
| <a id="u01"></a>U01 | 模块图、执行记录及画框操作 | **已有代码/历史局部验证；完整验收待补**。核对三部分归属、真实 EX 与 cause/管理/成员连线区分、节点/任务定位、状态/参数、单步动画及拖动、宽高调整、内容自适应、颜色和全屏。 | [页面](../../web/async-structural-storage/index.html)、[布局代码](../../web/async-structural-storage/frame-layout.mjs)、[全屏代码](../../web/async-structural-storage/canvas-fullscreen.mjs)。这些控件已有代码；本轮未操作浏览器，不把它们列为未实现。验收缩放、嵌套、折叠、还原布局、各视口及全屏退出后的连线与运行状态一致。 |

<a id="documents"></a>

## 七、文档与证据引用

| 编号 | 内容 | 状态与剩余工作 | 来源与验证出口 |
| --- | --- | --- | --- |
| <a id="d01"></a>D01 | 旧专题的相对路径与来源标识 | **本轮确认存在；待修整**。修正旧专题中 14 处失效的本地文件引用，并明确旧正文、临时 publication 编码与当前规则的关系；当前链接失效不自动等于证据丢失。 | [失效引用明细](#broken-links)。修复后逐项验证目标与附件身份；保留历史报告版本、哈希及验证范围，不重写旧验证结论。 |

<a id="boundaries"></a>

## 已确认边界与不重新打开的事项

| 事项 | 当前处理 |
| --- | --- |
| 节点豁免 | 已否决，链尾/池/停用 Q 全部遵守既有规则；不再列为待批准选项 |
| 链式自动延伸 | 已确认是遵守 V4 节点规则的构建用法；剩余工作是 A04 的实际构造，不是另立基础语法 |
| 每次 Xi 独立锁存、Xi/帧参数的 Qi_J0 方式 | 已确认；A02/V01/V02 只负责实现和验证 |
| FRAME_OUT 后才有 ACK 资格、ACK0 复用保留 q、ACK1 撤销资格 | 已确认；A05/S04 负责实现、验证及将来的恢复现场 |
| 满 8 帧、全部消费、无依赖才复用；部分使用空块继续使用 | 已确认；A04/V03 负责合法构造和验证 |
| 跨队列先后依赖 | 用户已改为“这种跨队列的先后依赖是设计结构所需。”；不要求设计者回避它 |
| 严格优先级下的有限等待 | 现行规则不保证持续高优先级输入下的低优先级推进；若将来要求有限等待，再另行设计。不能自行增加轮转、配额或入口暂停作为本清单的实施要求 |
| 连续输入与物理资源 | 连续接收是设计目标，不等于无限物理内存；资源不足的明确失败/保留策略属于 F03/F04，不默认丢帧或加入正常入口拒收限制 |
| 原 ack-burst 与 ack-replay 旧推论 | 依赖错误归属的连续消费结论已撤回；重读原槽方案已由当前 ACK 保留 q 方案替换，不作为未决设计恢复 |
| JKRD 文档版本 | V5.0.0 已批准；快照 format 名称和格式契约仍在 S01/S07/S08，二者不混同 |

<a id="audit-evidence"></a>

## 本轮实际复核与发现

1. 原稿 E01–E67 的 67 项均核对处置去向；E65 的六类旧待定项已分别归入 F/R/S，节点豁免与文档版本两项按最新确认关闭。原始差异稿正文不改写。
2. 补充 46 条逐项归类，完整映射见下表。5 条 ring-*、6 条 snapshot-* 原文及已迁入的原稿正文复核完整；V4 快照章节及恢复算例仍逐字保留。
3. 本轮用独立 EX 引用解析与拓扑排序检查初始实验图：66 个 Q 中只能拓扑移除 10 个，存在多节点环。直接互引例子包括 Q10(S1)↔Q11(C1)、Q33(H[7])↔Q40(OR7)、Q44(ACK_READY)↔Q47(ACK1)。这是 A01 的具体实现差异，不是规范缺陷证明；未用实验自身的 sources/validate/SCC 函数计算预期。
   读取的实验源码：[engine.mjs](../../web/async-structural-storage/engine.mjs)，SHA-256：`c8906048569fa8938d8a3f6d5e697bcde37896b698c579dca47605edea551c9e`。

4. 初始图检查只证明当前初始图未满足 DAG，不证明全部动态轨迹的性质。本轮未重跑 17 项历史测试、未做浏览器交互、未检查外部三个项目，也未完成任意交错、失败重试、环监督或快照恢复验证。
5. 页面源码中已有移动、调尺寸、颜色、ResizeObserver 与全屏代码；U01 的状态为待验收，不能因旧验证表未覆盖它们就改称未实现。
6. 本轮补齐 E15 的环待处理稿链接，并将两份待处理稿和本总清单登记到配置及相关文档入口。旧专题中另发现 14 处相对引用失效，详见 D01；没有将其混作本轮新增链接。

<a id="source-matrix"></a>

## 46 条历史补充的当前归类

每项保留历史正文；下表说明现行状态和剩余工作的归属，不把历史提案整体追认为已批准规范。原稿 E01–E67 的完整对照继续见 [更新对照](JKRD-V5.0.0-integration.md)。

| 补充来源 | 当前归类 | 剩余工作 |
| --- | --- | --- |
| [node-state](JKRD-V5.0.0-notes.md#node-state) | 基础规则已确认 | A01、A04、V01 |
| [node-ex](JKRD-V5.0.0-notes.md#node-ex) | 基础规则已确认 | F02、V01、V02 |
| [node-source](JKRD-V5.0.0-notes.md#node-source) | 引用与 cause 分开已确认 | A01、F02、V02 |
| [node-pro](JKRD-V5.0.0-notes.md#node-pro) | pro 只管传播已确认 | A05、F02、V02 |
| [node-refs](JKRD-V5.0.0-notes.md#node-refs) | 普通约束保留；空闲池豁免已否决 | A01、A04；不重开豁免 |
| [input-latch](JKRD-V5.0.0-notes.md#input-latch) | 逐次锁存已确认 | A02、V01 |
| [input-frame](JKRD-V5.0.0-notes.md#input-frame) | 模块封帧规则已确认 | A02、V03 |
| [input-clear](JKRD-V5.0.0-notes.md#input-clear) | 清除范围已确认 | A02、V03 |
| [input-copy](JKRD-V5.0.0-notes.md#input-copy) | 按 Qi_J0 事件来源处理已确认 | A02、V01、V02 |
| [input-handoff](JKRD-V5.0.0-notes.md#input-handoff) | 整帧接力已确认 | A02、F02 |
| [queue-priority](JKRD-V5.0.0-notes.md#queue-priority) | 当前 1/2/5 已确认；3 随环延后 | V02、R03 |
| [queue-ram](JKRD-V5.0.0-notes.md#queue-ram) | RAM 目标归属已确认；环分支延后 | V02、R03 |
| [schedule-boundary](JKRD-V5.0.0-notes.md#schedule-boundary) | 原子任务边界已确认；保存请求延后 | F02、V02、S05 |
| [task-identity](JKRD-V5.0.0-notes.md#task-identity) | 模块身份保护有要求；字段格式未定 | A04、F01、S03 |
| [task-payload](JKRD-V5.0.0-notes.md#task-payload) | 独立持有已确认；Xi/帧参数按 Qi_J0 方式归并 | A02、A05、S03 |
| [task-arrival](JKRD-V5.0.0-notes.md#task-arrival) | 目标到达集合已确认；序列化延后 | V02、S03 |
| [storage-factory](JKRD-V5.0.0-notes.md#storage-factory) | 模块职责已确认；通用动作待设计 | F01、F02、A04 |
| [storage-block](JKRD-V5.0.0-notes.md#storage-block) | 8 槽为本模型配置已确认 | A04、V03 |
| [storage-slot](JKRD-V5.0.0-notes.md#storage-slot) | W 个数据 Q 与位序已确认 | A04、V03 |
| [storage-data](JKRD-V5.0.0-notes.md#storage-data) | 长期数据保存在 JK q 已确认 | A02、A04、V03 |
| [storage-growth](JKRD-V5.0.0-notes.md#storage-growth) | 按需增长和安全优先复用已确认 | A04、F03、V03 |
| [storage-recycle](JKRD-V5.0.0-notes.md#storage-recycle) | 已补充满 8 帧条件；旧提案不单独适用 | A04、V03 |
| [ack-head](JKRD-V5.0.0-notes.md#ack-head) | L 执行时队首，补充 FRAME_OUT 资格已确认 | A05、S04 |
| [ack-decode](JKRD-V5.0.0-notes.md#ack-decode) | 互斥动作与锁存值已确认 | A05 |
| [ack-replay](JKRD-V5.0.0-notes.md#ack-replay) | 重读原槽旧方案被保留 q 重发取代 | A05；旧方案不再待确认 |
| [ack-consume](JKRD-V5.0.0-notes.md#ack-consume) | 消费、撤销资格和下一帧首发已确认 | A05、S04 |
| [ack-burst](JKRD-V5.0.0-notes.md#ack-burst) | 旧时序结论已撤回 | 不列为待批准规则；交错验证归 A05/V03 |
| [output-latch](JKRD-V5.0.0-notes.md#output-latch) | 输出任务独立锁存已确认 | A05、S03、S04 |
| [output-detach](JKRD-V5.0.0-notes.md#output-detach) | 槽与输出载荷独立、目标保护已确认 | A04、A05 |
| [output-marker](JKRD-V5.0.0-notes.md#output-marker) | W 位后完成标记与首发/重发值已确认 | A05、S04 |
| [transaction-validate](JKRD-V5.0.0-notes.md#transaction-validate) | 校验方向已提出；通用权限与动作待补 | F01、F02、A04 |
| [transaction-commit](JKRD-V5.0.0-notes.md#transaction-commit) | 原子提交边界已确认；通用绑定待补 | F02、F03 |
| [transaction-publish](JKRD-V5.0.0-notes.md#transaction-publish) | 提交后发布方向保留；逐动作次序待落实 | F02 |
| [transaction-generation](JKRD-V5.0.0-notes.md#transaction-generation) | 世代隔离要求保留；动态与恢复须完整化 | A04、S02、S03 |
| [transaction-failure](JKRD-V5.0.0-notes.md#transaction-failure) | 整体回滚/保留/重试为待定方案 | F03、F04 |
| [ring-classify](JKRD-V5.0.0-notes.md#ring-classify) | 明确延后 | R01、R02 |
| [ring-reassign](JKRD-V5.0.0-notes.md#ring-reassign) | 明确延后 | R03 |
| [ring-budget](JKRD-V5.0.0-notes.md#ring-budget) | 明确延后，6 非通用规则 | R04 |
| [ring-suspend](JKRD-V5.0.0-notes.md#ring-suspend) | 明确延后 | R05、S02 |
| [ring-resume](JKRD-V5.0.0-notes.md#ring-resume) | 明确延后 | R05、S06 |
| [snapshot-static](JKRD-V5.0.0-notes.md#snapshot-static) | 明确延后 | S01 |
| [snapshot-runtime](JKRD-V5.0.0-notes.md#snapshot-runtime) | 明确延后 | S02、S03、S04、S06 |
| [snapshot-tasks](JKRD-V5.0.0-notes.md#snapshot-tasks) | 明确延后 | S03 |
| [snapshot-progress](JKRD-V5.0.0-notes.md#snapshot-progress) | 明确延后 | S04 |
| [snapshot-boundary](JKRD-V5.0.0-notes.md#snapshot-boundary) | 明确延后 | S05、S06、S09 |
| [snapshot-format](JKRD-V5.0.0-notes.md#snapshot-format) | 明确延后，格式名与载荷未定稿 | S01、S07、S08、S09 |

<a id="broken-links"></a>

## 旧专题的失效引用明细

本轮只读扫描 Markdown 正文中的本地文件引用，排除代码围栏和外部 URL；共 14 处。下列行号为复核时位置，当前工作按 D01 归口，不改写历史附件本身。

| 文档及行号 | 当前失效的相对目标 |
| --- | --- |
| [latch-dynamic-waiting.md](../logic_units/latch-dynamic-waiting.md)：64 | `JKRD.md` |
| [counters-events.md](../logic_units/counters-events.md)：5 | `JKRD.md` |
| [counters-events.md](../logic_units/counters-events.md)：133 | `../assets/counters/counter-and-transition-models.json` |
| [counters-events.md](../logic_units/counters-events.md)：135 | `../assets/counters/verification-report.json` |
| [counters-events.md](../logic_units/counters-events.md)：137 | `../provenance/missing-design-evidence-2026-10-01.md` |
| [static-prototypes.md](../logic_units/static-prototypes.md)：9 | `JKRD.md` |
| [static-prototypes.md](../logic_units/static-prototypes.md)：469 | `../assets/static-prototypes/async-buffer-43-q39-q41.json` |
| [static-prototypes.md](../logic_units/static-prototypes.md)：471 | `../provenance/missing-design-evidence-2026-10-01.md` |
| [logic-units.md](../logic_units/logic-units.md)：245 | `../assets/logic-units/original8/minimal_gate_structures.json` |
| [logic-units.md](../logic_units/logic-units.md)：247 | `../assets/logic-units/original8/verify.py` |
| [logic-units.md](../logic_units/logic-units.md)：249 | `../assets/logic-units/original8/results.json` |
| [logic-units.md](../logic_units/logic-units.md)：255 | `../assets/logic-units/complete11/minimal_boolean_structures11.json` |
| [logic-units.md](../logic_units/logic-units.md)：257 | `../assets/logic-units/complete11/verify.py` |
| [logic-units.md](../logic_units/logic-units.md)：259 | `../assets/logic-units/complete11/results_stage1_complete.json` |

## 工作次序（整理建议）

先补 A01、F01/F02 及 A04 的合法结构与动态动作，再落实 F03/F04、A02/A03/A05 与 V/U 验收。环和快照继续分别在对应待处理稿中设计；S02–S04 需要引用模块最终的数据生命周期，监督现场又与 R04/R05 衔接。此顺序是整理建议，不改变已确认的队列优先级、跨队先后依赖或业务规则。

# JKRD V5.0.0 待处理总清单（复核稿）

> 2026-10-19。依据用户“再核对一遍，并整理所有需要待处理的模块或内容”的要求建立。本清单覆盖当前 JKRD、异步结构存储模块、环与快照待处理稿、原稿 E01–E67、46 条补充及本地实验；记录 31 项待设计、待实现或待验证工作。它是工作索引，不新增计算规则，也不把已确认行为重新列作待批准。

> **2026-10-21 最新进展：** 已按全部实际参数就绪后入队重构 A03/F02 的 JK 结构及事务，并更新75任务人工推导与6份动态检查点；ACK采用用户批准的“译码确定帧和资格、后续独立原子动作、陈旧动作不转投下一帧”。已完成设计数据及本例静态核对，未实现执行器或实际恢复验证。旧49任务只保留历史文字。见[当前设计](../logic_units/async-structural-storage-draft.md#a03-readiness-redesign)。


异步结构存储仍由 **JK 节点组合的异步处理结构、FIFO 队列组、RAM.FACTORY** 三部分协作。下表的八类是工作范围，不是八个新的运行模块。

| 工作范围 | 清单 | 当前状态 |
| --- | --- | --- |
| JK 节点结构与业务接入 | A01–A05 | A03就绪结构、事务重划、75任务和6检查点已推导；运行、通用交错与更多宽度未验证 |
| RAM.FACTORY 操作与事务 | F01–F02 | 工厂只执行操作事务已确认；F02已补真实JK就绪及完整参数绑定候选，通用实现/失败协议待做 |
| 失败、回滚与重试 | F03–F04 | 完整协议待设计与实现 |
| 环判定、DAG.CARE、定时队列 | R01–R07 | 明确延后，未启用 |
| 快照、恢复、校验与指纹 | S01–S09 | 通用字段、75任务与6份更新后现场已设计；本例静态/摘要核对，实际保存恢复等价未做 |
| 消费者与模型验证 | V01–V04 | 已有局部证据；通用验证、迁移状态及旧模型 V5 复核待做 |
| 交互页面 | U01 | 已有页面和画框操作代码；完整界面验收待做 |
| 文档与证据引用 | D01 | 本轮发现的旧专题引用待修整 |

状态口径：“待设计/确认”表示尚未确定具体协议；“已确认/待实现”表示规则不再悬而未决；“已有定向实验/待完整验证”表示不能扩大现有测试的证明范围；“外部未复核”不等于断言外部未实现。

详细设计入口：[异步结构存储模块](../logic_units/async-structural-storage-draft.md)、[环监督待处理稿](JKRD-V5.0.0-ring-supervision-pending.md)、[快照恢复待处理稿](JKRD-V5.0.0-snapshot-recovery-pending.md)。

2026-10-21：A01–A05 已整理 [合法拓扑候选](../logic_units/async-structural-storage-draft.md#topology-proposal)与[模型 JSON、直接验证及来源对应表](../logic_units/async-structural-storage-draft.md#model-design-evidence)。本次新增设计数据，未编写执行器；此前提前产生的代码修改已撤回。下表分别显示已处理的设计、尚待确认的选择及未完成的执行验证，不把候选模型当作现有演示状态。

2026-10-21 续补：[A03 与 RAM.FACTORY 通用动态接入](../logic_units/async-structural-storage-draft.md#dynamic-integration)。依据用户新确认，将 JK 求值和工厂操作事务明确分工；新增完整 80/87 节点 JSON、动态构造、GC 与晚到/早到案例。A03/F01/F02 的设计缺口已补齐到可审阅方案，运行实现和失败重试没有提前关闭。

2026-10-21 续补第四模块：[快照格式与恢复契约](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-format-design)。S01–S08 已形成当前无环范围的候选；S09 已有完整核心JSON、动态片段、独立续算预期及指纹实算。仅设计与静态/字节核对，未写执行器；监督/失败扩展、实际动态续算和消费者支持仍待处理。

2026-10-21 历史续补曾给出49任务/6检查点；本次已由[75任务及六份更新后检查点](JKRD-V5.0.0-snapshot-recovery-pending.md#a03-readiness-checkpoints)替代。新CP2包含真实非空到达集合，CP3保存已锁定未执行的SAVE，CP5区分待执行领取门与active准备。运行恢复尚未验证。

<a id="storage"></a>

## 一、异步结构存储：JK 节点结构与业务接入

| 编号 | 内容 | 状态与剩余工作 | 来源与验证出口 |
| --- | --- | --- | --- |
| <a id="a01"></a>A01 | 完整合法拓扑 | **新候选完整图及静态核对已补；运行未实现**。固定输出与中转保留，A/A_READ改为不执行校验的真实引用锚；PRE.V由CLAIM保持EX引用闭合，READY由真实观察节点闭合。历史71节点/78节点构造仍保留，不再混用旧A求值顺序。 | [当前结构及来源表](../logic_units/async-structural-storage-draft.md#a03-readiness-redesign)、[六份全图](JKRD-V5.0.0-snapshot-recovery-pending.md#a03-readiness-checkpoints)。静态图合法不证明任意动态轨迹。 |
| <a id="a02"></a>A02 | 整帧接力、输入及参数生命周期 | **接力设计及独立预期已推导；待确认后实现**。给出每帧 Xi→S/C→D 的真实 EX、锁存参数与释放边界；连续两帧实例不从最新输入重拼旧帧。W=1/8、重复0、校验0、FRAME_IN 清除已有直接案例，尚非运行验收。 | [input-handoff](JKRD-V5.0.0-notes.md#input-handoff)、[构造与案例 JSON](../../assets/async-structural-storage-v5-design/construction-and-cases.json)中的 `construct_f1_transaction/task_contracts/reasoned_cases`。待验证实际队列交错与载荷生命周期。 |
| <a id="a03"></a>A03 | 计算前后接入及 Q7/Q8/Q9/Q10i | **按最新就绪规则完成结构、EX、JSON和人工序列推导；执行与通用验证待做**。JOIN/CLAIM按编号独立运行，GO锁存成功事件；各无状态COMP独立计算，COMMIT收齐实际结果后保存POST/下一前沿。预分配初0前沿支持早到/晚到接入，0不当缺值；观察节点及旧轮依赖完整列出。 | [业务结构](../../assets/async-structural-storage-v5-design/a03-readiness-business.json)、[当前设计](../logic_units/async-structural-storage-draft.md#a03-readiness-redesign)、[75任务/6检查点](JKRD-V5.0.0-snapshot-recovery-pending.md#a03-readiness-checkpoints)。旧80/87节点与49任务仅历史候选；不声称通用全部已验证。 |
| <a id="a04"></a>A04 | 节点生命周期、块槽回收和链式展开 | **旧轮回收、部分块保留及LATCH结束边界已补候选；运行待验**。旧业务计算轮仍由后续Q71 GC删除。临时LATCH只在主/附带EX、最后读取、静默无待发布及全部外部依赖结束后的最终原子提交删除；活动EX内不删，有依赖则转GC。这是结束边界细化，不是节点豁免。 | [当前生命周期细化](../logic_units/async-structural-storage-draft.md#a03-readiness-redesign)、[6断面](JKRD-V5.0.0-snapshot-recovery-pending.md#a03-readiness-checkpoints)。满8且全部消费并解除依赖才可复用；第9帧增长、世代复用、保护拒绝及失败回滚仍待运行验证。 |
| <a id="a05"></a>A05 | 输出、FRAME_OUT 与 ACK 全链路 | **就绪图及交错预期已重推；运行待验**。B/R/标记完成节点使LATCH等齐后才锁存输出；FRAME_OUT先用旧F/C算READY，再独立更新H/F。ACK按已批准边界拆DEC与固定帧ACT，陈旧动作忽略，不转投下一帧。 | [输出结构](../../assets/async-structural-storage-v5-design/a03-readiness-output.json)、[ACK结构](../../assets/async-structural-storage-v5-design/a03-readiness-ack.json)、[CP3–CP6](JKRD-V5.0.0-snapshot-recovery-pending.md#a03-readiness-checkpoints)。完整任意交错、旧锁存被后续覆盖的执行反例仍待验。 |

<a id="factory"></a>

## 二、RAM.FACTORY：操作、权限与失败处理

| 编号 | 内容 | 状态与剩余工作 | 来源与验证出口 |
| --- | --- | --- | --- |
| <a id="f01"></a>F01 | 工厂操作清单与权限 | **7 类通用操作及允许/拒绝条件已设计，待确认与实现**。工厂负责完整片段分配、引用绑定/断开、成员和槽登记、请求真实Q求值、队首推进、旧轮回收、整块容量复用。没有工厂EX或直接write_q，业务变化由各Q真实EX完成；固定输出、现存依赖和节点约束均受保护。 | [原操作权限分类](../../assets/async-structural-storage-v5-design/a03-factory-transactions.json)的 `ownership/factory_operations` 保留作基线；实际 A03 事务以[当前 draft-2 完整契约](../../assets/v5-snapshot-design/a03-dynamic/checkpoint-contract.json)及[新设计说明](../logic_units/async-structural-storage-draft.md#a03-readiness-redesign)为准。操作事务本身获用户明确界定；具体原语与权限为本轮设计方案，未实现通用API。 |
| <a id="f02"></a>F02 | 节点行为、事务整体就绪与任务绑定 | **全部实际参数就绪规则已确认；JK门、事务划分及具体绑定已补设计**。不使用事务内未来结果；独立多EX仅共享已经存在的输入。缺项留在JK/到达集合，不让未就绪任务占FIFO队首；工厂不执行EX或直接改q。 | [当前设计及对应表](../logic_units/async-structural-storage-draft.md#a03-readiness-redesign)、[内嵌契约](../../assets/v5-snapshot-design/a03-dynamic/checkpoint-contract.json)。通用操作实现、任意交错和F03/F04失败处理未完成。 |
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
| <a id="s01"></a>S01 | 快照分层与格式名称 | **两层格式及候选版本已设计，待确认**。原通用核心保留 draft-1；本次 A03 使用独立 `draft-2-a03-ready` 扩展，旧消费者不得忽略新字段。structure 用于新运行；runtime 内嵌结构并保存完整边界现场。当前 profile 仅无环、Xi/RAM/Qi=1/2/5；未知监督/失败现场拒绝，不声称有限快照可完整续算。 | [本轮格式设计](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-format-design)、[字段契约](../../assets/v5-snapshot-design/format-contract.json)。正式发布与消费者支持待完成。 |
| <a id="s02"></a>S02 | 结构、状态、元数据与监督现场 | **新就绪图的6份完整动态现场已更新并做本例静态核对**。包含初值/当前q、预留与已完成前沿、观察节点、PRE/POST、回收与工厂契约；业务许可仍在JK q。 | [当前6检查点](JKRD-V5.0.0-snapshot-recovery-pending.md#a03-readiness-checkpoints)、[完整契约](../../assets/v5-snapshot-design/a03-dynamic/checkpoint-contract.json)。环监督、失败/重试现场和实际恢复待做。 |
| <a id="s03"></a>S03 | 任务、Qi_J0 载荷与到达集合格式 | **任务、参数池及真实未齐现场已重推**。CP1保存独立输入handoff；CP2的LATCH只有部分来源到达，不在FIFO；CP3的SAVE2已锁定COMP `[1,1]`，尚未保存结果。普通q仍执行时读。 | [CP1–CP3及75任务](JKRD-V5.0.0-snapshot-recovery-pending.md#a03-readiness-checkpoints)、[逐任务JSON](../../assets/v5-snapshot-design/a03-dynamic/reasoned-continuations.json)。具体字段/保护静态核对不替代序列化和加载实现。 |
| <a id="s04"></a>S04 | 输出批次、FRAME_OUT 和 ACK 进度 | **按DEC→固定帧ACT边界更新CP3–CP6及9次输出预期**。CP4现保存T46后两个实际绑定帧1且未执行的ACT47/48，包含参数、附带EX和planned_creations；不只描述契约。CP5的Q194仍只是待执行领取门。旧完成不复活，陈旧ACT不转投下一帧。 | [输出/ACK设计](../logic_units/async-structural-storage-draft.md#a03-readiness-redesign)、[完整检查点](JKRD-V5.0.0-snapshot-recovery-pending.md#a03-readiness-checkpoints)。实际续算、全部交错及输出覆盖反例未执行。 |
| <a id="s05"></a>S05 | 保存请求与一致边界 | **一致切点协议已设计，待确认及实现**。完整EX/事务、传播、当前send交接后取值，覆盖首任务前与参数不足结束；保存输入/输出序号，不等待未来来源。半事务、失败现场不伪装为可保存检查点。 | [本轮保存协议](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-format-design)第6节。宿主输入切点、并发保存与运行等价待验证。 |
| <a id="s06"></a>S06 | 加载恢复及 V4 兼容/迁移策略 | **隔离校验、原子安装及V4策略已设计**。加载零EX/事件/补任务/Yi重放，初始暂停；V4不允许补字段冒充无损续算，只提出显式新运行结构导入。宿主崩溃恰好一次另需协议。 | [恢复要求](JKRD-V5.0.0-snapshot-recovery-pending.md#snapshot-format-design)第6/7节；[直接推导](../../assets/v5-snapshot-design/continuation-example-notes.json)。加载器和迁移器未写。 |
| <a id="s07"></a>S07 | 逐字段格式与完整合法性校验 | **通用字段要求保留，最新A03契约及六图静态核对已补**。本例核对引用/DAG、状态、目标/来源版本、锁存、保护与到达集合；新增条件只能读已存在参数，不读本事务未来主结果。 | [字段契约](../../assets/v5-snapshot-design/format-contract.json)、[A03 draft-2契约](../../assets/v5-snapshot-design/a03-dynamic/checkpoint-contract.json)、[静态记录](../../assets/v5-snapshot-design/a03-dynamic/verification-record.json)。声明式契约不是通用校验器，正式格式与消费者仍待完成。 |
| <a id="s08"></a>S08 | 规范 JSON 和双指纹 | **F/M规则保留，更新后六份动态JSON及内嵌契约摘要已复算**。format_md5覆盖结构/初值/接口/契约，md5再含runtime；metadata排除、默认pro归一化和数组保序不变。 | [本轮静态与双指纹记录](../../assets/v5-snapshot-design/a03-dynamic/verification-record.json)记录Python/OpenSSL一致性；[原字节向量](../../assets/v5-snapshot-design/validation-and-fingerprint-cases.json)保留。摘要一致不证明执行行为；正式契约及消费者校验器待做。 |
| <a id="s09"></a>S09 | 正式 JSON、恢复算例和续算等价验证 | **已更新6份完整动态JSON及75任务条件续算人工预期；运行等价未做**。覆盖复制中途、真实非空到达集合、部分输出、DEC/ACT交错、旧轮回收和部分块保留；每份明确当前队列与未来输入计划。 | [当前检查点入口](JKRD-V5.0.0-snapshot-recovery-pending.md#a03-readiness-checkpoints)、[逐任务推导](../../assets/v5-snapshot-design/a03-dynamic/reasoned-continuations.json)。实际恢复/不中断比较、通用宽度、任意交错、满8世代复用和失败现场仍待验证。 |

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
| 事务入队就绪 | 全部节点/操作参数实际准备好后才由JK结构触发；缺项不入FIFO。A03/F02与6检查点已补设计/人工推导，运行待验 |
| ACK译码与动作边界 | 用户已批准译码时确定帧/资格，再触发固定该帧的独立原子事务；陈旧动作忽略，不转投下一帧 |
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
| [schedule-boundary](JKRD-V5.0.0-notes.md#schedule-boundary) | 原子任务边界已确认；保存请求协议已补设计 | F02、V02、S05 |
| [task-identity](JKRD-V5.0.0-notes.md#task-identity) | 模块身份保护已确认；快照身份/版本字段已补设计 | A04、F01、S03 |
| [task-payload](JKRD-V5.0.0-notes.md#task-payload) | 独立持有已确认；Xi/帧参数按 Qi_J0 方式归并 | A02、A05、S03 |
| [task-arrival](JKRD-V5.0.0-notes.md#task-arrival) | 目标到达集合已确认；序列化字段已补设计 | V02、S03 |
| [storage-factory](JKRD-V5.0.0-notes.md#storage-factory) | 模块职责已确认；通用操作与节点行为绑定已补设计，待确认及实现 | F01、F02、A04 |
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
| [transaction-validate](JKRD-V5.0.0-notes.md#transaction-validate) | 通用操作权限与拒绝条件已补设计；运行校验待实现 | F01、F02、A04 |
| [transaction-commit](JKRD-V5.0.0-notes.md#transaction-commit) | 原子提交边界已确认；通用绑定已补设计，失败细节待处理 | F02、F03 |
| [transaction-publish](JKRD-V5.0.0-notes.md#transaction-publish) | 提交后发布方向保留；显式请求与发布次序已列候选，待确认及验证 | F02 |
| [transaction-generation](JKRD-V5.0.0-notes.md#transaction-generation) | 世代隔离要求保留；动态与恢复须完整化 | A04、S02、S03 |
| [transaction-failure](JKRD-V5.0.0-notes.md#transaction-failure) | 整体回滚/保留/重试为待定方案 | F03、F04 |
| [ring-classify](JKRD-V5.0.0-notes.md#ring-classify) | 明确延后 | R01、R02 |
| [ring-reassign](JKRD-V5.0.0-notes.md#ring-reassign) | 明确延后 | R03 |
| [ring-budget](JKRD-V5.0.0-notes.md#ring-budget) | 明确延后，6 非通用规则 | R04 |
| [ring-suspend](JKRD-V5.0.0-notes.md#ring-suspend) | 明确延后 | R05、S02 |
| [ring-resume](JKRD-V5.0.0-notes.md#ring-resume) | 明确延后 | R05、S06 |
| [snapshot-static](JKRD-V5.0.0-notes.md#snapshot-static) | 两层格式已补设计，待确认 | S01 |
| [snapshot-runtime](JKRD-V5.0.0-notes.md#snapshot-runtime) | 无环现场字段已设计；监督/失败扩展仍延后 | S02、S03、S04、S06 |
| [snapshot-tasks](JKRD-V5.0.0-notes.md#snapshot-tasks) | 统一参数池、任务与到达集合已设计 | S03 |
| [snapshot-progress](JKRD-V5.0.0-notes.md#snapshot-progress) | 输出/ACK字段与局部案例已设计 | S04 |
| [snapshot-boundary](JKRD-V5.0.0-notes.md#snapshot-boundary) | 一致保存/恢复协议已设计，运行待验 | S05、S06、S09 |
| [snapshot-format](JKRD-V5.0.0-notes.md#snapshot-format) | draft-1格式与载荷已给候选并实算，待定稿 | S01、S07、S08、S09 |

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

本轮已完成 A03/F02 的就绪结构与事务重划、六份动态检查点和75任务人工推导。下一步审阅具体候选，继续设计 F03/F04 失败协议；设计确认后再实现 A02/A03/A05 与保存/加载，并比较恢复和不中断运行的实际轨迹。更多帧宽、任意交错与满8世代复用分别验收。环监督及其现场继续延后；不改变已确认的队列优先级与跨队先后依赖。

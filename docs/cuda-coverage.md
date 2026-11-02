# V6.1 CUDA 实现覆盖与证据

适用来源为 [plan.V6.1.md](plan.V6.1.md)。V5 静态结构迁移另按 [JKRD V5](JKRD.md) 校验；V6.1 的新运行规则不反向改写 V5。`plan.V6.1.cc.md` 不覆盖本次指定方案。

本表记录实现进度，不把代码存在、CPU 原生测试或历史摘要匹配计为 GPU 验收。**CUDA 编译、真实设备正确性、异步内存顺序、Compute Sanitizer 和性能全部待验收。** 目前不存在可以据此宣称“V6.1 全部 44 项完成”的证据。

运行配置名为 `jkcuda.v6.1`，格式版本为 `1`；`native-cpu` 是明确选择的原生状态机测试后端，独立语义参考位于 `jkcuda/reference.py`。选择 `cuda` 时环境不足必须报错，不自动回退到 CPU。

## 原 44 项对应关系

“部分”表示已有可执行基础或代码路径，但该原项仍有缺口；“待实现”表示不能通过类似功能冒充；所有 CUDA 路径均还需真实设备验证。文件名可从项目根查找。

| 编号 | 当前状态 | 来源条款 → 必须行为 | 实现位置 | 验证依据与未覆盖 |
|---|---|---|---|---|
| A01 | 部分 | §9 版本 → profile、结构/运行格式和兼容能力显式区分 | `model.py`、`compat.py`、`persistence.py` | 拒绝未知 profile；旧运行恢复明确不支持。不是完整 V5/V6 模块版本注册体系。 |
| A02 | 部分 | §3.2 N01 → 来源、状态和订阅分离；输入副本事件型分类保持 | `model.py`、`backend.py::_compile_model`、`compat.py` | 宿主迁移测试确认有状态输入副本仍映射 PARAM/ALL_LATEST；CUDA 待验。 |
| A03 | 部分 | §3.2 N01、§3.4 → 完整 EX、固定来源、q_seed/self、原始程序保留 | `model.py::parse_ex`、`native/core.hpp::evaluate_one` | 解释器/参考测试；完整语法、重复操作、self 反例。热点 JIT 和长 EX 并行组合未实现。 |
| A04 | 部分 | §3.2、T03 → 稳定 ID/世代与设备槽分离，不截断 | `model.py`、`backend.py`、`compat.py` | 大编号、旧任务/新世代隔离及状态槽复用约束已有原生反例验证；通用物理槽 GC 未实现。 |
| A05 | 部分 | §10、L01 → 计算来源与触发图分别检查；环须有启动与预算 | `model.py::strongly_connected`、`compat.py` | V5 DAG 反例、V6 触发环启动/预算检查；动态 SCC 合并拆分历史继承未定义，不能重置冒充。 |
| B01 | 部分 | §3.2 N02 → 整次输入校验、锁存和 FIFO 入队，重复/零保留 | `runtime.py::send`、`backend.py::enqueue` | 独立参考及原生差分覆盖；真实 GPU 并发接纳尚未验证。 |
| B02 | 部分 | §6 → accepted/device_visible/durable 独立事实，传输不传播 | `runtime.py::Ticket/_accept/send_tensor` | 当前传输同步后 accepted/device_visible 可以同时成立；尚无真正重叠 H2D 管线。 |
| B03 | 部分 | §3.3 N03 → ANY、ALL_LATEST、ZIP、KEYED 保持各自配对状态 | `native/core.hpp`、`reference.py::_deliver` | CPU 参考/原生差分、零值与重复 key 测试；GPU 并行匹配未验。 |
| B04 | 部分 | §3.3 → 调用锁存不可变事件参数，帧/输出独立所有权 | `backend.py` PARAMS、TOKENS、OUTPUTS；`runtime.py` outbox | 基础位参数和输出已有；通用帧载荷、版本化 VALUE 结果池仍未完整实现。 |
| B05 | 部分 | §3.4 N04、T01 → 实际执行绑定状态/self；事务按内部次序读前序结果 | `native/core.hpp::state_value/evaluate_one` | 普通任务、事务状态别名和内部 result_ref 已通过独立参考差分；GPU 待验。 |
| B06 | 部分 | §3.1 Q01、N04 → 一个活动任务，完整传播后重选 | `native/core.hpp::select/advance`、`runtime.py::step/run` | 完整任务边界、分片传播、失败续接定向测试；CUDA 调度待验。 |
| B07 | 部分 | §3.4、Q03 → 事件有任务身份及发布次序，不按线程抢位 | `native/core.hpp::commit`、`native/propagation.hpp` | 事件有序提交；后继采用稳定前缀定位、协作写入后集中发布。native 逆序模拟写入通过，GPU 线程竞争压力待验。 |
| C01 | 部分 | Q02 → 设备现场包含 FIFO、事件、状态、匹配余项和活动任务 | `backend.py` arena、`native/core.hpp` | 统一设备整数 arena 保存记录；是固定可扩容段，尚非独立分页池。 |
| C02 | 部分 | N01/N04 → 合法 EX 解释路径，共享不改变 FIFO | `native/core.hpp::evaluate_one` | 通用解释器已写；模板压缩、JIT、位切片、长 EX 优化未实现。 |
| C03 | 部分 | §3.6 N05 → 明确 stream 依赖与可见性 | `native/engine.cu`、`backend.py` CUDA 包装 | 当前有界 kernel 后同步；多 stream 重叠、release/acquire 并发发布与 CUDA Graph 未验。 |
| C04 | 部分 | N05、§7 → 不足容量背压/扩容，身份和 FIFO 保持 | `native/core.hpp::room/commit`、`backend.py::grow` | 容量不足前保留任务、显式扩容；尚非分页分配器，长期记录回收需完善。 |
| C05 | 部分 | §4 PERF-P/X/H → 优化任务内部，不并行独立任务 | `native/engine.cu`、`native/propagation.hpp`、`native/core.hpp` | 新增单 block 多 warp 扇出、同目标独占匹配、稳定 scan/scatter 和保序发布；CPU 阶段模拟与独立参考比较，CUDA 同步与性能待实机。JIT/bitpack 未实现。 |
| D01 | 部分 | T01 → 声明原子事务先排 FIFO，显式内部前序结果引用 | `model.py` transactions、`runtime.py::submit_transaction`、`native/core.hpp` | 普通事务计算路径已写；不据此宣称 V5 A03 事务兼容。 |
| D02 | 部分 | T01/T03 → 结构/状态/队首/回收动作有明确任务契约 | `backend.py::modify`、`native/core.hpp` 结构任务、`native/frames.hpp` 控制任务 | 改图及帧队首/资格改变均经 FIFO；通用 V5 工厂权限与任意业务操作集未实现。 |
| D03 | 部分 | T01 → 同任务重复目标与多 EX 逐项、seed 和结果版本可追踪 | `native/core.hpp` TXOPS/TXPARAMS | 多目标、同槽别名、前序结果/状态候选、缺参原子无写与故障续接已有原生验证；GPU 待验。 |
| D04 | 部分 | T02 → 提交前资源预留，本事务一次提交，不覆盖新输入 | `native/core.hpp::commit` | 基础事务候选及容量预留；页级 COW、层次根安装、异步旧根保护未实现。 |
| D05 | 部分 | T03 → 改 EX/订阅先排队，旧任务保留绑定版本 | `backend.py::modify`、`native/core.hpp` 版本提交 | 原生测试覆盖旧任务/新版本共存、未齐 token 保护、帧固定输出版本。带余项的契约变更明确拒绝，未擅自定义迁移。 |
| D06 | 部分 | T03 → 逻辑退休后检查任务/输出/快照持有者再回收 | `backend.py::modify` 逻辑退休及保留历史版本 | 世代重用隔离状态槽，旧任务继续持有旧身份；尚无完整物理页/节点 GC，历史版本保留会增长内存。 |
| E01 | 部分 | S01 → 新 W/K 参数化、旧 W≤8/整块满8复用 | `frames.py::submit_frame`、`native/frames.hpp` INPUT_BIT/STORE | 新 profile 每帧恰好 W 独立输入复制任务；K 整块满、全部消费、无批次持有后换世代。旧模块 A03 运行兼容仍未实现。 |
| E02 | 部分 | S01 → 每帧独立接力，S_W/C_W 按宽度保存 | `business.py`、`frames.py`、`native/frames.hpp` | 新增每声明宽度独立 S_W/C_W 的真实 EX 任务；原始 PRE 与计算后 POST 独立，输入/输出宽度可不同。GPU 待验。 |
| E03 | 新 V6 构造已实现，GPU 待验 | S01 → PRE/COMP/POST 的明确任务或原子内部步骤 | `business.py::build_business_model`、KEYED/普通节点、native PRE_ACCEPT/CLAIM 与 FINISH hooks | 声明有限无环 JK 图；全部 COMP→COMMIT→POST/NEXT→FINISH 均为真实 FIFO 任务。原生验证累计、DAG、多宽度、慢 ACK、资源等待、故障/恢复和保护子图。不是 V5 A03 原子事务兼容，也不包含通用物理 GC。 |
| E04 | 部分 | S02 → 设备输出、宿主 outbox 和应用确认分开 | `native/frames.hpp::emit/frame_capture_output`、`runtime.py` outbox | W 个数据及 marker 由真实声明 JK 输出任务求值；独立批次和稳定 ID。宿主保守等待整批完整，不宣称任意跨帧交错交付。 |
| E05 | 部分 | S02 → W 项宿主接收后 marker，可靠完成控制任务入 FIFO | `frames.py::received_batch`、`native/frames.hpp` COMPLETE、`runtime.py::read_frame_batches` | 完整批次收到后先可靠接纳完成任务再向应用提供 marker；资格仅在 COMPLETE 执行时更新。每批预留完成任务、trace 和请求空间；GPU 交接仍待验。 |
| E06 | 部分 | S03 → DEC→绑定帧 ACT；旧动作无效、不转投 | `native/frames.hpp` ACK_DEC/ACK_ACT、`runtime.py::ack_frame` | ACK0 从保留输出重发且保持资格；ACK1 原子消费/撤资格/推进。ACT 绑定 frame/gen/slotgen/token；旧重发 COMPLETE 不复活资格。宿主 ack_output 仍只是交付确认。 |
| F01 | 部分 | §7 → 正常无动作、缺参、资源等待、失败、致命故障分开 | `native/core.hpp` Stop/Phase、`backend.py` 错误、`runtime.py` | 原生失败注入与正常缺参覆盖；真实异步 CUDA 故障分类待验。 |
| F02 | 部分 | §7 → 接纳/提交前预留，满队列不越过活动任务 | `backend.py::enqueue`、`native/core.hpp::commit` | 整批接纳、保留信用和显式 grow；页池与极限压力待验。 |
| F03 | 部分 | §7 → 原身份重试，提交后只续接，不重复事件/入队 | `native/core.hpp` 阶段/游标、`runtime.py::retry_failed` | 提交前后和部分传播原生故障注入；GPU 故障恢复待验。 |
| F04 | 部分 | §7 → 致命故障后只从可信持久前沿恢复 | `persistence.py`、`runtime.py::restore_runtime` | 持久前沿读取基础；无自动重建 CUDA 进程监督器，不能保证失效上下文无损。 |
| F05 | 部分 | §6/§8 → 稳定 output_id、耐久 outbox、重投不重算 | `runtime.py` outbox、`persistence.py::Journal` | 宿主交付确认与业务 ACK 严格分开；任意外部 exactly-once 仍需接收方去重。 |
| G01 | 部分 | §9 → 旧 profile 分开验证，迁移报告披露差异 | `compat.py::SUPPORT_MATRIX/import_v5_structure` | draft-1 静态结构新运行迁移；draft-1/draft-2 摘要验证；两旧完整 runtime 均明确拒绝。 |
| G02 | 部分 | §8 → 保存完整 FIFO/匹配/活动任务/事件与输出现场 | `backend.py::dump`、`runtime.py::_payload`、`frames.py::validate_blob` | 包含动态图、业务 PRE/CLAIM、S/C/NEXT、独立 POST、批次/资格与绑定 ACT；业务源事件和投递必须先于后继入队。真实 GPU/进程故障仍待验。 |
| G03 | 部分 | §8 → 普通快照完整任务边界，输入切点一致 | `runtime.py::snapshot` | 当前锁内同步冻结并保存；异步页面复制/COW、接纳同时复制未实现。 |
| G04 | 部分 | §8 → 隔离校验后暂停安装，恢复不自动执行 | `runtime.py::restore_runtime`、后端恢复检查、`frames.py::validate_blob` | 原生恢复覆盖部分输入/输出、已排 COMPLETE、动态改版与固定帧 adapter；篡改 frame payload 与真实 EX 输出不符时拒绝。GPU 仍待验。 |
| G05 | 部分 | §10 → V5 原 F/M 字节不变，V6 新规则分开 | `compat.py`、`model.py::structure_fingerprint`、`runtime.py::fingerprint` | 6 旧规范向量、8 历史文档摘要通过；原生扩容指纹不变、恢复一致、伪造活动游标拒绝已测。GPU 页布局验证待验。 |
| G06 | 部分 | §8 → 活动故障胶囊保留提交和传播游标 | `backend.py` 原生现场、`runtime.py` active snapshot、`persistence.py` | 原生异常现场恢复；真实进程杀死/GPU 致命故障矩阵未验。 |
| H01 | 部分 | §9 → 创建、接纳、run/pause/step、retry、输出、快照、诊断 | `runtime.py::Runtime`，含 submit_frame/ack_frame/read_frame_batches | 原生 API/帧/WAL/恢复测试已运行；GPU tensor、复杂线程交错及真实设备故障仍需分别验证。 |
| H02 | 部分 | §9 → 无 Torch、独立标量预期，不复用生产求值/匹配判断 | `reference.py`、`tests/test_reference.py` | 真值表求值与独立容器；尚非全部模块及 V5 旧检查点执行器。 |
| H03 | 部分 | §9 → 完整逻辑轨迹与故障恢复比较，历史 75 任务不混作新 golden | `tests/test_differential.py`、`tests/test_compat.py` | 新核心定向参考差分；旧 75 任务/6 检查点只有指纹验证，未执行续算。 |
| H04 | 待真实测量 | §4 PERF-M、§9 → E/D/R/G、完整任务吞吐、延迟/显存/host往返 | 原生统计计数已具备基础 | 未报告任何 GPU 性能数字；长链/长EX/热点/动态/I/O 基准、Sanitizer 均待真实设备。 |

## 已取得的有限证据

- `tests/test_compat.py`：六个原始规范字节向量、两个 draft-1 文档和六个 draft-2 文档的 F/M 与内嵌契约摘要；严格 EX、引用、DAG、输入副本分类、显式迁移边界。摘要通过不意味着旧模块运行恢复可执行。
- `tests/test_model.py`：版本、FIFO、参数契约、完整 EX、位值、触发输入、订阅顺序、环启动/预算、事务内部依赖等反例；13 项已在宿主运行通过。
- 兼容迁移与 `load_model`/独立 `Reference` 集成：两组输入 `(1,0)`、`(0,0)` 先排 Xi 队列，后续累计 Q 依次输出 `1,1`，确认已入队事件载荷不被输入副本最新状态替换。

- `tests/test_frame_runtime.py` 与 `tests/test_frame_integration.py`：宿主接收只形成完成任务、ACK0/ACK1、10-bit 帧、持久输出 ID、部分输入提交断面、无关模型改版后的固定 adapter 恢复、真实 JK 输出与帧载荷一致性、并发 marker 交付切点和请求身份校验；相应用例已在 native-cpu 运行通过。
- `clang++ -std=c++17 -Wall -Wextra -Werror -pedantic -fsyntax-only jkcuda/native/cpu.cpp` 通过，包含 `frames.hpp`。这是宿主 C++ 检查，不是 NVCC 或 GPU 编译证据。

最终统一执行共 **149 项测试通过**；独立差分语料为 33 案例 × 2 传播路径 × 3 推进预算，共 **198 次运行、4098 个完整任务和 30312 条轨迹记录**。可在目标设备运行的模块子集共 61 项，通过且无跳过，不重复计入 149。严格 C++ 检查与两路径基准脚本的本机试跑均通过；后者只证明脚本和逻辑对照可运行，不是 GPU 性能测量。详细环境、命令、模块结果及 39 个源码/模型文件的 SHA-256 见 [cuda-validation.json](cuda-validation.json)。CUDA 为明确跳过，不计通过。

## 仍需明确的模块语义

1. 方案 T03 明确要求触发契约变更时定义 ALL_LATEST/ZIP/KEYED 剩余 token 的版本继承/迁移；当前缺少统一迁移契约。受影响操作须明确拒绝，不能清空或混配。
2. 方案 L01 明确指出 SCC 合并/拆分的历史预算继承仍需具体化；当前不能因重新建图而重置活动环历史。

用户已确认本次先拒绝上述两类修改并保留现场，且本次没有可用 NVIDIA CUDA 环境。

这两项不妨碍静态运行、已明确的 FIFO/EX/触发、输出或故障现场工作；也不能以它们为理由把其他未完成模块写成已实现。

## 并行传播补充对应

| 来源条款 | 预期行为 | 实现位置 | 验证依据与边界 |
|---|---|---|---|
| §3.3、PERF-P01/P02 | 只展开当前事件实际订阅，按事件绑定版本保序分块 | `backend.py::_compile_model`、`native/propagation.hpp::prepare` | 来源边先建索引，源内按 order 排序；0/1/31/32/33/127/128/129/257 扇出与参考轨迹比较。仍为单 block 分块。 |
| §3.3 N03、PERF-P03 | 四种匹配不丢零值、重复值或同目标多次配对 | `match_owner/earliest` | 目标独占处理；ALL_LATEST 的 A0/B1/A1/B0、ZIP/KEYED 同源 FIFO、同事件多输入边及热点目标。预期来自独立 `Reference` 与手算配对。 |
| Q01/Q03、PERF-P04/H02/H04 | 前缀定位、完整协作写入后按逻辑序发布，不能抢位或提前执行目标 EX | `scan_prepare/scan_publish/scatter/publish`、CUDA block barriers | native 模拟故意逆序执行 owner/scatter，比较全部 trace 与逻辑现场；真实 GPU racecheck/synccheck 待验。 |
| §3.3 第6点、Q03、§7 | 分块、故障、扩容不重复投递、不越过 active | `begin/publish`、Core/Runtime 恢复接口 | before/after_delivery 断面、入队交错、容量不足补充、公开 Runtime 快照跨 chunk/block 恢复；scratch 不参与逻辑指纹。 |
| PERF-M | 报告完整 FIFO 循环，禁止以单算术 kernel 或 CPU 模拟宣称 GPU 加速 | `scripts/benchmark_propagation.py` | 两变体先核对完整逻辑现场；硬件测量暂未执行，明确保留全 arena 同步传输成本。 |

## PRE/COMP/POST 补充对应

| 来源条款 | 预期行为 | 实现位置 | 验证依据与边界 |
|---|---|---|---|
| S01；异步模块 §13.2 的就绪原则 | 输入实际执行后保存 PRE；依赖 COMP 结果实际发布后才形成后继任务 | `business.py::_construct`、native INPUT_BIT/PRE_ACCEPT/CLAIM、KEYED matcher | 接纳时无模型计算；各节点完整 trace；业务 DAG 环与未知来源拒绝。此新构造显式声明自己的任务边界。 |
| S01；异步模块 S_W/C_W 单向观察公式 | S=本帧 parity XOR 旧 C，C=本帧 parity，每宽独立；0 不丢帧 | 生成的 `.S/.C` 节点和状态 | W=1、8、9，交替宽度、重复零、相同 parity；不复用一份跨宽 C。 |
| S01；异步模块 PRE/POST/下一轮前态职责 | POST 和 NEXT 分别复制已完成 COMP，慢 ACK 不覆盖结果、不阻断计算 | 生成的 `.COMMIT/.POST/.NEXT/.FINISH`、native FINISH hooks | 输入 1/0/1 累计结果1/1/0；非平凡 RESULT DAG；W≠M；实际 EX 事件溯源。 |
| T01、Q01/Q03、§7 | FINISH 提交前联合预留；STORE/下一 CLAIM 只入队；失败保留现场 | `frame_business_reservation/commit` | 容量恰好不足、grow 续接、提交前后故障恢复不重复；原生结果不证明 GPU 原子可见性。 |
| T03、§8 | 改图不靠物理槽认身份；恢复不能用伪造完成参数冒充 POST | logical ID+generation hook；`validate_business_contract/validate_blob` | 无关改图后业务运行、跨宽度断面恢复；内部来源别名冲突、保护图/状态/入口篡改及 FINISH 参数篡改反例。 |

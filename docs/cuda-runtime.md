# V6.1 执行器：实现、接口与验收

本实现依据 [plan.V6.1.md](plan.V6.1.md)，注册独立运行格式 `jkcuda.v6.1` / `format_version=1`。它不修改 JKRD，不将新 profile 的参数绑定、事务、环、快照或摘要称为旧 JKRD 的已有行为。逐项对应和缺口见 [44 项覆盖表](cuda-coverage.md)。

**证据边界：本机为 Apple Silicon，没有 NVIDIA GPU、nvcc 或 PyTorch。C++ 原生后端用于核对生产状态机，独立 Python 参考用于推导预期；二者都不能证明 CUDA 已编译、内存顺序正确或有性能优势。**

## 安装和运行

Python 3.9 以上。原生验证需要 `clang++` 或 `g++`。在仓库目录可直接运行，无须安装 Python 依赖：

```sh
python3 -m unittest discover -s tests -v
python3 -m jkcuda validate examples/cuda/xor.json
python3 -m jkcuda run examples/cuda/xor.json --device native-cpu --send '{"X0":1,"X1":0}'
python3 scripts/validate_cuda.py --device native-cpu
python3 scripts/verify_local.py
```

CUDA 环境需安装匹配目标 NVIDIA 驱动的 CUDA 版 PyTorch、CUDA Toolkit（含 nvcc）、C++ 工具链和 Ninja，然后在仓库安装 `python3 -m pip install -e .`。PyTorch 的 [C++/CUDA 扩展说明](https://docs.pytorch.org/docs/stable/cpp_extension.html)明确区分 PyTorch 安装与扩展编译所需 Toolkit；可通过 `CUDA_HOME` 指定 Toolkit。运行时按 [CUDA guard/stream 接口](https://docs.pytorch.org/cppdocs/api/cuda/streams.html)使用设备与 stream guard。

```sh
python3 scripts/validate_cuda.py --device cuda --modules
python3 -m jkcuda run examples/cuda/xor.json --device cuda --send '{"X0":1,"X1":0}'
python3 scripts/validate_cuda.py --print-sanitizer-commands
python3 scripts/benchmark_cuda.py --device cuda --output /tmp/jkcuda-benchmark.json
```

GPU 验证脚本在环境不可用时报告 `skipped`，默认退出码 **77**。明确请求 CUDA 时不会自动回退 CPU。Compute Sanitizer 四类检查需分别执行；普通差分脚本成功不表示 sanitizer 成功。验证脚本耗时不作为性能结果。

本次最终本机验证记录在 [cuda-validation.json](cuda-validation.json)：**149 项测试通过**、严格 C++ 语法/警告检查通过；33 个独立语料案例按串行/并行两路径、三种推进预算比较 **198 次运行、4098 个完整任务、30312 条轨迹**。设备可选模块套件包含 61 项传播、动态图、帧与业务测试；它们是上述测试的子集，不重复累加。并行基准脚本的本机小规模试跑也确认两路径逻辑现场相同。报告保存 39 个源码/模型文件的 SHA-256；CUDA 检查为 `skipped` / exit 77，未运行 Compute Sanitizer 或测量 GPU 性能。

## 代码路径与执行职责

| 位置 | 职责 |
| --- | --- |
| `jkcuda/model.py` | 显式格式、完整 EX 解析、来源/订阅校验、反馈 SCC 与启动/预算检查 |
| `jkcuda/native/core.hpp` | 同一生产状态机：队首选择、参数绑定、EX/事务、提交、事件、四类匹配、任务入队与完成 |
| `jkcuda/native/engine.cu` | 有界 CUDA 设备执行入口；设备端推进整个任务循环 |
| `jkcuda/backend.py` | Torch/int64 存储、原生编译适配、入队线性化、容量扩展、现场导出与恢复验证 |
| `jkcuda/runtime.py` | 接纳 ticket、run/step/pause、宿主 outbox、调用解耦、快照/日志接口 |
| `jkcuda/frames.py`、`native/frames.hpp` | 参数化帧保存、真实输出 EX、完成控制、ACK0 重发/ACK1 消费及块世代 |
| `jkcuda/business.py` | 声明式 PRE/COMP/POST 图生成、按宽度独立状态及内部任务边界校验 |
| `jkcuda/native/propagation.hpp` | 稳定分块、目标独占匹配、前缀和、协作写入与正式发布 |
| `jkcuda/persistence.py` | SHA-256 清单、临时文件同步与原子发布、哈希链全现场日志 |
| `jkcuda/reference.py` | 独立 Python truth-table 标量参考，不导入生产求值或匹配代码 |
| `jkcuda/compat.py` | 旧 draft 指纹规范与明确的新运行迁移；不伪造旧现场恢复 |

`native-cpu` 编译同一生产 C++ 核心，是设备算法的原生验证路径，不是独立语义基准。真正独立的基准是 `Reference`。编译产物在系统临时目录缓存，不写入仓库。

CUDA 保留**唯一活动任务和有界解释执行**，传播可选择 `serial` 或默认 `parallel`。并行路径在单个 CUDA block 内用多个 warp 读取当前事件的真实 CSR 边，由每个目标的独占处理者保序匹配，再通过稳定前缀定位和协作写入生成 token、任务与轨迹。协调者在协作写入汇合后按逻辑顺序发布 FIFO；后继 EX 仍须等当前任务完整结束。CPU 后端顺序模拟相同协作阶段，用于比较逻辑结果，不能证明 CUDA 屏障、访存或性能正确。

`Runtime`、`Core` 及各自恢复接口接受 `propagation="parallel"|"serial"`、`propagation_chunk=128`（1–1024）和 `block_size=128`（32–1024，32 的倍数）。恢复时可以改变这些物理配置，临时工作区不进入逻辑现场或指纹。单个 block 循环处理高扇出分块，尚未实现多个 block 协同传播。物理计数提供批次数、投递数、目标组数、形成任务数与最大实际分块；它们不是性能或硬件并行性的证明。

张量仍为连续 int64 arena 的多个定宽表区域，传输和检查会同步完整 arena。临时工作区占 `8 × (32 + propagation_chunk × (20 + 最大参数数))` 字节，另有宿主镜像；匹配仍访问保留的 token 历史。启动、带宽、宿主往返、热点目标串行工作和历史内存成本仍需实测，不能据此宣称已适合单个大型模型的高吞吐生产运行。

GPU 环境就绪后，先运行正确性与 Sanitizer，再比较完整 FIFO 循环：

```sh
python3 scripts/validate_cuda.py --device cuda --modules --propagation both
python3 scripts/benchmark_propagation.py --device cuda --fanout 256 --events 32 --propagation-chunk 128 --block-size 128
```

基准排除编译与预热，包含接纳、任务执行、传播及同步传输；两路径的完整逻辑现场必须相同才接受结果。单次合成 ANY 扇出结果不能代表所有模型。

## 新格式的确定行为

模型必须显式给出 `queues: [{name, priority}]`，名称与优先值分别唯一。选择最小优先值的非空 FIFO，每次仅取一个队首。预算用尽时保留该队首并暂停整个实例，不尝试低优先级 FIFO；这是本 profile 的明确策略。

`states` 声明独立 bit 状态槽与初值；`nodes` 声明稳定字符串 ID、正整数 generation/version、所属 queue、可选 state、无状态 seed、EX、来源、trigger、publish 与可选 output。没有隐式编号缩窄。EX 必须完整匹配由 `J0/J1/K0/K1/J(name)/K(name)` 组成的序列；不接受剩余字符、嵌套或未知引用。原 EX 保留，重复引用与指令保序。

来源绑定：

| kind | 字段 | 绑定时机 |
| --- | --- | --- |
| CONST | value=0/1 | 模型定义 |
| PARAM | param | 输入接纳或触发形成任务时锁存 |
| STATE | state | 任务实际执行时读取；事务内可见前序内部候选 |
| SELF | 无 | 该次 EX 的固定 seed，非变化中的累加器 |
| VALUE | value_id | `values` 中声明的已有不可变值；不等待后继任务产生 |

所有声明来源的可取得性都要检查，包括算术未使用的 PARAM。普通低层调用缺参按 `missing` 正常结束、不提交、不发布；加载器提前拒绝触发模式不能提供所需参数的模型。0 只代表有效 bit，不代表缺失。

`trigger` 为 `{mode, ports}`。订阅记录为 `{source,target,port,order}`；同一 source 的 order 必须唯一。ANY 每项投递形成任务；ALL_LATEST 同源覆盖、收齐清空；ZIP 按每来源 FIFO 配对；KEYED 按业务 key 和每来源 FIFO 配对。KEYED 区分整数 key 与字符串 key，null 也是明确的共同桶。跨来源 key 应由业务配置一致；不从 CUDA 批次生成 key。

多端口 send 按 `inputs` 数组的声明顺序登记，整次入队成功才接纳。不同请求的同值输入保留独立身份。STATE/SELF 不在 send 或入队时提前读取。传播产生的任务只入队，目标 EX 必须等当前任务完整结束后重新选择。

`publish` 支持 `always`、`zero`、`one`、`never`、`changed`；changed 比较该次结果与固定 seed。输出来自当次发布记录，不延后回读最新状态。以上新 profile 允许显式常量程序与独立订阅；V5 迁移仍先按其旧来源引用与常量节点禁令校验，不能反向放宽 V5。

## Python 接口

```python
from jkcuda import Runtime

with Runtime.from_structure("examples/cuda/xor.json", device="cuda") as engine:
    ticket = engine.send({"X0": 1, "X1": 0}, request_id="request-1", key="frame-1")
    ticket.wait("device_visible")
    engine.step()             # 一个完整任务，或明确的资源等待/故障
    engine.run(max_tasks=100)  # 按完成的独立任务计数
    for record in engine.read_output():
        consume(record)       # 应用使用 output_id 去重
        engine.ack_output(record["output_id"])
    engine.snapshot("/tmp/jk-checkpoint.json")
```

`send` ticket 的 accepted、device_visible、durable 是三个不同事实。当前安全传输路径在发布后同步，因此前两个通常同时可见；不是所有输入都经历了计算。durable 仅在启用 `durable_path` 且日志 fsync 成功后可见。`send_tensor` 先在生产者 current stream 取得独立 clone，再同步校验和宿主暂存；当前不宣称零复制或异步传输吞吐。

`request_id` 相同且载荷相同，返回原 ticket；相同 ID 配不同载荷拒绝。请求接纳失败有 error，不算已接纳。请求记录在持久现场中保存，恢复后仍可查询/重试相同 ID；同值不同 ID 是独立任务。

`submit` 仅允许模型声明的 `entrypoints`。`submit_transaction` 仅允许 `transactions` 中声明的原子契约；内部步骤列出 node、params、result_refs，result_refs 只能指向更早的内部步骤。一个事务占一个 FIFO 位置，逐项绑定 seed、处理同状态别名，并一次提交候选，再按声明顺序传播。不能用此接口将普通已排队任务临时合并。

容量由 tasks/events/tokens/traces/outputs/txops 指定。提交前保守预留最大后继/投递记录；资源不足会保留当前任务，调用 `grow(tasks=..., tokens=...)` 补充后继续。当前存储保留历史，容量不是仅指同时在途条目数；没有自动队列回收或无限运行承诺。

`pause` 请求在完整任务边界停止；`retry_failed` 延续活动身份，不移队尾。`resume_budget(group, additional)` 增加显式预算段，保留历史计数。普通快照等待当前任务达到边界；若当前任务失败/等待资源，则应明确选择 `active=True` 保存活动胶囊，不能冒称完整边界。

## 动态结构与帧模块

`modify(candidate_model, queue=..., request_id=...)` 先校验并准备不可变模型版本，然后登记一个结构 FIFO 任务。新节点、程序和订阅只有该任务执行后才生效；`current_model()` 查询已安装版本。状态槽预分配不代表业务状态已安装，诊断中 `states` 与 `retained_states` 分开。

新 profile 明确采用：任务入队时绑定程序版本；该任务提交事件时，绑定同世代节点当时已安装的订阅版本。当前活动事件不因随后排队的改图请求变化。退休或新世代的同名对象不接收旧世代任务的事件；有状态 ID 复用要求独立的新状态 ID。改变程序必须增加 version；初值和已有 VALUE ID 不允许重绑。

不改变触发契约的程序更新保留未配齐输入。触发/订阅改变在结构任务实际执行时再次检查，有残余 token 则记录 `rejected_pending_tokens`，不丢数据。实际循环 SCC 成员的合并/拆分被拒绝；不是只比较用户预算组的名称。队列优先级、预算归属和帧适配器契约不能借动态修改重定义。当前保留旧版本与历史记录，**逻辑退休已实现，通用物理 GC 尚未实现**。

参数化帧示例在 `examples/cuda/frames.json`，显式声明 input_queue、control queue、data/marker 节点、参数名、block_capacity=K 和 max_width。输出适配器必须是无状态、always 发布、带 output 的 `J0K(PARAM)` 节点。每帧 W 个输入各自排队，收齐后 STORE 控制任务存储，再形成 W 个数据 EX 任务及 marker EX 任务；所有这些任务使用相同的活动任务状态机。首发 marker=1，重发 marker=0。

```python
with Runtime("examples/cuda/frames.json", device="cuda") as engine:
    ticket = engine.submit_frame([0, 1, 0, 1], request_id="frame-1").wait("device_visible")
    engine.run()
    batches = engine.read_frame_batches()
    # 已在宿主收到 W 项与 marker，并可靠排入 FRAME_COMPLETE；尚未建立模型资格。
    engine.run()  # FRAME_COMPLETE 实际执行，建立对应帧与 token 的资格。
    engine.ack_frame(0, request_id="replay-1").wait("accepted")
    engine.run()  # 独立 DEC 和 ACT，重发同帧不可变载荷。
    engine.read_frame_batches()
    engine.run()
    engine.ack_frame(1, request_id="consume-1").wait("accepted")
    engine.run()
```

ACK 的业务含义来自模块原文：**0 重发，1 消费**。DEC 在执行时绑定队首、帧/槽世代和资格 token；ACT 不重新选择队首。无资格 DEC 正常结束；同帧重复 ACT 不消费后继帧；旧完成通知不复活已消费帧。宿主 `read_output`/`read_frame_batches` 在暴露完整 marker 前可靠登记完成控制任务，并在耐久模式同步日志。任务、trace 和完成事实载荷均有预留信用；输出回调仍不直接建立资格。

帧 ID 单调分配；块仅在已满 K、全部消费、输出批次持有者释放后复用，并推进槽/块世代。输入帧及每个输出批次保留独立载荷，重发不从新输入重建。基础 `frames.json` 仍是存储/输出示例；业务计算使用下面的显式构造接口。

## PRE/COMP/POST 声明式构造

`build_business_model(spec)` 接受按输入宽度声明的有限无环 JK 图。每个节点声明 `id`、`ex`、`sources`、可选常量 `seed` 和显式 `dependencies`；来源支持 `INPUT(index)`、`RESULT(node)`、`STATE(state)`、`CONST(value)`、`SELF`。`outputs` 按顺序指定结果节点，允许输出宽度与输入不同；`state` 声明初态，`next_state` 必须为每个状态槽指定下一值的结果节点。STATE 在 COMP 实际执行时读取；SELF 是该无状态 COMP 的 seed，不是跨轮存储。需要用旧状态起算时，在 EX 中显式使用 STATE。

完整生成示例为 [examples/cuda/business.json](../examples/cuda/business.json)，声明 W=1、9 的独立累计异或，输出均为一位。可直接作为 `Runtime` 的模型路径使用；`frame_status()` 返回原始 `pre_values`、计算后 `post_values`、领取/完成任务身份和 PRE 队列。

例如每个 W=1 输入与本宽度前态异或，依次输入 1、0、1 得到 1、1、0：

```python
from jkcuda import Runtime, build_business_model

model = build_business_model({
    "block_capacity": 2,
    "widths": {"1": {
        "nodes": [{"id": "sum", "ex": "J0K(x)K(old)", "sources": {
            "x": {"kind": "INPUT", "index": 0},
            "old": {"kind": "STATE", "state": "acc"}}}],
        "outputs": ["sum"], "state": {"acc": 0},
        "next_state": {"acc": "sum"}
    }}
})
with Runtime(model, device="native-cpu") as engine:
    for number, value in enumerate((1, 0, 1)):
        engine.submit_frame([value], request_id=f"frame-{number}").wait("device_visible")
    engine.run()
    first = engine.read_frame_batches()  # 首帧结果；后帧已计算并独立保存在 POST。
    # 沿用前文 FRAME_COMPLETE → ACK1 → ACT 协议，逐帧取得后续输出。
```

生成流程为：输入任务 → PRE 接纳/领取控制 → 独立 PRE 复制 EX → 本宽度 S_W、C_W → GO → 按依赖收齐的各 COMP → COMMIT → 独立 POST 保存与 NEXT 状态写入 EX → FINISH → POST STORE 与下一次领取控制。图中的每个普通节点均有自己的 FIFO 任务、事件、参数锁存和轨迹；宿主不计算 COMP 结果。COMMIT 先收齐全部 COMP，FINISH 再收齐所有 POST/NEXT；0、重复帧和相同 parity 都正常通过。

每种输入宽度有独立 S_W/C_W 和业务状态：S 计算本帧 parity XOR 旧 C，C 保存本帧 parity，两者依序执行且只用于观察。一个业务帧被领取后，下一业务帧必须等其 FINISH；其它合法 FIFO 输入/控制任务仍按队列优先级执行。慢 ACK 只延长已保存 POST 的保留，不阻止后续业务轮。原始 PRE、POST 值和下一轮状态分别保存；原始输入不会被输出宽度或计算结果覆盖。

这是新 `jkcuda.business/1` 构造契约，按 S01 声明具体任务边界，**不声称复刻 V5 A03 的节点编号、原子事务边界或 75 任务轨迹**。构造器校验 DAG、来源、完整状态映射并重新生成保护子图；拒绝通过手动任务、外部订阅、事务或动态改图伪造业务内部完成。支持声明宽度超过 8；未声明的宽度明确拒绝。业务图和状态归属在本执行域中固定，尚无通用 PRE/旧轮物理 GC，持续历史仍会占用 arena 容量。

## 快照、恢复、日志与输出

普通及活动快照分别标记 `boundary` / `active`。保存模型、队列、状态版本、触发余项、活动参数/候选、事件与传播游标、事务、预算、身份、请求记录及 outbox。先验证结构/所有权再安装，恢复保持暂停，不产生新事件。

动态版本历史、帧/块世代、批次载荷、资格、已排完成控制与其预留信用也进入现场。请求接纳前沿按成功接纳记录递增；未接纳的宿主 pending 请求不混入该前沿。恢复检查哈希之外，还检查队列链接、事件归属、传播完成游标、帧指针、真实 EX 输出与批次记录的一致性。

```python
restored = Runtime.restore_runtime("/tmp/jk-checkpoint.json", device="cuda")
assert restored.status()["paused"]
# 普通现场由 run/step 继续；失败胶囊由 retry_failed 明确续接。
```

结构摘要为 SHA-256，规范化版本 `jkcuda.sha256.v1`：UTF-8、对象键排序、数组保序、不允许 NaN；结构摘要只排除模型根 metadata。完整运行摘要包含逻辑已用记录、FIFO/传播游标、输入/输出身份及状态；排除容量、物理偏移、执行分块大小和故障注入计数。扩容不改变运行摘要；改变运行状态或载荷会改变摘要。该规则不替代旧版 MD5 字节规范。

当前快照在边界复制出独立宿主现场，再在锁外同步临时文件及原子替换。没有实现后台 GPU 页级 COW。耐久模式的 WAL 是**每次有界推进后写完整现场的哈希链日志**，不是增量高性能日志；顺序 fsync 保存因果前缀，进程崩溃恢复最后完整记录。末尾撕裂的不完整记录不使用；有换行的完整损坏记录报错。暂不自动截断日志。恢复可从原 journal 读取，新的持续耐久运行必须指定一个新 `durable_path`。

输出使用 `instance_id:output_number` 稳定 ID。read_output 返回独立宿主记录，耐久模式在交付前同步现场。drain 的回调不持运行/接纳锁；回调失败重投同一输出，不重算 EX。ack_output 是应用交付确认，**不是帧协议业务 ACK**。任意外部副作用恰好一次仍需应用按 output_id 去重。

## 兼容与未覆盖边界

`compat.py` 分别核对 V5 draft-1、draft-2-a03-ready 的规范化字节与历史指纹；静态基础结构可以在明确报告后导入新运行。旧 runtime、工厂模块和不受支持的绑定会明确拒绝，不以补默认值或改版本名伪装兼容。完整 V5 75 任务/六检查点续算以及 V4 无损运行现场迁移尚未完成。

V6.1 原文仍未定义触发变更时未配齐 token 的迁移、SCC 合并/拆分时预算继承。本次用户已明确确认：先拒绝这两类修改并保留现场；不自行清空、混配或重置。用户同时确认本次没有可用 NVIDIA 环境，因此 GPU 编译、执行和工具验收保留为待执行命令。动态操作的实际支持范围以接口检查和覆盖表为准。

单 block 并行传播及稳定 scan/scatter 已有实现与本机阶段模拟证据，仍缺真实 CUDA 验收。多个 block 协作传播、页池回收、byte/bitpack、JIT、CUDA Graph、跨 stream 压力、并发页 COW、设备致命故障后的进程监督重建及真实 GPU 性能比较仍未完成。完成的功能和未覆盖项必须分别报告，不能将新增 CUDA 文件或测试数量等同于整份方案已完成。

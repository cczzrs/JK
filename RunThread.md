# thread 模块（RunThread）

- **版本**：7.0.0，与 [JKRD7](JKRD7.md) 相同。
- **状态**：第 1—6 节由用户 2026-11-12 批准，同日改定一次（引用可以跨 thread）。第 11 节（thread.factory）由用户 2026-11-13 定义。原话与选择见第 10 节。
- **定位**：thread 模块是线程调度模块。关于 thread 模块的设计规则与声明都在本文（用户 2026-11-12）。本文由用户新建，原为空文件。
- **依赖方向**：本文引用 JKRD7 的定义（JKI、JKS、JKM、处理单元、事务、FIFO、绝对路径等）。JKRD7 只保留一个 thread 内部的执行模型（第 7 节），凡涉及 thread 的声明、启动与多个 thread 的并行，都指向本文。
- **实现状态**：见第 9 节。两个后端目前只执行单 thread 模型，本文的多 thread 规则与 thread.factory 都还没有实现。
- **待定事项**：见第 8 节。尚未确定的选择不从旧版本、旧附件或代码推断。

## 1. 职责

1. thread 模块只管调度。
2. 默认只有一个 thread，默认名为 `main`，称为主线程。主线程管理和调度运行中用到的全部 thread。运行时总是先启动主线程（第 4 节）。
3. 每个 thread 执行自己的 JKS.thread.FIFO 中的任务。thread 不划定它包含哪些节点，它只执行从某个触发起点进入它的 FIFO 的任务。
4. thread 之间可以有引用。一个 thread 执行时或执行后发出的通知，可以到达别的模块的节点，使别的 thread 产生新的任务，或使一个新的 thread 启动。这是结构设计呈现的正常情况。
5. 多个 thread 并行计算。每个 thread 是一份硬件资源上运行的线程，运行时不会被中断，也不会切换或跳转到别的 thread。能不能启动新的 thread，由硬件资源决定。

thread 模块不管的事：

| 事项 | 归属 |
| --- | --- |
| 一个 thread 内部怎样执行 | JKRD7 第 7 节（处理单元、事件优先、投递顺序） |
| 硬件资源的分配；FIFO 的存储、容量与故障处理；运行中的问题处理 | thread.factory 模块（第 11 节）。它取代 FIFO.factory 模块 |
| 运行脚本与输入批在多个 thread 下的时序 | 输入批模块（延后，见第 8 节） |
| 多个 thread 并行时快照在什么时刻取 | 快照模块（[snapshot/Snapshot.md](snapshot/Snapshot.md)） |

## 2. 声明

写法沿用 JKRD7 §5.1、§8.1，格式不变：

| 写法 | 含义 |
| --- | --- |
| `JKM.threads` | 必须声明，至少有一个名称，不重复。默认写 `["main"]`。例：`["work"]`、`["main"]`、`["main", "fast"]` 都合法。其中没有 `main` 的是分支模型（第 4 节） |
| `JKS.thread` | 必填，取 `JKM.threads` 中的一个名称。它决定这个 JKS 的各项进入哪一对 JKS.thread.FIFO（第 3 节） |

- 子 JKS 的 `JKS.thread` 可以与上层 JKS 不同。例：G1 的 `thread` 是 `main`，G1.G2 的 `thread` 是 `fast`。
- `JKS.thread` 不是“节点属于哪个 thread”的划分，只决定各项进入哪一对 FIFO。

## 3. JKS.thread.FIFO

每个 thread 名对应一对 FIFO，本文写作 JKS.thread.FIFO：

- `JKS.thread` 的事件 FIFO；
- `JKS.thread` 的任务 FIFO。

各项进入哪个 thread 的 FIFO，由 JKRD7 §7.4 规定：

| 项 | 进入 |
| --- | --- |
| 节点任务 | 目标 JKI 所属 JKS 的 `JKS.thread` 的任务 FIFO |
| 事件 | 来源 JKI 所属 JKS 的 `JKS.thread` 的事件 FIFO |
| 事务任务 | 登记它的 JKS 的 `JKS.thread` 的任务 FIFO |

“所属 JKS”指直接包含该 JKI 的 JKS。事务执行期间的事务事件 FIFO 与事务任务 FIFO 属于事务，不属于 thread（JKRD7 §6.2）。

## 4. thread 之间的引用与启动

**引用可以跨 thread。** trigger 引用与 sources 引用的两端，可以是 `JKS.thread` 不同的两个 JKS 的成员。静态检查不限制。

**主线程。** 运行时先启动主线程 `main`，再由它启动别的 thread。

- `JKM.threads` 中有 `main`：主线程同时执行 `JKS.thread` 为 `main` 的那一对 FIFO。
- `JKM.threads` 中没有 `main`：这是分支模型。它单独运行时，仍然先启动默认的 `main` 线程。例：`JKM.threads` 为 `["work"]`，运行时先启动 `main`，`work` 的 FIFO 有项时再由 `main` 启动 `work`。

**启动（按需）。** 一个 thread 的 JKS.thread.FIFO 第一次有项时，由主线程启动它；它的事件 FIFO 与任务 FIFO 都空了，就收回。之后再有项进入，再启动。

**硬件资源。** 每个 thread 独占一份硬件资源运行。没有空闲的硬件资源时，新的 thread 不能启动，它的项留在 JKS.thread.FIFO 中，等到有资源时再启动。已经在运行的 thread 不会为它让出资源。硬件资源怎样分配，归 thread.factory 模块（第 11 节）：一份硬件资源就是 Worker 线程池中的一个 Worker。

例：硬件只能同时运行两个 thread，`main` 与 `fast` 正在运行。这时一条通知使 `slow` 的任务 FIFO 有了项：`slow` 不能启动，这一项留在 `slow` 的任务 FIFO 中；`fast` 的两个 FIFO 都空了、被收回之后，`slow` 才启动。

例：G1 的 `thread` 是 `main`，G2 的 `thread` 是 `fast`，G2.Q1 的 trigger.any 是 `["G1.Q2"]`。

```text
JKM.threads = ["main", "fast"]
G1.thread = "main"   G1.Q1（入口）→ G1.Q2
G2.thread = "fast"   G2.Q1.trigger.any = ["G1.Q2"]

1. 注入 G1.Q1：事件进入 main 的事件 FIFO。此时 fast 没有启动。
2. main 投递，G1.Q2 的节点任务进入 main 的任务 FIFO；main 执行它，G1.Q2 发出通知，事件进入 main 的事件 FIFO（来源 G1.Q2 属于 G1）。
3. main 投递这条事件给订阅者 G2.Q1：节点任务进入 fast 的任务 FIFO（目标 G2.Q1 属于 G2）。fast 的 FIFO 第一次有项，主线程启动 fast。
4. fast 执行 G2.Q1 的节点任务；main 不等它。fast 的两个 FIFO 都空了，收回。
```

**事务。** 事务推进到的 JKI 都在事务中执行（JKRD7 §6.1），不论它所属 JKS 的 `JKS.thread` 是什么：它的节点任务进入当前事务的事务任务 FIFO，由执行这个事务的 thread 执行，记录行也记在这个 thread 的记录里。

例：G1（`thread` 为 `main`）登记了 transaction，事务中的通知到达 G2.Q1（G2 的 `thread` 为 `fast`）。G2.Q1 的节点任务进入 G1 事务的事务任务 FIFO，由 `main` 执行，`{"q": "G2.Q1", …}` 记在 `main` 的记录里；`fast` 不因此启动。

## 5. 并行与执行记录

- 多个 thread 并行计算。每个 thread 只处理自己的 JKS.thread.FIFO，内部按 JKRD7 第 7 节逐个处理单元执行。
- thread 之间不切换，不等待：一个 thread 不等别的 thread 静止，也不等别的 thread 的结果。
- **处理单元是原子的。** 一个处理单元对它触及的 q、到达记录（trigger_all）和轮记录的读写，不与别的 thread 的处理单元交错。怎样做到由实现决定。

  例：G3.Q1 的 trigger.all 是 `["G1.Q2", "G2.Q1"]`，`main` 投递 G1.Q2 的通知，`fast` 同时投递 G2.Q1 的通知。两次投递对 G3.Q1 到达记录的修改一先一后完成，后完成的那次看到两个来源都已到达，恰好形成一个节点任务。
- **执行记录按 thread 分开**（JKRD7 §9.4）：每个 thread 一条记录，各自按该 thread 处理的先后排列，不合并成一条。不同 thread 的记录之间不规定先后。
- 一条记录行写进哪个 thread 的记录：

  | 记录行 | 所在的记录 |
  | --- | --- |
  | `inject` | 输入入口所属 JKS 的 `JKS.thread` |
  | `notify`、`q`、`output`、`read` | 产生这一行的处理单元所在的 thread |

- **交付**：一个 JSONL 文件，按 `JKM.threads` 的声明顺序分段，每段前加一行 `{"thread": "<名称>"}`。只有一个 thread 时不加这一行，记录与此前逐字节相同。

例：第 4 节的模型注入一次 G1.Q1（设 G1.Q2、G2.Q1 都有非空 EX，q 由 0 变 1）。

```jsonl
{"thread": "main"}
{"inject": "G1.Q1"}
{"notify": "G1.Q2"}
{"q": "G1.Q2", "from": 0, "to": 1}
{"thread": "fast"}
{"notify": "G2.Q1"}
{"q": "G2.Q1", "from": 0, "to": 1}
```

**先后不作保证。** 引用跨 thread 时，一个 thread 读取或触发另一个 thread 的先后不作保证，结果可能取决于别的 thread 算到哪一步，这由结构负责。需要确定的先后，就用触发连接等待（JKRD7 §7.3 的原则）。

例：G2.Q1（`fast`）的 sources 读 G1.Q2（`main`）。`fast` 执行 G2.Q1 时，`main` 可能已经写入 G1.Q2，也可能还没有。要让 G2.Q1 一定读到新值，就把 G1.Q2 写进 G2.Q1 的 trigger：G1.Q2 的通知要到它的节点任务结束、q 已经写入之后才投递（JKRD7 §4.3、§7.2）。

**核对分两级**（JKRD7 §7.5）：

- 单 thread 模型：任何实现的执行记录都必须与串行参考逐字节相同。
- 多 thread 模型：只核对每个 thread 的记录自身合法，检查项见下。

**`read` 行（第五种记录行）。** 节点任务在执行入口读取来源的 q（JKRD7 §4.2）。来源所属 JKS 的 `JKS.thread` 与执行这个节点任务的 thread 不同时，记一行：

```jsonl
{"read": "G1.Q2", "by": "G2.Q2", "value": 1}
```

- `read` 是来源，`by` 是执行的 JKI，`value` 是读到的 q。
- 它记在执行这个节点任务的 thread 的记录里，排在这个任务的 `notify` 行与 `q` 行之前。
- 一个任务有多个跨 thread 的来源时，按 `sources.s` 的顺序各记一行；同一来源出现多次只记一行（§4.2：同一来源使用同一个入口值）。
- 来源与执行者同 thread 时不记。所以单 thread 模型的记录里没有 `read` 行，与此前逐字节相同。

**多 thread 记录的四项检查。** 对每个 thread 的一段：

| 编号 | 检查 | 能发现的错误 |
| --- | --- | --- |
| ① | 每条 `q` 行的 `from` 等于同一节点上一条 `q` 行的 `to`；第一条等于模型的 q 初值 | 丢了一次写入；两个 thread 同时写同一个节点 |
| ② | 每条 `notify` 行都有来由：来源的 EX 非空时，紧随其后是同一节点的 `q` 行（JKRD7 §4.3）；来源的 EX 为空时，本段中在它之前有一条能投递到该来源的 `inject` 行或 `notify` 行 | 凭空多出的通知；通知记进了别的 thread 的段 |
| ③ | 每条 `output` 行的 `values`，等于本段中各成员最近一条 `q` 行的 `to`（没有 `q` 行时等于初值），并且只含同 thread 的成员 | 输出读到错误的值；带了别的 thread 的成员 |
| ④ | 每条 `q` 行的 `to`，等于按 §4.2 重算的 result：同 thread 的来源取本段中最近一条 `q` 行的 `to`，跨 thread 的来源取这个任务的 `read` 行的 `value` | 计算结果错误 |

例外：一个节点的 `q` 行出现在不止一段时（例如第 4 节的事务由 `main` 写了 `JKS.thread` 为 `fast` 的 G2.Q1），各段之间没有先后，这个节点不参加 ①、③，以它为同 thread 来源的任务不参加 ④。

例：G1 的 `thread` 是 `main`，G2 的 `thread` 是 `fast`；G1.Q2 的 sources 是 `s = ["Q1"]`、`ex = ["K"]`，G2.Q2 的 sources 是 `s = ["G1.Q2"]`、`ex = ["K"]`，两个入口 G1.Q1、G2.Q1 的 q 都是 1，其余 q 初值为 0；`JKM.output` 为 `{"a": ["G1.Q2"], "b": ["G2.Q2"]}`。各注入一次。`fast` 执行 G2.Q2 时，`main` 可能已经写入 G1.Q2，也可能还没有，所以有两份合法的记录，只差 `fast` 一段：

```jsonl
{"thread": "main"}
{"inject": "G1.Q1"}
{"notify": "G1.Q2"}
{"q": "G1.Q2", "from": 0, "to": 1}
{"output": "G1.Q2", "values": {"a": [1]}}
{"thread": "fast"}
{"inject": "G2.Q1"}
{"read": "G1.Q2", "by": "G2.Q2", "value": 1}
{"notify": "G2.Q2"}
{"q": "G2.Q2", "from": 0, "to": 1}
{"output": "G2.Q2", "values": {"b": [1]}}
```

另一种时机下，`fast` 一段是：

```jsonl
{"thread": "fast"}
{"inject": "G2.Q1"}
{"read": "G1.Q2", "by": "G2.Q2", "value": 0}
{"notify": "G2.Q2"}
{"q": "G2.Q2", "from": 0, "to": 0}
{"output": "G2.Q2", "values": {"b": [0]}}
```

检查 ④ 对两份都成立：0 XOR 1 = 1，0 XOR 0 = 0。没有 `read` 行，就无法判断 G2.Q2 写入的 1 或 0 对不对。

## 6. 输出

输出接入模块订阅 `JKM.output` 中每个成员的通知（JKRD7 §9.1）。某个成员的通知投递时，它按 output 的组顺序与组内顺序，**只读取与该成员 `JKS.thread` 相同的 output 成员的 q**。没有这样的成员的组，在 `values` 中省略。

例：`JKM.output` 为 `{"a": ["G1.Q2"], "b": ["G2.Q1"]}`，G1 的 `thread` 是 `main`，G2 的 `thread` 是 `fast`。

- G1.Q2 的通知投递时，记录为 `{"output": "G1.Q2", "values": {"a": [1]}}`，不带 `b`；
- G2.Q1 的通知投递时，记录为 `{"output": "G2.Q1", "values": {"b": [1]}}`，不带 `a`。

只有一个 thread 时，全部 output 成员的 `JKS.thread` 相同，读取的就是全部成员，与此前相同。

## 7. 与其他并行方式的关系

三种并行互不替代：

| 并行 | 并行的单位 | 出处 |
| --- | --- | --- |
| 实例并行 | 同一个模型的多份运行现场 | WebGPU.md（GPU 后端） |
| thread 并行 | 一个模型里的多对 JKS.thread.FIFO | 本文 |
| 批并行 | 一个 thread 的任务 FIFO 里的若干节点任务（目标互不相同，sources 不含排在前面的任务的目标） | JKRD7 §7.5 |

## 8. 延后与待定

**延后的模块**（用户 2026-11-12）

| 模块 | 内容 |
| --- | --- |
| ~~FIFO.factory~~ | 用户 2026-11-13：由 thread.factory 模块取代，不再延后，见第 11 节。其中尚未确定的选择见本节“待定”的 F1—F15（F11、F12 已撤销） |
| 输入批 | 运行脚本或输入批在多个 thread 下的全部问题，放在一起处理。例如 JKRD7 §9.4 的“在模型静止时注入下一批”：多个 thread 时，是等全部 thread 静止，还是每个 thread 只等自己静止 |

**已定**（用户 2026-11-12）

| 编号 | 问题 | 决定 |
| --- | --- | --- |
| T2 | `JKM.threads` 的要求 | 必须声明，至少有一个；名称不限，`main` 是默认名（第 2 节） |
| T3 | 其他 thread 何时启动 | 按需：JKS.thread.FIFO 第一次有项时启动，空了收回（第 4 节） |
| T4 | output 记录中没有同 thread 成员的组 | 省略（第 6 节） |
| T5 | 多条执行记录怎样交付 | 一个 JSONL 文件，按声明顺序分段，段前一行 `{"thread": …}`（第 5 节） |
| T6 | 多个 thread 并行时快照在什么时刻取 | 交给快照模块决定。用户的倾向：每个 thread 各自在两个处理单元之间取，合成一份 |
| T7 | 引用跨 thread 时执行记录怎样核对 | 先后不作保证，由结构负责；核对分两级（第 5 节） |
| T8 | 两个 thread 同时触及同一份状态 | 处理单元是原子的（第 5 节） |
| T9 | 事务推进到别的 thread 的 JKI | 仍在事务中，由执行事务的 thread 执行（第 4 节） |
| T10 | `JKM.threads` 中没有 `main` | 是分支模型；单独运行时先启动默认的 `main` 线程（第 4 节） |
| T11 | 什么时候不能启动新的 thread | 由硬件资源决定；没有空闲资源时项留在 FIFO 中等待（第 4 节） |
| T13 | 多 thread 记录“自身合法”的检查项 | 四项检查，并新增 `read` 行记下跨 thread 读到的值（第 5 节） |

**已定**（用户 2026-11-13）

| 编号 | 问题 | 决定 |
| --- | --- | --- |
| T14 | 硬件资源分配与运行问题处理归谁 | thread.factory 模块；它取代 FIFO.factory 模块（§11.1） |
| T15 | 一份硬件资源是什么 | CPU 上 Worker 线程池中的一个 Worker；Worker 的数量按 `navigator.hardwareConcurrency`（§11.2） |
| T16 | 怎样分发 | 任务队列：一个 Worker 领一个任务，一口气跑完，再领下一个（§11.3） |
| T18 | 实现流程 | 主线程（任务分发中心）→ Worker 线程池 → 纯同步跑完全部串行步骤（§11.7）。原来的一级“每个 Worker 加载独立的 WASM 实例”已撤销（T20） |
| T19 | 线程池适配什么 | CPU 物理核心（怎样得到物理核心数见 F14）。同一句里的“密集计算用 WebAssembly（C++/Rust/Zig）写”已撤销（T20） |
| T20 | 实现范围 | 只实现 Worker 线程池（硬件多核并发），不用 WASM。Worker 里的执行器仍用 TypeScript 写，“代码只用 TypeScript”不再有例外 |
| T17 | 数据怎样传输 | `SharedArrayBuffer` 加 `Atomics`，或 Transferable Objects；不靠 `postMessage` 的序列化（§11.4） |

**待定**

| 编号 | 问题 | 说明 |
| --- | --- | --- |
| T1 | 实现到哪一步 | 用户 2026-11-12：待设计结束后再定。现状见第 9 节 |
| F1—F15 | thread.factory 尚未确定的选择（F11、F12 已撤销） | 见 §11.6 |
| T12 | 分支模型怎样并入别的模型 | 用户 2026-11-12 只说“没有 main 说明是分支模型”，并决定现在不定：并入要改接连接，随生命周期模块与工厂模块一起延后。现在只有“分支模型可以单独运行”这一条 |

## 9. 实现状态

| 规则 | 现状 |
| --- | --- |
| 第 2 节的声明 | 已实现：`JKM.threads` 非空、无重复，`JKS.thread` 必须是其中之一（`src/model.ts`） |
| thread 名默认 `main` | JKRD7 的全部示例、十选一附件、测试夹具与展示页的内置示例已由 `work` 改为 `main`。待适配的工厂附件没有改 |
| 第 4 节的跨 thread 引用 | 静态检查不限制，与规则一致 |
| 第 4—6 节的按需启动、并行、分开的记录与输出、`read` 行与四项检查 | **未实现**。CPU 后端与 GPU 后端都拒绝多 thread 模型；单 thread 模型的记录与输出不受本文影响 |
| 第 11 节的 thread.factory（Worker 线程池、任务队列、共享内存） | **未实现**。`src/` 中没有 Worker、`SharedArrayBuffer` 或 `Atomics`；展示页现有的两个 Worker（`web/show/cpu-worker.ts`、`web/show/scene/layout-worker.ts`）与 thread 无关 |
| JKRD7 §7.4、§9.2、§9.3 第 4 项与 README 延后处理区 | 仍写“FIFO.factory”。改这两份正文须有用户明确指令（AGENTS.md），尚未改 |

## 10. 沿革

2026-11-12，用户定义 thread 模块并逐项选择：

- “thread 模块是 线程调度模块，默认为单个线程运行。当 JKM 或 JKS 满足并行计算时（或有时模型结构设计了并行计算结构）就按需分配多个线程并行计算。线程之间互不影响、互不切换或等待，如不满足改要求则无法启动新线程。”
- “thread 默认为 ‘main’ 主线程。该线程管理和调度一切运行中所有用到的线程。”
- 分配方式：作者声明，静态检查核对（选 1A）。
- 不满足独立条件：静态检查报错，模型不合法（选 2A）。
- 执行记录：按 thread 分成多条，各自有序，不合并；“多 thread 是并行计算的”（选 3B）。
- 输出：只读与通知成员同 thread 的 output 成员（选 4B）。
- “运行脚本或输入批模块相关问题都放到一起并延后处理。”
- 格式不变，`threads` 与 `thread` 仍必填；“默认 ‘work’ 改为 ‘main’”（选 6A）。
- “FIFO 容量与故障处理归 FIFO.factory 管，该模块延后处理。”
- 实现范围：“待设计结束后再定。”
- “把所有关于 thread 模块的设计规则或声明等，都放到 RunThread.md 文件中。”

同日稍后，用户改定：

- “每个线程执行独立的 FIFO 任务。该线程执行时或执行后会触发事件通知到别的模块的节点，可能会使其它模块产生新的任务或线程，这是设计结构所呈现的正常情况。线程也不指定包含哪些节点，只是执行某个触发起点的任务。所以 thread 之间可以有引用。”
- 这取代了上面的 1A、2A：Claude 由“线程之间互不影响”推出的独立条件（引用不得跨 thread、不满足时静态检查报错）撤销，本文原第 4 节改写。
- T2：“必须声明，并且至少有一个。例：["work"]、["main"]、["main", "fast"] 合法。”
- T3：按需启动（选 B）。T4：省略没有同 thread 成员的组（选 A）。T5：一个 JSONL 文件分段（选 A）。
- T6：“应该选B，但是选C吧。”即交给快照模块决定，倾向是每个 thread 各自取、合成一份。

之后用户又定：

- T7、T8、T9：都选 A（先后不作保证并分两级核对；处理单元原子；事务仍由执行它的 thread 执行）。
- T10：“没有main说明是分支模型，单独运行时先启动默认 main 线程。”
- T11：选 B，“新线程是硬件资源决定的，是运行时不会中断切换跳转到其他线程的硬件资源运行线程。”

- T12：选 A，现在不定。T13：选 C，在三项检查之上新增 `read` 记录行；检查 ④ 与例外是 Claude 据此写出的。

第 4 节例子中各项进入哪个 FIFO，是按 JKRD7 §7.4 原有的三条归属规则写的；“thread 不划定节点，只执行进入它的 FIFO 的任务”按这三条理解。

2026-11-13，用户定义 thread.factory 模块：

- “这里设计 thread.factory 模块：管理运行平台的硬件资源分配，和运行相关的问题处理（也取代 FIFO.factory 模块的功能）等。更新在 RunThread.md 文档中。”
- “主要方案是在 CPU 上运行实现或管理：建立一个 Worker 线程池（Hardware Concurrency Pool）。例如根据 `navigator.hardwareConcurrency` 获取 CPU 逻辑核心数（如 8 或 16 核），创建对应数量的 Worker。”
- “任务队列分发：主线程将 1000 种任务放入队列，每个 Worker 领到一种任务后，独占该 CPU 核心一口气跑完 10000 个步骤，再领取下一个任务。这能最大限度利用硬件，同时把线程切换中断降到最低。”
- “数据高效传输（SharedArrayBuffer 或 Transferable Objects）：如果任务之间有大量数据交互，使用 `SharedArrayBuffer` 实现零拷贝的共享内存读写，结合 `Atomics` 进行无锁或低延迟同步，避免消息传递（`postMessage` 序列化）带来的中断和延迟。”
- 第 11 节由 Claude 据此写出。§11.2—§11.4 中标“对应”的句子，是把用户的话对到本文第 4、5 节已有规则上的读法，待用户确认（F1）；§11.5 是实现设计，不是规则来源；没有依据的选择都留在 §11.6。

同日稍后，用户给出实现流程：

- “实现流程：主线程（任务分发中心）到 Worker 线程池（硬件多核并发）到 每个 Worker 加载独立的 WASM 实例（零 GC、极致单核算力）到 纯同步跑完 10000 个串行步骤。”
- §11.7 据此写出。它定了“由主线程分发”，F3 因此改为只问分发走哪条通道；它新带来的选择记为 F11—F13。F1、F2 没有因此确定。

之后用户又定：

- “CPU Web Workers 线程池适配 CPU 物理核心，将 Workers 内部的密集计算逻辑用 WebAssembly (C++/Rust/Zig) 编写，在 Worker 线程内部调用 WASM 模块。”
- 这使 F11 由“用什么写”改为“三种语言选哪一种”，并新增 F14（物理核心数）。它与“代码只用 TypeScript”（用户 2026-11-06，AGENTS.md、TypeScript.md）不一致：按这句话，WASM 内核是例外。AGENTS.md 与 TypeScript.md 的那一句还没有改，待用户确认。

之后用户撤销 WASM：

- “只实现 Worker 线程池（硬件多核并发）吧，不用 WASM 了。”
- 这撤销了实现流程中的“每个 Worker 加载独立的 WASM 实例”和“用 WebAssembly（C++/Rust/Zig）编写”。F11（选哪种语言）、F12（WASM 实例共不共享内存）随之撤销，F13 改为问 Worker 里的 TypeScript 执行器与 `src/cpu.ts` 的关系。与“代码只用 TypeScript”的冲突不再存在，AGENTS.md 与 TypeScript.md 不必改。“适配 CPU 物理核心”没有撤销。
- 这之前用户问过能否“独占该 CPU 核心”。结论：浏览器不能；Linux 上的 Node 把每个 Worker 绑定到一个核心、再隔离这些核心，可以接近；RTOS 可以，但那里没有浏览器与 Node。用户没有就此作决定，记为 F15。

## 11. thread.factory

### 11.1 职责

thread.factory 模块管三件事（用户 2026-11-13）：

1. 运行平台硬件资源的分配：第 4 节“每个 thread 独占一份硬件资源”中的硬件资源由它提供。
2. 与运行相关的问题处理。
3. 原 FIFO.factory 模块的全部内容：JKS.thread.FIFO 的存储、容量与故障处理。FIFO.factory 这个名称不再使用。

分工：thread 模块（第 1—6 节）规定一个 thread 什么时候该启动、该收回，各项进入哪个 FIFO；thread.factory 规定用什么硬件运行它、FIFO 放在哪里、出了问题怎么办。

thread.factory 与工厂模块（JKI.FACTORY、RAM.FACTORY，JKRD7 附录，待适配）无关：后者是用 JKI 组成的 JKS，前者是运行平台上的资源管理。

### 11.2 Worker 线程池

- 主要方案在 CPU 上实现和管理。
- 建立一个 Worker 线程池。Worker 的数量取 CPU 的逻辑核心数，由 `navigator.hardwareConcurrency` 得到。例：8 核创建 8 个 Worker，16 核创建 16 个。
- 对应：一个 Worker 就是第 4 节所说的一份硬件资源。“没有空闲的硬件资源”就是池里没有空闲的 Worker。

平台事实（实现时必须面对，不是规则）：

| 事实 | 后果 |
| --- | --- |
| `navigator.hardwareConcurrency` 给的是逻辑核心数，浏览器可以给出比实际少的数 | 用户 2026-11-13 稍后要求“适配 CPU 物理核心”。网页没有读物理核心数的接口，Node 的 `os` 模块也只给逻辑核心。有超线程的 CPU 上逻辑核心数是物理核心数的 2 倍；Apple 芯片没有超线程，两者相等（本机都是 10），但分性能核与能效核，网页同样读不到。怎样适配见 F14 |
| 网页与 Node 都不能把 Worker 绑定到指定的 CPU 核心，核心由操作系统分配 | “独占该 CPU 核心”只能做到两点：Worker 的数量不超过逻辑核心数；Worker 在一个任务中途不让出（不 `await`，不回到消息循环）。操作系统的抢占排除不了 |
| 第 1 节第 5 条“运行时不会被中断，也不会切换或跳转到别的 thread” | 指 JK 这一层：一个 Worker 在收回之前只执行一个 thread。不保证操作系统不调度 |
| Node 26 没有全局的 `Worker`（本机 26.13.0 核对：`typeof Worker` 为 `undefined`），Worker 在 `node:worker_threads` 中，接口与浏览器不同；`navigator.hardwareConcurrency` 两边都有（本机为 10） | `src/` 不依赖 Node（TypeScript.md 第 2 节），池的创建要由 `tools/` 与 `web/` 各自提供 |

### 11.3 任务队列

- 等待执行的任务放进一个队列。每个 Worker 领一个任务，一口气跑完它的全部步骤，再领下一个。
- Worker 的数量少于任务的数量时，多出的任务在队列里等。例：1000 个任务、8 个 Worker，同一时刻最多 8 个任务在跑，其余 992 个在队列里。
- 这样做是为了用满硬件，并把线程切换降到最低。

对应（F1）：

| 用户的话 | 本文已有的规则 |
| --- | --- |
| 一个任务 | 一个 thread 的一次启动：从 JKS.thread.FIFO 有项被启动，到两个 FIFO 都空被收回（第 4 节） |
| 一个步骤 | 一个处理单元（JKRD7 第 7 节） |
| 放入队列 | JKS.thread.FIFO 有了项而 thread 没有在运行，这个 thread 进入等待启动的队列 |
| 一口气跑完，再领下一个 | Worker 执行到这个 thread 的两个 FIFO 都空，收回，再领队列里的下一个 thread |
| 队列 | 先进入队列的 thread 先被领走 |

例：池里有 2 个 Worker，`JKM.threads` 为 `["main", "fast", "slow"]`。`main` 与 `fast` 各占一个 Worker。`main` 的一条通知使 `slow` 的任务 FIFO 有了项：`slow` 进入等待队列，这一项留在 `slow` 的任务 FIFO 中。`fast` 的两个 FIFO 都空了，它的 Worker 收回，领走 `slow`，一直执行到 `slow` 的两个 FIFO 都空。这与第 4 节的例子一致。

由此得出：

- 一个任务中途 Worker 不回到消息循环，所以收不到 `postMessage`。别的 thread 在这期间给它的项，只能通过共享内存到达（§11.4）。
- 一个 thread 的 FIFO 一直不空（例如结构里有不终止的环），它的 Worker 就一直不收回。第 4 节已定：已经在运行的 thread 不会为别的 thread 让出资源。要不要设上限，见 F8。
- 只有 1 个 Worker 时，多 thread 模型仍然能运行：各 thread 轮流占用这个 Worker，一个收回后下一个才启动。

### 11.4 数据传输

- 任务之间有大量数据交互时，用 `SharedArrayBuffer` 做零拷贝的共享内存读写，用 `Atomics` 做无锁或低延迟的同步。
- 也可以用 Transferable Objects（转移所有权，不拷贝）。
- 不用 `postMessage` 的序列化传运行中的数据：它带来中断和延迟。

平台事实：

| 事实 | 后果 |
| --- | --- |
| 浏览器中 `SharedArrayBuffer` 只在跨源隔离的页面可用（`crossOriginIsolated` 为 `true`），页面的响应要带 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`（或 `credentialless`） | 本机服务 `tools/server.ts` 现在不发这两个头，实现时要加。页面没有隔离时怎么办，见 F9 |
| Node 中 `SharedArrayBuffer` 与 `Atomics` 直接可用 | 命令行没有这个限制 |
| `Atomics.wait` 会阻塞，浏览器的页面主线程不允许调用；Worker 与 Node 可以。`Atomics.waitAsync` 不阻塞，两边都有 | 页面主线程不能用阻塞的方式等 Worker，见 F3 |
| Transferable 转移之后，原来的一方不能再访问这块内存 | 只适合交接一次的数据，不适合多个 thread 同时读写的数据 |

### 11.5 实现设计（Claude 推导，不是规则来源）

这一小节是由 §11.2—§11.4 与第 3—6 节推出的实现设计，地位与 WebGPU.md 相同；与规则冲突时以规则为准，待定的选择以用户的决定为准。

| 数据 | 谁读写 | 放在哪里 | 理由 |
| --- | --- | --- | --- |
| 模型的静态结构（编译后的数组） | 所有 Worker 只读 | `SharedArrayBuffer`，建池时写一次 | 不变，不需要同步 |
| 各节点的 q、到达记录（trigger_all）、轮记录 | 多个 thread 读写 | `SharedArrayBuffer` + `Atomics` | 第 5 节：引用可以跨 thread，处理单元是原子的（T8）。做法见 F6 |
| JKS.thread.FIFO（每个 thread 一对） | 本 thread 取出；本 thread、别的 thread 与注入方放入 | `SharedArrayBuffer` 中的环形队列，项用节点的整数编号表示 | §11.3：任务中途收不到消息。容量见 F4，满了怎么办见 F5 |
| 等待启动的 thread 队列、各 Worker 的忙闲 | 所有 Worker | `SharedArrayBuffer` + `Atomics` | 谁来分发见 F3 |
| 每个 thread 的执行记录 | 只有执行它的 Worker 写 | Worker 私有的 `ArrayBuffer`，运行结束时作为 Transferable 交回 | 第 5 节：记录按 thread 分开，不合并，所以不需要共享 |
| 事务事件 FIFO、事务任务 FIFO | 只有执行事务的 thread | Worker 私有 | 第 3 节：它们属于事务，不属于 thread |

必须做对的一处：“两个 FIFO 都空了就收回”与“别的 thread 这时放入一项”可能同时发生。收回与放入要用同一个原子操作判定，否则这一项会留在一个已经收回、又没有进入等待队列的 thread 里，永远不被执行。

### 11.6 待定

这些选择没有用户批准的依据，不自行推断。每项的第一个方案是 Claude 推荐的。

| 编号 | 问题 | 方案 |
| --- | --- | --- |
| F1 | “任务”“步骤”对应什么 | A. 任务是一个 thread 的一次启动，步骤是处理单元（§11.3 按此写）。B. 任务是一份运行现场（同一个模型的多次运行，即第 7 节的实例并行搬到 CPU 上）。C. 任务是一个运行脚本或一个输入批 |
| F2 | 池的大小；流程中的“主线程”与 `main` thread 的关系 | A. 创建 `hardwareConcurrency` 个 Worker，`main` 占其中一个，创建池的宿主线程（页面主线程或 Node 主线程）不执行 thread。例：8 核，`main` 之外最多同时再运行 7 个 thread。B. 创建 `hardwareConcurrency − 1` 个 Worker，给宿主线程留一个核心。C. `main` 就在宿主线程上执行，另建 `hardwareConcurrency − 1` 个 Worker（页面会在 `main` 执行期间卡住） |
| F3 | 主线程分发走哪条通道（“由主线程分发”已定，T18） | A. Worker 跑完一个任务回到消息循环，用 `postMessage` 报告空闲；主线程用 `postMessage` 发给它下一个任务的编号。消息里只有编号，没有运行数据，也不在任务中途收发，不违反 §11.4。主线程用 `Atomics.waitAsync` 得知有 thread 进入了等待队列。B. 全走共享内存：Worker 跑完后用 `Atomics.wait` 等主线程写入下一个任务的编号，始终不回到消息循环（Worker 出错时较难收场）。C. Worker 自己从共享的等待队列领取，主线程只建池和收结果（这与“主线程是任务分发中心”不符） |
| F4 | JKS.thread.FIFO 的容量 | A. 建池时按模型估计一个固定容量（与 README 的 C6 一并解决）。B. 由运行配置给出，默认一个固定值。C. 用可增长的 `SharedArrayBuffer`（`maxByteLength` + `grow`），满了就增长，直到上限 |
| F5 | FIFO 满了 | A. 整个运行停止并报错，交回各 thread 已有的记录。B. 放入的一方等到有空位（这违反第 5 节“thread 之间不等待”，并可能死锁）。C. 增长（要先选 F4 的 C） |
| F6 | 处理单元的原子性怎样做到（T8） | A. 每个 JKS 一把用 `Atomics` 实现的锁，处理单元开始时按固定顺序取得它触及的 JKS 的锁。B. 全模型一把锁（最简单，但跨 thread 的处理单元实际上串行）。C. 无锁：逐字用 `Atomics.compareExchange`，失败重试（一个处理单元触及多个字时很难保证整体原子） |
| F7 | Worker 出错（抛异常、被终止） | A. 整个运行停止并报错，交回各 thread 已有的记录；不重试，因为共享状态已经被改过。B. 只停这个 thread，其余继续（别的 thread 给它的项不再被执行，结果不完整）。C. 从快照恢复后重跑（依赖快照模块） |
| F8 | 一直不空的 thread | A. 每次启动设处理单元上限，超出时按 F7 的 A 处理（与 README 的 C3 用同一个上限）。B. 不设上限，由调用方终止整个池。C. 超出上限时让出 Worker、重新排队（这违反第 4 节“不让出资源”） |
| F9 | 页面没有跨源隔离，`SharedArrayBuffer` 不可用 | A. 拒绝多 thread 模型并说明原因；单 thread 模型照常运行。B. 退回到一个 Worker 上依次执行各 thread。C. 改用 `postMessage` 传递（违反 §11.4） |
| F10 | GPU 后端与 thread.factory 的关系 | A. thread.factory 只管 CPU 后端；GPU 后端继续只执行单 thread 模型。B. 每个 thread 在 GPU 上占一份实例或一组缓冲区，由 thread.factory 统一管理。C. 待 CPU 上实现之后再定 |
| ~~F11~~ | ~~WASM 内核用哪种语言写~~ | 撤销（T20：不用 WASM） |
| ~~F12~~ | ~~WASM 实例之间共不共享内存~~ | 撤销（T20）。各 Worker 共享同一块 `SharedArrayBuffer`，见 §11.5 |
| F13 | Worker 里的执行器与 `src/cpu.ts` 的关系 | A. 新写一个读写 `SharedArrayBuffer` 上类型化数组的执行器（布局可参照 `src/gpu/compile.ts` 的结构数组）；`src/cpu.ts` 仍是串行参考和默认后端，单 thread 模型两者的记录必须逐字节相同（JKRD7 §7.5）。B. 把 `src/cpu.ts` 的状态改成类型化数组，串行与线程池共用一份执行逻辑（参考实现本身被改动，要重新对拍 GPU 后端与快照）。C. 每个 Worker 各跑一份现在的 `src/cpu.ts`，状态私有，用消息同步（引用跨 thread 时读不到别的 thread 的 q，违反 §11.4） |
| F14 | 线程池怎样适配物理核心（网页与 Node 都读不到物理核心数） | A. 默认取 `navigator.hardwareConcurrency`，运行配置里可以写明 Worker 的数量，写了就以它为准。例：16 逻辑核、8 物理核的机器上写 8。B. 命令行在 Node 中调用系统命令读物理核心数（macOS 的 `sysctl hw.physicalcpu`），浏览器仍取 `hardwareConcurrency`（两边的数可能不同）。C. 一律取 `hardwareConcurrency` 的一半（在没有超线程的 CPU 上少用了一半核心，例如本机） |
| F15 | 要不要把 Worker 绑定到核心（“独占该 CPU 核心”） | A. 不绑定：Worker 数不超过核心数，Worker 在任务中途不让出，核心由操作系统分配。浏览器与 Node 行为一致。B. 命令行在 Linux 上可选绑定：Worker 读 `/proc/thread-self` 得到线程号，执行 `taskset -cp` 绑定；浏览器与 macOS 不绑定（本机无法核对）。C. 换运行平台（Linux 实时内核或 RTOS），这要改 T15—T18 的前提 |

### 11.7 实现流程

用户 2026-11-13 给出的流程。原有四级，其中“每个 Worker 加载独立的 WASM 实例”已撤销（T20），现在是三级：

| 级 | 内容 | 说明 |
| --- | --- | --- |
| 1 | 主线程：任务分发中心 | 建池，把任务放进队列，分给空闲的 Worker，收回结果。它不做计算 |
| 2 | Worker 线程池：硬件多核并发 | §11.2 |
| 3 | 纯同步跑完全部串行步骤 | Worker 调用执行器的一个函数，这个函数返回时任务已经跑完。中途不 `await`，不回到消息循环（§11.3） |

例：8 核，`JKM.threads` 为 `["main", "fast"]`。主线程创建 8 个 Worker，把同一块 `SharedArrayBuffer` 交给每个 Worker。`fast` 进入等待队列时，主线程把 `fast` 的编号发给一个空闲的 Worker；这个 Worker 调用 `run(fast)`，函数在 `fast` 的两个 FIFO 都空时返回；Worker 报告空闲，等下一个任务。

不用 WASM 的后果：

| 事实 | 后果 |
| --- | --- |
| Worker 里的执行器是 TypeScript，运行在 JS 引擎上 | 垃圾回收排除不了。执行器在任务中途只读写类型化数组、不新建对象，回收就很少发生 |
| 流程中的“主线程”是建池的宿主线程；第 1 节的主线程是名为 `main` 的 thread，它有自己的一对 FIFO 要执行 | 两者是不是同一个，没有依据，见 F2。按 F2 的 A，宿主线程分发，`main` thread 在一个 Worker 里执行 |

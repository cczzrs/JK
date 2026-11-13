# JK · JKRD7

本项目只维护 **JKRD7（7.0.0）**：JKI／JKS 的设计规则、已批准的模型示例、静态检查、按规则实现的执行器，以及展示执行过程的网页。不兼容、不维护此前版本。

唯一规则入口是 [JKRD7.md](JKRD7.md)。尚未确定的选择集中在 JKRD7 §9.3。全部代码用 TypeScript 编写。执行器有两个后端：

- **CPU 后端**（默认）：JKRD7 的串行参考语义，是判断对错的基准；
- **GPU 后端**：在 WebGPU 上同时执行许多实例，执行记录必须与 CPU 后端逐字节相同。

两个后端都只执行单 thread 模型；thread 名默认 `main`，thread 模块的规则在 [RunThread.md](RunThread.md)，其中多 thread 的部分尚未实现。展示页（`web/show/`）在浏览器中显示模型和执行过程：交互执行用 CPU 后端，GPU 后端用于对拍。

## 设计要点

- **JKI**：每个节点保存 q；trigger 为 any 或 all；EX 由 J（AND）、K（XOR）组成，在执行入口读取来源的 q；publish 有七种模式。通知不携带值。
- **JKS**：members 递归保存完整的 JKI 与子 JKS；跨层引用写绝对路径。trigger 登记本结构的前置成员，按类型整合它们的通知：any 不整合，all 到齐后同步放行，transaction 到齐后形成事务任务，transaction_any 每条通知形成一个事务任务；out 不整合，声明环的退出节点。
- **事务**：从本次前置的受整合订阅者开始，一直执行到本次触发的事件和任务都处理完；不划定成员范围，推进到的 JKI 都在事务中执行。每个事务有自己的事件 FIFO 与任务 FIFO，优先于 thread 的两个 FIFO；事务中满足的事务登记形成嵌套事务，逐层执行。事务内按 publish 结果沿连接推进，通知在投递时就到达输出；不设失败与回滚；多个事务任务按任务 FIFO 顺序逐个执行。
- **环**：每个环都要有明确的停止或退出结构，退出节点登记为 out；静态检查只核对登记。执行器另设事务的步数与层数上限。
- **执行模型**：一次处理一个单元；事件优先；同一通知按订阅者绝对路径的顺序投递。任何并行实现对同一运行脚本必须产生与串行参考相同的执行记录；JKRD7 §7.5 给出了可以直接并行的任务批。
- **运行脚本**：运行脚本规定输入批；输出观察由 JKM 的 output 决定；执行记录按串行顺序逐条列出。
- **快照**：保存两个处理单元之间的全部运行现场。快照模块不属于 JKRD7 的主要路线，规则、代码说明与待处理事项都在 [snapshot/Snapshot.md](snapshot/Snapshot.md)，代码在 `snapshot/`。
- **JKM**：模型封装，包含版本、thread 声明、输入登记（input）、分组的输出列表（output）与根 JKS。

## 阅读入口

| 内容 | 入口 |
| --- | --- |
| 规则 | [JKRD7](JKRD7.md)：字段、触发、整合、事务、执行模型、寻址、模块边界、示例与验收案例 |
| thread 模块 | [RunThread.md](RunThread.md)：线程调度、主线程 main、thread 之间的引用与按需启动、按 thread 分开的执行记录与输出、延后与待定事项 |
| 快照模块（不属于主要路线） | [Snapshot.md](snapshot/Snapshot.md)：快照格式、文本格式、`snapshot/` 中的代码、验收与待定事项 |
| 十选一 ASCII 模型 | [digits.jkm.json](assets/ascii-bit-design/digits.jkm.json)：完整 JKM，一个数字选择转换为 8 个 ASCII bit |
| TypeScript 工具链 | [TypeScript.md](TypeScript.md)：环境、目录、命令、写法约束，以及各模块与 JKRD7 章节的对应 |
| WebGPU 运行方案 | [WebGPU.md](WebGPU.md)：GPU 后端的设计、实现与实测（实现设计，不是规则来源） |
| 展示页 | [web-show.md](docs/web-show.md)：`web/show/` 的决定、执行会话、展示内容、待处理与延后事项、验收 |
| 工厂模块（待适配） | [factory-pending.md](docs/modules/factory-pending.md) 及 [assets/jks-factory-v7-design/](assets/jks-factory-v7-design/JKI.FACTORY.json) 中的附件 |
| 维护记录 | [jkrd7-maintenance.md](docs/jkrd7-maintenance.md)：各次修改的依据与前后差异 |
| 结构与代码整理 | [ultra.md](ultra.md)：2026-11-11 的全面分析、已执行的改动、核对结果与下一步规划 |
| 补充提案 | [第一轮](docs/jkrd7-proposal-2026-11-05.md)（P1—P9）、[第二轮](docs/jkrd7-proposal-2026-11-06.md)（P10—P17），均已批准 |
| 核对报告 | [静态检查](reports/static-validation.json)、[CPU 后端](reports/reference-run.json)、[GPU 后端](reports/gpu-run.json)、[展示页](reports/show-run.json) |

[jk.config.json](jk.config.json) 保存入口索引；[AGENTS.md](AGENTS.md) 保存协作要求。

## 核对

需要 Node 26（[.node-version](.node-version)）。首次运行前执行 `npm install`，安装类型检查用的开发依赖和展示页用的 three。GPU 后端与展示页的验收还需要本机装有 Chrome。

```sh
npm run typecheck
node tools/validate.ts
node tools/reference.ts
node tools/gpu.ts
node tools/show.ts
npm run test:ui
```

- `npm run typecheck`：TypeScript 类型检查。
- `tools/validate.ts`：静态检查。范围包括 JKRD7 与 Snapshot.md 中的 JSON、模型附件、正例与负例、bit 的原文写法、快照的正例与负例、待适配附件的 JSON 语法、展示页的内置示例、本地链接和索引。
- `tools/reference.ts`：用 CPU 后端执行 JKRD7 第 10 节的模型与十选一附件，核对 §11.2 的验收案例。案例包括批执行模式、运行脚本和快照。
- `tools/gpu.ts`：以无头模式启动本机 Chrome，在 WebGPU 上执行 GPU 后端，并与同一页面里的 CPU 后端逐字节对拍。
- `tools/show.ts`：以无头模式启动本机 Chrome 打开展示页，通过页面控件执行运行脚本、单步、时间轴等案例，把页面导出的执行记录和显示的状态同 CPU 后端比较。
- `npm run test:ui`：用 Node 自带的测试运行器检查展示页界面的纯函数（偏好的校验、图片转输入、观察点与布局、输出数值的换算、输出列表的推导），不需要浏览器。
- 加 `--write-report` 时更新 `reports/` 下的报告。
- 用 `--script <运行脚本>` 输出 JKRD7 §9.4 的执行记录，供逐条比对：
  - `node tools/reference.ts`（CPU）可加 `--batch`；
  - `node tools/gpu.ts`（GPU）；
  - 两者的 `--start <快照>`、`--save <快照>` 见 [snapshot/Snapshot.md](snapshot/Snapshot.md) 第 4 节。
- 运行 `npm run serve` 后，可以在浏览器中打开展示页 `http://127.0.0.1:8317/web/show/index.html` 和 GPU 对拍页 `http://127.0.0.1:8317/web/index.html`。

这些检查通过，只说明在本机已核对的范围内，两个后端和展示页与规则一致。其他浏览器、其他 GPU、恢复流程和多 thread 并行尚未验证。

## 待处理事项（2026-11-11 整理）

2026-11-06 对 JKRD7 的规则逻辑与边界做过一次推理，并对照两个后端做了核对。2026-11-08 按现行规则重新核对并分为两区；2026-11-09 按用户的决定重排，并写入了环的退出节点（R1）与 JKM 的输出列表（原 §9.3 第 4 项）。2026-11-11 全面整理了结构与代码（[ultra.md](ultra.md)），其中处理了 R6、R4、C1、C7，并确认 R3、C2 已失效；这六项已从下表移除。

- **待处理区**：接下来处理的事项，按先后排列。
- **延后处理区**：运行中假设的溢出或异常、thread 模块的实现与相关模块、验证与工程，以及共享模型池。快照相关的问题不在本表，见 [snapshot/Snapshot.md](snapshot/Snapshot.md) 第 6 节。

现有检查全部通过：类型检查、静态检查 140/140、CPU 验收案例 26/26、GPU 对拍 6/6、展示页验收 18/18、展示页界面单元测试 7/7。下面各项都**尚未处理**；涉及规则的项，改 JKRD7 正文须有你的明确指令。编号沿用 2026-11-06 的审查：R 为规则，C 为执行器，V 为验证与工程。

### 一、待处理区

#### 1. 工厂模块（下一步）

- 按本版语义重新设计（JKRD7 §9.3 第 3 项）。JKRD7 附录与 [factory-pending.md](docs/modules/factory-pending.md) 待适配；附件中的模型也要补 `input`、`output`，并给环登记退出节点。

#### 2. 执行器

| 编号 | 问题 | 现状与证据 | 决定／建议 |
| --- | --- | --- | --- |
| C4 | 没有统一的执行器入口 | executor.ts 中只有 CPU 的 runScriptCpu（没有使用者的 `Backend`、`RunResult` 类型已于 2026-11-11 删除）；GPU 要另外调用 GpuExecutor.runScript；命令行也分成 reference.ts 与 gpu.ts 两个。两个后端出错时交回结果的方式不同（见延后处理区 C3），统一入口要先定这一点 | 增加 `runScript(script, model, { backend: "cpu" \| "gpu", … })`，默认用 CPU；命令行增加 `--backend`。待定的选择见 [ultra.md](ultra.md) 第 6 节 |

#### 3. GPU 后端

- WebGPU.md 第 3 阶段，实例内并行：一个 workgroup 执行一个实例，事件按波次投递，节点任务按 JKRD7 §7.5 分批；执行记录仍须与 CPU 逐字节相同。尚未开始。
- WebGPU.md 第 4 阶段的资源节省：可选只写 output 记录；q 按位打包。同阶段的按模型估计容量见延后处理区 C6。

#### 4. 展示页

- 原列的四项已于 2026-11-11 完成：显示 GPU 结果（读回 GPU 状态缓冲区）、环与退出节点的可视化、§7.5 批执行与“下一批”的显示、[ultra.md](ultra.md) 第 5 节的清理。
- 目前没有待处理项。剩下的发布前转换属于 V4，快照窗口与 GPU 单步属于快照模块；见 [docs/web-show.md](docs/web-show.md) 第 8 节。

### 二、延后处理区

#### 快照

快照模块不属于主要路线。R2、R5、C5、保存时机与恢复流程、CPU 现场交给 GPU、展示页的快照窗口与 GPU 单步等事项，都移到 [snapshot/Snapshot.md](snapshot/Snapshot.md) 第 6 节。

#### 运行中假设的溢出与异常

| 编号 | 问题 | 现状与证据 | 建议 |
| --- | --- | --- | --- |
| C3 | 两个后端的上限不一致 | CPU：每次 `run()` 默认最多 10 万个处理单元，超出时抛异常；可在 `CpuOptions.maxUnits` 中设定，命令行不能设定。2026-11-06 探测：一个扇出 20 万、本来会正常结束的模型也因此失败。GPU：每批默认最多 100 万个微步，超出时报错码 6，并交回已有记录。两边的计数单位、默认值、报错方式都不同，同一个不终止的模型交回的记录条数也不同 | 统一为“每批处理单元上限”，默认值相同，可在命令行配置；两边都交回已产生的记录和同一种错误信息 |
| C6 | GPU 的容量要手动设定 | 各 FIFO 默认 64 项：不够时报错，过大又浪费显存 | 按模型估计容量（WebGPU.md 第 4 阶段） |

#### thread 模块

设计规则在 [RunThread.md](RunThread.md)（用户 2026-11-12）：thread 名默认 `main`；每个 thread 执行自己的一对 FIFO，thread 之间可以有引用，其他 thread 按需启动；多个 thread 并行计算，执行记录与输出按 thread 分开。

- 实现：两个后端现在都只执行单 thread 模型，多 thread 模型被拒绝。实现到哪一步，用户 2026-11-12 决定待设计结束后再定。
- 待定：RunThread.md 第 8 节的 T1（实现范围）、T12（分支模型怎样并入别的模型，用户决定现在不定）。多个 thread 并行时的快照（T6）交给快照模块。
- FIFO.factory 模块（FIFO 的存储、容量与故障处理；thread 所用硬件资源的分配）：用户 2026-11-12 决定延后。
- 运行脚本或输入批在多个 thread 下的全部问题：放在一起，用户 2026-11-12 决定延后。

#### 验证与工程

用户 2026-11-09 决定延后。

| 编号 | 问题 | 现状与证据 | 建议 |
| --- | --- | --- | --- |
| V1 | GPU 对拍对部分错误不灵敏 | 2026-11-06 对 GPU 内核故意改错 10 处，用 606 个实例对拍，其中“提交顺序颠倒”“子孙事务不就地处理”两处没有被发现。“提交顺序颠倒”“事务中范围外的投递不暂存”两处所针对的统一提交，已在 2026-11-07 的修订中取消 | 按现行内核重新设计突变；扩充随机模型：嵌套事务、事务中的 JKS all、带退出节点的环；M_NEST 改用两次以上的重叠输入；扩充后重做突变检查，直到每处改动都能被发现 |
| V2 | 跨平台未验证 | GPU 对拍和展示页都只在本机 Chrome 157 与 Apple GPU（Metal）上核对过 | WebGPU.md 第 5 阶段：Safari、Firefox；NVIDIA、AMD、Intel；Windows、Linux；手机 |
| V3 | 没有持续集成 | 每次都要手动运行检查 | 普通 CI 运行类型检查、静态检查与 CPU 案例；GPU 对拍和展示页验收放在带 GPU 的机器上 |
| V4 | 浏览器端代码依赖 Node 的去类型功能 | 本机服务（tools/server.ts）去掉类型后才提供给浏览器，这一功能仍是实验功能；展示页放到静态主机之前，也要先把 TypeScript 转成 JavaScript | 改用 esbuild 等转换工具，同时生成发布用的文件（TypeScript.md 第 9 节） |

#### 共享模型池

用户 2026-11-08 决定延后，需要时再设计；JK 目前没有服务端存储。展示页只保留本地文件的导入、下载和内置示例。

## 维护要求

修改 README 或 JKRD7 正文须有用户明确指令，并在维护记录中列出修改前后差异。新增或改变行为必须有批准依据；尚未确定的选择留在 JKRD7 §9.3，不从旧版本或代码补默认规则。

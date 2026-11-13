# TypeScript 工具链

- **日期**：2026-11-06
- **依据**：用户批准“只使用 TypeScript，规则工具链也改成 TypeScript”；执行器分为 CPU 和 GPU 两个后端，默认用 CPU。
- **状态**：原 Python 工具已全部移植到 TypeScript 并删除。删除前做过逐字节对拍，见第 7 节。
- GPU 后端的设计见 [WebGPU.md](WebGPU.md)。规则只以 [JKRD7](JKRD7.md) 为准。
- 2026-11-08 增加展示页 `web/show/`（JKM 工作区），设计与依据见 [docs/web-show.md](docs/web-show.md)。
- 2026-11-11 整理结构与代码（依据、改动与下一步规划见 [ultra.md](ultra.md)）。

## 1. 环境

| 项 | 版本 | 说明 |
| --- | --- | --- |
| Node | 26（LTS） | 版本写在 [.node-version](.node-version) 中；本机是 26.13.0，用 fnm 管理。可以直接运行 `.ts` 文件，运行时只去掉类型，不做检查 |
| TypeScript | 7.0.2（开发依赖） | 只做类型检查（`tsc`，不输出文件） |
| @types/node、@webgpu/types、@types/three | 开发依赖 | Node、WebGPU 与 three 的类型声明 |
| three | 0.180.0（运行依赖） | 只用于浏览器展示页 `web/show/` 的 3D 场景（用户 2026-11-08 批准） |
| Chrome | 本机 157 | 运行 GPU 后端、展示页，并做对拍 |

- 第三方运行依赖只有 three，而且只在浏览器展示页中使用：
  - `src/` 只用语言本身和 WebGPU 接口；
  - `tools/` 只用 Node 内置模块；
  - `web/show/` 另用 three，由本机服务的只读路由提供（第 8 节）。
- 首次使用前运行 `npm install`。开发依赖的版本锁定在 [package.json](package.json) 与 `package-lock.json` 中。

## 2. 目录

```text
src/                     命令行与浏览器共用，不依赖 Node
  model.ts               规则：JSON 原文解析、JSON 结构、静态检查、引用解析、运行脚本检查
  doc.ts                 JKRD7 正文中 JSON 块的提取、第 10 节模型名单、JKM 的排版
  record.ts              执行记录与固定文本格式
  cpu.ts                 CPU 后端（串行参考，默认）
  executor.ts            按运行脚本运行 CPU 后端
  gpu/
    compile.ts           模型 → 结构数组，状态与记录布局
    kernel.ts            生成 WGSL 内核
    backend.ts           GPU 后端主机端：调度、记录解码、起始与结束状态
  testing/
    cases.ts             §11.2 验收案例（CPU）
    gpu-cases.ts         GPU 验收案例（与 CPU 对拍）
    static.ts            静态检查的正例与负例、bit 的原文写法、快照的正例与负例
    fixtures.ts          模型构造、输入登记的同步、随机模型、深比较
    random.ts            可设种子的伪随机数
snapshot/                快照模块（不属于主要路线；引用 src/，src/ 不引用它）
  Snapshot.md            快照的规则与相关内容
  snapshot.ts            快照的类型、检查与文件文本格式
  cpu.ts                 CPU 后端的快照导出与载入
  gpu.ts                 GPU 后端的快照编码、解码与带快照的运行
tools/                   命令行（只在 Node 中运行）
  validate.ts            静态检查
  reference.ts           CPU 后端：验收案例、运行脚本
  gpu.ts                 GPU 后端：启动 Chrome，对拍或运行运行脚本
  show.ts                展示页验收：启动 Chrome，通过页面控件运行，与 CPU 后端比较
  chrome.ts              启动本机 Chrome 并等待页面交回结果（gpu.ts、show.ts 共用）
  server.ts              本机 HTTP 服务（去掉类型后提供给浏览器）
  serve.ts               手动启动本机服务
  examples.ts            生成展示页的内置示例文件 web/show/examples.json
  common.ts              文件读写、命令行参数解析、报告写出
web/
  index.html、gpu.ts     GPU 对拍页面
  show/                  展示页：JKM 工作区（docs/web-show.md）
    index.html、style.css、cosmic.css
    boot.ts、three-source.ts  启动：选定 three 的来源（CDN 优先，本机回退），写入 import map，再载入 main.ts
    examples.json        内置示例（由 tools/examples.ts 生成）
    config.ts            默认配置树
    main.ts              入口：窗口、控件、场景、面板、播放与 GPU 对拍的连接
    state.ts             页面状态：模型、会话、选中的对象、最近的处理单元
    session.ts           执行会话：包装 CPU 后端，只读；按执行细节分步
    panels.ts            面板：状态、FIFO、执行记录、输出、节点与 JKS 详情、本单元
    output-list.ts       输出数据格式及列表的推导（不碰 DOM）：列表行与各列文字
    playback.ts          播放与时间轴（从初值重新执行到目标单元）
    gpu-run.ts、cpu-worker.ts  GPU 对拍：管线缓存，CPU 参考在 Worker 中计算
    gpu-device.ts        3D 渲染与 GPU 后端共用的设备
    verify.ts            自动验收（由 tools/show.ts 触发）
    scene/               3D 场景（three）：布局、连线、标签、信号动画、渲染、Canvas 2D 降级
    ui/                  桌面窗口、外观面板、节点树、网络样式、图片转输入、标签页、偏好校验、选择的保存
    tests/ui.test.ts     界面纯函数的单元测试（Node 自带的测试运行器）
reports/                 四份核对报告
```

## 3. 命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖：TypeScript、类型声明，以及展示页用的 three |
| `npm run typecheck` | 类型检查 |
| `node tools/validate.ts [--write-report]` | 静态检查 |
| `node tools/reference.ts [--write-report]` | 用 CPU 后端跑验收案例 |
| `node tools/reference.ts --script <运行脚本> [--batch]` | 用 CPU 后端运行，输出执行记录。`--start`、`--save` 见 [snapshot/Snapshot.md](snapshot/Snapshot.md) |
| `node tools/reference.ts --model <JKM> --inject <输入入口> …` | 把这些输入作为一批运行 |
| `node tools/gpu.ts [--write-report]` | 用 GPU 后端跑验收案例 |
| `node tools/gpu.ts --script <运行脚本>` | 用 GPU 后端运行，输出执行记录。`--start`、`--save` 见 [snapshot/Snapshot.md](snapshot/Snapshot.md) |
| `node tools/show.ts [--write-report]` | 展示页验收：在 Chrome 中通过页面控件运行，与 CPU 后端比较 |
| `node tools/examples.ts` | 由 JKRD7 第 10 节与十选一附件重新生成 `web/show/examples.json`（改动这些模型后运行） |
| `npm run serve` | 启动本机服务，在浏览器中打开 `http://127.0.0.1:8317/web/show/index.html`（展示页）或 `/web/index.html`（GPU 对拍） |
| `npm run test:ui` | 展示页界面纯函数的单元测试（偏好校验、图片转输入、展示投影与布局、输出列表的推导） |
| `npm run check` | 依次执行类型检查、静态检查、CPU 验收案例、界面单元测试 |

`tools/gpu.ts` 与 `tools/show.ts` 的其他参数：

- `--chrome <路径>`：指定 Chrome 位置，也可以用环境变量 `CHROME`；
- `--headed`：显示浏览器窗口；
- `--timeout <秒>`：等待结果的时间上限；
- `--count <实例数>`：吞吐参考使用的实例数（只用于 `tools/gpu.ts`）。

## 4. 写法约束

- **只用可擦除的语法**：tsconfig 开启了 `erasableSyntaxOnly`。
  - 不用 `enum`、`namespace`，也不用构造函数的参数属性。
  - 取值集合用字符串字面量联合类型，或 `as const` 对象。
  - 这样 Node 和浏览器端的本机服务都能直接去掉类型运行。
- **导入写法**：
  - 相对导入写完整的 `.ts` 扩展名；
  - 只导入类型时写 `import type`（`verbatimModuleSyntax`）。
- **运行环境分开**：
  - `src/` 不使用 Node 模块，命令行和浏览器共用；
  - 文件读写、进程、HTTP 只放在 `tools/` 中。
- **严格模式**（`strict`）。
- **不补规则**：JKRD7 未确定的行为不在代码中自行补全（[AGENTS.md](AGENTS.md)）。
- **界面写法**（`web/show/`，用户 2026-11-08 批准）：
  - 不用 JavaScript 拼接 HTML：元素和模板都写在 HTML 中，脚本只查找元素、复制 `<template>`，再填充文本与属性；
  - 不用 JavaScript 生成 CSS 规则：脚本只设置 CSS 变量、类名和 `data-`、`aria-` 属性，样式写在样式表中；
  - 页面的默认配置和默认值集中在 `web/show/config.ts` 的只读树形结构中；浏览器存储只保存窗口布局、外观和网络样式等展示偏好，不保存 JKM 定义或执行状态；
  - 页面不执行规则：执行只经 `src/cpu.ts` 与 `src/gpu/backend.ts`；动画与计数只从运行日志推出。

## 5. 模块与 JKRD7 的对应

| 模块 | 内容 | JKRD7 |
| --- | --- | --- |
| [src/model.ts](src/model.ts) | JSON 原文解析（bit 只接受写成 0、1）、JKI 字段检查、JKM 加载（含输入登记 input 与根登记的核对、分组的输出列表 output）、引用解析、派生索引（成员、前置、带事务登记的 JKS、订阅者）、登记分层、环的退出节点（out 登记）、纯通知环、运行脚本检查 | §2、§3、§5、§6.4、§8、§9.4 |
| [src/doc.ts](src/doc.ts) | 取出 JKRD7 正文中的 JSON 块（模型、JKI 片段、运行脚本），也用于取出 Snapshot.md 中的快照示例；第 10 节的模型名单；按第 10 节的排版输出 JKM。不含规则 | 第 10 节 |
| [src/record.ts](src/record.ts) | 执行记录的四种项与固定文本格式（多 thread 的 `read` 行尚未实现） | §9.4 |
| [src/cpu.ts](src/cpu.ts) | 串行执行：触发、计算、发布、整合、事务与嵌套事务、事务上限、投递顺序；按 JKM.output 写输出记录；可并行批；到达记录与轮记录的排序输出（`arrivals`）；可选的执行细节回调 `trace`（展示用，不进入记录，不改变执行） | §4—§7、§8.1、§9.1、§9.2 |
| [src/executor.ts](src/executor.ts) | 按运行脚本运行 CPU 后端（GPU 后端的入口是 `GpuExecutor.runScript`） | §9.4 |
| [src/gpu/](src/gpu/backend.ts) | GPU 后端 | WebGPU.md |
| [snapshot/](snapshot/snapshot.ts) | 快照模块：检查、文本格式、两个后端的导出与载入 | [snapshot/Snapshot.md](snapshot/Snapshot.md) |
| [web/show/](web/show/main.ts) | 展示页：显示与交互，执行交给两个后端 | §9.1、§9.2、§9.4 |
| [src/testing/](src/testing/cases.ts) | 验收案例、正例与负例、随机模型 | §11.2 |
| [tools/](tools/validate.ts) | 命令行 | §11.1 |

## 6. 执行记录的文本格式

**执行记录**：

- 每行一个 JSON 对象；
- 逗号和冒号后各一个空格；
- 键按 JKRD7 §9.4 的顺序；
- 非 ASCII 字符原样输出。

例如 `{"q": "G1.Q15", "from": 0, "to": 0}`。两个后端都用 `formatRecord` 输出，比对时逐字节比较。

快照文件的文本格式见 [snapshot/Snapshot.md](snapshot/Snapshot.md) 第 3 节。执行记录的格式与原 Python 工具的输出逐字节相同。

## 7. 从 Python 迁移时的核对

删除 Python 工具之前，用 Python 版生成测试向量，让 TypeScript 版逐项比较：

| 对象 | 结果 |
| --- | --- |
| Python 生成的 400 个随机模型：执行记录、批执行模式的记录、运行中途的快照文本 | 全部相同 |
| 十选一 100 组随机输入批 | 全部相同 |
| 第 10 节的 6 个模型 | 全部相同 |
| 静态检查的 43 个负例、5 个正例：每例的错误条数 | 全部相同 |
| 命令行 `--script`、`--save`、`--start` 与 `--batch`、`--model` 与 `--inject` 的输出 | 逐字节相同 |

移植后的检查数量：

- 静态检查 67/67 通过，正例与负例数量都没有变。
- CPU 验收案例 24 项。原 Python 版有 25 项，其中“CUDA 执行模型”一项随 CUDA 方案取消；GPU 后端改由 `tools/gpu.ts` 的 6 项案例核对。

两点差别：

- 随机测试改用 TypeScript 的可设种子伪随机数（sfc32），抽到的样本与 Python 版不同，检验的性质相同。
- 错误信息中的值改用 JSON 写法，例如 `["state"]`，原来是 `['state']`。

已删除的文件：

- `scripts/jk_model.py`
- `scripts/validate_jkrd7.py`
- `scripts/jk_reference.py`
- `scripts/jk_cuda_model.py`
- `CUDA.md`

## 8. 在浏览器中运行

- 浏览器不能直接运行 TypeScript。[tools/server.ts](tools/server.ts) 把仓库文件提供给浏览器，对 `.ts` 文件先用 Node 内置的 `stripTypeScriptTypes` 去掉类型。这个功能在 Node 26 中仍属实验功能。
- 服务只监听 127.0.0.1，不提供以点开头的文件，也不提供 `node_modules`。
- 例外是只读路由 `/vendor/three/build/` 与 `/vendor/three/examples/jsm/`：只提供 `node_modules/three` 中这两个目录的 `.js` 文件，展示页用 import map 引用。
- `tools/gpu.ts` 与 `tools/show.ts` 用一个临时用户目录启动 Chrome（运行后删除），不影响日常使用的 Chrome 配置。启动时打开 `--enable-unsafe-webgpu`。

## 9. 边界

- 类型检查和四项核对都通过，只说明在本机已核对的范围内实现与 JKRD7 一致。
- 展示页已有 JKM 工作区（[docs/web-show.md](docs/web-show.md)），3D 渲染与 GPU 后端共用设备。
- 还没有做的：
  - 发布用的打包（例如用 esbuild 生成单个 JavaScript 文件）；
  - 展示页的共享模型池（用户 2026-11-08 决定延后）；快照窗口见 [snapshot/Snapshot.md](snapshot/Snapshot.md) 第 6 节；
  - 页面直接读取 GPU 状态缓冲区、GPU 单步（WebGPU.md 第 11 节第 2 阶段的其余部分）。

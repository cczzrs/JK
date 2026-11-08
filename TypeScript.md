# TypeScript 工具链

- **日期**：2026-11-06
- **依据**：用户批准“只使用 TypeScript，规则工具链也改成 TypeScript”；执行器分为 CPU 和 GPU 两个后端，默认用 CPU。
- **状态**：原 Python 工具已全部移植到 TypeScript 并删除。删除前做过逐字节对拍，见第 7 节。
- GPU 后端的设计见 [WebGPU.md](WebGPU.md)。规则只以 [JKRD7](JKRD7.md) 为准。

## 1. 环境

| 项 | 版本 | 说明 |
| --- | --- | --- |
| Node | 26（LTS） | 版本写在 [.node-version](.node-version) 中；本机是 26.13.0，用 fnm 管理。可以直接运行 `.ts` 文件，运行时只去掉类型，不做检查 |
| TypeScript | 7.0.2（开发依赖） | 只做类型检查（`tsc`，不输出文件） |
| @types/node、@webgpu/types | 开发依赖 | Node 与 WebGPU 的类型声明 |
| Chrome | 本机 157 | 运行 GPU 后端并做对拍 |

- 运行时没有第三方依赖：
  - `src/` 只用语言本身和 WebGPU 接口；
  - `tools/` 只用 Node 内置模块。
- 首次使用前运行 `npm install`。开发依赖的版本锁定在 [package.json](package.json) 与 `package-lock.json` 中。

## 2. 目录

```text
src/                     命令行与浏览器共用，不依赖 Node
  model.ts               规则：JSON 结构、静态检查、引用解析、运行脚本与快照检查
  record.ts              执行记录与固定文本格式
  cpu.ts                 CPU 后端（串行参考，默认）
  executor.ts            运行脚本入口
  gpu/
    compile.ts           模型 → 结构数组，状态与记录布局
    kernel.ts            生成 WGSL 内核
    backend.ts           GPU 后端主机端：调度、记录解码、快照
  testing/
    cases.ts             §11.2 验收案例（CPU）
    gpu-cases.ts         GPU 验收案例（与 CPU 对拍）
    static.ts            静态检查的正例与负例
    fixtures.ts          模型构造、随机模型、深比较
    random.ts            可设种子的伪随机数
tools/                   命令行（只在 Node 中运行）
  validate.ts            静态检查
  reference.ts           CPU 后端：验收案例、运行脚本
  gpu.ts                 GPU 后端：启动 Chrome，对拍或运行运行脚本
  server.ts              本机 HTTP 服务（去掉类型后提供给浏览器）
  serve.ts               手动启动本机服务
  common.ts              文件读写与报告
web/
  index.html、gpu.ts     GPU 对拍页面
reports/                 三份核对报告
```

## 3. 命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装开发依赖（TypeScript 与类型声明） |
| `npm run typecheck` | 类型检查 |
| `node tools/validate.ts [--write-report]` | 静态检查 |
| `node tools/reference.ts [--write-report]` | 用 CPU 后端跑验收案例 |
| `node tools/reference.ts --script <运行脚本> [--batch] [--start <快照>] [--save <快照>]` | 用 CPU 后端运行，输出执行记录 |
| `node tools/reference.ts --model <JKM> --inject <输入入口> …` | 把这些输入作为一批运行 |
| `node tools/gpu.ts [--write-report]` | 用 GPU 后端跑验收案例 |
| `node tools/gpu.ts --script <运行脚本> [--start <快照>] [--save <快照>]` | 用 GPU 后端运行，输出执行记录 |
| `npm run serve` | 启动本机服务，在浏览器中打开 `http://127.0.0.1:8317/web/index.html` |
| `npm run check` | 依次执行类型检查、静态检查、CPU 验收案例 |

`tools/gpu.ts` 的其他参数：

- `--chrome <路径>`：指定 Chrome 位置，也可以用环境变量 `CHROME`；
- `--headed`：显示浏览器窗口；
- `--timeout <秒>`：等待结果的时间上限；
- `--count <实例数>`：吞吐参考使用的实例数。

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

## 5. 模块与 JKRD7 的对应

| 模块 | 内容 | JKRD7 |
| --- | --- | --- |
| [src/model.ts](src/model.ts) | JKI 字段检查、JKM 加载、引用解析、派生索引（成员、前置、带事务登记的 JKS、订阅者）、登记分层、从事务可达的环的退出结构、纯通知环、运行脚本与快照检查 | §2、§3、§5、§6.4、§8、§9.4、§9.5 |
| [src/record.ts](src/record.ts) | 执行记录的四种项与固定文本格式 | §9.4 |
| [src/cpu.ts](src/cpu.ts) | 串行执行：触发、计算、发布、整合、事务与嵌套事务、事务上限、投递顺序；可并行批；快照导出与载入 | §4—§7、§9.1、§9.5 |
| [src/executor.ts](src/executor.ts) | 按运行脚本执行 | §9.4 |
| [src/gpu/](src/gpu/backend.ts) | GPU 后端 | WebGPU.md |
| [src/testing/](src/testing/cases.ts) | 验收案例、正例与负例、随机模型 | §11.2 |
| [tools/](tools/validate.ts) | 命令行 | §11.1 |

## 6. 执行记录与快照的文本格式

**执行记录**：

- 每行一个 JSON 对象；
- 逗号和冒号后各一个空格；
- 键按 JKRD7 §9.4 的顺序；
- 非 ASCII 字符原样输出。

例如 `{"q": "G1.Q15", "from": 0, "to": 0}`。两个后端都用 `formatRecord` 输出，比对时逐字节比较。

**快照文件**：

- 两格缩进；
- `q` 与 `trigger_all` 按 JKRD7 §7.3 的路径顺序排列；
- `rounds` 先按 JKS 层数排序，再按路径文本，最后按类型名。

这两种格式与原 Python 工具的输出逐字节相同。

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
- `tools/gpu.ts` 用一个临时用户目录启动 Chrome（运行后删除），不影响日常使用的 Chrome 配置。启动时打开 `--enable-unsafe-webgpu`。

## 9. 边界

- 类型检查和三项核对都通过，只说明在本机已核对的范围内实现与 JKRD7 一致。
- 还没有做的：
  - 发布用的打包（例如用 esbuild 生成单个 JavaScript 文件）；
  - 展示界面（WebGPU.md 第 11 节第 2 阶段）。

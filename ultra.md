# ultra：项目结构与代码整理（2026-11-11）

- **依据**：用户 2026-11-10 的要求，原话：“项目结构与代码优结构化。读取整个项目内容，先分析 JKRD7 设计与规则，再推理与参考其它模块的设计与规则。目的是根据先后的设计与规则，分析出项目结构是否需要优化、代码结构和内容是否需要优化、再给出下一步的设计方向及规划。需要全面分析并执行改进更新。可调整所有内容，所有执行操作都记录在 ultra.md 文档里。”
- **规则来源**：只有 [JKRD7.md](JKRD7.md)。本文的每项判断都写明依据：JKRD7 的条款、项目文档中的文字，或[维护记录](docs/jkrd7-maintenance.md)中的用户批准。JKRD7 §9.3 未确定的选择没有补全，需要用户决定的问题列在第 6 节。
- **之后的变化**：第 1—4 节、第 8 节记的是整理当时的情况，没有改。同日晚些时候快照移出主要路线（原 JKRD7 §9.5 移到 [snapshot/Snapshot.md](snapshot/Snapshot.md)，代码移到 `snapshot/`），展示页的待处理项全部完成。第 5—7 节已按这一现状更新。
- **本文的地位**：工作记录，不是规则来源。README.md 与 JKRD7.md 正文的前后差异另见维护记录 2026-11-11 一条。

## 1. 结论

1. **顶层结构不需要调整。** 现有分层（`src/` 规则与执行、`tools/` 命令行、`web/` 页面、`docs/`、`assets/`、`reports/`）与 JKRD7 的章节和 TypeScript.md 第 4 节“运行环境分开”一致。考虑过的四项移动都不做，理由见 §3.3。
2. **代码结构做了五处调整**：规则模型与文档工具分开（新增 `src/doc.ts`）；`Model.derive()` 拆成七步；命令行的参数解析和报告写出各收成一份；测试夹具的依赖方向理顺；第 10 节的模型名单只留一处。
3. **代码内容**：实现了用户已定的 bit 原文检查（R6）；补全了快照检查（原 R4、C1），此前有 7 种不合法的快照被接受；修了展示页渲染器重建的重入漏洞；删除了全仓库确认无人使用的代码。样式表净减 661 行；其余代码增删相抵（删去重复与死代码约 560 行，新增检查、案例与共用函数约 580 行）。
4. **文档**：修正 WebGPU.md 的 5 处过时或损坏的内容、README 的过时数字与 6 个已处理或已失效的待处理项、TypeScript.md 与 docs/web-show.md 的遗漏。
5. **核对**：五项检查全部通过，四份报告已重新生成。静态检查由 105 项增到 135 项；执行记录与两个后端的对拍结果没有变化。
6. **下一步**：工厂模块按本版语义重新设计。它依赖尚未定义的生命周期模块，开工前有 10 个设计问题要由用户决定（§6.2）。

## 2. 过程记录

按先后列出全部操作。

| 序 | 操作 | 结果 |
| --- | --- | --- |
| 1 | 通读 README、JKRD7（全文）、TypeScript.md、WebGPU.md、docs/web-show.md、factory-pending.md、配置文件，以及 `src/`、`tools/`、`src/testing/` 全部源码、展示页的入口、会话、面板、播放与场景视图 | 得到 §3 的对应表与一批待核实的线索 |
| 2 | 基线：`npm run typecheck`、`node tools/validate.ts`、`node tools/reference.ts`、`node tools/gpu.ts`、`node tools/show.ts` | 通过：静态 105/105、CPU 26/26、GPU 6/6、展示页 17/17 |
| 3 | 按 AGENTS.md 的要求查 modern-web-guidance，取回 css、html、accessibility、tabs 等 10 份指南 | 作为展示页审计与修改的依据 |
| 4 | 第一次多代理工作流：8 个领域审计、逐域对抗核实、3 个架构方案、完整性复查 | **因用量上限全部中断，没有产出**（12 个代理都没有完成） |
| 5 | 改为主会话自己分析。写 6 个机械扫描脚本（放在仓库外的临时目录）：无外部引用的导出、无引用的类成员、样式表中的死选择器、HTML 中无人引用的 id 与模板、无人读取的配置项、受限写法 | 结果见 §4.3、§5 |
| 6 | 探针脚本：快照检查的漏检、`JSON.parse` 取原文、批执行模式下事务上限停下的位置（随机模型 300 个） | 快照 7 种不合法输入被接受；原文可取；批模式与串行相同 |
| 7 | 第二次工作流：2 个代理，中等强度，只读审计展示页的场景层与界面层（以第 5 步的扫描结果为线索） | 完成，各 13 条发现；逐条复核后采纳的见 §4.3，未执行的见 §5 |
| 8 | 改 `src/`、`src/testing/`、`tools/`、`web/gpu.ts`（§4.1、§4.2） | 类型检查、静态检查、CPU 验收通过 |
| 9 | 改展示页（§4.3）。改布局模块之前先记录 19 个模型 × 7 种布局的坐标作为基线 | 改后 133 行基线逐位相同 |
| 10 | 用 CSS 解析器删除死规则；在浏览器中比对清理前后全部元素的计算样式 | 1404 个元素一致，只少了 6 个无人使用的自定义属性 |
| 11 | 再跑五项检查（不写报告） | 通过：静态 135/135、CPU 26/26、GPU 6/6、展示页 17/17 |
| 12 | 改文档（§4.4），写维护记录与本文 | — |
| 13 | 第三次工作流：2 个代理对抗复核本次改动 | **启动后即因用量上限中断，没有产出**；改由主会话用探针自查，见 §7.2 |
| 14 | 五项检查加 `--write-report`，更新四份报告 | 见 §7.1 |

## 3. 分析

### 3.1 JKRD7 的章节与代码的对应

| JKRD7 | 内容 | 位置 | 评价 |
| --- | --- | --- | --- |
| §2 | JSON 约定 | `src/model.ts`：`parseJson`、各字段集合 | 第 2 条（bit 只能是整数 0 或 1）此前只查解析后的值，本次补上原文检查 |
| §3、§5、§6.4、§8 | JKI、JKS、JKM 的静态规则 | `src/model.ts`：`checkJki`、`Model` | 对应完整；`derive()` 职责过多，已拆 |
| §4—§7 | 触发、计算、发布、整合、事务、执行模型 | `src/cpu.ts`（串行参考）、`src/gpu/`（并行实现） | 与规则逐条对应；GPU 内核的函数与 CPU 一一对应（WebGPU.md §6.2） |
| §7.5 | 可并行批 | `src/cpu.ts` 的批执行模式 | 探针确认事务上限在批模式下停在同一步 |
| §9.1 | 输入接入模块、输出接入模块 | 执行器内置：`inject`、投递时读取 output | 规则把它们称作模块，但没有规定独立的接口；现在不拆 |
| §9.2 thread 模块 | 多 thread 调度 | 没有；两个后端只执行单 thread 模型 | §9.3 第 1 项未定，不预留代码 |
| §9.2 生命周期模块 | 创建、改接、删除、编号分配、不处理的任务 | 没有 | 未定义；工厂模块依赖它（§6.2） |
| §9.2 运行现场与恢复 | 快照格式（§9.5）已定，保存时机与恢复流程未定 | `checkSnapshot`、两个后端的导出与载入 | 检查此前不完整，本次补全 |
| §9.2 工厂 | 待适配 | `docs/modules/factory-pending.md`、`assets/jks-factory-v7-design/` | 只查 JSON 语法；下一步的主题 |
| §9.2 展示 | 图形、颜色、布局 | `web/show/` | 没有发现页面自行推算规则语义；遗留代码较多，已清理 |
| §9.4 | 运行脚本、执行记录 | `src/executor.ts`、`src/record.ts` | executor.ts 只有 CPU 入口，统一入口是待处理项 C4 |
| 第 10 节 | 示例 | JKRD7.md 中的 JSON，由 `src/doc.ts` 取出 | 提取代码原在 model.ts 里，与规则无关，已分开 |
| 第 11 节 | 验收 | `src/testing/`、`tools/` | §11.1 漏了展示页验收，已补 |

### 3.2 其他模块的设计与代码的对应

| 文档 | 核对结果 |
| --- | --- |
| TypeScript.md | 第 4 节的约束基本落实。两处违反“界面写法”：`ui/network-style-panel.ts` 直接写 `style.backgroundColor`；`ui/output-choices.ts` 用 `createElement("option")`。都已改。目录树与对应表缺 `doc.ts`，已补 |
| WebGPU.md | 设计与代码一致。文档有 5 处问题：§6.4 的表格被截断；§7 仍写“事件的接收者路径换成出边编号”（事件项只有来源）；§8 仍写“子孙 JKS 的事务就地放行”（现行为逐层执行）；§9 的两个数字过时 |
| docs/web-show.md | 各项决定都已实现。第 7 节漏了第三个浏览器存储键 |
| factory-pending.md | 状态描述与 JKRD7 附录、README 一致：待适配，不是规则来源 |

### 3.3 结构：考虑过、决定不做的调整

| 调整 | 不做的理由 |
| --- | --- |
| 把根目录的 TypeScript.md、WebGPU.md 移进 `docs/` | JKRD7 正文、AGENTS.md、README、jk.config.json 都链接到它们；移动要改规则正文的链接，收益只是摆放整齐 |
| 把 GPU 对拍页 `web/index.html`、`web/gpu.ts` 移进 `web/gpu/` | docs/web-show.md 第 1 节已定“GPU 对拍页 `web/index.html` 和 `tools/gpu.ts` 的行为不变” |
| 把 `src/testing/` 移出 `src/` | 浏览器中的 GPU 对拍页要用它，而 `tools/` 只在 Node 中运行（TypeScript.md 第 4 节） |
| 拆分或归档维护记录（约 950 行） | AGENTS.md 指定它是记录修改差异的唯一位置 |
| 给输入接入、输出接入、thread、生命周期模块预留目录或接口 | 这些模块的规则尚未定义（JKRD7 §9.3）；不从代码补规则 |
| 统一执行器入口（C4） | 两个后端出错时交回结果的方式不同（C3，延后处理区），统一入口要先定这一点（§6.3） |
| 大幅拆分 `scene/view.ts`（约 1100 行）、`ui/cosmic-workspace.ts`（约 840 行） | 场景层没有单元测试，只有整页验收；审计认为各只有一个清楚的拆分点（信号动画层、外观面板），已记入 §5 |

## 4. 已执行的改动

每项列出依据与验证。

### 4.1 规则模型与两个后端（`src/`）

| 编号 | 改动 | 依据 | 验证 |
| --- | --- | --- | --- |
| A1 | **bit 按 JSON 原文核对**（原 R6）。新增 `parseJson`：值等于 0 或 1、原文却不是 `0`、`1` 的数（`1.0`、`1e0`、`-0`）换成原文字符串，后面的检查按“不是 bit”拒绝。命令行读文件、正文 JSON 块、GPU 对拍页、展示页的三处模型入口都改走它 | 用户 2026-11-09 已定从严；JKRD7 §2 第 2 条 | 新增原文案例 5 例；快照中写成 `1.0` 的 q 被拒绝 |
| A2 | **快照检查补全**（原 R4、C1）。`snapshot` 须为非空字符串；`jkm` 须与模型对应（原来两个后端各查一遍，现在只在 `checkSnapshot` 中查）；`trigger_all`、`rounds` 须为对象；事务任务的前置须是本次前置 | JKRD7 §9.5（“本次前置”）、§5.3 | 探针：改前 7 种不合法快照被接受，改后都拒绝；新增快照案例 25 例；GPU 从快照继续的对拍照常通过 |
| A3 | `Model.derive()` 拆成 `indexMembers`、`resolveRefs`、`indexRegistrations`、`checkEntries`、`checkInput`、`indexSubscribers`、`checkLoops`，顺序与错误信息不变；“trigger.any 为空”的判定收成 `isOpenEntry`；去掉一处多余的条件 | 代码自洽 | 静态检查的 77 个负例、8 个正例结果不变 |
| A4 | 正文 JSON 块的提取与 JKM 的排版移到新文件 `src/doc.ts`；第 10 节的模型名单 `DOC_MODELS` 只在这里写一次（原来在 4 个文件各写一份） | model.ts 的文件头写明它是规则模型 | 类型检查；`web/show/examples.json` 逐字节不变 |
| A5 | `Fifo.push` 只接受一项（原用展开语法）；删除只用一次的 `abs()`；快照版本用常量 `VERSION` | 原 C2：确认全仓库没有一次追加多项的调用 | CPU 验收 26/26 |
| A6 | `src/executor.ts` 删除没有使用者的 `Backend`、`RunResult`；文件头改为实际内容 | 机械扫描 | 类型检查 |
| A7 | GPU 主机端：解码用 `NODE_BITS`、`F_ALL` 代替字面量；实例数组与模型各段不再用展开语法（原 C7），模型缓冲区用 `Uint32Array.set` 写入；删除只写不读的 `GpuExecutor.source`；改正 compile.ts 文件头引用的章节号 | WebGPU.md §4、§5；README C7 | GPU 对拍 6/6，含 16384 个实例的吞吐参考 |
| A8 | 测试夹具：`syncInput` 从 static.ts 移到 fixtures.ts（原来被 fixtures.ts 与 cases.ts 反向引用）；static.ts 复用 `jkm`、`jks`；`same()` 去掉 `as never` | 依赖方向 | 类型检查；案例数量不变 |

### 4.2 命令行与工程（`tools/`、配置）

| 编号 | 改动 | 依据 | 验证 |
| --- | --- | --- | --- |
| B1 | `tools/common.ts` 新增 `parseArgs`（原来 reference.ts、gpu.ts、show.ts 各写一份）与 `writeReport`（原来四个工具各自拼装报告）；`DOC`、`ASCII_MODEL` 改为相对仓库根目录的路径，调用处不再混用 `rel()`；`readJson` 改用 `parseJson` | 重复 | 试用 `--script`、`--model --inject`、未知参数、缺少参数值，行为与原来相同 |
| B2 | reference.ts 去掉无人导入的导出与 `import.meta.main` 判断；serve.ts 用 `parseArgs` | 机械扫描 | 同上 |
| B3 | `web/gpu.ts` 的运行脚本任务改用 `scriptModel`，与 CPU 后端做同样的模型与运行脚本检查 | JKRD7 §9.4 | 类型检查；GPU 对拍通过 |
| B4 | reference 报告的说明把 “nested transactions executed in place” 改为 “executed layer by layer” | JKRD7 §6.3 | — |
| B5 | `.gitignore` 删除 Python 条目；`jk.config.json` 补 `src/doc.ts` 与 `ultra.md` | TypeScript.md 第 7 节（Python 工具已删除） | 静态检查的索引项通过 |

### 4.3 展示页（`web/show/`）

| 编号 | 改动 | 依据 | 验证 |
| --- | --- | --- | --- |
| C1 | **样式表**：删除 133 条永远匹配不到的规则（约 641 行）、13 处选择器列表中的死选择器、6 个无人使用的自定义属性、3 个变空的 @media。`style.css` 2014 行减到 1363 行。这些规则的选择器含有 HTML 与全部脚本中都不存在的类或 id，是移植时留下的（模型池、鉴权对话框、旧布局、旧的图片输入对话框） | 机械扫描，界面层审计抽查 60 多个类名与 17 个 id | 清理后复扫为 0；浏览器中 1404 个元素的计算样式与清理前一致；展示页验收 17/17 |
| C2 | `index.html`：删除无人使用的模板 `row-template`、恒隐藏的 `#model-errors`、无人读取的 6 个 data- 属性；三个没有可聚焦内容的标签面板加 `tabindex="0"`；输入框去掉盖住可见标签的 aria-label；`#input-buttons` 加 `role="group"` | 界面层审计；tabs 与 accessibility 指南 | 展示页验收 |
| C3 | **界面写法**：连线图例的颜色改为设置 CSS 变量 `--legend-color`，样式写在 cosmic.css；触发组下拉项改为复制 `option-template` | TypeScript.md 第 4 节 | 浏览器中 5 个图例色块颜色正确 |
| C4 | **死代码**：`CosmicWorkspace.setActive` 与恒为真的 `active`；只写不读的 `data-window-gesture`、`--cosmic-rail-bg`；`NetworkView.setAnimationEnabled`、`motionEnabled`、`playback.running`；`CanvasRenderer.isCanvasRenderer`；永不执行的节点图例循环；配置项 `model.version`、`engine.backend`、`geometry.baseWidth`、`theme.rail`、`software.edgeColors`；类型 `AppConfig`、`RenderScheduleSettings` | 机械扫描与两份审计 | 类型检查；展示页验收 |
| C5 | **展示投影与布局**：删除恒为空或无人读取的 `DisplayNode.errors`、`initial`，`DisplayOutput.error`、`category`，`DisplayModel.inputs`、`name`，以及随之走不到的“X 类型节点”分支；布局结果收窄为 positions、mode、bounds、requestedMode，删除 7 个只写不读的字段。非自动布局原来每次白算一遍可读性评分，现在只在自动选择时计算 | 场景层审计 F2、F3、F6 | 19 个模型 × 7 种布局的坐标与包围盒逐位不变 |
| C6 | **缺陷**：`NetworkView.recover()` 可以重入，连点“重试”会留下一套没有释放的渲染器、画布、控件与 ResizeObserver。改为逐个重建，并在重建途中页面关闭时释放 | 场景层审计 F1 | 展示页验收（含 Canvas 2D 降级再恢复） |
| C7 | **重复**：`setText`、`pretty` 从 main.ts、panels.ts 移到 ui/dom.ts；观察点键名 `observe:路径` 的拼接与拆解集中到 `observeKey`、`observedPath` | 重复 | 类型检查；展示页验收 |

### 4.4 文档

| 文件 | 改动 |
| --- | --- |
| JKRD7.md | §9.5 写明事务任务的本次前置；§11.1 补展示页验收与第四份报告；§11.2 补 bit 原文与快照格式两项静态案例；开头的状态加一句。差异见维护记录 |
| README.md | 阅读入口加本文；检查数量改为现值；待处理事项移除 R6、R4、C1、C7（已处理）与 R3、C2（已失效）；C4 的现状更新。差异见维护记录 |
| WebGPU.md | 修好 §6.4 的错误码表；§7、§8 改为现行做法；§9 的 72 条、55 次改为 96 条、45 次（取自 reports/gpu-run.json） |
| TypeScript.md | 目录树与对应表补 `doc.ts`、`common.ts`；`npm install` 的说明；“三项核对”改为“四项核对” |
| docs/web-show.md | 第 7 节列全三个存储键，注明脚本自己创建的两类元素（import map 脚本、渲染用的 canvas）；第 8 节加一行指向本文 |
| docs/jkrd7-maintenance.md | 新增 2026-11-11 一条 |

## 5. 已确认、尚未执行的事项

都经过核对，没有执行的原因写在后面。本节已按 2026-11-11 晚的现状更新：展示页的各项已执行，快照的各项已移到 [snapshot/Snapshot.md](snapshot/Snapshot.md) 第 6 节。

**规则与执行器**

| 事项 | 没有执行的原因 |
| --- | --- |
| 运行脚本 `run` 的名称：代码按“非空字符串”检查，JKRD7 §9.4 只写“名称” | 规则文字要不要补上类型，由用户决定 |
| C3（两个后端的上限不一致）、C6（GPU 容量估计） | 在延后处理区，用户 2026-11-09 的决定 |
| `parseJson` 靠 JSON.parse 交给 reviver 的原文（Node 22、Chrome 114 起）；没有这一功能的浏览器里照常解析，但不做原文检查 | 项目只在 Node 26 与本机 Chrome 上核对；其他浏览器属于 V2 |
| 只在文件内使用、却带 `export` 的符号（约 70 个，多为类型） | 无害；逐个去掉只增加改动量 |
| `.claude/launch.json` 含本机的 Node 绝对路径 | 预览工具需要；换成 `node` 取决于桌面应用的 PATH，没有验证 |

**展示页**

原列的场景层 9 项与界面层 4 项，用户 2026-11-11 逐项批准后都已执行，见[维护记录](docs/jkrd7-maintenance.md)“展示页的待处理项（GPU 结果、环与退出节点、批执行）与清理”一条。其中三项原来要用户决定，决定是：“次数超过 1000 变红”保留并写进配置与文档；品牌文字改成 h1；连线摆动跟随系统的“减少动态效果”。

## 6. 下一步的设计方向与规划

### 6.1 先后

| 阶段 | 内容 | 开工条件 | 验收 |
| --- | --- | --- | --- |
| 1 | **工厂模块按本版语义重新设计**（JKRD7 §9.3 第 3 项，README 待处理区第 1 项） | §6.2 的问题有了决定 | 工厂与 RAM 写成合法的 JKM，通过静态检查；两个后端的执行记录逐字节相同；附录与 factory-pending.md 改写 |
| 2 | **执行器统一入口**（C4），同时统一两个后端的上限与出错信息（C3） | §6.3 的问题有了决定 | `runScript` 与命令行 `--backend`；同一个不终止的模型，两个后端交回相同的记录与错误 |
| 3 | **GPU 第 3、4 阶段**：实例内并行（波次投递、任务批）；只写 output 记录、q 按位打包、按模型估计容量（C6） | 阶段 2 之后 | 执行记录仍与 CPU 逐字节相同；随机模型先扩充（V1） |
| 4 | **展示页**：显示 GPU 结果；退出节点与环的可视化；§7.5 批执行的显示；§5 中的清理 | — | **已于 2026-11-11 完成**，展示页验收增到 18 个案例，另有界面单元测试 7 项 |
| 延后 | 多 thread 调度（§9.3 第 1 项）；V1—V4；快照模块的各项（不属于主要路线，见 snapshot/Snapshot.md 第 6 节） | 用户 2026-11-09、2026-11-11 的决定 | — |

本次整理是阶段 1 的准备：静态检查入口唯一（工厂生成的模型走同一套检查）；快照检查完整（工厂的事务交接要靠它）；第 10 节的模型名单只有一处（新增示例只改一处）。

### 6.2 工厂模块重新设计前要决定的问题

依据是 [factory-pending.md](docs/modules/factory-pending.md) 与 JKRD7 第 3—8 节。这里只提问题，不给答案。

1. **输入怎样编码。** 通知不携带值（§4.2），输入值要用独热入口表达（§9.1）。原来的六位 b0—b5 各有 0、1 两个取值：是不是每位设“置 0”“置 1”两个入口？原来的五个“有效标志”还要不要？
2. **节点的配置位怎样重排。** 原来的 b0、b1 在“生成 q 还是 seed”之间二选一。现行每个 JKI 都有 q 初值，seed 可有可无，触发方式有 any、all 两种（§3）。工厂要表达哪些：q 初值、seed 的有无与取值、触发方式、七种 publish？
3. **清空与上升沿用什么结构表达。** 原协议是“b5=0 清空，b5 从 0 到 1 且五位齐备才创建”。现行规则只有登记、连接与 publish。这一段用哪种登记（transaction、transaction_any、all）和哪种 publish（如 one_changed）来组合？
4. **成员怎样放置。** 原附件让 F1.WRITE0—4、F1.CONTROL 用成员 ID 重复引用 Q1—Q10。现行 members 是完整对象，同一份 JSON 放两处就是两个节点（§5.1）。这些共用的节点放在哪个 JKS 里，其余结构用绝对路径引用？
5. **拒绝与失败怎样表达。** 现行事务不设失败，也不回滚（§6.2）。原协议里的“输入未齐时拒绝”“父安装失败时保留草稿”改成什么？
6. **生命周期模块的边界。** 创建、改接、删除节点，编号怎样分配、删除后是否复用（§8.1），哪些任务不处理（§6.5），JKRD7 都交给生命周期模块，而这个模块还没有定义。工厂“生成并安装节点”要靠它。先定生命周期模块，还是把工厂限定为“只生成 JKM 文本，不在运行中安装”？
7. **草稿的地位。** 原方案把 `trigger={}` 的节点当作待配置的草稿。现行 JKI 的 trigger 必须恰好有 any 或 all 一个键（§3）。草稿放在模型之外，还是需要新的规则？
8. **环与退出节点。** 工厂与 RAM 里的回路（重发、回收、ACK）都要登记退出节点（§6.4），并且不能是纯通知环。各个环的退出节点是哪一个？
9. **编号与登记。** F1、R1、RAM1、F1.WRITE0 等要改成 G＋编号（§5.1）；模型要补 input、output（§8.1）。RAM 的帧宽 1—8、每块 8 槽是模块配置，写在哪里？
10. **验收范围。** 完整动态 RAM 的展开、ACK 交错、恢复，原文都标为未验证。重新设计后，哪些进入 §11.2 的验收案例？

### 6.3 其余需要用户决定的问题

1. **C4 与 C3**：统一入口出错时怎样交回结果。CPU 现在抛出异常，记录留在执行器上；GPU 交回 `{records, error, snapshot}`。统一成后一种，还是保留抛出？每批的上限用处理单元还是微步计数，默认值取多少？
2. **名称的类型**：JKRD7 §9.4 的 `run` 要不要写明“非空字符串”（代码已这样检查）？

原第 3—5 项（“超过 1000 变红”、页面标题、减少动态效果）已有决定并执行，见第 5 节。

## 7. 核对

### 7.1 检查命令

| 命令 | 整理前 | 整理后 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 通过 |
| `node tools/validate.ts` | 105/105（负例 77、正例 8） | 135/135（负例 77、正例 8、原文 5、快照 25） |
| `node tools/reference.ts` | 26/26 | 26/26 |
| `node tools/gpu.ts` | 6/6 | 6/6 |
| `node tools/show.ts` | 17/17（WebGPU 渲染） | 17/17（WebGPU 渲染） |

上表是本次整理结束时的数字。之后展示页验收增到 18/18，并新增 `npm run test:ui`（7 项）。

四份报告已用 `--write-report` 重新生成。这些检查通过，只说明在本机已核对的范围内（Chrome 157，Apple GPU），两个后端和展示页与规则一致；不说明恢复流程、多 thread 调度、其他浏览器或其他 GPU 已经验证。

另外做过的核对：

- 布局：19 个模型（7 个内置示例与 12 个随机模型）× 7 种布局（含临时布局）的坐标与包围盒，改动前后逐位相同。
- 样式：浏览器中 1404 个元素的计算样式，清理前后一致（只少了 6 个无人使用的自定义属性）。
- 批执行模式：300 个随机模型在事务步数上限为 3 时，批模式与串行的记录、停下的位置、q 都相同（43 个触发上限）。
- 内置示例文件 `web/show/examples.json` 逐字节不变。

### 7.2 对本次改动的复核

原计划用两个代理独立复核（核心与工具一名，展示页与文档一名）。工作流启动后即因用量上限中断，没有产出。所以本次改动**没有经过独立复核**，只有主会话自己做的下列核对：

| 核对 | 结果 |
| --- | --- |
| 新旧两版 `src/model.ts` 对同一批模型给出的错误：8 个正例、77 个负例、300 个随机改坏的模型 | 385 个模型的 errors 数组逐条相同（`derive()` 的拆分没有改变检查） |
| `parseJson` 对各种写法：`1`、`0`、`1.0`、`0.0`、`1e0`、`-0`、`10`、`2`、`0.5`、`"1"`、`true`、`null`、嵌套数组、含字符串与大数的对象 | 只有值为 0 或 1、原文不是 `0`、`1` 的数被换成原文字符串；其余不变 |
| 快照检查：改前接受的 7 种不合法快照 | 改后都拒绝；JKRD7 §9.5 的示例快照与两个后端自己导出的快照照常通过 |
| 命令行：`--script`、`--model --inject 多个值`、未知参数、缺少参数值 | 与改前相同 |
| 布局、样式、批执行模式 | 见 §7.1 |

没有覆盖到的：展示页在双板、全屏等各种窗口状态下的人工目测（样式比对只在默认状态下做，依据是被删规则的类名与 id 在任何状态下都不存在）；Canvas 2D 渲染下的目测；其他浏览器。建议提交前由用户在浏览器里看一遍展示页，或在用量恢复后再跑一次独立复核。

之后的情况：用户复核了本次整理与展示页的改动，提出并批准 6 项改进与 8 个决定，见维护记录“展示页复核后的改进与决定”一条。`src/`、`tools/` 的改动仍只有上表的自查，没有独立复核的记录。

## 8. 改动的文件

- **新增**：`src/doc.ts`、`ultra.md`。
- **规则与执行**：`src/model.ts`、`src/cpu.ts`、`src/executor.ts`、`src/gpu/backend.ts`、`src/gpu/compile.ts`。
- **测试夹具**：`src/testing/static.ts`、`fixtures.ts`、`cases.ts`、`gpu-cases.ts`。
- **命令行**：`tools/common.ts`、`validate.ts`、`reference.ts`、`gpu.ts`、`show.ts`、`serve.ts`、`examples.ts`、`chrome.ts`。
- **页面**：`web/gpu.ts`；`web/show/` 下的 `main.ts`、`panels.ts`、`session.ts`、`config.ts`、`verify.ts`、`index.html`、`style.css`、`cosmic.css`、`scene/view.ts`、`scene/layout.ts`、`scene/model-view.ts`、`scene/canvas-renderer.ts`、`ui/cosmic-workspace.ts`、`ui/network-style-panel.ts`、`ui/output-choices.ts`、`ui/tabs.ts`、`ui/dom.ts`。
- **文档与配置**：`JKRD7.md`、`README.md`、`TypeScript.md`、`WebGPU.md`、`docs/web-show.md`、`docs/jkrd7-maintenance.md`、`jk.config.json`、`.gitignore`。
- **报告**：`reports/` 下四份。

没有提交，也没有推送；改动都在工作区。

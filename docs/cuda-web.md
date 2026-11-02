# JK CUDA 实时 Web 控制台

控制台读取当前 `jkcuda.v6.1` 实例的真实状态，并通过运行时接口控制执行。浏览器不计算 EX、不模拟 FIFO，也不生成替代运行数据。已安装模型对应独立 V6.1 运行 profile；新增工厂定义视图依据 [JKRD7 7.0.0](../JKRD7.md#13-jkifactory-与-ramfactory-的-jks-设计)，不把定义混作已安装运行状态。

## 启动

在仓库根目录运行（Python 3.9+；原生后端需要 C++ 编译器，无新增 Python/Node 依赖）：

```sh
python3 -m jkcuda serve examples/cuda/business.json --device native-cpu
```

打开终端打印的 `http://127.0.0.1:8765`。`business.json` 支持宽度 1 和 9 的帧，分别具有独立累计异或状态。基础任务/KEYED 示例可改用 `examples/cuda/xor.json`，单独帧存储示例可用 `examples/cuda/frames.json`。启动后暂停，只有明确发送输入、执行命令才推进。

在有 NVIDIA GPU、CUDA Toolkit 和 CUDA 版 PyTorch 的机器上：

```sh
python3 -m jkcuda serve examples/cuda/business.json --device cuda
```

显式请求 CUDA 时，环境不可用会报错，不回退 CPU。当前本机验证使用 `native-cpu`，不能证明 CUDA 编译、同步或性能正确。服务只绑定 loopback；访问远端 GPU 主机可使用同端口 SSH 转发，例如 `ssh -L 8765:127.0.0.1:8765 GPU_HOST`。

可用参数：`--port`、`--host 127.0.0.1|localhost`、`--work-slice`、`--propagation serial|parallel`、`--wal`。停止服务使用 Ctrl+C。已有程序可使用 `jkcuda.webserver.create_server(runtime, port=8765)` 并在独立线程调用 `serve_forever()`；关闭时调用 `shutdown()`、`server_close()`，Runtime 的生命周期仍由原程序持有。嵌入方式应让控制台独占推进命令，避免另一个线程同时主动调用 `run/step`。

## 页面与操作

- **全局结构与运行流程**：接入、模型、任务 FIFO、唯一活动任务、EX/提交、事件传播、触发匹配、任务入队和宿主输出。
- **双队列闭环**：任务执行与事件传播是围绕同一活动任务协作的两类职责。task_queue 可包含多条模型 FIFO；event_queue 只展示当前活动任务尚未完成的事件。事件历史总量单独统计。
- **完整模型运行结构图**：显示已安装模型的全部普通节点和订阅，按实际依赖分层，环按强连通分量归组。业务模型包括输入、PRE、S/C、GO、COMP、COMMIT、POST/NEXT、FINISH、存储与输出；运行时控制任务类型、宿主操作和存储对象使用不同样式。控制生成连线注明条件，ACK 重发／消费和下一帧领取作为反馈关系显示，不伪装为普通订阅或同步调用。搜索用于定位，不删除未匹配结构。
- **模型 JSON**：显示 `/api/model` 返回的当前已安装模型原始 JSON 文本，支持展开、复制与下载，保留 int64 数字字面值，不受图中搜索影响。它是模型定义，实时状态和可恢复快照各有独立含义。
- **JKRD7 工厂结构**：在结构图内切换“JKRD7 · 工厂结构”，直接读取 `assets/jks-factory-v7-design/` 的原始 JSON。F1 是 JKI.FACTORY 子 JKS，R1 是包含 F1／RAM1 的 RAM.FACTORY。支持闭环总览、F1内部、RAM内部及全部成员／操作，纵向或横向依赖分层、成员层级展开、搜索定位、来源绑定查看和定义JSON复制／下载。q／seed 明确标为初始化定义；不匹配同名 V6.1 节点统计，也不提供模拟工厂执行。使用 `/?view=factory#topology` 可直接打开该视图。
- **数据桶与统计**：显示按真实次序排列的任务、传播事件、未配齐 token、帧与 PRE/POST 值、状态槽、输出、容量及预留记录。0 是有效值；KEYED 的整型 key 与字符串 key 分开；ZIP 保持每来源 FIFO，ALL_LATEST 显示每来源最新值，二者不按 key 分桶。
- **流程控制**：连续运行、暂停、完整任务单步、内部工作单步，以及慢速工作推进。内部一步是原生状态机工作单位，可能是阶段或传播分块，不是单条 J/K 指令。完整任务单步包括其传播完成；普通暂停在完整任务边界生效。资源等待/故障保留活动现场，需补容量/预算或显式重试。
- **输出协议**：观察输出不建立 ACK 资格。点击“接收输出”后，运行时才登记 FRAME_COMPLETE；再执行该任务建立资格。ACK0 重发、ACK1 消费，均经过 DEC/ACT。`ack_output` 仅确认应用交付，与帧业务 ACK 分开。

推荐业务检查顺序：发送一帧 `[1]` → 运行 → 查看 POST 和输出 → 接收输出 → 运行 FRAME_COMPLETE → ACK0 → 运行 → 接收重发 → 运行 → ACK1 → 运行。需要观察中间步骤时使用工作单步或慢速工作推进。

## 观察与控制接口

`Runtime.observe(since_trace=0, limit=200, include_model=False)` 在同一运行时/核心锁内复制已同步宿主镜像，返回 `jkcuda.observe/1`：状态、FIFO、活动任务、事件、token、存储、输出、帧和轨迹页。`since_trace` 是已读取的一起始轨迹序号，0 从头读取，`None` 读取末尾窗口。`Runtime.step_work(max_work=1)` 有界推进，最多完成一个任务，允许保留任务内部现场；已有推进时拒绝并发调用。

| HTTP 接口 | 用途 |
| --- | --- |
| `GET /api/model` | 已安装模型和版本；`model_json` 为保留数字字面值的完整 JSON 文本 |
| `GET /api/factory-design` | JKRD7工厂静态定义及精确原文；execution_status=definition-only，不安装模型、不读取或改变执行现场 |
| `GET /api/state?after=0&limit=200` | 一致观察视图；省略 after 获取最新轨迹窗口 |
| `GET /api/stream` | SSE `state` 事件，共享采样默认每 200ms 一次 |
| `GET /api/trace?after=0&limit=200` | 按序号读取轨迹页 |
| `GET /api/inspection` | 带模型的有界观察 JSON；不是可恢复快照 |
| `GET /api/session` | 当前本地页面的命令 token |
| `POST /api/command` | `{action, request_id, payload}`，通过 `X-JK-Token` 提交 |
| `GET /api/commands/<request_id>` | queued/running/completed/failed 与结果 |

命令支持 `run`、`pause`、`step`、`step_work`、`send`、`submit_frame`、`receive_outputs`、`ack_frame`、`ack_output`、`grow`、`resume_budget`、`retry_failed`。重复 request_id 与同载荷返回原命令，异载荷拒绝；执行中拒绝重复推进命令，输入/接收/资源操作独立接纳。运行限制按完整任务数计算，队列排空、预算/资源阻塞、故障或暂停时停止。后续新输入不会自动启动已停止的运行。

SSE 给出最新有界观察窗口；高速运行可能越过中间阶段，页面只呈现实际观测或轨迹。需要完整历史时使用轨迹分页；浏览器动画和刷新不参与运行时调度。每个列表都有数量/截断提示。`task_activity` 从完整已保留任务表统计各普通节点、控制任务类型的累计、等待、活动与完成任务，不用有界 FIFO 列表推算总数；控制类型代表可重复生成的任务类别，并非模型节点。JSON 中超出 JavaScript 精确范围的整数以十进制字符串传输，key_type 保留业务 key 类型。断线重连只恢复观察，不自动重发命令。浏览器断开不会自动暂停运行。

节点活动统计按逻辑 ID 汇总全部已保留世代，`scope=logical_id_all_generations`，同时给出当前安装世代和程序版本。控制统计按类型汇总全部帧。事务内部步骤不重复计为独立节点任务；业务节点的帧身份沿真实 CLAIM 因果链读取，ACK_DEC 尚未绑定帧时不补造帧身份。

更新观察服务代码后，应重启原 `serve` 进程再刷新页面。旧进程不会自动加载新增观察字段和静态模块路由；缺少活动统计时显示未知，不能据此将未知状态显示为零。

工厂模块在选择定义视图时才加载；旧服务缺少新接口时给出重启提示，不阻断已有实时视图。定义文件从本仓库 assets 读取，图与 JSON 共用这份来源；“重新读取定义”不会推进执行器。

## 语义依据与验证

| 来源 | 预期行为 | 实现位置 | 验证依据 |
| --- | --- | --- | --- |
| V6.1 Q01、N04 | 唯一活动任务；传播结束后才能重新选 FIFO | 原生 core/propagation；Runtime.step_work；WebController | 完整任务与内部工作推进轨迹相同，并对照独立 Reference；暂停反例 |
| V6.1 Q02 | 多 FIFO 属于 task_queue；event_queue 属于当前任务 | inspection 的任务链、事件范围/游标读取 | A 完成后保留 B 与等待 token；B 传播只形成 xor 任务 |
| V6.1 N02、N03 | 输入先入队；0 有效；KEYED 按类型和值分桶 | 原运行时接入/匹配，inspection 只解码 | 0 值与整数/字符串 key 反例 |
| V6.1 S02、S03 | 接收事实经 FRAME_COMPLETE；ACK 译码/动作分开 | 显式 receive_outputs/ack_frame 命令 | 观察前后完整现场不变，接收才出现完成控制任务，ACK0 载荷一致 |
| V6.1 S01 及当前 business 构造契约 | PRE／COMP／POST 等是普通 JK 节点；FINISH 提交后生成 STORE，待领取帧存在时另生成 CLAIM | business.py 的真实订阅、native/frames.hpp 的控制生成，web/graph.mjs 的类型与依赖 | 独立图依赖断言、普通节点与控制角色数量核对、实时任务统计测试 |
| V6.1 Q03 与当前保留历史实现 | pending、历史占用、预留信用分开 | inspection.storage 和三个数据桶 | 队列排空但历史记录继续占容量 |

针对性测试：

```sh
python3 -m unittest tests.test_observation tests.test_web_server tests.test_runtime tests.test_frame_runtime -v
```

观察测试禁止初始化帧模块、上传、下载、日志写入和输出接收；HTTP 测试覆盖只读查询、SSE 重连、命令幂等、并发推进拒绝、完整边界暂停与输入错误。浏览器交互验证与真实 CUDA 验收需分别记录，页面可用不等于 GPU 已验证。

本次本机验收（2026-10-28）：上面的 43 项 Python 相关测试通过；前端 25 项独立展示断言与 JS 语法检查通过。浏览器实测了帧接纳、阶段推进、完整边界暂停、PRE/COMP/POST、显式接收及 FRAME_COMPLETE、ACK0 保留载荷并输出 marker=0、ACK1 消费；W=9 输入显示到达 9/9、输出宽度 1。另检查节点搜索/详情、历史轨迹、桌面与 390px 窄屏布局，测试页面没有控制台警告或错误。未执行全流程回归；本机 Darwin arm64 未安装 PyTorch，未进行 CUDA/GPU 验收。

结构图升级验收（2026-10-29）：50 项 Python 相关测试通过；完整图独立断言覆盖 28 个普通节点、50 条真实订阅、7 类控制任务、18 个依赖层、121 节点不截断、SCC 和条件反馈；原 25 项展示断言与 JS 语法检查通过。浏览器以独立 native-cpu 实例核对排队/活动/完成状态、W=9 的 COMP 锁存参数与 frame ID、FRAME_COMPLETE 排队期间无资格、ACK0 重发 marker=0 和 ACK1 消费。搜索不删除普通节点，也不改变 JSON；展开、复制、下载可用，下载解析结果等于当前已安装模型，int64 原文字面值另由 HTTP 测试覆盖。桌面与 390px 布局通过，浏览器无警告或错误。现有用户服务未重启；本轮未做 CUDA/GPU 验收。

图与 JSON 的前端检查：

```sh
node jkcuda/web/graph.test.mjs
node jkcuda/web/state.test.mjs
node jkcuda/web/factory.test.mjs
```

2026-10-31 工厂更新验收：14项 Web 控制／HTTP 测试通过，包含定义接口精确原文、同源限制、读取前后执行现场与已安装模型不变；工厂图独立断言覆盖 F1/R1 嵌套、全部65个静态JKI、22个JKS、提交后阶段连接、ACK独立输入、反馈排除分层、纵向布局及与真实活动统计隔离，原实时图和展示辅助断言仍通过。浏览器检查工厂／RAM／全部视图、Q12上升沿详情、搜索保留全部节点及JSON、来源和布局切换、剪贴板／下载、实时视图回切；下载与原文件逐字节一致，390px窄屏无页面横向溢出。浏览器无警告或错误。动态槽展开后的引用与DAG、工厂执行、并发恢复及CUDA仍未由这些检查验证。

当前限制：采样读取最后一次有界推进同步的宿主镜像，不在 kernel 执行过程中探测设备内存；现有 CUDA advance 本身仍同步完整 arena。历史任务、token 和帧计数扫描随历史增长，5Hz 刷新和工作单步会增加调试开销。图表中的吞吐是观察窗口的完成任务率，含宿主/调试开销；没有采集 GPU 利用率或真实阶段耗时。通用物理 GC、多 block 传播和硬件性能验收仍沿用运行时原有限制；此控制台不新增它们。

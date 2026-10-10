# JK_NET 模型配置与初始化

当前维护范围（2026-10-02）：两个 3D 渲染图，以及 `model.configure`、`model.initial`、`initialization.plan` 三个接口服务及其相关模块。

规则和设计以 [JK 空间](https://chatgpt.com/space/page_6abc4b5e3dd88191a1d99ee9d2d4255f) 的 [JK规则与设计](https://chatgpt.com/space/page_1cee9c7aae188191be3608cbf94fb889) 为主。当前实现依据本次读取的第 89 版。历史设计材料与当前产品范围分开理解。

## 启动

```sh
python -m pip install -e '.[dev]'
jk-net-service --host 127.0.0.1 --port 8000
```

用 Chrome 打开 <http://127.0.0.1:8000>。项目运行依赖为 FastAPI、Uvicorn 和 Pydantic，已移除训练框架依赖及演示 CLI。

## 三个接口

统一调用入口为 `POST /api/functions/{function_id}/run`，请求体是 `{"input": {...}, "context": {...}}`。返回 `result`、`context_patch` 和执行时间；后续调用应将 `context_patch` 合并到自己的上下文。网页在当前会话中自动处理该上下文。

| 接口 | 输入与职责 | 主要输出 |
| --- | --- | --- |
| `model.configure` | 校验输入/输出位数、节点上限、1–5 维布局、种子和永久模型池引用 | `model_config` |
| `model.initial` | 使用配置和 seed 生成可复现的初始 JK 结构 | 严格 `structure_snapshot`，自动保存到临时快照池 |
| `initialization.plan` | 将永久快照引用解析为有序模型池计划；重复引用保留独立位置 | `initialization`、`jk_group_pond`、更新后的 `model_config` |

配置默认值集中在 `src/jk_net/service/functions.py` 的 `MODEL_DEFAULTS` 树形对象，网页从接口目录读取默认输入：

```json
{
  "input_bits": 8,
  "jk_bits_max": 24,
  "output_bits": 8,
  "jk_group_pond": [],
  "layout_dimension": 1,
  "seed": 0
}
```

X/Y 最多 216 位，节点上限配置为 1–512。`lr` 等训练字段已移除。初始化请求默认为 `{"name":"initial-model"}`；也可通过 `model_config` 显式传入完整配置。相同配置和 seed 生成相同结构与哈希，但各快照具有独立创建时间。

模型池请求示例：

```json
{
  "strategy": "from_snapshots",
  "snapshots": [{"name": "my-model", "md5": "已有永久快照的32位md5"}]
}
```

省略 `snapshots` 时使用上下文模型池或永久目录；显式传入 `[]` 清空计划。模型必须先通过真实结构图的“入池”进入永久池；引用按 `name`、`md5` 匹配，缺失或歧义均报错。计划保留重复引用，不按哈希去重。该接口生成计划；`model.initial` 生成配置规定的主结构，不执行池模型或训练任务。

## 两个 3D 图

- **概念层级图**：显示配置中的 X/Q/Y 数量与布局，连线表示概念上的结构关系。
- **真实结构快照图**：按照实际 EX 和 `q_y` 建立连线，区分有状态与无状态 Q。可旋转、缩放、重置、全屏、选择节点及编辑 EX、状态初值、传播条件和输出绑定。

右侧图保留快照选取、入池、重命名、删除和复制。状态和传播条件编辑经过后端严格校验，失败不会覆盖已保存快照。连线动画用于展示结构关系；数据发送、验证和训练入口已删除。

HTML 中声明页面、表单和选项模板，CSS 独立维护样式。JavaScript 绑定交互、填充模板数据和绘制 Canvas，不拼接 HTML 或生成 CSS。前端默认视角与节点规则集中在 `MODEL_RULE_CONFIG`，布局算法位于 `jk_net_layout.js`。

## 模型只包含三类节点标记：

- `X0..Xn`：输入位。
- `Q0..Qn`：JK 节点。
- `Y0..Yn`：通过 `q_y` 引用 Q 的输出位。

J 为 `q AND x`，K 为 `q XOR x`；EX 从左向右原子执行。每个 EX 必须非空并引用至少一个 Xi 或 Qi。纯字面量 `J0`、`J0K1`、`K1` 不能单独作为节点。

节点的三个分支分别负责：**状态**保存 q 及下次执行起点；**EX**计算本次 q；**事件**确定何时执行及完成后是否传播。

`initial_q` 成员身份是状态分类的唯一依据。有状态节点允许 EX 以 `J0` 开头；未声明的无状态节点必须以 `J0` 开头。初始化、恢复和读取都不额外执行 EX 或发布事件。

| 传播条件 | 完整 EX 提交 q 后的行为 |
| --- | --- |
| `q=0/1` | 默认，每次完成都传播，相同值也传播 |
| `q=0` | 最终 q 为 0 时传播 |
| `q=1` | 最终 q 为 1 时传播 |
| `q=` | 永不传播，仅有状态节点可用 |

本项目以可选顶层 `publication` 映射保存传播条件。默认条目省略，非默认条目同时纳入 `md5` 和 `format_md5`；默认模型保持原哈希载荷。该字段是 JK_NET 的实现编码，统一格式仍以空间后续规定为准。

保留的 `JKGroup` 核心按来源事件 FIFO 执行：无无状态来源的目标由每个来源事件触发；有无状态来源时，仅对这些来源做 AND 到齐等待。无状态链接保存本次事件数据，同来源重复到达覆盖槽位；有状态来源始终读取最新 q，旧通知不能回滚当前状态。EX 提交后才筛选传播，已入队事件不再筛选。

快照保存结构与有状态 q，不保存输入寄存器、未消费的链接到达槽或事件队列。`q_y` 是当前输出映射，不是事件历史。

## 文件与接口边界

```text
src/jk_net/
├── group.py              JK 规则、快照校验与基础执行
├── json_format.py        JSON 排版
└── service/
    ├── functions.py      三个服务及配置/模型池辅助逻辑
    ├── registry.py       显式接口注册与 schema 校验
    ├── store.py          SnapshotStore 快照持久化
    └── api.py            HTTP 调用及 3D 快照编辑支持
html/
├── jk_net.html/css/js
├── jk_net_layout.js
└── JKS.json
```

除三个业务服务外，HTTP 保留健康检查、接口发现、页面资源及 3D 图所需的快照 CRUD 路由。旧训练、数据生成、编码、验证、优化、卷积、动态网络、冻结编译、工作流编排和后台任务模块及入口已删除。

当前范围不实现动态等待区的节点分配、连接与回收；相关研究以 JK 空间为准。

## 验证

只运行本次改动相关检查，见 [tests/README.md](tests/README.md)。Git 提交和全流程回归需另行批准。

# JK_BASE

`JK_BASE` 把一组从自定义 JK 触发器逐步演化到“可训练 NAND/JK 电路”的实验整理成了一个可安装、可测试的 Python 项目。这里的目标不是把聊天代码逐段堆在一起，而是保留设计演进，同时让每一阶段共享一致的数据约定和模块边界。

> 研究性质说明：固定逻辑模拟器与编译器可以做确定性验证；基于 STE（straight-through estimator）的拓扑训练只是实验性搜索方法，不保证每次训练都收敛，也不能替代形式验证或真实硬件时序验证。

## 设计约定

本项目里的“JK”是对话中定义的自定义单元，不是标准 JK 真值表：

| 操作 | 控制值 | 结果 |
|---|---:|---|
| `J` 写入 | 0 | `Q <- 0` |
| `J` 写入 | 1 | `Q <- 1` |
| `K` 操作 | 0 | 保持 |
| `K` 操作 | 1 | 翻转 |

可训练模型把它统一写成 `W/J/K` 更新：

```text
base = J if W == 1 else Q
Q_next = base XOR K
```

这样 `W=0` 表示本拍不执行 J 写入，而 K 仍可保持或翻转。

## 从计数器到拓扑进化

```text
Phase 1  Custom JK
   └── n 个 JK 组成下降沿触发的异步脉动计数器

Phase 2  Expanded Comparator
   └── 每位 2 个 JK，逐位产生 A XOR B，并选择最高差异位

Phase 3  Fixed Two-Layer Comparator
   └── 4 个 JK 时间复用，L2 比较当前位，L1 决定继续或停止

Phase 4  Native PyTorch JK-RNN
   └── 小型浮点 Controller 产生离散 W/J/K，固定 JK 状态循环长序列

Phase 5  Fully Binary NAND/JK Network
   └── Controller 和 Readout 都改成硬接线 NAND 网络

Phase 6  Dynamic / Unlimited NAND DAG
   └── 取消固定层数与候选池；节点按名字连接并可真实增长、删除

Phase 7  Topology Compiler
   └── 冻结接线、删除死逻辑、常量传播、合并重复 NAND、导出 Verilog

Phase 8  Structural Evolution
   └── add/delete/rewire/insert/duplicate NAND，以及 grow/delete JK
```

关键边界是：训练时可使用浮点接线分数；硬前向只传播 0/1；编译后只保留网表，不再需要训练 logits 或 PyTorch 推理。

## 目录

```text
JK_BASE/
├── src/jk_base/
│   ├── core.py                 # 自定义 JK 原语和 W/J/K 标量更新
│   ├── counter.py              # n 位异步脉动计数器
│   ├── comparator.py           # 2n-JK 与固定四-JK 比较器
│   ├── torch_ops.py            # STE、张量 JK 更新、比较数据生成
│   ├── models/
│   │   ├── fixed_comparator.py # 无参数的固定四状态 PyTorch 比较器
│   │   ├── jk_rnn.py           # 原生 PyTorch 可训练 JK-RNN
│   │   ├── pure_logic.py       # 固定层 NAND + JK + NAND readout
│   │   └── dynamic_logic.py    # 无限 NAND DAG + JK 状态模型
│   ├── logic/
│   │   ├── dynamic_graph.py    # DynamicSelector / UnlimitedNANDGraph
│   │   └── compiler.py         # 网表冻结、化简、模拟、Verilog
│   └── evolution/
│       └── mutations.py        # 结构变异、fitness、接受/回滚
├── examples/                   # 命令行示例与短训练脚本
├── notebooks/                  # ipywidgets 交互演示
└── tests/                      # 纯 Python 与可选 PyTorch 测试
```

## 安装

推荐 Python 3.10 或更新版本：

```bash
cd JK_BASE
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
python -m pip install -e ".[dev,notebook]"
```

只运行计数器和纯 Python 比较器时，不需要导入 PyTorch 模块；完整项目依赖声明仍包含 PyTorch，因为后半部分设计需要它。

## 快速运行

```bash
python examples/counter_demo.py
python examples/comparator_demo.py
python examples/fixed_torch_comparator.py
python examples/topology_demo.py
```

短训练烟雾测试：

```bash
STEPS=100 python examples/train_jk_rnn.py
```

增加 `STEPS` 才是实际训练实验。随机初始化与 STE 离散接线使结果具有随机性。

## Jupyter 交互演示

启动 Jupyter Lab：

```bash
jupyter lab
```

打开：

- `notebooks/01_ripple_counter.ipynb`：单步观察下降沿如何沿 Q0、Q1…传播。
- `notebooks/02_comparator_demos.ipynb`：切换“每位展开的 2n-JK”与“固定四-JK 两层循环”并逐步执行。

Notebook 只负责 UI；状态机实现来自已测试的 `jk_base` 包，避免 Notebook 与库代码出现两个不一致版本。

## 三类比较器的关系

| 实现 | 状态规模 | 可训练 | 用途 |
|---|---:|---:|---|
| `JKComparatorNetwork` | `2n` JK | 否 | 直观看每一位如何生成差异状态 |
| `TwoLayerJKComparator` | 固定 4 JK | 否 | 展示时间复用与“发现最高差异位后锁定” |
| `FixedJKComparatorRNN` | 固定 4 tensor bits | 否 | 批处理、长序列与 PyTorch 轨迹验证 |
| `JKRNN` | 固定 `hidden_size` | 是 | 让 Controller 学习不同序列任务 |

所有比较输入都必须按 `MSB -> LSB` 顺序进入。训练数据中的 Python 比较运算只用于生成监督标签，不进入模型前向逻辑。

## 全二值与动态 NAND

`PureLogicJKRNN` 保留固定 NAND 层数，适合观察“浮点 Controller → 逻辑 Controller”的过渡。它的接线 logits 是浮点参数，但硬前向的 NAND、W/J/K、Q 和输出都是 0/1。

`UnlimitedNANDGraph` 进一步取消固定层与 `max_nodes`：

- 每根信号使用稳定名字，如 `X0`、`Q2`、`G17`。
- 新节点只能访问创建时已存在的信号，因此天然保持 DAG。
- 输出 selector 会看见后来增加的门。
- 节点 ID 只递增，删除后不复用，便于网表追踪。
- `reachable_nodes` 与 `physically_prune_graph` 可删除输出不可达的门。

一个最小用法：

```python
from jk_base.logic.dynamic_graph import UnlimitedNANDGraph

graph = UnlimitedNANDGraph(["X0", "X1", "C0", "C1"])
graph.add_output("Y")
graph.grow(4)
```

## 拓扑编译器

`NANDTopologyCompiler` 从真实输出反向编译，而不是机械复制所有候选门。编译过程包含：

1. 冻结每个 selector 当前选择的信号。
2. 把 inactive 节点视为常量 0。
3. 输出不可达的 NAND 不进入网表。
4. 执行 `NAND(0,x)=1` 等常量传播。
5. 利用 NAND 输入交换律合并重复子表达式。
6. 按拓扑顺序重新编号并计算最大逻辑深度。

```python
from jk_base.logic.compiler import NANDTopologyCompiler

compiled = NANDTopologyCompiler(graph, name="controller", prefix="CG").compile()
print(compiled.gate_count, compiled.max_depth)
print(compiled.to_verilog("controller_nand"))
```

`CompiledLogicGraph.evaluate()` 是脱离 PyTorch 的纯 Python 门级模拟器；`verify_compilation()` 可对小图穷举输入并比较训练图的硬前向与编译网表。

当前 Verilog 导出覆盖组合 NAND 图。完整的时序实现仍需根据目标工艺提供 W/J/K 状态单元、复位策略、时钟约束和时序验证。

## 结构变异

`MutationEngine` 提供：

- `add_nand`
- `delete_nand`
- `rewire`
- `insert_nand_on_wire`
- `duplicate_subcircuit`
- `rewire_output`
- `grow_jk`
- `delete_jk`

删除 JK 采用尾部删除，避免状态编号重排。删除 NAND 前会把现有引用安全改接到 `C0`。`try_mutation()` 用深拷贝实现接受/回滚，适合小型研究图；大模型应改用结构化快照，避免深拷贝成本。

一个兼顾任务正确率和电路规模的简单适应度为：

```text
fitness = accuracy
          - lambda_nand  * NAND_count
          - lambda_depth * logic_depth
          - lambda_jk    * JK_count
```

拓扑变化会新增或删除 Parameter，因此训练代码应在结构变化后重建优化器。

## 测试

```bash
python -m unittest discover -s tests -v
# 或安装 dev 依赖后
pytest
```

测试覆盖：

- 1–8 位计数器的完整计数周期。
- 两类纯 Python 比较器的全部 4 位输入组合。
- 固定 PyTorch 比较器的全部 5 位输入组合。
- 动态图编译等价性和 JK grow/delete。

若环境没有 PyTorch，纯 Python 测试仍可运行，PyTorch 测试会明确跳过。

## 尚未声称完成的部分

- STE 训练没有收敛保证；项目提供结构和短训练入口，不附带“已学会比较”的权重。
- 随机等价测试或小图穷举不是通用形式证明。
- Verilog 尚未包含目标工艺的 JK 标准单元、STA、CDC、复位同步或 FPGA/ASIC 约束。
- population evolution、Pareto front、跨个体交叉与完整子图复制属于后续研究方向。

## License

MIT，见 `LICENSE`。


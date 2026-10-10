# JK 节点结构数字识别优势评估

本项目提供三个可直接运行并进行结构搜索的模型：纯 Python CNN、带单头缩放点积注意力的 Transformer，以及自定义 JK 节点网络。项目内置了 MNIST 原始 IDX 数据文件，运行时将 28×28 手写图像下采样为统一的 8×8 输入；同时保留 8×8 七段数字作为确定性结构基线。

## 运行

```bash
python3 experiment.py
```

默认合并项目内 MNIST 的 60000 张训练图像和 10000 张测试图像，使用固定种子 7 打乱后按 80% 训练、20% 测试。程序先从训练集内部划出搜索验证集，搜索 CNN 通道数、Transformer token 维度，以及 JK 的规则数和字面量预算；再用全部 80% 训练数据生成最终模型。可用 `--mnist-limit` 做快速功能测试：

```bash
python3 experiment.py --mnist-limit 2000
python3 experiment.py --skip-mnist
```

CNN 和 Transformer 还执行自适应训练策略：准确率低于 95% 时换一个确定性 80/20 划分重训，连续三次仍低于阈值就把当前结构规模扩大一倍，再继续三次尝试。`comparison_report.json` 的 `training_policy.attempts` 保存每次训练的划分种子、准确率、结构规模和扩容动作；最终交付结构是最后一轮扩容后的模型，同时记录历史最佳尝试。

数据文件位于 `data/mnist/`：`train-images`、`train-labels`、`t10k-images`、`t10k-labels` 四个原始 gzip IDX 文件。

输出会生成：

- `artifacts/jk_digit_model.json`：JK 节点、`ex`、端口和 FIFO 协议规格。
- `artifacts/comparison_report.json`：七段基线和 MNIST 手写测试的准确率、参数/节点数、静态乘加数或 JK 操作数。

## 口径

CNN 候选为 2/4/6 个 3×3 卷积核，Transformer 候选为 4/8/12 维 token，并实际计算单头缩放点积注意力。两者的特征提取器使用确定性小结构，分类头用逐样本 SGD 训练；结构搜索依据训练集内部验证准确率，准确率相同时选择更小结构。

JK 模型先为 64 个像素生成 NOT 节点，再从训练数据学习每个类别的若干布尔合取规则，并搜索每类规则数 1/2/4 与字面量预算 4/6/8。每次完整输入帧排空 FIFO；每个规则对应一个 `Y`，类别由模型元数据映射。`average_jk_operations` 是每帧所有节点实际执行的 J/K token 数，不是把节点数假设为计算次数。

优化审查范围是：CNN/Transformer 候选结构验证、JK 合取规则模板检查、搜索候选比较，以及完整模型生成后对每个最终 `ex` 的合法性和输入来源审查。搜索是有限候选和贪心规则学习，不是全局最优证明；JK 的规则投票和输出事件仍需在更完整的 JK 引擎中进行端到端 FIFO 回放验证。

## 结果解释

应以运行生成的 JSON 为准。JK 在七段基准上可以精确匹配；在 MNIST 手写集上，当前 JK 模型使用二值像素合取规则和规则投票，已经参与训练与结构搜索，但仍是低容量的离散基线，不代表完整 JK 学习系统。

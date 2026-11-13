# JK 协作要求（JKRD7）

- 唯一规则入口是 [JKRD7.md](JKRD7.md)；需要理解项目整体时先读 [README.md](README.md)。本项目只维护 7.0.0，不兼容、不迁移此前版本，不从旧版本、旧附件或代码补默认规则。
- 快照模块不属于 JKRD7 的主要路线（用户 2026-11-11）：关于快照的设计规则与相关内容都在 [snapshot/Snapshot.md](snapshot/Snapshot.md)，运行代码都在 `snapshot/`。`src/` 不引用 `snapshot/`。
- 快照的设计与问题由 Claude 推理后实现或解决，不必逐项等用户批准（用户 2026-11-11）；每项决定连同依据记入 Snapshot.md。这项授权不含 README.md、JKRD7.md 正文和主要路线的规则。每天 3 点有定时任务 `snapshot-daily` 梳理、检查、执行或更新快照模块。
- thread 模块的设计规则与声明都在 [RunThread.md](RunThread.md)（用户 2026-11-12）；thread 名默认 `main`。其中多 thread 的部分尚未实现。
- 修改 README.md 或 JKRD7.md 正文须有用户明确指令，并在 [维护记录](docs/jkrd7-maintenance.md) 列出修改前后差异。
- 新增或改变行为必须有用户批准依据；尚未确定的选择留在 JKRD7 §9.3 的待补充清单，不自行推断补全。
- 代码只用 TypeScript（用户 2026-11-06 批准），环境与写法约束见 [TypeScript.md](TypeScript.md)。执行器有 CPU（默认）与 GPU 两个后端，GPU 后端运行在 WebGPU 上。
- 凡涉及 HTML/CSS/浏览器端 JS 的任务，必须先调用 modern-web-guidance 技能
- [WebGPU.md](WebGPU.md) 是由 JKRD7 推导的实现设计，不是规则来源；与 JKRD7 冲突时以 JKRD7 为准。
- 工厂模块（JKRD7 附录、[docs/modules/factory-pending.md](docs/modules/factory-pending.md)）处于待适配状态，不作为当前 JKI／JKS 的合法样例或规则来源。
- 修改规则、示例、附件或代码后，运行以下命令；更新报告时加 `--write-report`：
  - `npm run typecheck`
  - `node tools/validate.ts`
  - `node tools/reference.ts`
  - `node tools/gpu.ts`（改动 GPU 后端或执行语义时运行）
  - `node tools/show.ts`（改动展示页 web/show、本机服务或执行语义时运行）
- 这些检查通过，只说明在本机已核对的范围内，两个后端和展示页与规则一致。不说明恢复流程、多 thread 并行、其他浏览器或其他 GPU 已经验证。

# 待处理问题列表 的回答要求
- 每次询问待处理问题列表时，所有列表的问题都需要你来推理给出方案，每个问题都需要给出 2-5 个可执行的解决方案，最推荐的方案放在第一位，批准后执行推荐方案。只需待我选择或批准方案即可。问题列表按模块划分展示，最后列出延后处理的模块内容。
- 所有问题和方案都要详细解释说明并举例，其中所有代称也都要是结构式：JKS.thread、JKS.thread.FIFO、JKS 的 thread。
# JK 协作要求（JKRD7）

- 唯一规则入口是 [JKRD7.md](JKRD7.md)；需要理解项目整体时先读 [README.md](README.md)。本项目只维护 7.0.0，不兼容、不迁移此前版本，不从旧版本、旧附件或代码补默认规则。
- 修改 README.md 或 JKRD7.md 正文须有用户明确指令，并在 [维护记录](docs/jkrd7-maintenance.md) 列出修改前后差异。
- 新增或改变行为必须有用户批准依据；尚未确定的选择留在 JKRD7 §9.3 的待补充清单，不自行推断补全。
- 代码只用 TypeScript（用户 2026-11-06 批准），环境与写法约束见 [TypeScript.md](TypeScript.md)。执行器有 CPU（默认）与 GPU 两个后端，GPU 后端运行在 WebGPU 上。
- [WebGPU.md](WebGPU.md) 是由 JKRD7 推导的实现设计，不是规则来源；与 JKRD7 冲突时以 JKRD7 为准。
- 工厂模块（JKRD7 附录、[docs/modules/factory-pending.md](docs/modules/factory-pending.md)）处于待适配状态，不作为当前 JKI／JKS 的合法样例或规则来源。
- 修改规则、示例、附件或代码后，运行以下命令；更新报告时加 `--write-report`：
  - `npm run typecheck`
  - `node tools/validate.ts`
  - `node tools/reference.ts`
  - `node tools/gpu.ts`（改动 GPU 后端或执行语义时运行）
- 这些检查通过，只说明在本机已核对的范围内两个后端与规则一致。不说明恢复流程、多 queue 调度、其他浏览器或其他 GPU 已经验证。

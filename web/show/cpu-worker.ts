/** 在 Worker 中用 CPU 后端运行运行脚本，作为 GPU 对拍的参考，不阻塞页面。 */

import type { RunScript } from "../../src/model.ts";
import { runScriptCpu } from "../../src/executor.ts";
import { formatRecords } from "../../src/record.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; script: RunScript; model: unknown }>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = ({ data }) => {
  try {
    const started = performance.now();
    const ex = runScriptCpu(data.script, data.model);
    scope.postMessage({ id: data.id, records: formatRecords(ex.record()), ms: performance.now() - started });
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};

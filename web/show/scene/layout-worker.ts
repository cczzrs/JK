/** 布局 Worker：在页面主线程之外计算布局。 */

import { createLayout, type LayoutMode } from "./layout.ts";
import type { DisplayModel } from "./model-view.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ model: DisplayModel; mode: LayoutMode }>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({ result: createLayout(data.model, data.mode) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

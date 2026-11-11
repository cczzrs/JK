/** 页面的当前状态：模型、执行会话、选中的对象与最近的处理单元。不写入浏览器存储。 */

import type { Jkm, Model } from "../../src/model.ts";
import type { Session, Unit } from "./session.ts";

/** 当前模型：原始定义、加载后的 Model、输入入口与只读的统计。 */
export interface Loaded {
  raw: Jkm;
  model: Model;
  inputs: string[];
  edges: number;
  operations: number;
}

export const state: {
  loaded: Loaded | null;
  session: Session | null;
  /** 选中的 JKI 或 JKS 的绝对路径。 */
  selected: string | null;
  /** 运行脚本 model 字段使用的 JKM 文件标识。 */
  modelPath: string;
  /** 最近处理的单元，以及本单元窗口中正在显示的步（-1 表示没有选定）。 */
  unit: Unit | null;
  unitStep: number;
} = { loaded: null, session: null, selected: null, modelPath: "", unit: null, unitStep: -1 };

export function current(): { loaded: Loaded; session: Session } {
  if (!state.loaded || !state.session) throw new Error("尚未加载模型");
  return { loaded: state.loaded, session: state.session };
}

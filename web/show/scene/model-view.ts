/**
 * 模型的展示投影：从 JK 的 Model 得到画图用的节点、连线与观察点。只读，不是可接受的模型格式。
 */

import { type Bit, type Model, comparePaths, isInputEntry, sortPaths } from "../../../src/model.ts";

export interface Token {
  source: string;
  index: number;
  op: "J" | "K";
  /** source：EX 来源；source-definition：空 EX 的 sources.s；trigger：触发引用。 */
  relation: "source" | "source-definition" | "trigger";
}

export interface DisplayNode {
  id: string;
  key: string;
  initial: Bit;
  hasEX: boolean;
  errors: string[];
  tokens: Token[];
  isInput: boolean;
  tags: string[];
  displayName: string;
}

export interface DisplayOutput {
  id: string;
  source: string;
  displayName: string;
  error: null;
  category: "observe";
  tags: string[];
}

export interface DisplayModel {
  name: string;
  nodes: DisplayNode[];
  /** 场景中独立的输入点；JKM 的输入入口本身就是 JKI，因此为空。 */
  inputs: string[];
  outputs: DisplayOutput[];
}

export function compareDisplayNodes(a: { id: string }, b: { id: string }): number {
  return comparePaths(a.id, b.id);
}

/** 观察点取自模型的 output（§8.1）：每个输出成员一个。 */
export function createDisplayModel(model: Model): DisplayModel {
  const nodes = sortPaths(model.jki.keys()).map((path): DisplayNode => {
    const definition = model.jki.get(path)!;
    const ops = definition.sources?.ex ?? [];
    const tokens: Token[] = (model.sourceRefs.get(path) ?? []).map((source, index) => ({
      source, index, op: ops[index] ?? "K", relation: ops.length ? "source" : "source-definition",
    }));
    for (const [index, source] of (model.triggerRefs.get(path) ?? []).entries()) {
      tokens.push({ source, index, op: "K", relation: "trigger" });
    }
    const tags = [...(definition.pro?.tag ?? [])];
    return {
      id: path, key: path, initial: definition.q, hasEX: ops.length > 0, errors: [], tokens,
      isInput: isInputEntry(model, path), tags,
      displayName: tags.length ? `${path} · ${tags.join(" · ")}` : path,
    };
  });
  const outputs = sortPaths(model.output).map((path): DisplayOutput => ({
    id: `observe:${path}`, source: path, displayName: `观察 · ${path}`, error: null, category: "observe", tags: [],
  }));
  return { name: model.name ?? "", nodes, inputs: [], outputs };
}

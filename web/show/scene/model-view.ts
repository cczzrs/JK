/**
 * 模型的展示投影：从 JK 的 Model 得到画图用的节点、连线与观察点。只读，不是可接受的模型格式。
 */

import { type Model, comparePaths, isInputEntry, sortPaths } from "../../../src/model.ts";

/** 观察点在场景中的键：每个 output 成员一个，与它读取的 JKI 分开。 */
export function observeKey(path: string): string {
  return `observe:${path}`;
}

/** 观察点的键所读取的 JKI；不是观察点的键原样返回。 */
export function observedPath(key: string): string {
  return key.startsWith("observe:") ? key.slice("observe:".length) : key;
}

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
  hasEX: boolean;
  tokens: Token[];
  isInput: boolean;
  tags: string[];
  displayName: string;
}

export interface DisplayOutput {
  id: string;
  source: string;
  displayName: string;
  tags: string[];
}

/** 输入入口本身就是 JKI，在 nodes 中；outputs 是观察点。 */
export interface DisplayModel {
  nodes: DisplayNode[];
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
      id: path, key: path, hasEX: ops.length > 0, tokens,
      isInput: isInputEntry(model, path), tags,
      displayName: tags.length ? `${path} · ${tags.join(" · ")}` : path,
    };
  });
  const outputs = sortPaths(model.output).map((path): DisplayOutput => ({
    id: observeKey(path), source: path, displayName: `观察 · ${path}`, tags: [],
  }));
  return { nodes, outputs };
}

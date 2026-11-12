/**
 * 网络样式（只是浏览器中的展示偏好，不含 JKM 或执行状态）。
 */

import type { StylesConfig } from "../config.ts";
import { type Obj, boolean, bounded, color, isColor, object, own } from "./normalize.ts";

export interface EdgeStyle {
  color: string;
  opacity: number;
  length: number;
  visible: boolean;
}

export interface NodeStyle {
  color: string;
  size: number;
  visible: boolean;
  labels: boolean;
}

export interface MarkerState {
  visible: boolean;
  color: string;
}

export type ComputationStyle = Partial<NodeStyle> & { marker?: MarkerState };

export interface NetworkStyles {
  version: number;
  edges: Record<string, EdgeStyle>;
  nodes: Record<string, NodeStyle>;
  computation: Record<string, ComputationStyle>;
  tags: Record<string, NodeStyle>;
}



function edgeStyle(raw: unknown, defaults: EdgeStyle, limits: StylesConfig["edges"]["limits"]): EdgeStyle {
  return {
    color: color(own(raw, "color"), defaults.color),
    opacity: bounded(own(raw, "opacity"), defaults.opacity, limits.opacity),
    length: bounded(own(raw, "length"), defaults.length, limits.length),
    visible: boolean(own(raw, "visible"), defaults.visible),
  };
}

function nodeStyle(raw: unknown, defaults: NodeStyle, limits: StylesConfig["nodes"]["limits"]): NodeStyle {
  return {
    color: color(own(raw, "color"), defaults.color),
    size: bounded(own(raw, "size"), defaults.size, limits.size),
    visible: boolean(own(raw, "visible"), defaults.visible),
    labels: boolean(own(raw, "labels"), defaults.labels),
  };
}

function nodeOverrides(raw: unknown, defaults: Obj, base: NodeStyle, limits: StylesConfig["nodes"]["limits"]): Partial<NodeStyle> {
  const valid = (key: string, value: unknown): boolean => key === "color" ? isColor(value)
    : key === "size" ? typeof value === "number" && Number.isFinite(value)
      : (key === "visible" || key === "labels") && typeof value === "boolean";
  const overrides = Object.fromEntries([...Object.entries(defaults), ...(object(raw) ? Object.entries(raw) : [])]
    .filter(([key, value]) => valid(key, value)));
  const normalized = nodeStyle(overrides, base, limits);
  return Object.fromEntries(Object.keys(overrides).map((key) => [key, normalized[key as keyof NodeStyle]])) as Partial<NodeStyle>;
}

function markerStyle(raw: unknown, defaults: MarkerState): MarkerState {
  return { visible: boolean(own(raw, "visible"), defaults.visible), color: color(own(raw, "color"), defaults.color) };
}

export function normalizeNetworkStyles(raw: unknown, config: StylesConfig): NetworkStyles {
  const source = object(raw) && own(raw, "version") === config.storage.version ? raw : {};
  const edges = own(source, "edges");
  const nodes = own(source, "nodes");
  const tags = own(source, "tags");
  const computation = own(source, "computation");
  const base = config.nodes.types.node;
  return {
    version: config.storage.version,
    edges: Object.fromEntries(Object.entries(config.edges.types).map(([key, defaults]) => [key,
      edgeStyle(own(edges, key), defaults, config.edges.limits)])),
    nodes: Object.fromEntries(Object.entries(config.nodes.types).map(([key, defaults]) => [key,
      nodeStyle(own(nodes, key), defaults, config.nodes.limits)])),
    computation: Object.fromEntries(Object.entries(config.nodes.computationTypes).map(([key, defaults]) => {
      const entry = own(computation, key);
      const overrides = nodeOverrides(entry, defaults.overrides, base, config.nodes.limits);
      const marker = "marker" in defaults ? { marker: markerStyle(own(entry, "marker"), defaults.marker) } : {};
      return [key, { ...overrides, ...marker }];
    })),
    // 标签是模型中写的文本，即使名为 "__proto__"；fromEntries 只建立自有属性。
    tags: Object.fromEntries((object(tags) ? Object.entries(tags) : [])
      .filter(([, value]) => object(value))
      .map(([tag, value]) => [tag, nodeStyle(value, base, config.nodes.limits)])),
  };
}

export function defaultNetworkStyles(config: StylesConfig): NetworkStyles {
  return normalizeNetworkStyles(null, config);
}

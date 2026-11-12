/**
 * 画图用的分类与样式解析，以及按连线长度偏好调整布局。不改变 JKI 身份或执行。
 */

import type { Bounds3, LayoutResult, Point } from "./layout.ts";
import type { NetworkStyles, NodeStyle } from "../ui/network-style-state.ts";

export interface StyledEdge {
  relation: string;
  /** EX 运算 J、K，或输出观察线的 Y；触发引用没有运算。 */
  op?: string;
}

export interface StyledNode {
  category?: string;
  type?: string;
  isInput?: boolean;
  tags?: readonly string[];
  hasEX?: boolean;
}

export function edgeStyleType(edge: StyledEdge): string {
  if (edge.relation === "trigger") return "trigger";
  if (edge.relation === "source-definition") return "source";
  if (edge.relation === "observe" || edge.op === "Y") return "observe";
  return edge.op === "J" ? "J" : edge.op === "K" ? "K" : "source";
}

export function nodeStyleTarget(node: StyledNode, state: NetworkStyles | null): { category: string; tag: string | null } {
  const category = node.category === "observe" || node.type === "Y" ? "observe"
    : node.category === "input" || node.isInput || node.type === "X" ? "input" : "node";
  const tag = (node.tags ?? []).find((value) => Object.hasOwn(state?.tags ?? {}, value)) ?? null;
  return { category, tag };
}

export function nodeComputationType(node: StyledNode): "ex" | "q" | null {
  if (node.category === "observe" || node.type === "Y") return null;
  return node.hasEX ? "ex" : "q";
}

export function resolveNodeStyle(node: StyledNode, state: NetworkStyles | null): NodeStyle | null {
  if (!state) return null;
  const { category, tag } = nodeStyleTarget(node, state);
  if (tag !== null) return state.tags[tag];
  const base = state.nodes[category] ?? null;
  const computation = nodeComputationType(node);
  const overrides = computation === null ? null : state.computation[computation];
  const properties = Object.entries(overrides ?? {}).filter(([key]) => key !== "marker");
  return properties.length && base ? { ...base, ...Object.fromEntries(properties) } : base;
}

interface LayoutEdge extends StyledEdge {
  sourceKey: string;
  targetKey: string;
}

/**
 * 从不变的基础布局出发拟合两端距离。重复或相互竞争的连线是独立约束；Jacobi 松弛把修正分摊到两端。
 * 自连接与孤立节点不移动，连线不被截短。
 */
export function adjustNetworkLayout(layout: LayoutResult, edges: readonly LayoutEdge[], styles: NetworkStyles | null,
  { iterations, relaxation }: { iterations: number; relaxation: number }): LayoutResult {
  if (!styles || !edges.some((edge) => (styles.edges[edgeStyleType(edge)]?.length ?? 1) !== 1)) return layout;
  const constraints = edges.filter((edge) => edge.sourceKey !== edge.targetKey
    && layout.positions.has(edge.sourceKey) && layout.positions.has(edge.targetKey))
    .map((edge) => {
      const a = layout.positions.get(edge.sourceKey)!;
      const b = layout.positions.get(edge.targetKey)!;
      const delta = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const distance = Math.hypot(delta.x, delta.y, delta.z);
      const length = styles.edges[edgeStyleType(edge)]?.length ?? 1;
      return { a: edge.sourceKey, b: edge.targetKey, delta, distance, target: distance * length };
    }).filter((edge) => edge.distance > 0 && Number.isFinite(edge.target) && edge.target > 0);
  if (!constraints.length) return layout;
  const positions = new Map([...layout.positions].map(([key, point]) => [key, { ...point }]));
  const neighbors = new Map<string, Set<string>>();
  for (const { a, b } of constraints) {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    if (!neighbors.has(b)) neighbors.set(b, new Set());
    neighbors.get(a)!.add(b);
    neighbors.get(b)!.add(a);
  }
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const key of neighbors.keys()) {
    if (visited.has(key)) continue;
    const component: string[] = [];
    const pending = [key];
    visited.add(key);
    while (pending.length) {
      const next = pending.pop()!;
      component.push(next);
      for (const neighbor of neighbors.get(next)!) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          pending.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  for (let step = 0; step < iterations; step++) {
    const changes = new Map([...neighbors.keys()].map((key) => [key, { x: 0, y: 0, z: 0, count: 0 }]));
    for (const edge of constraints) {
      const a = positions.get(edge.a)!;
      const b = positions.get(edge.b)!;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dz = b.z - a.z;
      const distance = Math.hypot(dx, dy, dz);
      const scale = (distance - edge.target) / (distance || edge.distance) / 2;
      if (!distance) {
        dx = edge.delta.x;
        dy = edge.delta.y;
        dz = edge.delta.z;
      }
      const first = changes.get(edge.a)!;
      const second = changes.get(edge.b)!;
      first.x += dx * scale; first.y += dy * scale; first.z += dz * scale; first.count++;
      second.x -= dx * scale; second.y -= dy * scale; second.z -= dz * scale; second.count++;
    }
    for (const [key, delta] of changes) {
      const point = positions.get(key)!;
      const scale = relaxation / delta.count;
      point.x += delta.x * scale; point.y += delta.y * scale; point.z += delta.z * scale;
    }
  }
  // 保持每个连通分量原来的中心（度数不均的图也一样）。
  const axes = ["x", "y", "z"] as const;
  for (const component of components) {
    const shift: Point = { x: 0, y: 0, z: 0 };
    for (const key of component) for (const axis of axes) shift[axis] += positions.get(key)![axis] - layout.positions.get(key)![axis];
    for (const key of component) for (const axis of axes) positions.get(key)![axis] -= shift[axis] / component.length;
  }
  const bounds: Bounds3 = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (const point of positions.values()) {
    for (const axis of axes) {
      bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
    }
  }
  return { ...layout, positions, bounds };
}

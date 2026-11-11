/**
 * 确定性的网络布局（世界坐标）。不读取也不改变运行中的 q。
 * 在 Worker 中运行（layout-worker.ts）。
 */

import { APP_CONFIG } from "../config.ts";
import { type DisplayModel, type DisplayNode, compareDisplayNodes } from "./model-view.ts";

export const LAYOUT_MODES = ["auto", "1D", "2D", "3D", "4D", "5D"] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];
export const DEFAULT_LAYOUT_MODE: LayoutMode = APP_CONFIG.scene.layout;

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface Bounds3 {
  min: Point;
  max: Point;
}

export interface Metrics {
  score: number;
  overlaps: number;
  obstructed: number;
  crossing: number;
  backward: number;
  wireLength: number;
}

/** 布局结果：节点与观察点的世界坐标、包围盒、实际采用的布局与请求的布局。 */
export interface LayoutResult {
  positions: Map<string, Point>;
  mode: Exclude<LayoutMode, "auto">;
  bounds: Bounds3;
  requestedMode: LayoutMode;
}

interface Edge {
  source: string;
  target: string;
}

/** 构造坐标中的布局（还没有换到世界坐标）。 */
type Draft = Pick<LayoutResult, "positions" | "mode">;

const EPS = 1e-9;
const AXES = ["x", "y", "z"] as const;
const radius2 = (p: Point): number => p.x * p.x + p.y * p.y + p.z * p.z;
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const nodeOrder = compareDisplayNodes;
const centerOrder = (a: Point, b: Point): number => radius2(a) - radius2(b) || a.x - b.x || a.y - b.y || a.z - b.z;
const parameterCount = (n: DisplayNode): number => n.tokens.filter((t) => t.source).length;
const negate = (value: number): number => (value === 0 ? 0 : -value);
const toWorldPoint = (p: Point): Point => ({ x: p.x, y: negate(p.z), z: p.y });
const transformMap = (positions: Map<string, Point>, transform: (p: Point) => Point): Map<string, Point> =>
  new Map([...positions].map(([key, p]) => [key, transform(p)]));

function centered(points: Point[]): Point[] {
  if (!points.length) return points;
  const b = bounds(points);
  return points.map((p) => ({ x: p.x - (b.min.x + b.max.x) / 2, y: p.y - (b.min.y + b.max.y) / 2, z: p.z - (b.min.z + b.max.z) / 2 }));
}

/** 构造坐标；1D 保持竖排，其余模式返回时交换 Y／Z。 */
export function gridPoints(count: number, dimensions: number): Point[] {
  if (!count) return [];
  if (dimensions === 1) return Array.from({ length: count }, (_, i) => ({ x: 0, y: (count - 1) / 2 - i, z: 0 }));
  const side = Math.ceil(Math.pow(count, 1 / dimensions));
  return centered(Array.from({ length: count }, (_, i) => ({
    x: dimensions === 3 ? Math.floor(i / side) % side : 0,
    y: -(i % side),
    z: dimensions === 3 ? Math.floor(i / (side * side)) : Math.floor(i / side),
  })));
}

/** 完整的格点球壳，从球心向外排序。 */
export function spherePoints(count: number): Point[] {
  if (!count) return [];
  let radius = Math.max(1, Math.ceil(Math.cbrt((count * 3) / (4 * Math.PI))));
  let points: Point[] = [];
  while (points.length < count) {
    points = [];
    for (let x = -radius; x <= radius; x++) {
      for (let y = -radius; y <= radius; y++) {
        for (let z = -radius; z <= radius; z++) if (x * x + y * y + z * z <= radius * radius) points.push({ x, y, z });
      }
    }
    if (points.length < count) radius++;
  }
  points.sort(centerOrder);
  // 保留整层外壳，等半径的方向不被截断。
  const limit = radius2(points[count - 1]);
  return points.filter((p) => radius2(p) <= limit);
}

export function layoutEdges(model: DisplayModel): Edge[] {
  const byId = new Map<string, string>();
  for (const n of model.nodes) if (!byId.has(n.id)) byId.set(n.id, n.key);
  const edges: Edge[] = [];
  for (const n of model.nodes) {
    for (const t of n.tokens) {
      const source = t.source ? byId.get(t.source) : undefined;
      if (source) edges.push({ source, target: n.key }); // 重复的 J／K 项是各自画出的连线
    }
  }
  for (const o of model.outputs) {
    const source = byId.get(o.source);
    if (source) edges.push({ source, target: o.id });
  }
  return edges;
}

function bounds(points: Iterable<Point>): Bounds3 {
  const b: Bounds3 = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (const p of points) {
    for (const a of AXES) {
      b.min[a] = Math.min(b.min[a], p[a]);
      b.max[a] = Math.max(b.max[a], p[a]);
    }
  }
  if (b.min.x === Infinity) b.min = b.max = { x: 0, y: 0, z: 0 };
  return b;
}

/** 观察点排在节点包围盒的 +x 一侧（输入入口本身就是 JKI，不另设输入点）。 */
function terminals(model: DisplayModel, positions: Map<string, Point>, mode: string, envelope: Point[] = [...positions.values()]): Map<string, Point> {
  const b = bounds(envelope);
  const ids = model.outputs.map((o) => o.id);
  const ps = gridPoints(ids.length, mode === "1D" ? 1 : 2);
  const offset = b.max.x + 3 - bounds(ps).min.x;
  ids.forEach((id, i) => positions.set(id, { x: ps[i].x + offset, y: ps[i].y, z: ps[i].z }));
  return positions;
}

export function wireLength(positions: Map<string, Point>, edges: Edge[]): number {
  return edges.reduce((sum, e) => {
    const a = positions.get(e.source);
    const b = positions.get(e.target);
    return sum + (a && b ? distance(a, b) : 0);
  }, 0);
}

/** 1D：竖排，Y 轴从上到下；2D：YZ 平面，先沿 Z 再沿 Y 向下；3D：近似正方体。 */
function basic(model: DisplayModel, nodes: DisplayNode[], mode: "1D" | "2D" | "3D"): Draft {
  const candidates = gridPoints(nodes.length, Number(mode[0]));
  const positions = new Map(nodes.map((n, i) => [n.key, candidates[i]]));
  terminals(model, positions, mode);
  return { positions, mode };
}

/** 在固定的 x 切片内缩短实际连线长度，不颠倒拓扑次序。 */
function optimizeSlices(positions: Map<string, Point>, nodes: DisplayNode[], edges: Edge[]): void {
  const slices = new Map<number, string[]>();
  const incident = new Map<string, number[]>();
  for (const n of nodes) {
    const x = positions.get(n.key)!.x;
    if (!slices.has(x)) slices.set(x, []);
    slices.get(x)!.push(n.key);
  }
  edges.forEach((e, i) => {
    for (const k of new Set([e.source, e.target])) {
      if (!incident.has(k)) incident.set(k, []);
      incident.get(k)!.push(i);
    }
  });
  for (let pass = 0; pass < 2; pass++) {
    for (const keys of slices.values()) {
      for (let i = 0; i < keys.length; i++) {
        const a = keys[i];
        let best: string | null = null;
        let bestDelta = -EPS;
        // 大模型只看有限的邻域；普通的立方切片会比较全部候选。
        for (let j = i + 1; j < Math.min(keys.length, i + 65); j++) {
          const b = keys[j];
          const pa = positions.get(a)!;
          const pb = positions.get(b)!;
          const affected = new Set([...(incident.get(a) ?? []), ...(incident.get(b) ?? [])]);
          const at = (k: string): Point => (k === a ? pb : k === b ? pa : positions.get(k)!);
          let delta = 0;
          for (const index of affected) {
            const e = edges[index];
            const p = positions.get(e.source);
            const q = positions.get(e.target);
            if (p && q) delta += distance(at(e.source), at(e.target)) - distance(p, q);
          }
          if (delta < bestDelta) {
            best = b;
            bestDelta = delta;
          }
        }
        if (best) {
          const p = positions.get(a)!;
          positions.set(a, positions.get(best)!);
          positions.set(best, p);
        }
      }
    }
  }
}

function topological(model: DisplayModel, nodes: DisplayNode[], edges: Edge[]): Draft & { topologyRanks: Map<string, number> } {
  const topology = topologyOrder(nodes, edges);
  const candidates = gridPoints(nodes.length, 3).sort((a, b) => a.x - b.x || a.z - b.z || b.y - a.y);
  const sorted = [...nodes].sort((a, b) => topology.ranks.get(a.key)! - topology.ranks.get(b.key)!
    || topology.components.get(a.key)! - topology.components.get(b.key)! || nodeOrder(a, b));
  const positions = new Map(sorted.map((n, i) => [n.key, candidates[i]]));
  terminals(model, positions, "4D");
  optimizeSlices(positions, nodes, edges);
  return { positions, topologyRanks: topology.ranks, mode: "4D" };
}

/** 两侧第一排固定；其余节点各自优化与所引用来源的距离。 */
function five(model: DisplayModel, nodes: DisplayNode[], edges: Edge[]): Draft {
  const base = topological(model, nodes, edges);
  const inputNodes = nodes.filter((n) => n.isInput);
  const inputSet = new Set(inputNodes.map((n) => n.key));
  const outputSources = new Set(model.outputs.map((o) => o.source));
  // 一个节点不能同时占两侧；输入优先。
  const outputNodes = nodes.filter((n) => outputSources.has(n.id) && !inputSet.has(n.key));
  const outputSet = new Set(outputNodes.map((n) => n.key));
  const remaining = nodes.filter((n) => !inputSet.has(n.key) && !outputSet.has(n.key));
  const candidates = spherePoints(remaining.length);
  const cb = bounds(candidates);
  const leftX = cb.min.x - 1;
  const rightX = cb.max.x + 1;
  const positions = new Map<string, Point>();
  const slotByKey = new Map<string, number>();
  const occupant = new Map<number, string>();
  const sides: [DisplayNode[], number][] = [[inputNodes, leftX], [outputNodes, rightX]];
  for (const [group, x] of sides) {
    const ps = gridPoints(group.length, 2);
    group.forEach((n, i) => positions.set(n.key, { x, y: ps[i].y, z: ps[i].z }));
  }
  // 从 4D 排列出发，给每个自由节点分配一个邻近的球形格点。
  const vacant = new Set(candidates.map((_, i) => i));
  for (const n of remaining) {
    let best = -1;
    let nearest = Infinity;
    for (const slot of vacant) {
      const d = distance(base.positions.get(n.key)!, candidates[slot]);
      if (d < nearest - EPS) {
        nearest = d;
        best = slot;
      }
    }
    positions.set(n.key, candidates[best]);
    slotByKey.set(n.key, best);
    occupant.set(best, n.key);
    vacant.delete(best);
  }
  terminals(model, positions, "5D");
  const sources = new Map<string, string[]>();
  for (const e of edges) {
    if (!sources.has(e.target)) sources.set(e.target, []);
    sources.get(e.target)!.push(e.source);
  }
  const ranks = base.topologyRanks;
  const sorted = [...remaining].sort((a, b) => parameterCount(b) - parameterCount(a) || ranks.get(a.key)! - ranks.get(b.key)! || nodeOrder(a, b));
  const free = new Set(candidates.map((_, i) => i));
  for (const n of sorted) {
    const oldSlot = slotByKey.get(n.key)!;
    const oldPosition = positions.get(n.key)!;
    let bestSlot = oldSlot;
    let bestCost = Infinity;
    // 球形格点按半径排序：代价相同时从中心向外扩张。
    for (const slot of free) {
      const p = candidates[slot];
      const other = occupant.get(slot);
      let cost = 0;
      for (const source of sources.get(n.key) ?? []) {
        const q = source === n.key ? p : source === other ? oldPosition : positions.get(source);
        if (q) cost += distance(p, q);
      }
      if (cost < bestCost - EPS) {
        bestCost = cost;
        bestSlot = slot;
      }
    }
    const other = occupant.get(bestSlot);
    if (other && other !== n.key) {
      positions.set(other, oldPosition);
      slotByKey.set(other, oldSlot);
      occupant.set(oldSlot, other);
    } else {
      occupant.delete(oldSlot);
    }
    positions.set(n.key, candidates[bestSlot]);
    slotByKey.set(n.key, bestSlot);
    occupant.set(bestSlot, n.key);
    free.delete(bestSlot);
  }
  return { positions, mode: "5D" };
}

/** 迭代的强连通分量缩点，反馈网络的布局仍是有限的。 */
function topologyOrder(nodes: DisplayNode[], edges: Edge[]): { ranks: Map<string, number>; components: Map<string, number> } {
  const keys = nodes.map((n) => n.key);
  const keySet = new Set(keys);
  const forward = new Map(keys.map((k) => [k, [] as string[]]));
  const reverse = new Map(keys.map((k) => [k, [] as string[]]));
  for (const e of edges) {
    if (keySet.has(e.source) && keySet.has(e.target)) {
      forward.get(e.source)!.push(e.target);
      reverse.get(e.target)!.push(e.source);
    }
  }
  const seen = new Set<string>();
  const finish: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const stack: [string, number][] = [[key, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const neighbors = forward.get(top[0])!;
      if (top[1] < neighbors.length) {
        const next = neighbors[top[1]++];
        if (!seen.has(next)) {
          seen.add(next);
          stack.push([next, 0]);
        }
      } else {
        finish.push(top[0]);
        stack.pop();
      }
    }
  }
  const component = new Map<string, number>();
  const groups: string[][] = [];
  for (const key of finish.reverse()) {
    if (component.has(key)) continue;
    const id = groups.length;
    const group: string[] = [];
    const stack = [key];
    component.set(key, id);
    while (stack.length) {
      const v = stack.pop()!;
      group.push(v);
      for (const next of reverse.get(v)!) {
        if (!component.has(next)) {
          component.set(next, id);
          stack.push(next);
        }
      }
    }
    groups.push(group);
  }
  const dag = groups.map(() => new Set<number>());
  const indegree = groups.map(() => 0);
  const rank = groups.map(() => 0);
  for (const e of edges) {
    if (!component.has(e.source) || !component.has(e.target)) continue;
    const a = component.get(e.source)!;
    const b = component.get(e.target)!;
    if (a !== b && !dag[a].has(b)) {
      dag[a].add(b);
      indegree[b]++;
    }
  }
  const queue = indegree.flatMap((d, i) => (d === 0 ? [i] : []));
  for (let head = 0; head < queue.length; head++) {
    const a = queue[head];
    for (const b of dag[a]) {
      rank[b] = Math.max(rank[b], rank[a] + 1);
      if (--indegree[b] === 0) queue.push(b);
    }
  }
  return { ranks: new Map(keys.map((k) => [k, rank[component.get(k)!]])), components: component };
}

const project = (p: Point, flat: boolean): { x: number; y: number } =>
  flat ? { x: p.x, y: p.y } : { x: 0.545 * p.x - 0.839 * p.z, y: -0.237 * p.x + 0.959 * p.y - 0.154 * p.z };

function crosses(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): boolean {
  const turn = (p: typeof a, q: typeof a, r: typeof a) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return turn(a, b, c) * turn(a, b, d) < -EPS && turn(c, d, a) * turn(c, d, b) < -EPS;
}

/** 在构造坐标中评分，换到世界坐标之前调用。 */
export function readability(result: Draft, edges: Edge[]): Metrics {
  const positions = result.positions;
  const flat = result.mode === "1D";
  const screen = new Map([...positions].map(([k, p]) => [k, project(p, flat)]));
  const bins = new Map<string, { x: number; y: number }[]>();
  let overlaps = 0;
  for (const p of screen.values()) {
    const x = Math.floor(p.x / 0.7);
    const y = Math.floor(p.y / 0.7);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of bins.get(`${x + dx},${y + dy}`) ?? []) if (Math.hypot(p.x - q.x, p.y - q.y) < 0.65) overlaps++;
      }
    }
    const key = `${x},${y}`;
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key)!.push(p);
  }
  const sampled = edges.length <= 256 ? edges : Array.from({ length: 256 }, (_, i) => edges[Math.floor((i * edges.length) / 256)]);
  let crossing = 0;
  let backward = 0;
  let obstructed = 0;
  const screenNodes = [...screen];
  const sampledNodes = screenNodes.length <= 512 ? screenNodes
    : Array.from({ length: 512 }, (_, i) => screenNodes[Math.floor((i * screenNodes.length) / 512)]);
  for (let i = 0; i < sampled.length; i++) {
    const a = sampled[i];
    const p = screen.get(a.source);
    const q = screen.get(a.target);
    if (!p || !q) continue;
    if (p.x > q.x + EPS) backward++;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const squared = dx * dx + dy * dy;
    if (squared > EPS) {
      for (const [key, r] of sampledNodes) {
        if (key === a.source || key === a.target) continue;
        const t = ((r.x - p.x) * dx + (r.y - p.y) * dy) / squared;
        if (t > 0 && t < 1 && Math.hypot(r.x - p.x - t * dx, r.y - p.y - t * dy) < 0.32) obstructed++;
      }
    }
    for (let j = 0; j < i; j++) {
      const b = sampled[j];
      if ([a.source, a.target].some((k) => k === b.source || k === b.target)) continue;
      const r = screen.get(b.source);
      const s = screen.get(b.target);
      if (r && s && crosses(p, q, r, s)) crossing++;
    }
  }
  const b = bounds(positions.values());
  const width = b.max.x - b.min.x + 1;
  const height = b.max.y - b.min.y + 1;
  const aspectPenalty = Math.max(width / height, height / width);
  const length = wireLength(result.positions, edges);
  return {
    score: overlaps * 100 + obstructed * 10 + crossing * 3 + backward * 2 + length / Math.max(1, edges.length) + aspectPenalty * 0.5,
    overlaps, obstructed, crossing, backward, wireLength: length,
  };
}

/** 临时布局：只按网格排列、不评分。Worker 算出正式布局之前先用它显示，避免在主线程重复计算。 */
export function quickLayout(model: DisplayModel): LayoutResult {
  const nodes = [...model.nodes].sort(nodeOrder);
  const candidates = gridPoints(nodes.length, 2);
  const positions = new Map(nodes.map((n, i) => [n.key, candidates[i]]));
  terminals(model, positions, "2D");
  const world = transformMap(positions, toWorldPoint);
  return { positions: world, mode: "2D", bounds: bounds(world.values()), requestedMode: "2D" };
}

export function createLayout(model: DisplayModel, mode: LayoutMode = DEFAULT_LAYOUT_MODE): LayoutResult {
  if (!LAYOUT_MODES.includes(mode)) throw new Error(`未知布局：${mode}`);
  const nodes = [...model.nodes].sort(nodeOrder);
  const edges = layoutEdges(model);
  let result: Draft;
  if (mode === "5D") result = five(model, nodes, edges);
  else if (mode === "4D") result = topological(model, nodes, edges);
  else if (mode !== "auto") result = basic(model, nodes, mode);
  else {
    const choices: Draft[] = [...(["1D", "2D", "3D"] as const).map((m) => basic(model, nodes, m)), topological(model, nodes, edges)];
    if (nodes.length <= 256) choices.push(five(model, nodes, edges));
    // 自动选择：各候选在构造坐标中评分，取分数最低的（同分时保持上面的先后）
    result = choices.map((choice) => ({ choice, score: readability(choice, edges).score })).sort((a, b) => a.score - b.score)[0].choice;
  }
  // 只有 1D 保留原来从上到下的 Y 列（包括自动选中的 1D），其余换到世界坐标。
  const positions = result.mode === "1D" ? result.positions : transformMap(result.positions, toWorldPoint);
  return { positions, mode: result.mode, bounds: bounds(positions.values()), requestedMode: mode };
}

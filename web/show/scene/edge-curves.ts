/** 两端固定、缓慢摆动的连线曲线，以及复用缓冲区的几何更新。 */

import * as THREE from "three/webgpu";

const hash = (text: string): number => {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

/** 独立的随机路标，平滑插值，不逐帧抖动。 */
function driftValue(i: number, seed: number): number {
  let h = Math.imul(i ^ seed, 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1;
}

function drift(time: number, seed: number): number {
  const n = Math.floor(time);
  const f = time - n;
  const s = f * f * f * (f * (f * 6 - 15) + 10);
  return driftValue(n, seed) * (1 - s) + driftValue(n + 1, seed) * s;
}

export interface LaneEdge {
  sourceKey: string;
  targetKey: string;
  laneIndex?: number;
  laneCount?: number;
}

/** 两个方向共用车道分配，往返连线不重合。 */
export function assignEdgeLanes<T extends LaneEdge>(edges: T[]): (T & { laneIndex: number; laneCount: number })[] {
  const groups = new Map<string, T[]>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.sourceKey, edge.targetKey].sort());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(edge);
  }
  for (const list of groups.values()) {
    list.forEach((e, i) => {
      e.laneIndex = i;
      e.laneCount = list.length;
    });
  }
  return edges as (T & { laneIndex: number; laneCount: number })[];
}

export class FloatingEdgeCurve extends THREE.Curve<THREE.Vector3> {
  readonly start: THREE.Vector3;
  readonly end: THREE.Vector3;
  time = 0;
  /** Three.js 曲线的长度缓存标志（基类已有，类型声明中缺少）。 */
  needsUpdate = false;
  seed: number;
  speed: number;
  private driftTime = NaN;
  private driftSeed = NaN;
  private float = 0;
  private side = 0;
  private readonly loop: boolean;
  private readonly sway: number;
  private readonly radius: number;
  private readonly u: THREE.Vector3;
  private readonly v: THREE.Vector3;
  private readonly bow: number;
  private readonly wave: number;

  constructor(start: THREE.Vector3, end: THREE.Vector3, sourceKey: string, targetKey: string, laneIndex = 0, laneCount = 1) {
    super();
    this.start = start.clone();
    this.end = end.clone();
    const id = JSON.stringify([sourceKey, targetKey].sort());
    const h = hash(id);
    // 一次主要的摆动过渡用 15—25 秒，与播放速度无关。
    this.seed = (Math.random() * 4294967296) >>> 0;
    this.speed = 1 / (15 + Math.random() * 10);
    this.loop = sourceKey === targetKey;
    this.sway = Math.min(0.55, 0.18 + start.distanceTo(end) * 0.045);
    this.radius = 0.42 + laneIndex * 0.18;
    const direction = end.clone().sub(start);
    if (sourceKey > targetKey) direction.negate();
    if (direction.lengthSq() < 1e-12) direction.set(1, 0, 0);
    direction.normalize();
    const axis = Math.abs(direction.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this.u = new THREE.Vector3().crossVectors(direction, axis).normalize();
    this.v = new THREE.Vector3().crossVectors(direction, this.u).normalize();
    this.bow = 0.16 + Math.min(0.16, start.distanceTo(end) * 0.025) + (laneIndex - (laneCount - 1) / 2) * 0.2;
    this.wave = 0.04 + (h % 11) * 0.003;
  }

  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    if (t <= 0) return target.copy(this.start);
    if (t >= 1) return target.copy(this.end);
    const time = this.time * this.speed;
    const envelope = Math.sin(Math.PI * t);
    // 这两项与 t 无关：同一时刻的全部采样与箭头搜索共用。
    if (this.driftTime !== time || this.driftSeed !== this.seed) {
      this.driftTime = time;
      this.driftSeed = this.seed;
      this.float = drift(time, this.seed) * 0.025;
      this.side = drift(time, this.seed ^ 0x9e3779b9) * 0.025;
    }
    const breeze = this.sway * (0.8 * drift(time + 0.7 * t, this.seed ^ 0x85ebca6b) + 0.2 * drift(time * 1.7 - 1.1 * t, this.seed ^ 0xc2b2ae35));
    if (this.loop) {
      const angle = 2 * Math.PI * t;
      return target.copy(this.start)
        .addScaledVector(this.u, Math.sin(angle) * (this.radius + this.float) + envelope * breeze)
        .addScaledVector(this.v, (1 - Math.cos(angle)) * (this.radius + this.side));
    }
    return target.copy(this.start).lerp(this.end, t)
      .addScaledVector(this.u, envelope * (this.bow + this.float))
      .addScaledVector(this.v, envelope * (this.wave + breeze));
  }
}

/** 更新已有的管状几何缓冲区，动画中不逐帧分配或释放几何体。 */
export function updateTubeGeometry(geometry: THREE.TubeGeometry, curve: THREE.Curve<THREE.Vector3>): void {
  const { tubularSegments, radialSegments, radius } = geometry.parameters;
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const p = geometry.attributes.position as THREE.BufferAttribute;
  const center = new THREE.Vector3();
  let index = 0;
  for (let i = 0; i <= tubularSegments; i++) {
    curve.getPointAt(i / tubularSegments, center);
    for (let j = 0; j <= radialSegments; j++) {
      const angle = j / radialSegments * Math.PI * 2;
      const n = frames.normals[i];
      const b = frames.binormals[i];
      const s = Math.sin(angle);
      const c = -Math.cos(angle);
      p.setXYZ(index++, center.x + radius * (c * n.x + s * b.x), center.y + radius * (c * n.y + s * b.y), center.z + radius * (c * n.z + s * b.z));
    }
  }
  p.needsUpdate = true;
  geometry.computeBoundingSphere();
}

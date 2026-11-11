/**
 * Canvas 2D 软件渲染：WebGPU 不可用时，在同一世界坐标中画出节点、连线、标签与动画。
 */

import * as THREE from "three/webgpu";
import { APP_CONFIG } from "../config.ts";
import type { LabelHandle } from "./node-labels.ts";

type V4 = THREE.Vector4;
type Plane = (v: V4) => number;
interface ScreenPoint {
  x: number;
  y: number;
  z: number;
}

/** Canvas 渲染需要从视图读取的内容。 */
export interface CanvasView {
  readonly networkStyles: unknown;
  readonly appearance: { fontScale: number } | null;
  readonly grid: THREE.GridHelper | null;
  readonly edges: readonly {
    visible?: boolean;
    op: string;
    curve: THREE.Curve<THREE.Vector3>;
    endT: number;
    styleOpacity?: number;
    arrow: THREE.Object3D;
    highlight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
  }[];
  readonly batches: { edgeColor(index: number): number } | null;
  readonly visuals: ReadonlyMap<string, {
    mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
    title: LabelHandle;
    count: LabelHandle;
    q: LabelHandle | null;
  }>;
  readonly signals: readonly {
    edge: { visible?: boolean; curve: THREE.Curve<THREE.Vector3>; endT: number };
    text: THREE.Sprite;
    tip: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    value: string;
  }[];
  readonly signalProgress: number;
  readonly groupBoxes: readonly { box: THREE.Box3; helper: THREE.Box3Helper; label: LabelHandle }[];
  readonly pulses: readonly { sprite: THREE.Sprite; text: string; color: string }[];
  labelColor(base: string): string;
}

/** 长方体 8 个角点（按 x、y、z 三位编号）之间的 12 条棱。 */
const BOX_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]] as const;

// 先裁剪再除以 w：穿过相机的几何不会翻转或发散。
const CLIP_PLANES: Plane[] = [(v) => v.w + v.x, (v) => v.w - v.x, (v) => v.w + v.y, (v) => v.w - v.y, (v) => v.w + v.z, (v) => v.w - v.z];
const WEBGPU_CLIP_PLANES: Plane[] = [...CLIP_PLANES.slice(0, 4), (v) => v.z, CLIP_PLANES[5]];
const FACES = [
  { indices: [1, 3, 7, 5], normal: [1, 0, 0], shade: 0.8 },
  { indices: [0, 4, 6, 2], normal: [-1, 0, 0], shade: 0.65 },
  { indices: [2, 6, 7, 3], normal: [0, 1, 0], shade: 1 },
  { indices: [0, 1, 5, 4], normal: [0, -1, 0], shade: 0.55 },
  { indices: [4, 5, 7, 6], normal: [0, 0, 1], shade: 0.92 },
  { indices: [0, 2, 3, 1], normal: [0, 0, -1], shade: 0.72 },
] as const;

interface Command {
  points: ScreenPoint[];
  fill?: string | null;
  stroke?: string | null;
  width: number;
  alpha: number;
  close: boolean;
  depth: number;
}

interface TextItem {
  point: ScreenPoint;
  text: string;
  fontSize: number;
  color: string;
  order: number;
  alpha?: number;
}

export class CanvasRenderer {
  readonly domElement: HTMLCanvasElement;
  readonly isCanvasRenderer = true;
  private view: CanvasView;
  private readonly config = APP_CONFIG.scene.renderer.software;
  private context: CanvasRenderingContext2D | null;
  private pixelRatio: number;
  private width = 1;
  private height = 1;
  private readonly clearColor = new THREE.Color();
  private clearAlpha = 0;
  private readonly clipMatrix = new THREE.Matrix4();
  private clipPlanes = CLIP_PLANES;
  private readonly cameraPosition = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly commands: Command[] = [];
  private readonly labels: TextItem[] = [];
  private camera: THREE.PerspectiveCamera | null = null;
  private disposed = false;

  constructor(view: CanvasView, canvas: HTMLCanvasElement = document.createElement("canvas")) {
    this.view = view;
    this.domElement = canvas;
    this.context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (!this.context) throw new Error("浏览器无法建立 Canvas 2D 软件渲染画布。");
    this.pixelRatio = this.config.pixelRatio;
  }

  setPixelRatio(ratio: number): void {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    this.pixelRatio = ratio;
    this.setSize(this.width, this.height);
  }

  setClearColor(color: THREE.ColorRepresentation, alpha = 1): void {
    this.clearColor.set(color);
    this.clearAlpha = alpha;
  }

  setSize(width: number, height: number, _updateStyle?: boolean): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    // 画布的 CSS 尺寸由视口决定，渲染器只设置像素尺寸。
    this.domElement.width = Math.max(1, Math.round(this.width * this.pixelRatio));
    this.domElement.height = Math.max(1, Math.round(this.height * this.pixelRatio));
  }

  private clipPoint(point: THREE.Vector3): V4 {
    return new THREE.Vector4(point.x, point.y, point.z, 1).applyMatrix4(this.clipMatrix);
  }

  private screen(point: V4): ScreenPoint | null {
    if (!Number.isFinite(point.w) || point.w <= 0) return null;
    const x = point.x / point.w;
    const y = point.y / point.w;
    const z = point.z / point.w;
    return [x, y, z].every(Number.isFinite) ? { x: (x + 1) * this.width / 2, y: (1 - y) * this.height / 2, z } : null;
  }

  private project(point: THREE.Vector3): ScreenPoint | null {
    const p = this.clipPoint(point);
    return this.clipPlanes.every((plane) => plane(p) >= 0) ? this.screen(p) : null;
  }

  private clippedLine(a: THREE.Vector3, b: THREE.Vector3): [ScreenPoint, ScreenPoint] | null {
    let start = this.clipPoint(a);
    let end = this.clipPoint(b);
    for (const plane of this.clipPlanes) {
      const da = plane(start);
      const db = plane(end);
      if (da < 0 && db < 0) return null;
      if (da < 0 || db < 0) {
        const intersection = start.clone().lerp(end, da / (da - db));
        if (da < 0) start = intersection;
        else end = intersection;
      }
    }
    const p = this.screen(start);
    const q = this.screen(end);
    return p && q ? [p, q] : null;
  }

  private clippedPolygon(points: THREE.Vector3[]): ScreenPoint[] {
    let polygon = points.map((point) => this.clipPoint(point));
    for (const plane of this.clipPlanes) {
      const next: V4[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const da = plane(a);
        const db = plane(b);
        if (da >= 0) next.push(a);
        if ((da < 0) !== (db < 0)) next.push(a.clone().lerp(b, da / (da - db)));
      }
      polygon = next;
      if (polygon.length < 3) return [];
    }
    const projected = polygon.map((point) => this.screen(point));
    return projected.every((p): p is ScreenPoint => p !== null) ? projected as ScreenPoint[] : [];
  }

  private queue(points: ScreenPoint[], { fill = null, stroke = null, width = this.config.lineWidth, alpha = 1, close = false }:
    { fill?: string | null; stroke?: string | null; width?: number; alpha?: number; close?: boolean } = {}): void {
    if (points.length < 2) return;
    this.commands.push({ points, fill, stroke, width, alpha, close, depth: points.reduce((sum, point) => sum + point.z, 0) / points.length });
  }

  private line(a: THREE.Vector3, b: THREE.Vector3, color: string, width = this.config.lineWidth, alpha = 1): void {
    const points = this.clippedLine(a, b);
    if (points) this.queue(points, { stroke: color, width, alpha });
  }

  private polygon(points: THREE.Vector3[], fill: string | null, stroke: string | null = null, width?: number): void {
    this.queue(this.clippedPolygon(points), { fill, stroke, width, close: true });
  }

  private style(value: THREE.ColorRepresentation, shade = 1): string {
    return this.color.set(value).multiplyScalar(shade).getStyle();
  }

  private cube(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>, size: THREE.Vector3): void {
    if (mesh.visible === false) return;
    mesh.updateWorldMatrix(true, false);
    const corners: THREE.Vector3[] = [];
    for (const z of [-1, 1]) {
      for (const y of [-1, 1]) {
        for (const x of [-1, 1]) corners.push(new THREE.Vector3(x * size.x / 2, y * size.y / 2, z * size.z / 2).applyMatrix4(mesh.matrixWorld));
      }
    }
    const center = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const projected = this.project(center);
    const onScreen = corners.map((point) => this.project(point)).filter((p): p is ScreenPoint => p !== null);
    const minimumPixels = this.config.minNodePixels * (this.view.networkStyles ? mesh.scale.x : 1);
    if (projected && onScreen.length === 8
      && Math.max(...onScreen.map((p) => p.x)) - Math.min(...onScreen.map((p) => p.x)) < minimumPixels
      && Math.max(...onScreen.map((p) => p.y)) - Math.min(...onScreen.map((p) => p.y)) < minimumPixels) {
      const half = minimumPixels / 2;
      this.queue([
        { ...projected, x: projected.x - half, y: projected.y - half },
        { ...projected, x: projected.x + half, y: projected.y - half },
        { ...projected, x: projected.x + half, y: projected.y + half },
        { ...projected, x: projected.x - half, y: projected.y + half },
      ], { fill: this.style(mesh.material.color), close: true });
      return;
    }
    for (const face of FACES) {
      const normal = new THREE.Vector3(...face.normal).transformDirection(mesh.matrixWorld);
      const faceCenter = face.indices.reduce((sum, i) => sum.add(corners[i]), new THREE.Vector3()).multiplyScalar(0.25);
      if (normal.dot(this.cameraPosition.clone().sub(faceCenter)) <= 0) continue;
      this.polygon(face.indices.map((i) => corners[i]), this.style(mesh.material.color, face.shade));
    }
  }

  private curve(curve: THREE.Curve<THREE.Vector3>, color: string, width: number, alpha: number, endT = 1): void {
    const segments = Math.max(1, Math.floor(this.config.curveSegments));
    let previous = curve.getPoint(0);
    for (let i = 1; i <= segments; i++) {
      const point = curve.getPoint(endT * i / segments);
      this.line(previous, point, color, width, alpha);
      previous = point;
    }
  }

  private arrow(curve: THREE.Curve<THREE.Vector3>, t: number, color: string, scale = 1, alpha = 1): void {
    const point = this.project(curve.getPoint(t));
    if (!point) return;
    const tangent = curve.getTangent(t);
    const base = curve.getPoint(t).addScaledVector(tangent, -this.config.nodeSize);
    const clipped = this.clippedLine(base, curve.getPoint(t));
    if (!clipped) return;
    const dx = point.x - clipped[0].x;
    const dy = point.y - clipped[0].y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return;
    const ux = dx / length;
    const uy = dy / length;
    const size = this.config.arrowPixels * scale;
    this.queue([point,
      { x: point.x - ux * size - uy * size / 2, y: point.y - uy * size + ux * size / 2, z: point.z },
      { x: point.x - ux * size + uy * size / 2, y: point.y - uy * size - ux * size / 2, z: point.z }], { fill: color, close: true, alpha });
  }

  private label(label: LabelHandle | null): void {
    if (!label || label.visible === false || !label.text || !this.camera) return;
    const point = this.project(label.position);
    if (!point) return;
    const depth = -label.position.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
    const worldHeight = label.fontSize * label.scale.y / 64;
    const height = worldHeight * this.camera.projectionMatrix.elements[5] * this.height / (2 * depth);
    const scale = this.view.appearance?.fontScale ?? 1;
    const fontSize = THREE.MathUtils.clamp(height, this.config.minFontPixels * scale, this.config.maxFontPixels * scale);
    const color = this.color.copy(label.textColor).multiply(label.color).getStyle();
    this.labels.push({ point, text: label.text, fontSize, color, order: label.renderOrder ?? 4 });
  }

  private grid(grid: THREE.GridHelper | null): void {
    if (!grid || !grid.visible) return;
    grid.updateWorldMatrix(true, false);
    const position = grid.geometry.attributes.position as THREE.BufferAttribute | undefined;
    const colors = grid.geometry.attributes.color as THREE.BufferAttribute | undefined;
    if (!position) return;
    const material = grid.material as THREE.LineBasicMaterial;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i + 1 < position.count; i += 2) {
      a.fromBufferAttribute(position, i).applyMatrix4(grid.matrixWorld);
      b.fromBufferAttribute(position, i + 1).applyMatrix4(grid.matrixWorld);
      const color = colors ? this.color.fromBufferAttribute(colors, i).getStyle() : this.style(material.color);
      this.line(a, b, color, this.config.lineWidth, material.opacity);
    }
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const context = this.context;
    if (this.disposed || !context) return;
    this.camera = camera;
    camera.updateMatrixWorld();
    this.clipPlanes = camera.coordinateSystem === THREE.WebGPUCoordinateSystem ? WEBGPU_CLIP_PLANES : CLIP_PLANES;
    camera.getWorldPosition(this.cameraPosition);
    this.clipMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.commands.length = 0;
    this.labels.length = 0;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.domElement.width, this.domElement.height);
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.globalAlpha = 1;
    const background = scene.background instanceof THREE.Color ? scene.background : this.clearAlpha ? this.clearColor : null;
    if (background) {
      context.fillStyle = background.getStyle();
      context.globalAlpha = scene.background ? 1 : this.clearAlpha;
      context.fillRect(0, 0, this.width, this.height);
      context.globalAlpha = 1;
    }
    this.grid(this.view.grid);
    for (const g of this.view.groupBoxes) {
      if (!g.helper.visible || g.box.isEmpty()) continue;
      const color = this.style((g.helper.material as THREE.LineBasicMaterial).color);
      const { min, max } = g.box;
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z));
      for (const [a, b] of BOX_EDGES) this.line(corners[a], corners[b], color, this.config.lineWidth, 0.6);
      this.label(g.label);
    }
    for (const [index, edge] of this.view.edges.entries()) {
      if (edge.visible === false) continue;
      const active = Boolean(edge.highlight?.visible);
      const color = this.style(edge.highlight?.material.color ?? this.view.batches?.edgeColor(index) ?? this.config.edgeColors[edge.op] ?? 0xffffff);
      const opacity = edge.styleOpacity ?? 0.4;
      this.curve(edge.curve, color, active ? this.config.activeLineWidth : this.config.lineWidth, active ? Math.min(1, opacity / 0.4) : opacity, edge.endT);
      this.arrow(edge.curve, edge.endT, color, edge.arrow.scale.x, Math.min(1, opacity / 0.4));
    }
    for (const visual of this.view.visuals.values()) {
      const size = visual.mesh.geometry.parameters;
      this.cube(visual.mesh, new THREE.Vector3(size.width, size.height, size.depth));
      this.label(visual.title);
      this.label(visual.count);
      this.label(visual.q);
    }
    for (const signal of this.view.signals) {
      if (signal.edge.visible === false || signal.text.visible === false || signal.tip.visible === false) continue;
      const at = this.view.signalProgress * signal.edge.endT;
      this.arrow(signal.edge.curve, at, this.style(signal.tip.material.color), 1, signal.tip.material.opacity);
      const point = this.project(signal.text.position);
      if (point) {
        this.labels.push({
          point, text: signal.value, fontSize: this.config.maxFontPixels * (this.view.appearance?.fontScale ?? 1),
          color: this.style(this.view.labelColor(this.config.signalTextColor)), order: signal.text.renderOrder,
          alpha: signal.text.material.opacity,
        });
      }
    }
    const scale = this.view.appearance?.fontScale ?? 1;
    for (const pulse of this.view.pulses) {
      const point = this.project(pulse.sprite.position);
      if (point) this.labels.push({ point, text: pulse.text, fontSize: this.config.maxFontPixels * 0.8 * scale, color: pulse.color, order: 7 });
    }
    // 远处的几何先画；标签与 GPU 的 depthTest:false 一致，最后画。
    this.commands.sort((a, b) => b.depth - a.depth);
    context.lineJoin = "round";
    context.lineCap = "round";
    for (const command of this.commands) {
      context.globalAlpha = command.alpha;
      context.beginPath();
      context.moveTo(command.points[0].x, command.points[0].y);
      for (const point of command.points.slice(1)) context.lineTo(point.x, point.y);
      if (command.close) context.closePath();
      if (command.fill) {
        context.fillStyle = command.fill;
        context.fill();
      }
      if (command.stroke) {
        context.strokeStyle = command.stroke;
        context.lineWidth = command.width;
        context.stroke();
      }
    }
    context.globalAlpha = 1;
    context.textAlign = "center";
    context.textBaseline = "middle";
    this.labels.sort((a, b) => a.order - b.order || b.point.z - a.point.z);
    for (const label of this.labels) {
      context.globalAlpha = label.alpha ?? 1;
      context.fillStyle = label.color;
      context.font = `500 ${label.fontSize}px ${this.config.fontFamily}`;
      context.fillText(label.text, label.point.x, label.point.y);
    }
    context.globalAlpha = 1;
  }

  dispose(): void {
    this.disposed = true;
    this.commands.length = 0;
    this.labels.length = 0;
    this.context = null;
  }
}

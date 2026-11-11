/**
 * 3D 网络视图：节点、连线、标签、选择与逐单元动画。只显示执行会话的状态，不参与执行。
 */

import * as THREE from "three/webgpu";
import { APP_CONFIG } from "../config.ts";
import { type Bit, type Model, depth as pathDepth } from "../../../src/model.ts";
import type { Pulse, Session, Step, Transfer, Unit } from "../session.ts";
import type { Appearance } from "../ui/cosmic-state.ts";
import type { NetworkStyles } from "../ui/network-style-state.ts";
import type { CanvasView } from "./canvas-renderer.ts";
import { FloatingEdgeCurve, assignEdgeLanes, updateTubeGeometry } from "./edge-curves.ts";
import { EditorControls } from "./editor-controls.ts";
import { DEFAULT_LAYOUT_MODE, LAYOUT_MODES, type LayoutMode, type LayoutResult, quickLayout } from "./layout.ts";
import { type DisplayModel, compareDisplayNodes, createDisplayModel, observedPath } from "./model-view.ts";
import { NetworkBatches } from "./network-batches.ts";
import { adjustNetworkLayout, edgeStyleType, resolveNodeStyle } from "./network-style.ts";
import { type LabelHandle, NodeLabels } from "./node-labels.ts";
import { RenderSchedule } from "./render-schedule.ts";
import { type RendererOptions, type SceneRenderer, createRenderer, disposeRenderer } from "./renderer-backend.ts";
import { disposeGroup } from "./resources.ts";

const NODE_SIZE = 0.1;
const TITLE_OFFSET = -0.19;
const COUNT_OFFSET = -0.36;
const COLORS = { X: 0x73aaff, Q: 0xf1f6ff, Y: 0x79dfae, J: 0xe898c0, K: 0x689ef3, error: 0xff596e } as Record<string, number>;

type Box = THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;

interface Visual {
  mesh: Box;
  title: LabelHandle;
  count: LabelHandle;
  q: LabelHandle | null;
  id: string;
  /** Q：JKI；Y：观察点。 */
  type: "Q" | "Y";
  hasEX: boolean;
  base: number;
  styleColor: number;
  lastCount: number;
  batchIndex: number;
  tags: string[];
  isInput: boolean;
  /** 标签上显示的 q 值（只对 JKI）。 */
  qValue: Bit | null;
}

/** 一个 JKS 的边界框与标签。 */
interface GroupBox {
  path: string;
  box: THREE.Box3;
  helper: THREE.Box3Helper;
  label: LabelHandle;
  color: number;
}

/** 节点上的短暂文字：q 写入或发布。 */
interface PulseSprite {
  sprite: THREE.Sprite;
  text: string;
  color: string;
}

/** 动画序列中的一段：一步，或合并后的整个单元。 */
interface Segment {
  transfers: readonly Transfer[];
  pulses: readonly Pulse[];
}

interface DrawEdge {
  source: string;
  target: string;
  targetKey: string;
  sourceKey: string;
  op: string;
  index: number;
  relation: string;
  laneIndex: number;
  laneCount: number;
  curve: FloatingEdgeCurve;
  arrow: THREE.Object3D;
  endT: number;
  visible?: boolean;
  styleOpacity?: number;
  highlight: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial> | null;
}

interface Signal {
  edge: DrawEdge;
  text: THREE.Sprite;
  tip: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  value: string;
}

interface SpriteLabel {
  text: string;
  color: string;
  size: number;
}

export interface ViewStatus {
  backend: "webgpu" | "canvas" | "error";
  label: string;
  reason: string | null;
}

export interface LayoutStatus {
  pending?: boolean;
  error?: string;
  requestedMode?: LayoutMode;
  mode?: string;
}

export interface ViewOptions {
  container: HTMLElement;
  onSelect?: (path: string | null) => void;
  onStatus?: (status: ViewStatus) => void;
  onLayout?: (layout: LayoutStatus) => void;
  /** 逐步播放时当前的步（-1 表示没有逐步播放）。 */
  onStep?: (index: number) => void;
  /** 共用的 WebGPU 设备；不给时只用 Canvas 2D。 */
  device?: () => Promise<GPUDevice>;
}

/** 找到曲线最后一次进入目标节点盒子的位置（含自连接）。 */
export function arrowEnd(curve: THREE.Curve<THREE.Vector3>, center: THREE.Vector3, size = 1): number {
  const box = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3().setScalar(NODE_SIZE * size + 0.035));
  let inside = 1;
  let outside = 0;
  for (let i = 99; i >= 0; i--) {
    const t = i / 100;
    if (!box.containsPoint(curve.getPoint(t))) {
      outside = t;
      break;
    }
    inside = t;
  }
  for (let i = 0; i < 16; i++) {
    const mid = (outside + inside) / 2;
    if (box.containsPoint(curve.getPoint(mid))) inside = mid;
    else outside = mid;
  }
  return outside;
}

function paintLabel(canvas: HTMLCanvasElement, text: string, color: string, size: number): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `500 ${size}px ui-monospace, SFMono-Regular, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 32);
}

/** 动画中随信号移动的数值标签（离屏画布纹理，不是页面 HTML）。 */
function spriteLabel(text: string, color = "#a5bcd3", size = 22): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  paintLabel(canvas, text, color, size);
  const map = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
  sprite.scale.set(1.35, 0.3375, 1);
  sprite.renderOrder = 4;
  sprite.userData.label = { text, color, size } satisfies SpriteLabel;
  return sprite;
}

export class NetworkView implements CanvasView {
  readonly ready: Promise<void>;
  readonly container: HTMLElement;
  private readonly onSelect: (path: string | null) => void;
  private readonly onStatus: (status: ViewStatus) => void;
  private readonly onLayout: (layout: LayoutStatus) => void;
  private readonly device: (() => Promise<GPUDevice>) | undefined;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly group = new THREE.Group();
  private readonly signalGroup = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly labelAppearance = new WeakMap<object, { size?: number; color: THREE.Color | string; scale?: THREE.Vector3 }>();
  readonly visuals = new Map<string, Visual>();
  edges: DrawEdge[] = [];
  signals: Signal[] = [];
  pulses: PulseSprite[] = [];
  groupBoxes: GroupBox[] = [];
  signalProgress = 0;
  grid: THREE.GridHelper | null = null;
  batches: NetworkBatches | null = null;
  appearance: { background: string; opacity: number; foreground: string; fontScale: number } | null = null;
  networkStyles: NetworkStyles | null = null;
  private labels: NodeLabels | null = null;
  private nodeGeometry: THREE.BoxGeometry | null = null;
  private renderer: SceneRenderer | null = null;
  private controls: EditorControls | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private renderSchedule = new RenderSchedule();
  private visibilityChanged: (() => void) | null = null;
  private down: { id: number; x: number; y: number; moved: boolean } | null = null;
  private available = false;
  private disposed = false;
  private fallbackPending: Promise<void> | null = null;
  /** 最近一次渲染器重建；重建逐个进行。 */
  private rebuilding: Promise<void> = Promise.resolve();
  private backendName: "webgpu" | "canvas" = "canvas";
  private fallbackReason: string | null = null;
  private model: DisplayModel | null = null;
  private layout: LayoutResult | null = null;
  private originalLayout: LayoutResult | null = null;
  private layoutMode: LayoutMode = DEFAULT_LAYOUT_MODE;
  private layoutGeneration = 0;
  private layoutWorker: Worker | null = null;
  private edgeTime = 0;
  private lastEdgeUpdate = 0;
  private nodeLabelsHidden = APP_CONFIG.scene.nodeLabelsHidden;
  private blackBackground = APP_CONFIG.scene.blackBackground;
  private selected: string | null = null;
  private counts: ReadonlyMap<string, number> = new Map();
  private jk: Model | null = null;
  private session: Session | null = null;
  private playback = { speed: APP_CONFIG.playback.speed.value, skip: APP_CONFIG.playback.skip };
  private animationStart: number | undefined;
  private animationFrame = 0;
  private readonly onStep: (index: number) => void;
  private showGroups: boolean = APP_CONFIG.scene.jks.visible;
  private sequence: Segment[] = [];
  private sequenceIndex = -1;
  private stepSeconds: number = APP_CONFIG.playback.duration;
  private qOf: (path: string) => Bit | null = () => null;
  private readonly scratch = new THREE.Color();

  constructor({ container, onSelect = () => {}, onStatus = () => {}, onLayout = () => {}, onStep = () => {}, device }: ViewOptions) {
    this.container = container;
    // 选中观察点时选中它读取的 JKI。
    this.onSelect = (key) => onSelect(key === null ? null : observedPath(key));
    this.onStatus = onStatus;
    this.onLayout = (layout) => {
      if (!layout.pending && !layout.error) this.resetCamera();
      onLayout(layout);
    };
    this.device = device;
    this.onStep = onStep;
    this.scene.fog = new THREE.FogExp2(0x0a1422, 0.012);
    const { projection, initial } = APP_CONFIG.scene.camera;
    this.camera = new THREE.PerspectiveCamera(projection.fov, 1, projection.near, projection.far);
    this.camera.position.set(initial.position.x, initial.position.y, initial.position.z);
    this.camera.lookAt(initial.target.x, initial.target.y, initial.target.z);
    this.scene.add(this.group);
    this.scene.add(this.signalGroup);
    this.ready = this.init().then(() => {
      if (this.disposed) {
        this.releaseRenderer();
        return;
      }
      this.resetCamera();
      const frame = (now: number) => {
        if (this.disposed) return;
        if (this.animationStart !== undefined) {
          const elapsed = (now - this.animationStart) / 1000;
          this.progress(Math.min(1, elapsed * this.playback.speed / this.stepSeconds));
          if (this.signalProgress >= 1) this.nextSegment();
        }
        try {
          this.render();
        } catch (error) {
          void this.fail(error instanceof Error ? error : new Error(String(error)));
        }
        this.animationFrame = requestAnimationFrame(frame);
      };
      this.animationFrame = requestAnimationFrame(frame);
    });
  }

  // -- 外观 ---------------------------------------------------------------

  /** 外观只影响显示，可能在渲染器或模型初始化之前到达。 */
  applyAppearance(appearance: Appearance): { changed: boolean; blackBackgroundChanged: boolean } {
    const desk = APP_CONFIG.desktop;
    const defaults = { ...desk.appearance, ...desk.windows.scene.appearance };
    const previous = this.appearance ?? { background: defaults.background, opacity: defaults.opacity, foreground: defaults.foreground, fontScale: defaults.fontScale };
    const color = (value: unknown, fallback: string) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
    const numeric = (value: unknown, key: "opacity" | "fontScale") => {
      const range = desk.windows.scene.appearanceLimits?.[key] ?? desk.appearance.limits[key];
      return typeof value === "number" && Number.isFinite(value) ? THREE.MathUtils.clamp(value, range.min, range.max) : previous[key];
    };
    const next = {
      background: color(appearance.background, previous.background),
      opacity: numeric(appearance.opacity, "opacity"),
      foreground: color(appearance.foreground, previous.foreground),
      fontScale: numeric(appearance.fontScale, "fontScale"),
    };
    if (this.appearance && (Object.keys(next) as (keyof typeof next)[]).every((key) => next[key] === previous[key])) {
      return { changed: false, blackBackgroundChanged: false };
    }
    // 有意修改背景时退出纯黑背景；初始恢复保留该模式。
    const blackBackgroundChanged = Boolean(this.appearance && this.blackBackground
      && (next.background !== previous.background || next.opacity !== previous.opacity));
    this.appearance = next;
    if (blackBackgroundChanged) this.setBlackBackground(false);
    this.syncLabelAppearance();
    this.renderSchedule.invalidate();
    return { changed: true, blackBackgroundChanged };
  }

  labelColor(base: string): string {
    return this.appearance ? this.appearance.foreground : base;
  }

  private styleNodeLabel(handle: LabelHandle | null, original?: { size: number; color: string }): void {
    if (!handle) return;
    let base = this.labelAppearance.get(handle);
    if (!base) {
      base = { size: handle.fontSize, color: handle.textColor.clone() };
      this.labelAppearance.set(handle, base);
    }
    if (original) {
      base.size = original.size;
      (base.color as THREE.Color).set(original.color);
    }
    handle.fontSize = (base.size ?? handle.fontSize) * (this.appearance?.fontScale ?? 1);
    handle.textColor.set(this.appearance ? this.appearance.foreground : (base.color as THREE.Color));
  }

  private styleSignalLabel(signal: Signal): void {
    const handle = signal.text;
    const original = handle.userData.label as SpriteLabel;
    let base = this.labelAppearance.get(handle);
    if (!base) {
      base = { scale: handle.scale.clone(), color: original.color };
      this.labelAppearance.set(handle, base);
    }
    const color = this.labelColor(original.color);
    if (base.color !== color) {
      const map = handle.material.map!;
      paintLabel(map.image as HTMLCanvasElement, original.text, color, original.size);
      map.needsUpdate = true;
      base.color = color;
    }
    handle.scale.copy(base.scale!).multiplyScalar(this.appearance?.fontScale ?? 1);
  }

  private syncLabelAppearance(): void {
    for (const visual of this.visuals.values()) {
      this.styleNodeLabel(visual.title);
      this.styleNodeLabel(visual.count);
      this.styleNodeMarker(visual);
    }
    for (const signal of this.signals) this.styleSignalLabel(signal);
  }

  private styleNodeMarker(visual: Visual): void {
    if (!visual.q) return;
    const defaults = APP_CONFIG.scene.styles.nodes.computationTypes.ex.marker;
    const marker = { ...defaults, ...this.networkStyles?.computation.ex?.marker };
    this.styleNodeLabel(visual.q, { color: defaults.color, size: defaults.size });
    visual.q.textColor.set(marker.color);
    visual.q.visible = visual.mesh.visible && marker.visible;
  }

  setNetworkStyles(state: NetworkStyles | null): void {
    const next = state ? structuredClone(state) : null;
    if (JSON.stringify(next) === JSON.stringify(this.networkStyles)) return;
    const before = this.networkStyles;
    this.networkStyles = next;
    const geometry = (value: NetworkStyles | null) => JSON.stringify({
      lengths: ["J", "K", "trigger", "source", "observe"].map((key) => value?.edges[key]?.length ?? 1),
      sizes: [...this.visuals.values()].map((node) => resolveNodeStyle(node, value)?.size ?? 1),
    });
    if (this.originalLayout && geometry(before) !== geometry(next)) this.applyLayout(this.originalLayout, { preserveMotion: true });
    else this.refresh();
  }

  private placeVisualLabels(visual: Visual): void {
    const offset = NODE_SIZE * (visual.mesh.scale.y - 1) / 2;
    visual.title.position.copy(visual.mesh.position).add(new THREE.Vector3(0, TITLE_OFFSET - offset, 0));
    visual.count.position.copy(visual.mesh.position).add(new THREE.Vector3(0, COUNT_OFFSET - offset, 0));
    visual.q?.position.copy(visual.mesh.position);
  }

  private styleVisual(visual: Visual): void {
    const style = resolveNodeStyle(visual, this.networkStyles);
    visual.mesh.visible = style?.visible !== false;
    visual.mesh.scale.setScalar(style?.size ?? 1);
    visual.styleColor = style ? new THREE.Color(style.color).getHex() : visual.base;
    visual.title.visible = visual.count.visible = visual.mesh.visible && style?.labels !== false && !this.nodeLabelsHidden;
    this.styleNodeMarker(visual);
    this.placeVisualLabels(visual);
    visual.mesh.updateMatrixWorld();
  }

  private syncSignalStyles(): void {
    for (const signal of this.signals) {
      const visible = signal.edge.visible !== false;
      const opacity = this.networkStyles ? Math.min(1, (signal.edge.styleOpacity ?? 0.4) / 0.4) : 1;
      signal.text.visible = signal.tip.visible = visible;
      signal.text.material.opacity = opacity;
      signal.tip.material.transparent = opacity < 1;
      signal.tip.material.opacity = opacity;
    }
  }

  // -- 渲染器 ---------------------------------------------------------------

  private async init(options: RendererOptions = {}): Promise<void> {
    let result = await createRenderer(this, { device: this.device, ...options });
    if (result.backend === "webgpu" && (result.renderer as THREE.WebGPURenderer)._isDeviceLost) {
      disposeRenderer(result.renderer);
      result = await createRenderer(this, { mode: "canvas" });
    }
    this.renderer = result.renderer;
    this.backendName = result.backend;
    this.fallbackReason = result.reason;
    const renderer = this.renderer;
    if (result.backend === "webgpu") {
      const gpu = renderer as THREE.WebGPURenderer;
      const handleLoss = gpu.onDeviceLost.bind(gpu);
      gpu.onDeviceLost = (info) => {
        handleLoss(info);
        if (this.renderer === renderer) void this.fail(new Error(info.message || "GPU 设备连接丢失"));
      };
    }
    const settings = APP_CONFIG.scene.renderer;
    this.renderSchedule = new RenderSchedule(result.backend === "canvas" ? settings.software : settings.gpu);
    renderer.setPixelRatio(result.backend === "canvas" ? settings.software.pixelRatio : Math.min(globalThis.devicePixelRatio || 1, settings.gpu.maxPixelRatio));
    renderer.setClearColor(0x091422, 0);
    this.container.append(renderer.domElement);
    this.controls = new EditorControls(this.camera, renderer.domElement, (ndc) => {
      this.camera.updateMatrixWorld();
      this.raycaster.setFromCamera(ndc, this.camera);
      return this.raycaster.intersectObjects(this.pickObjects(), false)[0]?.point ?? null;
    });
    this.controls.addEventListener("change", () => this.renderSchedule.interact(performance.now()));
    this.visibilityChanged ??= () => this.renderSchedule.resetClock();
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    document.addEventListener("visibilitychange", this.visibilityChanged);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    const element = renderer.domElement;
    element.addEventListener("pointerdown", (e) => {
      this.down = e.button === 0 && !e.shiftKey ? { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false } : null;
    });
    element.addEventListener("pointermove", (e) => {
      if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) this.down.moved = true;
    });
    element.addEventListener("pointercancel", () => {
      this.down = null;
    });
    element.addEventListener("pointerup", (e) => {
      const down = this.down;
      this.down = null;
      if (!down || down.id !== e.pointerId || down.moved || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const rect = element.getBoundingClientRect();
      this.pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
      this.camera.updateMatrixWorld();
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObjects(this.pickObjects(), false)[0];
      this.onSelect((hit?.object.userData.key as string | undefined) ?? null);
    });
    this.available = true;
    this.resize();
    this.onStatus({ backend: result.backend, label: result.backend === "webgpu" ? "WebGPU" : "Canvas 3D", reason: this.fallbackReason });
  }

  private fail(error: Error): Promise<void> | void {
    this.available = false;
    if (this.fallbackPending) return this.fallbackPending;
    if (this.backendName === "webgpu") {
      // 保留场景、执行状态、相机与交互，只替换渲染器。
      this.fallbackPending = this.recover({ mode: "canvas" }).catch((fallbackError: unknown) => {
        this.available = false;
        this.onStatus({ backend: "error", label: "渲染中断", reason: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) });
      }).finally(() => {
        this.fallbackPending = null;
      });
      return this.fallbackPending;
    }
    console.error("3D 渲染中断", error);
    this.onStatus({ backend: "error", label: "渲染中断", reason: error.message });
  }

  /**
   * 重建渲染器（例如从 Canvas 2D 恢复到 WebGPU），保留相机与场景。
   * 上一次重建没有结束时排在它后面，不会同时建两套渲染器。
   */
  recover(options: RendererOptions = {}): Promise<void> {
    this.rebuilding = this.rebuilding.catch(() => {}).then(() => this.rebuild(options));
    return this.rebuilding;
  }

  private async rebuild(options: RendererOptions): Promise<void> {
    if (this.disposed) return;
    this.available = false;
    this.resizeObserver?.disconnect();
    const target = this.controls?.target.clone();
    const position = this.camera.position.clone();
    const quaternion = this.camera.quaternion.clone();
    const up = this.camera.up.clone();
    const limits = this.controls ? { min: this.controls.minDistance, max: this.controls.maxDistance } : null;
    this.controls?.dispose();
    const old = this.renderer;
    this.renderer = null; // 忽略旧设备的异步丢失回调
    old?.domElement.remove();
    disposeRenderer(old);
    await this.init(options);
    if (this.disposed) { // 重建途中页面已关闭
      this.releaseRenderer();
      return;
    }
    this.renderSchedule.resetClock();
    this.camera.position.copy(position);
    this.camera.up.copy(up);
    this.camera.quaternion.copy(quaternion);
    if (target && this.controls && limits) {
      this.controls.target.copy(target);
      this.controls.minDistance = limits.min;
      this.controls.maxDistance = limits.max;
      this.controls.update();
    }
    this.refresh();
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h || !this.renderer) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.controls?.handleResize();
    this.renderSchedule.invalidate();
  }

  resetCamera(): void {
    const b = this.layout?.bounds;
    if (!b) return;
    const center = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    const { projection, fit } = APP_CONFIG.scene.camera;
    const controls = APP_CONFIG.scene.controls;
    const direction = new THREE.Vector3(fit.direction.x, fit.direction.y, fit.direction.z).normalize();
    const fitUp = new THREE.Vector3(fit.up.x, fit.up.y, fit.up.z);
    const right = new THREE.Vector3().crossVectors(fitUp, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    let distance = fit.minDistance;
    // 容纳全部节点及其标签，并为上方的控件留出空间。
    for (const x of [b.min.x - fit.padding.min.x, b.max.x + fit.padding.max.x]) {
      for (const y of [b.min.y - fit.padding.min.y, b.max.y + fit.padding.max.y]) {
        for (const z of [b.min.z - fit.padding.min.z, b.max.z + fit.padding.max.z]) {
          const v = new THREE.Vector3(x, y, z).sub(center);
          const depth = v.dot(direction);
          distance = Math.max(distance, depth + Math.max(Math.abs(v.dot(right)) / (tangent * this.camera.aspect * fit.occupancy.horizontal),
            Math.abs(v.dot(up)) / (tangent * fit.occupancy.vertical)));
        }
      }
    }
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.far = Math.max(projection.far, distance * fit.farMultiplier);
    this.camera.updateProjectionMatrix();
    this.controls?.target.copy(center);
    this.camera.up.copy(fitUp);
    this.camera.lookAt(center);
    if (this.controls) {
      this.controls.minDistance = controls.minDistance;
      this.controls.maxDistance = Math.max(controls.maxDistance, distance * fit.maxDistanceMultiplier);
      this.controls.update();
    }
    this.renderSchedule.invalidate();
  }

  // -- 布局 ---------------------------------------------------------------

  private requestLayout(mode: LayoutMode = this.layoutMode): void {
    if (!this.model) return;
    this.layoutMode = mode;
    const generation = ++this.layoutGeneration;
    this.layoutWorker?.terminate();
    this.onLayout({ pending: true, requestedMode: mode });
    const worker = new Worker(new URL("./layout-worker.ts", import.meta.url), { type: "module" });
    this.layoutWorker = worker;
    worker.onmessage = ({ data }: MessageEvent<{ result?: LayoutResult; error?: string }>) => {
      if (generation !== this.layoutGeneration) return;
      worker.terminate();
      this.layoutWorker = null;
      if (data.error || !data.result) {
        this.onLayout({ error: data.error ?? "布局计算失败", requestedMode: mode });
        return;
      }
      this.applyLayout(data.result);
      this.onLayout(data.result);
    };
    worker.onerror = (event) => {
      if (generation !== this.layoutGeneration) return;
      worker.terminate();
      this.layoutWorker = null;
      this.onLayout({ error: event.message || "布局计算失败", requestedMode: mode });
    };
    worker.postMessage({ model: this.model, mode });
  }

  private applyLayout(original: LayoutResult, { preserveMotion = false } = {}): void {
    this.originalLayout = original;
    const layout = adjustNetworkLayout(original, this.edges, this.networkStyles, APP_CONFIG.scene.styles.layout);
    this.layout = layout;
    for (const [key, v] of this.visuals) {
      const p = layout.positions.get(key);
      if (!p) continue;
      v.mesh.position.set(p.x, p.y, p.z);
      this.styleVisual(v);
      v.mesh.updateMatrixWorld();
      this.batches?.setNode(v.batchIndex, v.mesh);
    }
    const byId = new Map<string, THREE.Vector3>();
    for (const v of this.visuals.values()) if (!byId.has(v.id)) byId.set(v.id, v.mesh.position);
    for (const [index, edge] of this.edges.entries()) {
      const prior = edge.curve;
      const target = this.visuals.get(edge.targetKey)!;
      edge.curve = this.edgeCurve(byId.get(edge.source)!, target.mesh.position, edge.laneIndex, edge.laneCount, edge.sourceKey, edge.targetKey);
      if (preserveMotion) {
        edge.curve.seed = prior.seed;
        edge.curve.speed = prior.speed;
      }
      if (edge.highlight) {
        this.group.remove(edge.highlight);
        edge.highlight.geometry.dispose();
        edge.highlight.material.dispose();
        edge.highlight = null;
      }
      edge.endT = arrowEnd(edge.curve, target.mesh.position, target.mesh.scale.x);
      edge.arrow.position.copy(edge.curve.getPoint(edge.endT));
      edge.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), edge.curve.getTangent(edge.endT).normalize());
      this.batches?.setEdge(index, edge.curve, edge.endT, edge.arrow);
    }
    if (this.grid) this.grid.position.y = layout.bounds.min.y - 1.5;
    this.updateGroups();
    this.progress(this.signalProgress);
    this.refresh();
  }

  private edgeCurve(start: THREE.Vector3, end: THREE.Vector3, index: number, total: number, sourceKey: string, targetKey: string): FloatingEdgeCurve {
    const curve = new FloatingEdgeCurve(start, end, sourceKey, targetKey, index, total);
    curve.time = this.edgeTime;
    return curve;
  }

  setLayout(mode: string): void {
    if (!(LAYOUT_MODES as readonly string[]).includes(mode)) throw new Error(`未知布局：${mode}`);
    if (this.model) this.requestLayout(mode as LayoutMode);
    else this.layoutMode = mode as LayoutMode;
  }

  // -- 模型与状态 -----------------------------------------------------------

  /** 换一个 JKM：投影重建，观察点取自模型的 output（§8.1）。 */
  setModel(model: Model): void {
    this.jk = model;
    this.session = null;
    this.qOf = () => null;
    this.counts = new Map();
    this.animationStart = undefined;
    this.setDisplayModel(createDisplayModel(model));
    this.resetCamera();
  }

  private setDisplayModel(model: DisplayModel): void {
    this.labels?.dispose();
    this.batches?.dispose();
    for (const v of this.visuals.values()) v.mesh.material.dispose();
    this.nodeGeometry?.dispose();
    disposeGroup(this.group);
    this.clearSignals();
    this.visuals.clear();
    this.edges = [];
    this.grid = null;
    this.labels = new NodeLabels();
    this.group.add(this.labels.group);
    this.model = model;
    const labels = this.labels;
    const sorted = [...model.nodes].sort(compareDisplayNodes);
    this.layout = quickLayout(model);
    this.originalLayout = this.layout;
    const geometry = new THREE.BoxGeometry(NODE_SIZE, NODE_SIZE, NODE_SIZE);
    this.nodeGeometry = geometry;
    const positions = new Map<string, THREE.Vector3>();
    const keysById = new Map<string, string>();
    const marker = APP_CONFIG.scene.styles.nodes.computationTypes.ex.marker;
    const at = (key: string) => {
      const p = this.layout!.positions.get(key)!;
      return new THREE.Vector3(p.x, p.y, p.z);
    };
    const add = (key: string, id: string, type: "Q" | "Y", pos: THREE.Vector3, hasEX: boolean, displayName: string): Visual => {
      // 场景外的轻量代理保留逐节点的拾取与位置。
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: COLORS[type] }));
      mesh.position.copy(pos);
      mesh.userData.key = key;
      mesh.updateMatrixWorld();
      const title = labels.add(displayName);
      title.position.copy(pos).add(new THREE.Vector3(0, TITLE_OFFSET, 0));
      const count = labels.add(type === "Q" ? "0 次" : "", { color: "#5c7a96", size: 17 });
      count.position.copy(pos).add(new THREE.Vector3(0, COUNT_OFFSET, 0));
      title.visible = count.visible = !this.nodeLabelsHidden;
      const q = hasEX ? labels.add("x", { color: marker.color, size: marker.size, renderOrder: 6 }) : null;
      if (q) {
        q.scale.set(0.46, 0.115, 1);
        q.position.copy(pos);
      }
      const visual: Visual = {
        mesh, title, count, q, id, type, hasEX, base: COLORS[type], styleColor: COLORS[type], lastCount: 0,
        batchIndex: this.visuals.size, tags: [], isInput: false, qValue: null,
      };
      this.visuals.set(key, visual);
      if (!positions.has(id)) {
        positions.set(id, pos);
        keysById.set(id, key);
      }
      return visual;
    };
    for (const n of sorted) {
      const visual = add(n.key, n.id, "Q", at(n.key), n.hasEX, n.displayName);
      visual.tags = n.tags;
      visual.isInput = n.isInput;
      if (n.isInput) {
        visual.base = COLORS.X;
        visual.mesh.material.color.setHex(COLORS.X);
      }
    }
    for (const o of model.outputs) add(o.id, o.id, "Y", at(o.id), false, o.displayName).tags = o.tags;
    const rawEdges: Omit<DrawEdge, "sourceKey" | "laneIndex" | "laneCount" | "curve" | "arrow" | "endT" | "highlight">[] = [];
    for (const n of model.nodes) {
      for (const t of n.tokens) {
        if (t.source) rawEdges.push({ source: t.source, target: n.id, targetKey: n.key, op: t.op, index: t.index, relation: t.relation });
      }
    }
    for (const o of model.outputs) {
      if (positions.has(o.source)) rawEdges.push({ source: o.source, target: o.id, targetKey: o.id, op: "Y", index: 0, relation: "observe" });
    }
    const drawable = rawEdges.filter((e) => positions.has(e.source) && this.visuals.has(e.targetKey))
      .map((e) => ({ ...e, sourceKey: keysById.get(e.source)! }));
    for (const e of assignEdgeLanes(drawable)) {
      const start = positions.get(e.source);
      const end = this.visuals.get(e.targetKey)?.mesh.position;
      if (!start || !end) continue;
      const curve = this.edgeCurve(start, end, e.laneIndex, e.laneCount, e.sourceKey, e.targetKey);
      const endT = arrowEnd(curve, end);
      const arrow = new THREE.Object3D();
      arrow.position.copy(curve.getPoint(endT));
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(endT).normalize());
      this.edges.push({ ...e, curve, arrow, endT, highlight: null });
    }
    const batches = new NetworkBatches(this.visuals.size, this.edges.length);
    this.batches = batches;
    this.group.add(batches.group);
    for (const v of this.visuals.values()) batches.setNode(v.batchIndex, v.mesh);
    this.edges.forEach((e, i) => {
      batches.setEdge(i, e.curve, e.endT, e.arrow);
      batches.setEdgeStyle(i, COLORS[e.op] ?? COLORS.K, false);
    });
    batches.commit();
    this.createGroups(labels);
    this.syncLabelAppearance();
    labels.flush();
    const b = this.layout.bounds;
    const size = Math.max(20, b.max.x - b.min.x + 8, b.max.z - b.min.z + 8);
    const grid = new THREE.GridHelper(size, Math.min(100, Math.ceil(size)), 0x29445a, 0x172c40);
    grid.position.y = b.min.y - 1.5;
    const gridMaterial = grid.material as THREE.LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.35;
    this.group.add(grid);
    this.grid = grid;
    this.setBlackBackground(this.blackBackground);
    if (this.networkStyles) this.applyLayout(this.originalLayout, { preserveMotion: true });
    else {
      this.updateGroups();
      this.refresh();
    }
    this.requestLayout();
  }

  /** 每个 JKS 一个边界框与标签（颜色按登记类型）；位置在布局后由 updateGroups 计算。 */
  private createGroups(labels: NodeLabels): void {
    this.groupBoxes = [];
    const jk = this.jk;
    if (!jk) return;
    const colors = APP_CONFIG.scene.jks;
    for (const [path, definition] of jk.jks) {
      const color = jk.txGroups.has(path) ? colors.transaction : Object.hasOwn(definition.trigger, "all") ? colors.all : colors.any;
      const box = new THREE.Box3();
      const helper = new THREE.Box3Helper(box, color);
      helper.visible = false;
      this.group.add(helper);
      const registrations = Object.entries(definition.trigger).map(([type, ids]) => `${type}[${(ids ?? []).join(",")}]`).join(" ");
      const label = labels.add(`${path} · ${registrations}`, { color: "#8fb3d9", size: 18 });
      label.visible = false;
      this.groupBoxes.push({ path, box, helper, label, color });
    }
  }

  /** 按成员 JKI 的位置计算各 JKS 的边界框；外层的框留得更宽，嵌套关系看得出来。 */
  private updateGroups(): void {
    const jk = this.jk;
    if (!jk) return;
    const maxDepth = Math.max(1, ...this.groupBoxes.map((g) => pathDepth(g.path)));
    for (const g of this.groupBoxes) {
      g.box.makeEmpty();
      for (const path of jk.members.get(g.path) ?? []) {
        const visual = this.visuals.get(path);
        if (visual && visual.mesh.visible !== false) g.box.expandByPoint(visual.mesh.position);
      }
      const empty = g.box.isEmpty();
      if (!empty) {
        g.box.expandByScalar(0.24 + 0.16 * (maxDepth - pathDepth(g.path)));
        g.label.position.set((g.box.min.x + g.box.max.x) / 2, g.box.max.y + 0.12, g.box.max.z);
      }
      g.helper.visible = this.showGroups && !empty;
      g.helper.updateMatrixWorld(true);
      g.label.visible = g.helper.visible && !this.nodeLabelsHidden;
    }
    this.renderSchedule.invalidate();
  }

  /** 显示或隐藏 JKS 边界框。 */
  setGroupsVisible(visible: boolean): void {
    this.showGroups = visible;
    this.updateGroups();
  }

  /** 读取会话状态：执行次数、选中的节点与 q 被写入的节点。 */
  update(session: Session, selected: string | null): void {
    if (!this.jk) return;
    const changed = session !== this.session || selected !== this.selected;
    if (session !== this.session) {
      this.clearSignals();
      this.animationStart = undefined;
      this.sequence = [];
      this.sequenceIndex = -1;
    }
    this.session = session;
    this.qOf = (path) => session.ex.q.get(path) ?? null;
    this.counts = session.counts;
    this.selected = selected;
    const dirty = session.takeDirty();
    if (changed) this.refresh();
    else if (dirty.length) this.refreshNodes(dirty);
  }

  private pickObjects(): THREE.Object3D[] {
    return [...this.visuals.values()].filter((v) => v.mesh.visible !== false).map((v) => v.mesh);
  }

  setBlackBackground(enabled: boolean): void {
    this.blackBackground = enabled;
    this.scene.background = enabled ? new THREE.Color(0x000000) : null;
    this.scene.fog = enabled ? null : new THREE.FogExp2(0x0a1422, 0.012);
    if (this.grid) this.grid.visible = !enabled;
    this.container.closest(".main-view")?.classList.toggle("black-background", enabled);
    this.renderSchedule.invalidate();
  }

  setLabels(enabled: boolean): void {
    this.nodeLabelsHidden = !enabled;
    for (const v of this.visuals.values()) this.styleVisual(v);
    this.updateGroups();
  }

  fit(): void {
    this.resetCamera();
  }

  setPlayback({ speed = this.playback.speed, skip = this.playback.skip }: { speed?: number; skip?: boolean } = {}): void {
    const skipChanged = skip && !this.playback.skip;
    if (this.animationStart !== undefined && speed !== this.playback.speed) {
      const now = performance.now();
      this.animationStart = now - (now - this.animationStart) * this.playback.speed / speed;
    }
    this.playback = { speed, skip };
    if (skipChanged) {
      this.clearSignals();
      this.animationStart = undefined;
    }
  }

  /**
   * 一个处理单元完成后播放它的动画，返回动画时长（毫秒）。多步的单元（事务）在步数不超过上限时逐步播放，
   * 否则整个单元一起显示。动画数据来自执行器报告的执行细节。
   */
  onUnit(unit: Unit | null, { force = false } = {}): number {
    if (!unit || !this.jk || !unit.detailed || (this.playback.skip && !force)) return 0;
    const steps = APP_CONFIG.playback.steps;
    const stepped = unit.steps.length > 1 && unit.steps.length <= steps.max;
    this.sequence = stepped ? unit.steps : [{ transfers: unit.steps.flatMap((s) => s.transfers), pulses: unit.steps.flatMap((s) => s.pulses) }];
    this.stepSeconds = stepped ? steps.duration : APP_CONFIG.playback.duration;
    this.playSegment(0, stepped ? 0 : -1);
    // 没有可画的内容（例如投递只形成事务任务、受整合订阅者在事务外收不到）时不占动画时长。
    if (this.sequence.every((s) => !s.transfers.length && !s.pulses.length)) return 0;
    return this.sequence.length * this.stepSeconds * 1000 / this.playback.speed;
  }

  /** 单独重播某一步（在本单元窗口中点选）。 */
  showStep(step: Step, index: number): void {
    if (!this.jk) return;
    this.sequence = [step];
    this.stepSeconds = APP_CONFIG.playback.steps.duration;
    this.playSegment(0, index);
  }

  private playSegment(index: number, reported: number): void {
    this.sequenceIndex = index;
    const segment = this.sequence[index];
    this.showTransfers(segment.transfers.slice(0, APP_CONFIG.playback.maxVisuals), segment.pulses);
    this.animationStart = performance.now();
    this.onStep(reported);
  }

  private nextSegment(): void {
    if (this.sequence.length > 1 && this.sequenceIndex + 1 < this.sequence.length) {
      const next = this.sequenceIndex + 1;
      this.playSegment(next, next);
      return;
    }
    this.clearSignals();
    this.animationStart = undefined;
    this.sequence = [];
    this.sequenceIndex = -1;
    this.onStep(-1);
  }

  /** 验收用：场景当前显示的节点 q、执行次数与其他计数。 */
  inspect(): { nodes: Record<string, { q: Bit | null; count: number; visible: boolean }>; observe: number; groups: number; layout: string } {
    const nodes: Record<string, { q: Bit | null; count: number; visible: boolean }> = {};
    for (const [key, v] of this.visuals) if (v.type === "Q") nodes[key] = { q: v.qValue, count: v.lastCount, visible: v.mesh.visible };
    return {
      nodes, observe: [...this.visuals.values()].filter((v) => v.type === "Y").length,
      groups: this.groupBoxes.filter((g) => g.helper.visible).length, layout: this.layout?.mode ?? "",
    };
  }

  /** 选中的 JKS 及其成员、前置（选中的是 JKI 时都为 null）。 */
  private selectedGroup(): { group: string; members: ReadonlySet<string>; prereqs: ReadonlySet<string> } | null {
    const jk = this.jk;
    if (!jk || this.selected === null || !jk.jks.has(this.selected)) return null;
    return { group: this.selected, members: jk.members.get(this.selected)!, prereqs: jk.prereqs.get(this.selected)! };
  }

  /** 节点的颜色（q=0 变暗）、标题颜色与“q · 次数”标签。 */
  private paintVisual(key: string, v: Visual, count: number, group: ReturnType<NetworkView["selectedGroup"]>): void {
    const q = v.type === "Q" ? this.qOf(key) : null;
    this.scratch.setHex(count > 1000 ? COLORS.error : v.styleColor);
    if (q === 0) this.scratch.multiplyScalar(APP_CONFIG.scene.qDisplay.zeroBrightness);
    v.mesh.material.color.copy(this.scratch);
    const title = key === this.selected ? 0x85efd0 : group?.prereqs.has(key) ? 0xffd27a : group?.members.has(key) ? 0xbfe9ff : 0xffffff;
    v.title.color.setHex(title);
    if (v.type === "Q" && (count !== v.lastCount || q !== v.qValue)) {
      const countColor = count > 1000 ? "#ff697e" : "#5c7a96";
      v.count.setText(`q=${q ?? "—"} · ${count} 次`, countColor, 17);
      this.styleNodeLabel(v.count, { color: countColor, size: 17 });
      v.lastCount = count;
      v.qValue = q;
    }
  }

  /** 只更新 q 被写入过的节点；某个节点的次数越过 1000 时整体刷新（连线要变红）。 */
  private refreshNodes(paths: readonly string[]): void {
    const group = this.selectedGroup();
    for (const path of paths) {
      const v = this.visuals.get(path);
      if (!v) continue;
      const count = this.counts.get(path) ?? 0;
      if (count > 1000 && v.lastCount <= 1000) {
        this.refresh();
        return;
      }
      this.paintVisual(path, v, count, group);
      this.batches?.setNode(v.batchIndex, v.mesh);
    }
    this.batches?.commit();
    this.renderSchedule.invalidate();
  }

  private refresh(): void {
    const group = this.selectedGroup();
    const selectedId = this.selected === null || group ? undefined : this.visuals.get(this.selected)?.id;
    const high = new Set<string>();
    for (const [key, v] of this.visuals) {
      this.styleVisual(v);
      const count = this.counts.get(key) ?? 0;
      if (count > 1000) high.add(v.id);
      this.paintVisual(key, v, count, group);
      this.batches?.setNode(v.batchIndex, v.mesh);
    }
    for (const g of this.groupBoxes) {
      (g.helper.material as THREE.LineBasicMaterial).color.setHex(g.path === group?.group ? APP_CONFIG.scene.jks.selected : g.color);
    }
    for (const [index, e] of this.edges.entries()) {
      const style = this.networkStyles?.edges[edgeStyleType(e)];
      e.visible = style?.visible !== false && (style?.opacity ?? 0.4) > 0
        && this.visuals.get(e.sourceKey)?.mesh.visible !== false && this.visuals.get(e.targetKey)?.mesh.visible !== false;
      e.styleOpacity = style?.opacity ?? 0.4;
      // 选中 JKI：与它相连的连线；选中 JKS：从前置到受整合订阅者的触发连线（§5.3）。
      const active = e.visible && ((Boolean(selectedId) && (e.source === selectedId || e.targetKey === this.selected))
        || (group !== null && e.relation === "trigger" && group.prereqs.has(e.source) && this.jk!.gated(group.group, e.targetKey)));
      const red = high.has(e.source) || high.has(e.target);
      const color = red ? COLORS.error : style ? new THREE.Color(style.color).getHex() : COLORS[e.op] ?? COLORS.K;
      e.arrow.scale.setScalar(active ? 1.35 : 1);
      this.batches?.setEdgeStyle(index, color, active, this.networkStyles ? { opacity: e.styleOpacity, visible: e.visible } : null);
      // 管状几何在 WebGPU 上有真实粗细；LineBasicMaterial 的 linewidth 不起作用。
      if (active && !e.highlight) {
        e.highlight = new THREE.Mesh(new THREE.TubeGeometry(e.curve, 36, 0.014, 5, false), new THREE.MeshBasicMaterial({ color }));
        this.group.add(e.highlight);
      }
      if (e.highlight) {
        if (active && !e.highlight.visible) updateTubeGeometry(e.highlight.geometry, e.curve);
        e.highlight.visible = active;
        e.highlight.material.color.setHex(color);
        e.highlight.material.opacity = Math.min(1, e.styleOpacity / 0.4);
        e.highlight.material.transparent = e.highlight.material.opacity < 1;
      }
    }
    this.syncSignalStyles();
    this.batches?.commit();
    this.renderSchedule.invalidate();
  }

  // -- 动画 ---------------------------------------------------------------

  private clearSignals(): void {
    disposeGroup(this.signalGroup);
    this.signals = [];
    this.pulses = [];
    this.renderSchedule.invalidate();
  }

  private showTransfers(transfers: readonly Transfer[], pulses: readonly Pulse[] = []): void {
    this.clearSignals();
    if (!this.available) return;
    const colors = APP_CONFIG.scene.signals;
    for (const edge of this.edges) {
      if (edge.visible === false) continue;
      const transfer = transfers.find((t) => t.source === edge.source && t.target === edge.target
        && t.relation === edge.relation && (t.index === undefined || t.index === edge.index));
      if (!transfer) continue;
      const text = spriteLabel(transfer.value, "#eefcf8", 34);
      text.scale.set(1.5, 0.375, 1);
      this.signalGroup.add(text);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.11, 8).translate(0, -0.055, 0), new THREE.MeshBasicMaterial({ color: colors[transfer.relation] }));
      this.signalGroup.add(tip);
      const signal: Signal = { edge, text, tip, value: transfer.value };
      this.signals.push(signal);
      this.styleSignalLabel(signal);
    }
    for (const pulse of pulses) {
      const visual = this.visuals.get(pulse.path);
      if (!visual || visual.mesh.visible === false) continue;
      const color = pulse.kind === "write" ? colors.write : colors.publish;
      const sprite = spriteLabel(pulse.text, color, 30);
      sprite.scale.set(1.2, 0.3, 1).multiplyScalar(this.appearance?.fontScale ?? 1);
      sprite.position.copy(visual.mesh.position).add(new THREE.Vector3(0, pulse.kind === "write" ? 0.3 : 0.48, 0));
      this.signalGroup.add(sprite);
      this.pulses.push({ sprite, text: pulse.text, color });
    }
    this.syncSignalStyles();
    this.progress(0);
  }

  private progress(t: number): void {
    this.signalProgress = t;
    if (this.signals.length) this.renderSchedule.invalidate();
    for (const { edge, text, tip } of this.signals) {
      const at = t * edge.endT;
      tip.position.copy(edge.curve.getPoint(at));
      tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), edge.curve.getTangent(at).normalize());
      text.position.copy(edge.curve.getPoint(Math.max(0, at - 0.09))).add(new THREE.Vector3(0, 0.23, 0));
    }
  }

  private render(): void {
    if (!this.available || !this.renderer || !this.controls) return;
    const now = performance.now();
    this.controls.update();
    const frame = this.renderSchedule.sample(now, { active: this.signals.length > 0 && this.signalProgress < 1, hidden: document.hidden });
    if (!frame) return;
    this.edgeTime += frame.deltaSeconds;
    // 连线以 20 Hz 缓慢摆动；缓冲区持久，箭头、高亮与信号保持一致。
    if (now - this.lastEdgeUpdate >= 50) {
      this.lastEdgeUpdate = now;
      for (const [index, e] of this.edges.entries()) {
        const target = this.visuals.get(e.targetKey)!;
        e.curve.time = this.edgeTime;
        e.curve.needsUpdate = true;
        e.endT = arrowEnd(e.curve, target.mesh.position, target.mesh.scale.x);
        e.arrow.position.copy(e.curve.getPoint(e.endT));
        e.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), e.curve.getTangent(e.endT).normalize());
        this.batches?.setEdge(index, e.curve, e.endT, e.arrow);
        if (e.highlight?.visible) updateTubeGeometry(e.highlight.geometry, e.curve);
      }
      this.progress(this.signalProgress);
    }
    this.batches?.commit();
    this.labels?.flush();
    this.renderer.render(this.scene, this.camera);
  }

  private releaseRenderer(): void {
    this.available = false;
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    if (this.visibilityChanged) document.removeEventListener("visibilitychange", this.visibilityChanged);
    const renderer = this.renderer;
    this.renderer = null;
    renderer?.domElement.remove();
    disposeRenderer(renderer);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.layoutGeneration += 1;
    this.layoutWorker?.terminate();
    this.releaseRenderer();
    this.clearSignals();
    this.labels?.dispose();
    this.batches?.dispose();
    for (const visual of this.visuals.values()) visual.mesh.material.dispose();
    this.nodeGeometry?.dispose();
    disposeGroup(this.group);
    this.scene.clear();
    this.visuals.clear();
  }
}

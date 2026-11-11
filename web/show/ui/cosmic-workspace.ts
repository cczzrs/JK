/**
 * 桌面窗口管理：把页面中已有的窗口标记与本地窗口状态绑定。只设置 CSS 变量和属性，不生成 HTML 或 CSS 规则。
 */

import type { DesktopConfig, Zone } from "../config.ts";
import {
  type Appearance, type AreaMetrics, type DisplayMode, type GlobalColorKey, type Layout, type Rect, type RailState,
  type WindowState, type WorkspaceState, GLOBAL_APPEARANCE_KEYS, appearanceLimits, changeDisplayMode, changeWindowGeometry,
  clamp, defaultAppearance, defaultGlobalAppearance, defaultWorkspaceState, fitRailWidth, fitWindowGeometry,
  isRailAppearanceTarget, normalizeAppearance, normalizeGlobalAppearance, normalizeWorkspaceState, placeWindowGeometry,
  resetCurrentLayout, windowPointFromPointer,
} from "./cosmic-state.ts";
import { need } from "./dom.ts";

/** 全局外观字段：[输入框 id 后缀, CSS 变量名后缀]。 */
const GLOBAL_FIELDS = {
  background: ["global-background", "desktop-bg"],
  accent: ["global-accent", "accent"],
  hover: ["global-hover", "hover"],
  focus: ["global-focus", "focus"],
  border: ["global-border", "border-color"],
  selectionBackground: ["global-selection-bg", "selection-bg"],
  selectionForeground: ["global-selection-text", "selection-text"],
} as const satisfies Record<GlobalColorKey, readonly [string, string]>;
type GlobalInput = (typeof GLOBAL_FIELDS)[GlobalColorKey][0];

/** 外观面板的控件，按元素类型分组（id 为 cosmic-style- 加名称）。 */
const INPUT_NAMES = [
  "bg", "fg", "alpha", "radius", "icon-color", "icon-alpha", "icon-size", "font-alpha", "font-size", "font-scale",
  "global-glass-enabled", "global-glass-blur",
] as const;
const TEXT_NAMES = [
  "alpha-value", "radius-value", "icon-alpha-value", "icon-size-value", "font-alpha-value", "font-size-value",
  "font-scale-value", "global-glass-blur-value",
] as const;
const BLOCK_NAMES = [
  "rail-fields", "font-alpha-field", "font-size-field", "font-scale-field", "surface-fields", "text-fields", "global-fields", "scene-hint",
] as const;
type InputName = (typeof INPUT_NAMES)[number] | GlobalInput;

function setRange(input: HTMLInputElement, limit: { min: number; max: number; step: number }, value: number): void {
  input.min = String(limit.min);
  input.max = String(limit.max);
  input.step = String(limit.step);
  input.value = String(value);
}

type GestureKind = "rail-width" | "rail-menu" | "split" | "resize" | "move";

interface Gesture {
  kind: GestureKind;
  key: string | undefined;
  handle: HTMLElement;
  pointerId: number;
  clientX: number;
  clientY: number;
  scrollTop: number;
  start: Rect | undefined;
  before: WindowState | undefined;
  split: number;
  moved: boolean;
  rail: RailState | undefined;
  railWidth: number;
  railHeight: number;
  grab: { x: number; y: number } | undefined;
}

export interface CosmicOptions {
  root: HTMLElement;
  config: DesktopConfig;
  onCommand?: (command: string) => void;
  onAppearanceChange?: (key: string, appearance: Appearance) => void;
}

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];

export class CosmicWorkspace {
  readonly root: HTMLElement;
  readonly config: DesktopConfig;
  private readonly onCommand: (command: string) => void;
  private readonly onAppearanceChange: (key: string, appearance: Appearance) => void;
  private readonly doc: Document;
  private readonly desktop: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly sceneArea: HTMLElement;
  private readonly splitter: HTMLButtonElement;
  private readonly shell: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly railResize: HTMLElement;
  private readonly railSplitter: HTMLElement;
  private readonly railMenu: HTMLElement;
  private readonly railDock: HTMLElement;
  private readonly elements: Map<string, HTMLElement>;
  private readonly appearancePanels: Map<string, HTMLElement>;
  private readonly inputs: Record<InputName, HTMLInputElement>;
  private readonly texts: Record<(typeof TEXT_NAMES)[number], HTMLElement>;
  private readonly blocks: Record<(typeof BLOCK_NAMES)[number], HTMLElement>;
  private readonly target: HTMLSelectElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly listeners: (() => void)[] = [];
  private readonly observer: ResizeObserver;
  private active = true;
  private gesture: Gesture | null = null;
  private disposed = false;
  private rendering = false;
  private frame: number | null = null;
  private exitPending = false;
  private completingExitAction = false;
  private state: WorkspaceState;
  private focused: string;
  private styleTarget: string;

  constructor({ root, config, onCommand = () => {}, onAppearanceChange = () => {} }: CosmicOptions) {
    this.root = root;
    this.config = config;
    this.onCommand = onCommand;
    this.onAppearanceChange = onAppearanceChange;
    this.doc = root.ownerDocument;
    this.desktop = need(root, ".cosmic-desktop");
    this.canvas = need(root, ".cosmic-canvas");
    this.sceneArea = need(root, ".cosmic-scene-area");
    this.splitter = need(root, "#cosmic-splitter", HTMLButtonElement);
    this.shell = need(root, ".cosmic-shell");
    this.rail = need(root, ".cosmic-rail");
    this.railResize = need(root, "#cosmic-rail-resize");
    this.railSplitter = need(root, "#cosmic-rail-splitter");
    this.railMenu = need(root, "#cosmic-menu");
    this.railDock = need(root, "#cosmic-dock");
    this.elements = new Map([...root.querySelectorAll<HTMLElement>("[data-cosmic-window]")]
      .map((element) => [element.dataset.cosmicWindow!, element]));
    this.state = this.restore();
    this.focused = this.layout.order.findLast((key) => this.windows[key].visible) ?? "scene";
    this.styleTarget = this.isAppearanceTarget(config.appearance.target) ? config.appearance.target : this.focused;
    this.appearancePanels = new Map(Object.entries(config.appearance.panels).map(([key, id]) => [key, need(root, `#${id}`)]));
    const field = <T extends HTMLElement>(name: string, type?: { new (): T; prototype: T }) => need<T>(root, `#cosmic-style-${name}`, type);
    const inputNames: InputName[] = [...INPUT_NAMES, ...Object.values(GLOBAL_FIELDS).map(([name]) => name)];
    this.inputs = Object.fromEntries(inputNames.map((name) => [name, field(name, HTMLInputElement)])) as Record<InputName, HTMLInputElement>;
    this.texts = Object.fromEntries(TEXT_NAMES.map((name) => [name, field(name)])) as Record<(typeof TEXT_NAMES)[number], HTMLElement>;
    this.blocks = Object.fromEntries(BLOCK_NAMES.map((name) => [name, field(name)])) as Record<(typeof BLOCK_NAMES)[number], HTMLElement>;
    this.target = field("target", HTMLSelectElement);
    this.resetButton = field("reset", HTMLButtonElement);
    this.configureAppearanceFields();
    this.listen(root, "click", (event) => this.click(event as MouseEvent));
    this.listen(root, "pointerdown", (event) => this.pointerDown(event as PointerEvent));
    this.listen(root, "keydown", (event) => this.keydown(event as KeyboardEvent));
    this.listen(root, "focusin", (event) => {
      const element = (event.target as Element).closest<HTMLElement>("[data-cosmic-window]");
      const key = element?.dataset.cosmicWindow;
      if (key && this.elements.has(key)) this.raise(key);
    });
    this.listen(this.doc, "pointermove", (event) => this.pointerMove(event as PointerEvent));
    this.listen(this.doc, "pointerup", (event) => this.pointerEnd(event as PointerEvent));
    this.listen(this.doc, "pointercancel", (event) => this.pointerEnd(event as PointerEvent, true));
    this.listen(this.doc, "keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape" && this.gesture) {
        event.preventDefault();
        this.cancelGesture();
      }
    });
    this.listen(this.doc, "fullscreenchange", () => {
      this.cancelGesture();
      this.scheduleLayout();
    });
    this.observer = new ResizeObserver(() => this.scheduleLayout());
    for (const element of [this.desktop, this.sceneArea, this.shell, this.rail]) this.observer.observe(element);
    this.render();
  }

  private listen(element: EventTarget, type: string, handler: (event: Event) => void): void {
    element.addEventListener(type, handler);
    this.listeners.push(() => element.removeEventListener(type, handler));
  }

  private get layout(): Layout {
    return this.state.layouts[this.state.displayMode];
  }

  private get windows(): Record<string, WindowState> {
    return this.layout.windows;
  }

  get single(): boolean {
    return this.state.displayMode === "single";
  }

  private isAppearanceTarget(key: unknown): key is string {
    return typeof key === "string"
      && (key === "global" || Object.hasOwn(this.state.appearance, key) || Object.hasOwn(this.config.appearance.panels, key));
  }

  private restore(): WorkspaceState {
    try {
      return normalizeWorkspaceState(JSON.parse(localStorage.getItem(this.config.storage.key) ?? "null"), this.config);
    } catch {
      return defaultWorkspaceState(this.config);
    }
  }

  private save(): void {
    try {
      localStorage.setItem(this.config.storage.key, JSON.stringify(this.state));
    } catch {
      // 无痕模式或存储不可用时，桌面照常工作。
    }
  }

  private resolve(value: string): string | null {
    if (this.elements.has(value)) return value;
    const element = this.doc.getElementById(value)?.closest<HTMLElement>("[data-cosmic-window]");
    return element && this.root.contains(element) ? element.dataset.cosmicWindow! : null;
  }

  private bounds(key: string, zone: Zone = this.windows[key].zone): { width: number; height: number } {
    return this.single || key === "scene" || zone === "scene"
      ? { width: this.sceneArea.clientWidth, height: this.sceneArea.clientHeight }
      : { width: this.desktop.clientWidth, height: this.config.geometry.maxCanvasHeight };
  }

  private areaMetrics(zone: Zone): AreaMetrics {
    const element = this.single || zone === "scene" ? this.sceneArea : this.desktop;
    const rect = element.getBoundingClientRect();
    return { left: rect.left + element.clientLeft, top: rect.top + element.clientTop, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop };
  }

  private pointerZone(clientX: number, previous: Zone): Zone {
    if (this.single) return "scene";
    const divider = this.splitter.getBoundingClientRect();
    return clientX < divider.left ? "scene" : clientX > divider.right ? "tools" : previous;
  }

  private sceneFullscreen(): boolean {
    const scene = this.elements.get("scene");
    return Boolean(scene?.classList.contains("scene-fullscreen") || this.doc.fullscreenElement === scene);
  }

  private panelFullscreen(): boolean {
    return this.sceneArea.classList.contains("cosmic-panel-fullscreen") || this.doc.fullscreenElement === this.sceneArea;
  }

  private fullscreenGeometry(key: string): boolean {
    const element = this.elements.get(key);
    return this.sceneFullscreen() && Boolean(element && this.elements.get("scene")!.contains(element));
  }

  /** 隐藏或收起处于全屏的元素会失去返回控件，所以先退出全屏再执行。 */
  private exitFullscreenBefore(key: string, action: () => void): boolean {
    if (this.completingExitAction) return false;
    const exitControl = this.root.querySelector("#scene-fullscreen");
    const ownsExitControl = Boolean(exitControl && this.elements.get(key)?.contains(exitControl));
    if ((key !== "scene" && !ownsExitControl) || !(this.sceneFullscreen() || this.panelFullscreen())) return false;
    if (this.exitPending) return true;
    this.exitPending = true;
    const leave = async () => {
      try {
        if (this.doc.fullscreenElement) await this.doc.exitFullscreen();
        else this.root.querySelector<HTMLElement>("#scene-fullscreen")?.click();
        // exitFullscreen() 可能在全屏辅助模块清除样式类之前就完成，先等一帧。
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (!this.disposed && !this.doc.fullscreenElement) {
          this.completingExitAction = true;
          try {
            action();
          } finally {
            this.completingExitAction = false;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.root.dispatchEvent(new CustomEvent("cosmic-workspace-error", { detail: { message: `退出全屏失败：${message}` } }));
      } finally {
        this.exitPending = false;
        this.scheduleLayout();
      }
    };
    void leave();
    return true;
  }

  scheduleLayout(): void {
    if (this.frame !== null || !this.active || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  private renderWindow(key: string): void {
    const element = this.elements.get(key);
    const state = this.windows[key];
    if (!element || !state) return;
    const parent = this.single || state.zone === "scene" ? this.sceneArea : this.canvas;
    if (!this.fullscreenGeometry(key) && element.parentElement !== parent) {
      const active = this.doc.activeElement;
      const focus = active instanceof HTMLElement && element.contains(active) ? active : null;
      parent.append(element);
      if (focus && this.doc.activeElement !== focus) focus.focus({ preventScroll: true });
      if (this.gesture?.key === key) this.gesture.handle.setPointerCapture(this.gesture.pointerId);
    }
    element.hidden = !state.visible;
    element.dataset.windowZone = state.zone;
    element.dataset.collapsed = String(state.collapsed);
    element.classList.toggle("is-active", this.focused === key);
    const bounds = this.bounds(key);
    if (bounds.width > 0 && bounds.height > 0) {
      const geometry = fitWindowGeometry(state, bounds, this.config, key);
      for (const name of ["x", "y", "width", "height"] as const) element.style.setProperty(`--window-${name}`, `${geometry[name]}px`);
    }
    const appearance = this.state.appearance[key];
    element.style.setProperty("--window-bg", appearance.background);
    element.style.setProperty("--window-fg", appearance.foreground);
    element.style.setProperty("--window-alpha", String(appearance.opacity));
    element.style.setProperty("--window-radius", `${appearance.radius}px`);
    element.style.setProperty("--window-font-scale", String(appearance.fontScale ?? 1));
    if (key === "scene") this.onAppearanceChange(key, appearance);
    element.style.setProperty("--window-z", String(this.layout.order.indexOf(key) + 1));
    const hints = this.config.display.modes[this.state.displayMode].hints;
    for (const handle of element.querySelectorAll<HTMLButtonElement>(":scope > .cosmic-window-header [data-window-drag], :scope > [data-window-resize]")) {
      handle.disabled = this.fullscreenGeometry(key) || (this.single && key === "scene");
      const which = `${key === "scene" ? "scene" : "window"}${handle.hasAttribute("data-window-drag") ? "Move" : "Resize"}` as keyof typeof hints;
      handle.title = hints[which];
    }
    const collapse = element.querySelector<HTMLElement>("[data-window-action=\"collapse\"]");
    if (collapse) {
      collapse.setAttribute("aria-expanded", String(!state.collapsed));
      collapse.setAttribute("aria-label", `${state.collapsed ? "展开" : "收起"}${this.title(key)}`);
      collapse.title = state.collapsed ? "展开模块" : "收起模块";
    }
    for (const toggle of this.root.querySelectorAll<HTMLElement>("[data-cosmic-toggle]")) {
      if (toggle.dataset.cosmicToggle === key) toggle.setAttribute("aria-pressed", String(state.visible));
    }
  }

  private renderRail(): void {
    const { width, menuRatio, geometry } = this.config.rail;
    const fitted = fitRailWidth(this.state.rail.width, this.shell.clientWidth, this.config);
    const maximum = fitRailWidth(width.max, this.shell.clientWidth, this.config);
    this.shell.style.setProperty("--cosmic-rail-width", `${fitted}px`);
    this.shell.style.setProperty("--cosmic-rail-menu-ratio", String(this.state.rail.menuRatio));
    this.shell.style.setProperty("--cosmic-rail-splitter-size", `${geometry.splitterSize}px`);
    this.shell.style.setProperty("--cosmic-rail-item-min-width", `${geometry.itemMinWidth}px`);
    this.railResize.setAttribute("aria-valuemin", String(width.min));
    this.railResize.setAttribute("aria-valuemax", String(Math.round(maximum)));
    this.railResize.setAttribute("aria-valuenow", String(Math.round(fitted)));
    this.railResize.setAttribute("aria-valuetext", `右侧栏 ${Math.round(fitted)} 像素`);
    const ratio = Math.round(this.state.rail.menuRatio * 100);
    this.railSplitter.setAttribute("aria-valuemin", String(Math.round(menuRatio.min * 100)));
    this.railSplitter.setAttribute("aria-valuemax", String(Math.round(menuRatio.max * 100)));
    this.railSplitter.setAttribute("aria-valuenow", String(ratio));
    this.railSplitter.setAttribute("aria-valuetext", `菜单栏 ${ratio}%，程序坞 ${100 - ratio}%`);
    this.renderAppearanceTarget("menu");
    this.renderAppearanceTarget("dock");
  }

  private renderAppearanceTarget(key: string): void {
    if (key === "global") {
      const appearance = this.state.global;
      for (const name of GLOBAL_APPEARANCE_KEYS) this.root.style.setProperty(`--cosmic-${GLOBAL_FIELDS[name][1]}`, appearance[name]);
      this.root.style.setProperty("--cosmic-glass-blur", `${appearance.glassEnabled ? appearance.glassBlur : 0}px`);
      return;
    }
    if (!isRailAppearanceTarget(key)) {
      this.renderWindow(key);
      return;
    }
    const element = key === "menu" ? this.railMenu : this.railDock;
    const appearance = this.state.appearance[key];
    element.style.setProperty("--rail-panel-bg", appearance.background);
    element.style.setProperty("--rail-panel-fg", appearance.foreground);
    element.style.setProperty("--rail-panel-icon-fg", appearance.iconColor ?? appearance.foreground);
    element.style.setProperty("--rail-panel-icon-alpha", String(appearance.iconOpacity ?? 1));
    element.style.setProperty("--rail-panel-font-alpha", String(appearance.fontOpacity ?? 1));
    element.style.setProperty("--rail-panel-alpha", String(appearance.opacity));
    element.style.setProperty("--rail-panel-radius", `${appearance.radius}px`);
    element.style.setProperty("--rail-panel-icon-size", `${appearance.iconSize ?? 30}px`);
    element.style.setProperty("--rail-panel-font-size", `${appearance.fontSize ?? 15}px`);
  }

  render(): void {
    if (!this.active || this.disposed) return;
    if (this.rendering) {
      this.scheduleLayout();
      return;
    }
    this.rendering = true;
    try {
      // 先切换 CSS 布局再测量，几何按目标显示类型计算。
      this.root.dataset.displayMode = this.state.displayMode;
      this.renderAppearanceTarget("global");
      this.renderRail();
      this.shell.style.setProperty("--cosmic-split", String(this.state.split));
      this.splitter.hidden = this.single;
      this.splitter.disabled = this.single;
      this.splitter.tabIndex = this.single ? -1 : 0;
      this.splitter.setAttribute("aria-disabled", String(this.single));
      this.splitter.setAttribute("aria-valuemin", String(Math.round(this.config.split.min * 100)));
      this.splitter.setAttribute("aria-valuemax", String(Math.round(this.config.split.max * 100)));
      this.splitter.setAttribute("aria-valuenow", String(Math.round(this.state.split * 100)));
      this.splitter.setAttribute("aria-valuetext",
        `3D 场景 ${Math.round(this.state.split * 100)}%，工具区 ${Math.round((1 - this.state.split) * 100)}%`);
      const currentLabel = this.config.display.modes[this.state.displayMode].label;
      const nextLabel = this.config.display.modes[this.single ? "dual" : "single"].label;
      for (const button of this.root.querySelectorAll<HTMLElement>("[data-cosmic-command=\"display-mode\"]")) {
        const description = `显示类型：${currentLabel}，切换为${nextLabel}`;
        button.setAttribute("aria-label", description);
        button.setAttribute("aria-pressed", String(!this.single));
        button.title = description;
        const label = button.querySelector("[data-display-mode-label]");
        if (label) label.textContent = currentLabel;
      }
      let height = this.desktop.clientHeight;
      for (const key of this.elements.keys()) {
        this.renderWindow(key);
        const window = this.windows[key];
        if (this.single || !window || !window.visible || window.zone !== "tools" || !this.desktop.clientWidth) continue;
        const geometry = fitWindowGeometry(window, this.bounds(key), this.config, key);
        height = Math.max(height, geometry.y + (window.collapsed ? this.config.geometry.titleHeight : geometry.height) + this.config.geometry.padding);
      }
      this.canvas.style.setProperty("--canvas-height", `${height}px`);
    } finally {
      this.rendering = false;
    }
  }

  private title(key: string): string {
    return this.elements.get(key)?.querySelector("[data-window-drag]")?.textContent?.trim() || key;
  }

  private raise(key: string): void {
    if (this.focused === key && this.layout.order.at(-1) === key) return;
    this.focused = key;
    this.layout.order = this.layout.order.filter((item) => item !== key).concat(key);
    this.render();
    this.save();
  }

  private reveal(key: string): void {
    if (this.single || this.windows[key].zone === "scene" || !this.active) return;
    const geometry = fitWindowGeometry(this.windows[key], this.bounds(key), this.config, key);
    const top = this.desktop.scrollTop;
    const bottom = top + this.desktop.clientHeight;
    const headerBottom = geometry.y + this.config.geometry.titleHeight;
    if (geometry.y < top || headerBottom > bottom) this.desktop.scrollTop = Math.max(0, geometry.y - this.config.geometry.padding);
  }

  /** 显示窗口；value 可以是窗口键，也可以是窗口内元素的 id。 */
  show(value: string): boolean {
    const key = this.resolve(value);
    if (!key) return false;
    // 原生全屏只绘制全屏元素的后代；打开桌面工具前先恢复桌面。
    if (this.sceneFullscreen() && !this.elements.get("scene")!.contains(this.elements.get(key)!)
      && this.exitFullscreenBefore("scene", () => this.show(value))) return true;
    const wasVisible = this.windows[key].visible;
    this.windows[key].visible = true;
    this.raise(key);
    this.render();
    this.reveal(key);
    this.save();
    if (!wasVisible) this.root.dispatchEvent(new CustomEvent("cosmic-window-show", { detail: { key } }));
    return true;
  }

  hide(value: string): boolean {
    const key = this.resolve(value);
    if (!key) return false;
    if (this.exitFullscreenBefore(key, () => this.hide(key))) return true;
    if (this.gesture?.key === key) this.cancelGesture();
    const active = this.doc.activeElement;
    const ownedFocus = Boolean(active && this.elements.get(key)!.contains(active));
    this.windows[key].visible = false;
    this.render();
    this.save();
    const toggle = [...this.root.querySelectorAll<HTMLElement>("[data-cosmic-toggle]")].find((element) => element.dataset.cosmicToggle === key);
    if (ownedFocus) toggle?.focus({ preventScroll: true });
    return true;
  }

  toggle(value: string): boolean {
    const key = this.resolve(value);
    if (!key) return false;
    return this.windows[key].visible ? this.hide(key) : this.show(key);
  }

  collapse(key: string): void {
    if (this.exitFullscreenBefore(key, () => this.collapse(key))) return;
    const state = this.windows[key];
    state.collapsed = !state.collapsed;
    this.raise(key);
    this.render();
    this.save();
    if (!state.collapsed) this.root.dispatchEvent(new CustomEvent("cosmic-window-show", { detail: { key } }));
  }

  isCollapsed(key: string): boolean {
    return this.windows[key]?.collapsed ?? false;
  }

  /** 窗口当前是否显示并展开；隐藏或收起的窗口不必刷新内容。 */
  isOpen(key: string): boolean {
    const window = this.windows[key];
    return Boolean(window?.visible && !window.collapsed);
  }

  private click(event: MouseEvent): void {
    if (!this.active) return;
    const target = event.target as Element;
    if (target.closest("#scene-fullscreen")) this.scheduleLayout();
    const appearance = target.closest<HTMLElement>("[data-cosmic-appearance]");
    if (appearance) {
      this.openAppearance(appearance.dataset.cosmicAppearance!);
      return;
    }
    const toggle = target.closest<HTMLElement>("[data-cosmic-toggle]");
    if (toggle) {
      this.toggle(toggle.dataset.cosmicToggle!);
      return;
    }
    const command = target.closest<HTMLElement>("[data-cosmic-command]")?.dataset.cosmicCommand;
    if (command) {
      if (command === "reset-layout") this.resetLayout();
      else if (command === "display-mode") this.setDisplayMode(this.single ? "dual" : "single");
      else if (command === "appearance") this.openAppearance(this.focused);
      else this.onCommand(command);
      return;
    }
    const action = target.closest<HTMLElement>("[data-window-action]");
    const key = action?.closest<HTMLElement>("[data-cosmic-window]")?.dataset.cosmicWindow;
    if (!action || !key) return;
    if (action.dataset.windowAction === "hide") this.hide(key);
    if (action.dataset.windowAction === "collapse") this.collapse(key);
    if (action.dataset.windowAction === "appearance") this.openAppearance(key);
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.active || event.button !== 0 || this.gesture) return;
    const target = event.target as Element;
    const element = target.closest<HTMLElement>("[data-cosmic-window]");
    const key = element?.dataset.cosmicWindow;
    if (key) this.raise(key);
    const splitter = target.closest<HTMLElement>("#cosmic-splitter");
    const railResize = target.closest<HTMLElement>("#cosmic-rail-resize");
    const railSplitter = target.closest<HTMLElement>("#cosmic-rail-splitter");
    const drag = target.closest<HTMLElement>("[data-window-drag]");
    const resize = target.closest<HTMLElement>("[data-window-resize]");
    const handle = railResize ?? railSplitter ?? splitter ?? drag ?? resize;
    if (!handle) return;
    const railGesture = Boolean(railResize || railSplitter);
    if (this.single && (splitter || key === "scene") && !railGesture) return;
    if (key && this.fullscreenGeometry(key) && !railGesture) return;
    if (resize && key && this.windows[key].collapsed) return;
    const kind: GestureKind = railResize ? "rail-width" : railSplitter ? "rail-menu" : splitter ? "split" : resize ? "resize" : "move";
    if ((kind === "move" || kind === "resize") && !key) return;
    const state = key ? this.windows[key] : undefined;
    const rect = element?.getBoundingClientRect();
    this.gesture = {
      kind, key, handle, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      scrollTop: this.desktop.scrollTop,
      start: state && key ? fitWindowGeometry(state, this.bounds(key), this.config, key) : undefined,
      before: state ? structuredClone(state) : undefined,
      split: this.state.split,
      moved: false,
      rail: railGesture ? { ...this.state.rail } : undefined,
      railWidth: railResize ? this.rail.getBoundingClientRect().width : 0,
      railHeight: railSplitter ? this.railMenu.getBoundingClientRect().height + this.railDock.getBoundingClientRect().height : 0,
      grab: rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : undefined,
    };
    event.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
  }

  private pointerMove(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const x = event.clientX - gesture.clientX;
    const y = event.clientY - gesture.clientY + (gesture.before?.zone === "tools" ? this.desktop.scrollTop - gesture.scrollTop : 0);
    const distance = gesture.kind === "rail-width" ? Math.abs(x) : gesture.kind === "rail-menu" ? Math.abs(y) : Math.hypot(x, y);
    if (!gesture.moved && distance < this.config.geometry.dragThreshold) return;
    gesture.moved = true;
    this.root.dataset.windowGesture = gesture.kind;
    if (gesture.kind === "rail-width") {
      this.state.rail.width = fitRailWidth(gesture.railWidth - x, this.shell.clientWidth, this.config);
    } else if (gesture.kind === "rail-menu") {
      const { min, max } = this.config.rail.menuRatio;
      if (gesture.railHeight > 0) this.state.rail.menuRatio = clamp(gesture.rail!.menuRatio + y / gesture.railHeight, min, max);
    } else if (gesture.kind === "split") {
      const width = this.sceneArea.clientWidth + this.desktop.clientWidth;
      if (width > 0) this.state.split = clamp(gesture.split + x / width, this.config.split.min, this.config.split.max);
    } else if (gesture.kind === "move" && gesture.key !== "scene") {
      const key = gesture.key!;
      const zone = this.pointerZone(event.clientX, this.windows[key].zone);
      const point = windowPointFromPointer({ x: event.clientX, y: event.clientY }, gesture.grab!, this.areaMetrics(zone));
      this.windows[key] = placeWindowGeometry(gesture.before!, point, this.bounds(key, zone), this.config, key, zone);
    } else {
      const key = gesture.key!;
      this.windows[key] = changeWindowGeometry(gesture.before!, gesture.start!, { x, y },
        gesture.kind === "resize" ? "resize" : "move", this.bounds(key), this.config, key);
    }
    this.render();
  }

  private pointerEnd(event: PointerEvent, cancelled = false): void {
    if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
    if (cancelled) {
      this.cancelGesture();
      return;
    }
    this.releaseGesture();
    this.save();
  }

  private releaseGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    delete this.root.dataset.windowGesture;
    if (gesture?.handle.hasPointerCapture(gesture.pointerId)) gesture.handle.releasePointerCapture(gesture.pointerId);
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.rail) this.state.rail = gesture.rail;
    else if (gesture.kind === "split") this.state.split = gesture.split;
    else if (gesture.key && gesture.before) this.windows[gesture.key] = gesture.before;
    this.releaseGesture();
    this.render();
  }

  private keydown(event: KeyboardEvent): void {
    if (!this.active || this.gesture || !ARROWS.includes(event.key)) return;
    const target = event.target as Element;
    const railResize = target.closest("#cosmic-rail-resize");
    const railSplitter = target.closest("#cosmic-rail-splitter");
    if (railResize || railSplitter) {
      const directionKeys = railResize ? ["ArrowRight", "ArrowLeft"] : ["ArrowUp", "ArrowDown"];
      if (!["Home", "End", ...directionKeys].includes(event.key)) return;
      event.preventDefault();
      const property = railResize ? "width" : "menuRatio";
      const { min, max, value, step } = this.config.rail[property];
      const start = railResize ? fitRailWidth(this.state.rail.width, this.shell.clientWidth, this.config) : this.state.rail.menuRatio;
      const next = event.key === "Home" ? (event.altKey ? value : min) : event.key === "End" ? max
        : start + (event.key === directionKeys[0] ? -step : step);
      this.state.rail[property] = railResize ? fitRailWidth(next, this.shell.clientWidth, this.config) : clamp(next, min, max);
      this.render();
      this.save();
      return;
    }
    if (target.closest("#cosmic-splitter")) {
      event.preventDefault();
      if (this.single) return;
      const { min, max, value, step } = this.config.split;
      this.state.split = event.key === "Home" ? min : event.key === "End" ? max
        : clamp(this.state.split + (["ArrowLeft", "ArrowDown"].includes(event.key) ? -step : step), min, max);
      if (event.altKey && event.key === "Home") this.state.split = value;
      this.render();
      this.save();
      return;
    }
    const drag = target.closest("[data-window-drag]");
    const resize = target.closest("[data-window-resize]");
    const handle = drag ?? resize;
    if (!handle) return;
    const key = handle.closest<HTMLElement>("[data-cosmic-window]")?.dataset.cosmicWindow;
    if (!key || this.fullscreenGeometry(key) || (this.single && key === "scene")) return;
    const window = this.windows[key];
    if (drag && key !== "scene" && ((event.ctrlKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) || (event.altKey && event.key === "Home"))) {
      event.preventDefault();
      if (this.single) return;
      const zone: Zone = event.key === "Home" ? (window.zone === "scene" ? "tools" : "scene") : event.key === "ArrowLeft" ? "scene" : "tools";
      const rect = this.elements.get(key)!.getBoundingClientRect();
      const point = windowPointFromPointer({ x: rect.left, y: rect.top }, { x: 0, y: 0 }, this.areaMetrics(zone));
      this.windows[key] = placeWindowGeometry(window, point, this.bounds(key, zone), this.config, key, zone);
      this.raise(key);
      this.render();
      this.reveal(key);
      this.save();
      return;
    }
    if (event.key === "Home" || event.key === "End") return;
    if (resize && window.collapsed) return;
    event.preventDefault();
    const step = this.config.geometry.keyboardStep * (event.shiftKey ? 2 : 1);
    const delta = {
      x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
      y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
    };
    this.windows[key] = changeWindowGeometry(window, fitWindowGeometry(window, this.bounds(key), this.config, key), delta,
      resize ? "resize" : "move", this.bounds(key), this.config, key);
    this.raise(key);
    this.render();
    this.reveal(key);
    this.save();
  }

  private configureAppearanceFields(): void {
    const i = this.inputs;
    this.listen(this.target, "change", () => {
      if (this.isAppearanceTarget(this.target.value)) this.styleTarget = this.target.value;
      this.syncAppearance();
    });
    for (const name of ["bg", "fg", "alpha", "radius", "icon-color", "icon-alpha", "icon-size", "font-alpha", "font-size", "font-scale", "global-glass-blur"] as const) {
      this.listen(i[name], "input", () => this.updateAppearance());
    }
    for (const key of GLOBAL_APPEARANCE_KEYS) this.listen(i[GLOBAL_FIELDS[key][0]], "input", () => this.updateAppearance());
    this.listen(i["global-glass-enabled"], "change", () => this.updateAppearance());
    this.listen(this.resetButton, "click", () => this.resetAppearance());
    this.syncAppearance();
  }

  openAppearance(key: string): void {
    const target = this.isAppearanceTarget(key) ? key : "scene";
    if (this.sceneFullscreen() && !this.elements.get("scene")!.contains(this.elements.get("appearance")!)
      && this.exitFullscreenBefore("scene", () => this.openAppearance(target))) return;
    this.styleTarget = target;
    this.syncAppearance();
    this.windows.appearance.collapsed = false;
    this.show("appearance");
  }

  private syncAppearance(): void {
    const { inputs: i, texts: t, blocks: b } = this;
    const external = this.appearancePanels.has(this.styleTarget);
    for (const [key, panel] of this.appearancePanels) panel.hidden = key !== this.styleTarget;
    this.target.value = this.styleTarget;
    this.resetButton.hidden = external;
    this.resetButton.disabled = external;
    if (external) {
      for (const name of ["global-fields", "surface-fields", "text-fields", "rail-fields", "scene-hint"] as const) b[name].hidden = true;
      return;
    }
    const global = this.styleTarget === "global";
    b["global-fields"].hidden = !global;
    b["surface-fields"].hidden = global;
    b["text-fields"].hidden = global;
    b["scene-hint"].hidden = this.styleTarget !== "scene";
    for (const key of GLOBAL_APPEARANCE_KEYS) {
      const input = i[GLOBAL_FIELDS[key][0]];
      input.disabled = !global;
      if (global) input.value = this.state.global[key];
    }
    i["global-glass-enabled"].disabled = !global;
    i["global-glass-blur"].disabled = !global;
    if (global) {
      const appearance = this.state.global;
      b["rail-fields"].hidden = true;
      i["global-glass-enabled"].checked = appearance.glassEnabled;
      setRange(i["global-glass-blur"], this.config.theme.glass.limits, appearance.glassBlur);
      t["global-glass-blur-value"].textContent = `${appearance.glassBlur}px`;
      return;
    }
    const appearance = this.state.appearance[this.styleTarget];
    if (!appearance) return;
    const rail = isRailAppearanceTarget(this.styleTarget);
    const limits = appearanceLimits(this.config, this.styleTarget);
    b["rail-fields"].hidden = !rail;
    b["font-alpha-field"].hidden = !rail;
    b["font-size-field"].hidden = !rail;
    b["font-scale-field"].hidden = rail;
    i["icon-color"].disabled = !rail;
    const ranges = [
      ["alpha", "opacity"], ["radius", "radius"], ["icon-size", "iconSize"], ["icon-alpha", "iconOpacity"],
      ["font-size", "fontSize"], ["font-alpha", "fontOpacity"], ["font-scale", "fontScale"],
    ] as const;
    for (const [name, key] of ranges) {
      const limit = limits[key];
      i[name].disabled = !limit;
      if (limit) setRange(i[name], limit, appearance[key] ?? limit.min);
    }
    i.bg.value = appearance.background;
    i.fg.value = appearance.foreground;
    t["alpha-value"].textContent = `${Math.round(appearance.opacity * 100)}%`;
    t["radius-value"].textContent = `${appearance.radius}px`;
    if (rail) {
      i["icon-color"].value = appearance.iconColor ?? appearance.foreground;
      t["icon-alpha-value"].textContent = `${Math.round((appearance.iconOpacity ?? 1) * 100)}%`;
      t["icon-size-value"].textContent = `${appearance.iconSize}px`;
      t["font-alpha-value"].textContent = `${Math.round((appearance.fontOpacity ?? 1) * 100)}%`;
      t["font-size-value"].textContent = `${appearance.fontSize}px`;
    } else {
      t["font-scale-value"].textContent = `${Math.round((appearance.fontScale ?? 1) * 100)}%`;
    }
  }

  private updateAppearance(): void {
    const i = this.inputs;
    if (this.styleTarget === "global") {
      const colors = Object.fromEntries(GLOBAL_APPEARANCE_KEYS.map((key) => [key, i[GLOBAL_FIELDS[key][0]].value]));
      this.state.global = normalizeGlobalAppearance({
        ...colors, glassEnabled: i["global-glass-enabled"].checked, glassBlur: Number(i["global-glass-blur"].value),
      }, this.state.global, this.config.theme.glass.limits);
      this.renderAppearanceTarget("global");
      this.syncAppearance();
      this.save();
      return;
    }
    const appearance = this.state.appearance[this.styleTarget];
    if (!appearance) return;
    this.state.appearance[this.styleTarget] = normalizeAppearance({
      background: i.bg.value, foreground: i.fg.value,
      opacity: Number(i.alpha.value), radius: Number(i.radius.value),
      iconColor: i["icon-color"].value,
      iconOpacity: Number(i["icon-alpha"].value), fontOpacity: Number(i["font-alpha"].value),
      iconSize: Number(i["icon-size"].value), fontSize: Number(i["font-size"].value),
      fontScale: Number(i["font-scale"].value),
    }, appearance, appearanceLimits(this.config, this.styleTarget));
    this.renderAppearanceTarget(this.styleTarget);
    this.syncAppearance();
    this.save();
  }

  private resetAppearance(): void {
    if (this.styleTarget === "global") this.state.global = defaultGlobalAppearance(this.config);
    else if (Object.hasOwn(this.state.appearance, this.styleTarget)) this.state.appearance[this.styleTarget] = defaultAppearance(this.config, this.styleTarget);
    else return;
    this.renderAppearanceTarget(this.styleTarget);
    this.syncAppearance();
    this.save();
  }

  resetLayout(): void {
    this.cancelGesture();
    this.state = resetCurrentLayout(this.state, this.config);
    this.focused = this.layout.order.findLast((key) => this.windows[key].visible) ?? "scene";
    this.desktop.scrollTop = 0;
    this.render();
    this.save();
  }

  setDisplayMode(mode: DisplayMode): void {
    if (mode === this.state.displayMode) return;
    if (this.exitFullscreenBefore("scene", () => this.setDisplayMode(mode))) return;
    this.cancelGesture();
    this.state = changeDisplayMode(this.state, mode);
    this.focused = this.layout.order.findLast((key) => this.windows[key].visible) ?? "scene";
    this.render();
    this.save();
    // 这是布局变化，不是打开窗口：业务处理不应因此改写编辑框。
    this.root.dispatchEvent(new CustomEvent("cosmic-display-mode-change", { detail: { mode } }));
  }

  setActive(active: boolean): void {
    if (!active) this.cancelGesture();
    this.active = active;
    if (this.active) this.scheduleLayout();
  }

  dispose(): void {
    this.cancelGesture();
    this.disposed = true;
    this.observer.disconnect();
    this.listeners.splice(0).forEach((remove) => remove());
    if (this.frame !== null) cancelAnimationFrame(this.frame);
  }
}

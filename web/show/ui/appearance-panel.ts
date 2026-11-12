/**
 * 模块外观面板：编辑窗口、侧栏与全局的外观。外观状态属于桌面窗口状态（cosmic-state.ts），
 * 读写、应用与保存都经工作区（cosmic-workspace.ts）提供的 AppearanceHost。
 */

import type { DesktopConfig } from "../config.ts";
import {
  type GlobalColorKey, type WorkspaceState, GLOBAL_APPEARANCE_KEYS, appearanceLimits, defaultAppearance, defaultGlobalAppearance,
  isRailAppearanceTarget, normalizeAppearance, normalizeGlobalAppearance,
} from "./cosmic-state.ts";
import { need } from "./dom.ts";

/** 全局外观字段：[输入框 id 后缀, CSS 变量名后缀]。 */
export const GLOBAL_FIELDS = {
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

/** 工作区交给外观面板的能力。 */
export interface AppearanceHost {
  readonly config: DesktopConfig;
  /** 当前的桌面窗口状态（面板直接改写其中的 global 与 appearance）。 */
  state(): WorkspaceState;
  /** key 是不是可设置外观的对象（global、窗口、侧栏或外部面板）。 */
  isTarget(key: unknown): key is string;
  /** 把 key 的外观写到页面上（CSS 变量）。 */
  apply(key: string): void;
  save(): void;
  listen(element: EventTarget, type: string, handler: (event: Event) => void): void;
}

export class AppearancePanel {
  /** 正在设置外观的对象。 */
  target: string;
  private readonly host: AppearanceHost;
  private readonly appearancePanels: Map<string, HTMLElement>;
  private readonly inputs: Record<InputName, HTMLInputElement>;
  private readonly texts: Record<(typeof TEXT_NAMES)[number], HTMLElement>;
  private readonly blocks: Record<(typeof BLOCK_NAMES)[number], HTMLElement>;
  private readonly select: HTMLSelectElement;
  private readonly resetButton: HTMLButtonElement;

  constructor(root: HTMLElement, host: AppearanceHost, target: string) {
    this.host = host;
    this.target = target;
    this.appearancePanels = new Map(Object.entries(host.config.appearance.panels).map(([key, id]) => [key, need(root, `#${id}`)]));
    const field = <T extends HTMLElement>(name: string, type?: { new (): T; prototype: T }) => need<T>(root, `#cosmic-style-${name}`, type);
    const inputNames: InputName[] = [...INPUT_NAMES, ...Object.values(GLOBAL_FIELDS).map(([name]) => name)];
    this.inputs = Object.fromEntries(inputNames.map((name) => [name, field(name, HTMLInputElement)])) as Record<InputName, HTMLInputElement>;
    this.texts = Object.fromEntries(TEXT_NAMES.map((name) => [name, field(name)])) as Record<(typeof TEXT_NAMES)[number], HTMLElement>;
    this.blocks = Object.fromEntries(BLOCK_NAMES.map((name) => [name, field(name)])) as Record<(typeof BLOCK_NAMES)[number], HTMLElement>;
    this.select = field("target", HTMLSelectElement);
    this.resetButton = field("reset", HTMLButtonElement);
    this.bind();
  }

  private bind(): void {
    const i = this.inputs;
    this.host.listen(this.select, "change", () => {
      if (this.host.isTarget(this.select.value)) this.target = this.select.value;
      this.sync();
    });
    for (const name of ["bg", "fg", "alpha", "radius", "icon-color", "icon-alpha", "icon-size", "font-alpha", "font-size", "font-scale", "global-glass-blur"] as const) {
      this.host.listen(i[name], "input", () => this.update());
    }
    for (const key of GLOBAL_APPEARANCE_KEYS) this.host.listen(i[GLOBAL_FIELDS[key][0]], "input", () => this.update());
    this.host.listen(i["global-glass-enabled"], "change", () => this.update());
    this.host.listen(this.resetButton, "click", () => this.reset());
    this.sync();
  }

  /** 把当前对象的外观写回面板控件。 */
  sync(): void {
    const { inputs: i, texts: t, blocks: b } = this;
    const state = this.host.state();
    const external = this.appearancePanels.has(this.target);
    for (const [key, panel] of this.appearancePanels) panel.hidden = key !== this.target;
    this.select.value = this.target;
    this.resetButton.hidden = external;
    this.resetButton.disabled = external;
    if (external) {
      for (const name of ["global-fields", "surface-fields", "text-fields", "rail-fields", "scene-hint"] as const) b[name].hidden = true;
      return;
    }
    const global = this.target === "global";
    b["global-fields"].hidden = !global;
    b["surface-fields"].hidden = global;
    b["text-fields"].hidden = global;
    b["scene-hint"].hidden = this.target !== "scene";
    for (const key of GLOBAL_APPEARANCE_KEYS) {
      const input = i[GLOBAL_FIELDS[key][0]];
      input.disabled = !global;
      if (global) input.value = state.global[key];
    }
    i["global-glass-enabled"].disabled = !global;
    i["global-glass-blur"].disabled = !global;
    if (global) {
      const appearance = state.global;
      b["rail-fields"].hidden = true;
      i["global-glass-enabled"].checked = appearance.glassEnabled;
      setRange(i["global-glass-blur"], this.host.config.theme.glass.limits, appearance.glassBlur);
      t["global-glass-blur-value"].textContent = `${appearance.glassBlur}px`;
      return;
    }
    const appearance = state.appearance[this.target];
    if (!appearance) return;
    const rail = isRailAppearanceTarget(this.target);
    const limits = appearanceLimits(this.host.config, this.target);
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

  private update(): void {
    const i = this.inputs;
    const state = this.host.state();
    if (this.target === "global") {
      const colors = Object.fromEntries(GLOBAL_APPEARANCE_KEYS.map((key) => [key, i[GLOBAL_FIELDS[key][0]].value]));
      state.global = normalizeGlobalAppearance({
        ...colors, glassEnabled: i["global-glass-enabled"].checked, glassBlur: Number(i["global-glass-blur"].value),
      }, state.global, this.host.config.theme.glass.limits);
      this.host.apply("global");
      this.sync();
      this.host.save();
      return;
    }
    const appearance = state.appearance[this.target];
    if (!appearance) return;
    state.appearance[this.target] = normalizeAppearance({
      background: i.bg.value, foreground: i.fg.value,
      opacity: Number(i.alpha.value), radius: Number(i.radius.value),
      iconColor: i["icon-color"].value,
      iconOpacity: Number(i["icon-alpha"].value), fontOpacity: Number(i["font-alpha"].value),
      iconSize: Number(i["icon-size"].value), fontSize: Number(i["font-size"].value),
      fontScale: Number(i["font-scale"].value),
    }, appearance, appearanceLimits(this.host.config, this.target));
    this.host.apply(this.target);
    this.sync();
    this.host.save();
  }

  private reset(): void {
    const state = this.host.state();
    if (this.target === "global") state.global = defaultGlobalAppearance(this.host.config);
    else if (Object.hasOwn(state.appearance, this.target)) state.appearance[this.target] = defaultAppearance(this.host.config, this.target);
    else return;
    this.host.apply(this.target);
    this.sync();
    this.host.save();
  }
}

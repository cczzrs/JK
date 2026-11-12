/**
 * 桌面窗口的几何与外观状态（纯函数）。模型、调度和渲染状态都不进入本文件。
 * 全局外观单独存放在 state.global。
 */

import type { DesktopConfig, Limit, WindowSpec, Zone } from "../config.ts";
import { type Obj, color, finite, object } from "./normalize.ts";

export type DisplayMode = "dual" | "single";

export interface WindowState {
  zone: Zone;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  collapsed: boolean;
  fill: boolean;
}

export interface Layout {
  windows: Record<string, WindowState>;
  order: string[];
}

/** 窗口、菜单栏、程序坞的外观。菜单栏和程序坞另有图标与字号字段。 */
export interface Appearance {
  background: string;
  foreground: string;
  opacity: number;
  radius: number;
  fontScale?: number;
  iconColor?: string;
  iconSize?: number;
  iconOpacity?: number;
  fontSize?: number;
  fontOpacity?: number;
}

export const GLOBAL_APPEARANCE_KEYS = [
  "background", "accent", "hover", "focus", "border", "selectionBackground", "selectionForeground",
] as const;
export type GlobalColorKey = (typeof GLOBAL_APPEARANCE_KEYS)[number];

export type GlobalAppearance = Record<GlobalColorKey, string> & { glassEnabled: boolean; glassBlur: number };

export interface RailState {
  width: number;
  menuRatio: number;
}

export interface WorkspaceState {
  version: number;
  displayMode: DisplayMode;
  split: number;
  rail: RailState;
  layouts: Record<DisplayMode, Layout>;
  /** 各窗口与 menu、dock 的外观。 */
  appearance: Record<string, Appearance>;
  global: GlobalAppearance;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Bounds {
  width: number;
  height: number;
}

type Limits = Partial<Record<string, Limit>>;

export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

export const isRailAppearanceTarget = (key: string): key is "menu" | "dock" => key === "menu" || key === "dock";

export function appearanceLimits(config: DesktopConfig, key: string): Limits {
  if (key === "global") return {};
  if (isRailAppearanceTarget(key)) return config.rail.appearance.limits;
  return { ...config.appearance.limits, ...config.windows[key]?.appearanceLimits };
}

export function windowZone(value: unknown, key: string, config: DesktopConfig): Zone {
  if (key === "scene") return "scene";
  if (value === "scene" || value === "tools") return value;
  return config.windows[key].zone ?? config.geometry.defaultZone;
}

export function defaultAppearance(config: DesktopConfig, key: string): Appearance {
  if (isRailAppearanceTarget(key)) return { ...config.rail.appearance[key] };
  const appearance = config.appearance;
  return {
    background: appearance.background,
    foreground: appearance.foreground,
    opacity: appearance.opacity,
    radius: appearance.radius,
    fontScale: appearance.fontScale,
    ...config.windows[key].appearance,
  };
}

export function defaultGlobalAppearance(config: DesktopConfig): GlobalAppearance {
  const colors = Object.fromEntries(GLOBAL_APPEARANCE_KEYS.map((name) => [name, config.theme[name]])) as Record<GlobalColorKey, string>;
  return { ...colors, glassEnabled: config.theme.glass.enabled, glassBlur: config.theme.glass.blur };
}

export function normalizeGlobalAppearance(raw: unknown, defaults: GlobalAppearance, glassLimits: Limit): GlobalAppearance {
  const value = object(raw) ? raw : {};
  const colors = Object.fromEntries(GLOBAL_APPEARANCE_KEYS.map((key) => [key, color(value[key], defaults[key])])) as Record<GlobalColorKey, string>;
  return {
    ...colors,
    glassEnabled: typeof value.glassEnabled === "boolean" ? value.glassEnabled : defaults.glassEnabled,
    glassBlur: clamp(finite(value.glassBlur, defaults.glassBlur), glassLimits.min, glassLimits.max),
  };
}

const NUMERIC_KEYS = ["iconSize", "fontSize", "iconOpacity", "fontOpacity", "fontScale"] as const;

export function normalizeAppearance(raw: unknown, defaults: Appearance, limits: Limits): Appearance {
  const value = object(raw) ? raw : {};
  const opacity = limits.opacity!;
  const radius = limits.radius!;
  const normalized: Appearance = {
    background: color(value.background, defaults.background),
    foreground: color(value.foreground, defaults.foreground),
    opacity: clamp(finite(value.opacity, defaults.opacity), opacity.min, opacity.max),
    radius: clamp(finite(value.radius, defaults.radius), radius.min, radius.max),
  };
  if (defaults.iconColor !== undefined) normalized.iconColor = color(value.iconColor, defaults.iconColor);
  for (const key of NUMERIC_KEYS) {
    const fallback = defaults[key];
    const limit = limits[key];
    if (fallback !== undefined && limit) normalized[key] = clamp(finite(value[key], fallback), limit.min, limit.max);
  }
  return normalized;
}

export function defaultWorkspaceState(config: DesktopConfig): WorkspaceState {
  return normalizeWorkspaceState(null, config);
}

/** 菜单栏与程序坞在两种显示类型中共用。 */
export function normalizeRail(raw: unknown, config: DesktopConfig): RailState {
  const value = object(raw) ? raw : {};
  const width = config.rail.width;
  const ratio = config.rail.menuRatio;
  return {
    width: clamp(finite(value.width, width.value), width.min, width.max),
    menuRatio: clamp(finite(value.menuRatio, ratio.value), ratio.min, ratio.max),
  };
}

/** 让侧栏适应当前宽度，不改变保存的宽度，并保留可操作的最小值。 */
export function fitRailWidth(width: number, shellWidth: number, config: DesktopConfig): number {
  const limits = config.rail.width;
  const available = finite(shellWidth, limits.max + config.rail.geometry.minWorkspaceWidth) - config.rail.geometry.minWorkspaceWidth;
  return clamp(finite(width, limits.value), limits.min, Math.min(limits.max, available));
}

/** 每种显示类型各有自己的几何与显隐；外观另行共用。 */
export function normalizeWorkspaceLayout(raw: unknown, config: DesktopConfig, mode: DisplayMode): Layout {
  const value = object(raw) ? raw : {};
  const supplied = object(value.windows) ? value.windows : {};
  const windows: Record<string, WindowState> = {};
  for (const [key, base] of Object.entries(config.windows)) {
    const defaults: WindowSpec = { ...base, ...config.display.modes[mode].windows[key] };
    const entry = Object.hasOwn(supplied, key) && object(supplied[key]) ? supplied[key] : {};
    const minWidth = defaults.minWidth ?? config.geometry.minWidth;
    const minHeight = defaults.minHeight ?? config.geometry.minHeight;
    const maximum = config.geometry.maxCanvasHeight;
    windows[key] = {
      zone: mode === "single" ? "scene" : windowZone(entry.zone ?? defaults.zone, key, config),
      x: clamp(finite(entry.x, defaults.x), 0, maximum),
      y: clamp(finite(entry.y, defaults.y), 0, maximum - config.geometry.titleHeight),
      width: clamp(finite(entry.width, defaults.width), minWidth, maximum),
      height: clamp(finite(entry.height, defaults.height), minHeight, maximum),
      visible: typeof entry.visible === "boolean" ? entry.visible : defaults.visible,
      collapsed: typeof entry.collapsed === "boolean" ? entry.collapsed : defaults.collapsed,
      fill: (mode === "single" && key === "scene")
        || (defaults.fill === true && (typeof entry.fill === "boolean" ? entry.fill : true)),
    };
  }
  const keys = Object.keys(windows);
  const knownOrder = (order: unknown): string[] => Array.isArray(order)
    ? [...new Set(order.filter((key): key is string => typeof key === "string" && Object.hasOwn(windows, key)))]
    : [];
  const configured = knownOrder(config.display.modes[mode].order);
  const defaults = [...keys.filter((key) => !configured.includes(key)), ...configured];
  const order = Array.isArray(value.order) ? knownOrder(value.order) : defaults;
  return { windows, order: [...defaults.filter((key) => !order.includes(key)), ...order] };
}

/** 无效字段各自回到默认值；未知窗口与运行字段一律丢弃。 */
export function normalizeWorkspaceState(raw: unknown, config: DesktopConfig): WorkspaceState {
  const value = object(raw) && raw.version === config.storage.version ? raw : {};
  const layouts = object(value.layouts) ? value.layouts : {};
  const appearance = object(value.appearance) ? value.appearance : {};
  const keys = [...Object.keys(config.windows), "menu", "dock"];
  return {
    version: config.storage.version,
    displayMode: value.displayMode === "dual" || value.displayMode === "single" ? value.displayMode : config.display.mode,
    split: clamp(finite(value.split, config.split.value), config.split.min, config.split.max),
    rail: normalizeRail(value.rail, config),
    layouts: {
      dual: normalizeWorkspaceLayout(layouts.dual, config, "dual"),
      single: normalizeWorkspaceLayout(layouts.single, config, "single"),
    },
    appearance: Object.fromEntries(keys.map((key) => [key,
      normalizeAppearance(Object.hasOwn(appearance, key) ? appearance[key] : null, defaultAppearance(config, key), appearanceLimits(config, key))])),
    global: normalizeGlobalAppearance(value.global, defaultGlobalAppearance(config), config.theme.glass.limits),
  };
}

export function changeDisplayMode(state: WorkspaceState, mode: DisplayMode): WorkspaceState {
  return { ...state, displayMode: mode };
}

export function resetCurrentLayout(state: WorkspaceState, config: DesktopConfig): WorkspaceState {
  return {
    ...state,
    split: state.displayMode === "dual" ? config.split.value : state.split,
    layouts: { ...state.layouts, [state.displayMode]: normalizeWorkspaceLayout(null, config, state.displayMode) },
  };
}

/** 临时适应当前区域，保留偏好几何，供以后更大的视口使用。 */
export function fitWindowGeometry(window: WindowState, bounds: Bounds, config: DesktopConfig, key: string): Rect {
  const { padding, titleHeight } = config.geometry;
  const spec = config.windows[key];
  const availableWidth = Math.max(1, bounds.width - padding * 2);
  const availableHeight = Math.max(titleHeight, bounds.height - padding * 2);
  if (window.fill) return { x: padding, y: padding, width: availableWidth, height: availableHeight };
  const width = clamp(window.width, Math.min(spec.minWidth ?? config.geometry.minWidth, availableWidth), availableWidth);
  const height = clamp(window.height, Math.min(spec.minHeight ?? config.geometry.minHeight, availableHeight), availableHeight);
  const occupiedHeight = window.collapsed ? titleHeight : height;
  return {
    x: clamp(window.x, padding, bounds.width - width - padding),
    y: clamp(window.y, padding, bounds.height - occupiedHeight - padding),
    width,
    height,
  };
}

/** 手势相对起始矩形计算，不累计指针取整误差。 */
export function changeWindowGeometry(window: WindowState, start: Rect, delta: { x: number; y: number },
  kind: "move" | "resize", bounds: Bounds, config: DesktopConfig, key: string): WindowState {
  const next: WindowState = { ...window, ...start, fill: false };
  if (kind === "move") {
    return placeWindowGeometry(window.fill ? next : window, { x: start.x + delta.x, y: start.y + delta.y }, bounds, config, key);
  }
  next.width += delta.x;
  next.height += delta.y;
  const padding = config.geometry.padding;
  next.width = Math.min(next.width, bounds.width - start.x - padding);
  next.height = Math.min(next.height, bounds.height - start.y - padding);
  return { ...next, ...fitWindowGeometry(next, bounds, config, key) };
}

/** 在两个工作区之间移动只改变局部位置，不改变偏好尺寸。 */
export function placeWindowGeometry(window: WindowState, point: { x: number; y: number }, bounds: Bounds,
  config: DesktopConfig, key: string, zone: Zone = window.zone): WindowState {
  const next: WindowState = { ...window, x: point.x, y: point.y, zone: windowZone(zone, key, config), fill: false };
  const fitted = fitWindowGeometry(next, bounds, config, key);
  return { ...next, x: fitted.x, y: fitted.y };
}

export interface AreaMetrics {
  left: number;
  top: number;
  scrollLeft: number;
  scrollTop: number;
}

/** 把视口中的指针位置换成标题栏的局部位置，滚动只计算一次。 */
export function windowPointFromPointer(pointer: { x: number; y: number }, grab: { x: number; y: number }, area: AreaMetrics): { x: number; y: number } {
  return {
    x: pointer.x - grab.x - area.left + area.scrollLeft,
    y: pointer.y - grab.y - area.top + area.scrollTop,
  };
}

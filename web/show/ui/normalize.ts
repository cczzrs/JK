/**
 * 读取浏览器存储中的展示偏好时共用的小工具：不合法的值换成默认值。
 * 窗口布局（cosmic-state.ts）与网络样式（network-style-state.ts）共用。
 */

export type Obj = Record<string, unknown>;

/** 普通对象（不含 null 与数组）。 */
export const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);

/** 对象自己的键对应的值，否则为 undefined。 */
export const own = (value: unknown, key: string): unknown => (object(value) && Object.hasOwn(value, key) ? value[key] : undefined);

/** “#rrggbb” 颜色。 */
export const isColor = (value: unknown): value is string => typeof value === "string" && /^#[\da-f]{6}$/i.test(value);

/** “#rrggbb” 颜色（转成小写），否则用默认值。 */
export const color = (value: unknown, fallback: string): string => (isColor(value) ? value.toLowerCase() : fallback);

export const boolean = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/** 有限的数，否则用默认值。 */
export const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** 有限的数并限制在 [min, max] 内，否则用默认值（同样限制）。 */
export const bounded = (value: unknown, fallback: number, limits: { min: number; max: number }): number =>
  Math.min(limits.max, Math.max(limits.min, finite(value, fallback)));

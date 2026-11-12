/**
 * “输出数据格式及列表”与“输出渲染”窗口的选择、运行控制的三个勾选框（跳过动画、切片记录、按输出格式），
 * 以及场景控制的“隐藏名称和次数”“显示环”两个按钮：
 * 默认值取自 config.ts，最新选择保存在浏览器本地，下次打开时恢复。
 * 浏览器不能保存时，本页的选择照常生效。
 */

import { byId, clone } from "./dom.ts";
import { selectTab, setupTabs } from "./tabs.ts";

export interface OutputChoices {
  /** 记录方式（标签页 output-mode）。 */
  mode: string;
  /** 触发组；空串表示模型的第一个 output 组。 */
  group: string;
  when: string;
  content: string;
  format: string;
  /** 渲染模式（标签页 output-render-mode）。 */
  render: string;
  /** 运行控制的勾选框：跳过动画、切片记录、按输出格式、批执行。 */
  skip: boolean;
  slice: boolean;
  byOutputFormat: boolean;
  batch: boolean;
  /** 场景控制的按钮：“隐藏名称和次数”（true 为已隐藏）、“显示环”。 */
  labelsHidden: boolean;
  loopsShown: boolean;
}

/** 场景控制按钮的状态（由页面按按钮读写，这里只保存）。 */
export type SceneFlag = "labelsHidden" | "loopsShown";

export interface OutputChoicesConfig {
  storage: { key: string; version: number; retired: readonly string[] };
  defaults: OutputChoices;
}

const TABS = { mode: "output-mode", render: "output-render-mode" } as const;
const SELECTS = { when: "output-trigger-when", content: "output-trigger-content", format: "output-format" } as const;
const GROUP = "output-trigger-group";
const CHECKS = { skip: "skip", slice: "slice-record", byOutputFormat: "by-output-format", batch: "batch-mode" } as const;

/** 标签组或下拉框中是否有 value 这一项。 */
function offers(id: string, value: unknown): value is string {
  return typeof value === "string" && [...byId(id).querySelectorAll<HTMLElement>("[data-value], option")]
    .some((item) => (item.dataset.value ?? (item as HTMLOptionElement).value) === value);
}

export class OutputChoiceStore {
  private readonly config: OutputChoicesConfig;
  private state: OutputChoices;

  /** 恢复保存的选择（不合法的项用默认值），写到页面上，并在每次改动时保存、调用 onChange。 */
  constructor(config: OutputChoicesConfig, onChange: () => void) {
    this.config = config;
    try {
      for (const key of config.storage.retired) localStorage.removeItem(key);
    } catch {
      // 浏览器不能访问存储时没有旧数据可清
    }
    this.state = this.restore();
    for (const [key, id] of Object.entries(TABS) as [keyof typeof TABS, string][]) {
      selectTab(id, this.state[key]);
      setupTabs(id, (value) => this.update(key, value, onChange));
    }
    for (const [key, id] of Object.entries(SELECTS) as [keyof typeof SELECTS, string][]) {
      byId(id, HTMLSelectElement).value = this.state[key];
      byId(id).addEventListener("change", () => this.update(key, byId(id, HTMLSelectElement).value, onChange));
    }
    byId(GROUP).addEventListener("change", () => this.update("group", byId(GROUP, HTMLSelectElement).value, onChange));
    for (const [key, id] of Object.entries(CHECKS) as [keyof typeof CHECKS, string][]) {
      byId(id, HTMLInputElement).checked = this.state[key];
      byId(id).addEventListener("change", () => this.update(key, byId(id, HTMLInputElement).checked, onChange));
    }
  }

  /** 换模型时的触发组选项：保存的组仍存在就选它，否则选默认组，再否则选第一个组。 */
  setGroups(names: readonly string[]): void {
    const select = byId(GROUP, HTMLSelectElement);
    select.replaceChildren(...names.map((name) => {
      const option = clone<HTMLOptionElement>("option-template");
      option.value = name;
      option.textContent = name;
      return option;
    }));
    const wanted = [this.state.group, this.config.defaults.group].find((name) => names.includes(name));
    if (wanted) select.value = wanted;
  }

  private restore(): OutputChoices {
    const defaults = this.config.defaults;
    let saved: Partial<OutputChoices> & { version?: number } = {};
    try {
      const data = JSON.parse(localStorage.getItem(this.config.storage.key) ?? "null") as unknown;
      if (data && typeof data === "object" && (data as { version?: unknown }).version === this.config.storage.version) saved = data;
    } catch {
      saved = {};
    }
    const pick = (key: keyof OutputChoices, id: string) => (offers(id, saved[key]) ? saved[key] : defaults[key]) as string;
    return {
      mode: pick("mode", TABS.mode),
      render: pick("render", TABS.render),
      when: pick("when", SELECTS.when),
      content: pick("content", SELECTS.content),
      format: pick("format", SELECTS.format),
      group: typeof saved.group === "string" ? saved.group : defaults.group,
      labelsHidden: typeof saved.labelsHidden === "boolean" ? saved.labelsHidden : defaults.labelsHidden,
      loopsShown: typeof saved.loopsShown === "boolean" ? saved.loopsShown : defaults.loopsShown,
      ...Object.fromEntries(Object.keys(CHECKS).map((key) => {
        const value = saved[key as keyof typeof CHECKS];
        return [key, typeof value === "boolean" ? value : defaults[key as keyof typeof CHECKS]];
      })) as Pick<OutputChoices, keyof typeof CHECKS>,
    };
  }

  flag(key: SceneFlag): boolean {
    return this.state[key];
  }

  /** 记下场景控制按钮的状态。 */
  setFlag(key: SceneFlag, value: boolean): void {
    this.update(key, value, () => {});
  }

  private update(key: keyof OutputChoices, value: string | boolean, onChange: () => void): void {
    this.state = { ...this.state, [key]: value };
    try {
      localStorage.setItem(this.config.storage.key, JSON.stringify({ version: this.config.storage.version, ...this.state }));
    } catch {
      // 浏览器不能保存时，本页的选择照常生效。
    }
    onChange();
  }
}

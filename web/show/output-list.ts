/**
 * “输出数据格式及列表”的推导（不碰 DOM）：由会话的输出记录推出列表行，以及各列的文字。
 * 页面（panels.ts）读取窗口里的选择、显示表格；单元测试直接调用这里。
 */

import type { OutputRow, Session } from "./session.ts";

/** 输出数据的显示格式：二进制、十进制、十六进制。 */
export type OutputFormat = "bin" | "dec" | "hex";

/** 一组 values 高位在前拼成的整数，按 format 显示。 */
export function outputNumber(values: readonly number[], format: OutputFormat): string {
  if (!values.length) return "—";
  if (format === "bin") return values.join("");
  const n = BigInt(`0b${values.join("")}`);
  return format === "dec" ? n.toString() : `0x${n.toString(16).toUpperCase()}`;
}

/** 8 个值且是可打印 ASCII 时的字符，否则为空。 */
export function outputChar(values: readonly number[]): string {
  if (values.length !== 8) return "";
  const code = parseInt(values.join(""), 2);
  return code >= 32 && code <= 126 ? String.fromCharCode(code) : "";
}

/** 输出列表的记录方式（展示页自定，不改变执行记录）。 */
export interface ListSettings {
  /** all：每条输出记录一行；trigger：按触发组记录。 */
  mode: "all" | "trigger";
  /** 触发组：output 的组名。 */
  group: string;
  /** 触发条件：事件到达；到达且来源的 q 为 0 或 1。 */
  when: "arrive" | "q0" | "q1";
  /** 记录内容：全部输出数据，或只记已标记节点。 */
  content: "all" | "marked";
  /** 每条输出的记录内容：slice 读取全部成员（切片）；real 只记到达的成员（真实运行）。 */
  slice: "slice" | "real";
}

/** 列表的一行：所在处理单元、来源成员、此刻全部成员的 q（展平），以及要记录的成员（null 为全部）。 */
export interface ListRow {
  /** 对应的输出记录在本会话中的序号（从 0 起）。 */
  index: number;
  unit: number;
  source: string;
  values: readonly number[];
  paths: ReadonlySet<string> | null;
}

/**
 * 由输出记录逐条推出列表行。arrived：自上次记录以来有事件到达的 output 成员（事件到达标记），及到达时它自己的 q。
 * 切片记录读取记录时刻全部成员的 q；不勾选切片记录时与真实运行一样，只用到达时带来的 q，不读取其他成员。
 */
export class ListBuilder {
  readonly rows: ListRow[] = [];
  private cursor = 0;
  private readonly arrived = new Map<string, number>();
  private readonly trigger: ReadonlySet<string>;
  readonly session: Session;
  readonly settings: ListSettings;
  readonly key: string;

  constructor(session: Session, settings: ListSettings, key: string) {
    this.session = session;
    this.settings = settings;
    this.key = key;
    const { model } = session;
    const members = settings.mode === "trigger" ? model.groupOutput(model.output)[settings.group] ?? [] : [];
    this.trigger = new Set(members);
  }

  update(): void {
    const { outputs, model } = this.session;
    const { mode, when, content } = this.settings;
    const real = this.settings.slice === "real";
    for (; this.cursor < outputs.length; this.cursor++) {
      const o: OutputRow = outputs[this.cursor];
      const q = o.values[model.output.indexOf(o.source)];
      if (mode === "all") {
        this.rows.push({ index: this.cursor, unit: o.unit, source: o.source, values: o.values, paths: real ? new Set([o.source]) : null });
        continue;
      }
      this.arrived.set(o.source, q);
      if (!this.trigger.has(o.source)) continue;
      if ((when === "q0" && q !== 0) || (when === "q1" && q !== 1)) continue;
      const marked = new Set(this.arrived.keys());
      this.rows.push({
        index: this.cursor, unit: o.unit, source: o.source,
        // 真实运行：已标记的成员用到达时的 q；全部输出数据只剩触发的成员自己
        values: real ? model.output.map((path, i) => this.arrived.get(path) ?? o.values[i]) : o.values,
        paths: content === "marked" ? marked : real ? new Set([o.source]) : null,
      });
      this.arrived.clear();
    }
  }
}

/** 一行的各列：values、数值、字符都按 output 的组分开（§9.4）；只记已标记节点时每组只列这些节点。 */
export type Pairs = readonly (readonly [string, number])[];

/** 一行按 output 分组的 [成员, q]；只记已标记节点时每组只留这些节点，去掉空组。 */
export function rowGroups(s: Session, row: ListRow): (readonly [string, Pairs])[] {
  const { output } = s.model;
  return Object.entries(s.model.groupOutput(output.map((path, i) => [path, row.values[i]] as const)))
    .map(([name, pairs]) => [name, row.paths ? pairs.filter(([path]) => row.paths!.has(path)) : pairs] as const)
    .filter(([, pairs]) => pairs.length);
}

export function outputCells(s: Session, row: ListRow, index: number, format: OutputFormat): string[] {
  const groups = rowGroups(s, row);
  const bits = (pairs: readonly (readonly [string, number])[]) => pairs.map(([, q]) => q);
  const each = (fn: (pairs: readonly (readonly [string, number])[]) => string) => groups.map(([name, pairs]) => `${name} ${fn(pairs)}`).join(" · ");
  const values = each((pairs) => `[${pairs.map(([path, q]) => (row.paths ? `${path}=${q}` : String(q))).join(", ")}]`);
  const chars = groups.filter(([, pairs]) => outputChar(bits(pairs))).map(([name, pairs]) => `${name} ${outputChar(bits(pairs))}`).join(" · ");
  return [String(index + 1), row.unit < 0 ? "—" : String(row.unit), row.source, values, each((pairs) => outputNumber(bits(pairs), format)), chars];
}

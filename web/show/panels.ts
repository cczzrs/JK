/**
 * 页面面板：状态与概览、两个 FIFO、执行记录、输出、节点详情（JKI 与 JKS）、本单元。
 * 只读 state 与执行会话；隐藏或收起的窗口只更新计数，不重建列表。脚本只复制模板、填充文本与属性。
 */

import { APP_CONFIG } from "./config.ts";
import { GATED_TYPES, type Jki, type Jks, type PublishMode, isInputEntry, publishMode } from "../../src/model.ts";
import type { TaskItem } from "../../src/cpu.ts";
import type { RecordEntry } from "../../src/record.ts";
import type { FifoRow, OutputRow, Session, Step } from "./session.ts";
import { type Loaded, state } from "./state.ts";
import { byId, clone } from "./ui/dom.ts";
import { tabValue } from "./ui/tabs.ts";

const $ = (id: string): HTMLElement => byId(id);
const setText = (id: string, text: unknown): void => {
  const element = document.getElementById(id);
  if (element) element.textContent = String(text);
};
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

/** JKRD7 §4.4 的发布条件：[EX 非空：完成后发布的条件, 空 EX：触发时发布的条件]。 */
const PUBLISH_RULES: Record<PublishMode, [string, string]> = {
  always: ["总是", "总是"],
  zero: ["result=0", "当前 q=0"],
  one: ["result=1", "当前 q=1"],
  never: ["从不", "从不"],
  always_changed: ["result≠q_before", "从不"],
  zero_changed: ["q_before=1 且 result=0", "从不"],
  one_changed: ["q_before=0 且 result=1", "从不"],
};

/** JKRD7 §5.2 的整合方式；其余用途按 any 处理。 */
const REGISTRATION_RULES: Record<string, string> = {
  any: "不整合",
  all: "按轮收集，到齐后每个前置放行一次",
  transaction: "按轮收集，到齐后形成一个事务任务",
  transaction_any: "每条通知形成一个事务任务",
};

const UNIT_LABELS = { event: "事件", node: "节点任务", tx: "事务任务" } as const;
const STEP_LABELS = { event: "投递事件", node: "执行节点任务", tx: "执行事务任务" } as const;

export interface PanelHooks {
  /** 窗口是否显示并展开。 */
  isOpen(key: string): boolean;
  select(path: string | null): void;
  /** 在场景中重播本单元的第 index 步。 */
  showStep(index: number): void;
  running(): boolean;
  gpuDispatches(): number;
  timeline(): string;
}

let hooks: PanelHooks = {
  isOpen: () => true, select: () => {}, showStep: () => {}, running: () => false, gpuDispatches: () => 0, timeline: () => "",
};

export function setPanelHooks(next: PanelHooks): void {
  hooks = next;
}

/** 刷新全部面板（只重建打开着的窗口的列表）。 */
export function renderPanels(): void {
  const l = state.loaded;
  const s = state.session;
  if (!l || !s) return;
  renderStatus(l, s);
  renderQueue("events", hooks.isOpen("events") ? s.eventRows() : null, s.ex.events.length);
  renderQueue("tasks", hooks.isOpen("tasks") ? s.taskRows() : null, s.ex.tasks.length);
  if (hooks.isOpen("events")) setText("rounds-json", pretty(s.roundsView()));
  setText("total", s.stats.evaluations);
  if (hooks.isOpen("history")) renderHistory(s);
  renderOutput(s);
  if (hooks.isOpen("observe")) renderOutputList(s);
  if (hooks.isOpen("inspector")) renderInspector();
  if (hooks.isOpen("unit")) renderUnit();
}

function renderStatus(l: Loaded, s: Session): void {
  const running = hooks.running();
  setText("run-state", s.stopped ? "已停止" : s.idle ? "静止" : running ? "运行中" : "已暂停");
  $("run-status").classList.toggle("running", running);
  setText("compute-status", "CPU 后端");
  const stats: Record<string, number> = {
    "stat-nodes": l.model.jki.size, "stat-edges": l.edges, "stat-ex": l.operations, "stat-groups": l.model.jks.size,
    "stat-units": s.units, "stat-events": s.ex.events.length, "stat-tasks": s.ex.tasks.length, "stat-gpu": hooks.gpuDispatches(),
  };
  for (const [id, value] of Object.entries(stats)) setText(id, value);
  setText("total2", s.stats.evaluations);
  setText("event-total", s.stats.evaluations + s.stats.transactions);
  setText("EXtotal", s.stats.operations);
  setText("timeline-status", hooks.timeline());
  byId("step-back", HTMLButtonElement).disabled = s.units === 0 && !s.stopped;
}

function renderQueue(kind: "events" | "tasks", rows: FifoRow[] | null, size: number): void {
  setText(`${kind}-count`, size);
  if (!rows) return;
  const limit = APP_CONFIG.view.queues.rows;
  $(`${kind}-empty`).hidden = rows.length > 0;
  const list = $(`${kind}-list`);
  list.replaceChildren();
  for (const item of rows.slice(0, limit)) {
    const row = clone("queue-row-template");
    row.querySelector("[data-kind]")!.textContent = item.kind;
    row.querySelector("[data-target]")!.textContent = item.target;
    row.querySelector("[data-detail]")!.textContent = item.detail;
    row.title = JSON.stringify(item.item);
    row.querySelector("button")!.addEventListener("click", () => hooks.select(item.target));
    list.append(row);
  }
  const notice = $(`${kind}-limit`);
  notice.hidden = rows.length <= limit;
  notice.textContent = notice.hidden ? "" : `显示前 ${limit} 项，全部 ${rows.length} 项仍保留在 FIFO 中。`;
}

function historyRows(records: readonly RecordEntry[]): void {
  const list = $("trace-list");
  list.replaceChildren();
  for (const record of records) {
    const row = clone("history-row-template");
    let kind: string;
    let detail: string;
    if ("q" in record) {
      kind = "q";
      detail = `${record.q} · ${record.from} → ${record.to}`;
    } else if ("output" in record) {
      kind = "output";
      detail = `${record.output} · ${Object.entries(record.values).map(([name, bits]) => `${name} ${bits.join("")}`).join(" · ")}`;
    } else if ("inject" in record) {
      kind = "inject";
      detail = record.inject;
    } else {
      kind = "notify";
      detail = record.notify;
    }
    row.querySelector("[data-kind]")!.textContent = kind.toUpperCase();
    row.querySelector("[data-detail]")!.textContent = detail;
    row.title = JSON.stringify(record);
    list.append(row);
  }
}

function renderHistory(s: Session): void {
  historyRows(s.recent);
  const limit = $("trace-limit");
  limit.hidden = s.recordCount <= s.recent.length;
  limit.textContent = `显示最近 ${s.recent.length} / ${s.recordCount} 条；下载保留完整记录。`;
}

function renderOutput(s: Session): void {
  const latest = s.latestOutput();
  const output = s.model.output; // JKM.output（§8.1）
  setText("output-status", latest ? `${s.ex.outputs.length} 次输出 · ${latest.source}` : "output 成员的通知投递时读取 · 尚未输出");
  setText("observe-summary", output.length ? `output: ${output.join(", ")} · ${s.ex.outputs.length} 条输出` : "模型没有输出节点（output 为空）");
  if (hooks.isOpen("output")) {
    $("output-rows").replaceChildren();
    const labels = s.model.outputGroups.flatMap(({ name, size }) => Array.from({ length: size }, (_, i) => `${name}[${i}]`));
    for (const [index, path] of output.entries()) {
      const row = clone("output-row-template");
      row.querySelector("[data-output-id]")!.textContent = labels[index];
      row.querySelector(".source")!.textContent = path;
      const value = row.querySelector(".output-value")!;
      value.textContent = latest ? String(latest.values[index]) : "—";
      value.classList.toggle("on", latest?.values[index] === 1);
      row.querySelector(".output-publication")!.textContent = latest ? "已输出" : "待通知";
      $("output-rows").append(row);
    }
    $("outputs-empty").hidden = output.length > 0;
  }
  if (hooks.isOpen("render")) renderBoard(s);
}

// -- 输出渲染 ----------------------------------------------------------------

/** kara 的起点：只渲染这条输出记录之后的列表行（会话改变时回到 0）。 */
let renderFrom: { session: Session | null; index: number } = { session: null, index: 0 };

/** kara：清除已渲染的数据，之后只渲染新数据。 */
export function clearRender(s: Session): void {
  renderFrom = { session: s, index: s.outputs.length };
}

/** 全部渲染：从本会话的第一条输出开始渲染。 */
export function renderAll(s: Session): void {
  renderFrom = { session: s, index: 0 };
}

/** 一行要画的位：按 output 的组顺序，只记已标记节点时只有这些节点。 */
function rowBits(s: Session, row: ListRow): number[] {
  return rowGroups(s, row).flatMap(([, pairs]) => pairs.map(([, q]) => q));
}

/** 一行 data 组转成的 ASCII：8 位且可打印时是字符，否则写十六进制码；没有 data 成员时为 null。 */
function rowAscii(s: Session, row: ListRow): string | null {
  const data = rowGroups(s, row).find(([name]) => name === "data");
  if (!data) return null;
  const bits = data[1].map(([, q]) => q);
  return outputChar(bits) || `[${outputNumber(bits, "hex")}]`;
}

/** 输出渲染跟随输出列表的行：RGB 画位，ASCII 二进制显示 data 组转成的字符。 */
function renderBoard(s: Session): void {
  if (renderFrom.session !== s) renderFrom = { session: s, index: 0 };
  const rows = currentRows(s).rows.filter((row) => row.index >= renderFrom.index);
  const latest = rows.at(-1);
  const ascii = tabValue("output-render-mode") === "ascii";
  if (latest) {
    const cells = outputCells(s, latest, 0, "bin"); // 各组的位，二进制
    setText("output-number", `${latest.source} · ${cells[4]}`);
    setText("output-character", rowAscii(s, latest) ?? "·");
  } else {
    setText("output-character", "—");
    setText("output-number", "等待通知");
  }
  setText("render-count", `渲染 ${rows.length} 行`);
  if (ascii) {
    setText("output-ascii", rows.map((row) => rowAscii(s, row)).filter((text) => text !== null).join(""));
    return;
  }
  const canvas = byId("output-board", HTMLCanvasElement);
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const board = APP_CONFIG.view.board;
  const drawn = rows.slice(-APP_CONFIG.view.outputRows).map((row) => rowBits(s, row));
  const cols = Math.max(1, ...drawn.map((bits) => bits.length));
  const cell = Math.min(board.cellSize, canvas.width / cols);
  const visible = Math.floor(canvas.height / cell);
  drawn.slice(-visible).forEach((bits, y) => bits.forEach((bit, x) => {
    ctx.fillStyle = bit ? board.one : board.zero;
    ctx.fillRect(x * cell + 1, y * cell + 1, Math.max(1, cell - 2), Math.max(1, cell - 2));
  }));
}

// -- 输出列表 ----------------------------------------------------------------

/** 输出数据的显示格式：二进制、十进制、十六进制。 */
export type OutputFormat = "bin" | "dec" | "hex";

/** 一组 values 高位在前拼成的整数，按 format 显示。 */
function outputNumber(values: readonly number[], format: OutputFormat): string {
  if (!values.length) return "—";
  if (format === "bin") return values.join("");
  const n = BigInt(`0b${values.join("")}`);
  return format === "dec" ? n.toString() : `0x${n.toString(16).toUpperCase()}`;
}

/** 8 个值且是可打印 ASCII 时的字符，否则为空。 */
function outputChar(values: readonly number[]): string {
  if (values.length !== 8) return "";
  const code = parseInt(values.join(""), 2);
  return code >= 32 && code <= 126 ? String.fromCharCode(code) : "";
}

/** 输出列表的记录方式（展示页自定，不改变执行记录）。 */
interface ListSettings {
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

function listSettings(): ListSettings {
  const value = (id: string) => byId(id, HTMLSelectElement).value;
  return {
    mode: tabValue("output-mode") as ListSettings["mode"],
    group: value("output-trigger-group"),
    when: value("output-trigger-when") as ListSettings["when"],
    content: value("output-trigger-content") as ListSettings["content"],
    slice: byId("slice-record", HTMLInputElement).checked ? "slice" : "real",
  };
}

/** 列表的一行：所在处理单元、来源成员、此刻全部成员的 q（展平），以及要记录的成员（null 为全部）。 */
interface ListRow {
  /** 对应的输出记录在本会话中的序号（从 0 起）。 */
  index: number;
  unit: number;
  source: string;
  values: readonly number[];
  paths: ReadonlySet<string> | null;
}

/** 由输出记录逐条推出列表行；marks 是自上次记录以来有事件到达的 output 成员。 */
class ListBuilder {
  readonly rows: ListRow[] = [];
  private cursor = 0;
  private readonly marks = new Set<string>();
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
    for (; this.cursor < outputs.length; this.cursor++) {
      const o: OutputRow = outputs[this.cursor];
      if (mode === "all") {
        this.rows.push({ index: this.cursor, unit: o.unit, source: o.source, values: o.values, paths: this.settings.slice === "real" ? new Set([o.source]) : null });
        continue;
      }
      this.marks.add(o.source);
      if (!this.trigger.has(o.source)) continue;
      const q = o.values[model.output.indexOf(o.source)];
      if ((when === "q0" && q !== 0) || (when === "q1" && q !== 1)) continue;
      this.rows.push({ index: this.cursor, unit: o.unit, source: o.source, values: o.values, paths: content === "marked" ? new Set(this.marks) : null });
      this.marks.clear();
    }
  }
}

/** 一行的各列：values、数值、字符都按 output 的组分开（§9.4）；只记已标记节点时每组只列这些节点。 */
type Pairs = readonly (readonly [string, number])[];

/** 一行按 output 分组的 [成员, q]；只记已标记节点时每组只留这些节点，去掉空组。 */
function rowGroups(s: Session, row: ListRow): (readonly [string, Pairs])[] {
  const { output } = s.model;
  return Object.entries(s.model.groupOutput(output.map((path, i) => [path, row.values[i]] as const)))
    .map(([name, pairs]) => [name, row.paths ? pairs.filter(([path]) => row.paths!.has(path)) : pairs] as const)
    .filter(([, pairs]) => pairs.length);
}

function outputCells(s: Session, row: ListRow, index: number, format: OutputFormat): string[] {
  const groups = rowGroups(s, row);
  const bits = (pairs: readonly (readonly [string, number])[]) => pairs.map(([, q]) => q);
  const each = (fn: (pairs: readonly (readonly [string, number])[]) => string) => groups.map(([name, pairs]) => `${name} ${fn(pairs)}`).join(" · ");
  const values = each((pairs) => `[${pairs.map(([path, q]) => (row.paths ? `${path}=${q}` : String(q))).join(", ")}]`);
  const chars = groups.filter(([, pairs]) => outputChar(bits(pairs))).map(([name, pairs]) => `${name} ${outputChar(bits(pairs))}`).join(" · ");
  return [String(index + 1), String(row.unit), row.source, values, each((pairs) => outputNumber(bits(pairs), format)), chars];
}

export function outputFormat(): OutputFormat {
  return byId("output-format", HTMLSelectElement).value as OutputFormat;
}

/** 当前列表行：会话或记录方式改变时重新推出，否则只处理新增的输出记录。 */
let builder: ListBuilder | null = null;
let shown = 0;

function currentRows(s: Session): ListBuilder {
  const settings = listSettings();
  const key = JSON.stringify(settings);
  if (!builder || builder.session !== s || builder.key !== key) {
    builder = new ListBuilder(s, settings, key);
    shown = 0;
    $("output-list-body").replaceChildren();
  }
  builder.update();
  return builder;
}

/**
 * 第 index 条输出在当前列表中的行要记录的成员：不成行时为 null，记录全部成员时为 "all"。
 * 场景中输出节点的动画按它取舍（运行控制的“按输出格式”）。
 */
export function listedMembers(s: Session, index: number): ReadonlySet<string> | "all" | null {
  const rows = currentRows(s).rows;
  for (let i = rows.length - 1; i >= 0 && rows[i].index >= index; i--) {
    if (rows[i].index === index) return rows[i].paths ?? "all";
  }
  return null;
}

/** 当前列表的文本（制表符分隔，首行是表头），用于复制。 */
export function outputListText(s: Session, format = outputFormat()): string {
  const header = ["序号", "处理单元", "来源成员", "values", `数值（${{ bin: "二进制", dec: "十进制", hex: "十六进制" }[format]}）`, "字符"];
  const rows = currentRows(s).rows.map((row, i) => outputCells(s, row, i, format));
  return [header, ...rows].map((cells) => cells.join("\t")).join("\n") + "\n";
}

/** 当前列表各行 data 组的数值，按 format 每行一个（没有 data 成员的行不列）。 */
export function outputDataText(s: Session, format = outputFormat()): string {
  const lines = currentRows(s).rows.flatMap((row) => {
    const data = rowGroups(s, row).find(([name]) => name === "data");
    return data ? [outputNumber(data[1].map(([, q]) => q), format)] : [];
  });
  return lines.map((line) => line + "\n").join("");
}

let shownFormat: OutputFormat | null = null;

function renderOutputList(s: Session): void {
  const format = outputFormat();
  const trigger = tabValue("output-mode") === "trigger";
  const b = currentRows(s);
  const body = $("output-list-body");
  if (shownFormat !== format) {
    body.replaceChildren();
    shown = 0;
    shownFormat = format;
  }
  const fragment = document.createDocumentFragment();
  for (; shown < b.rows.length; shown++) {
    const row = clone("output-list-row-template");
    const cells = outputCells(s, b.rows[shown], shown, format);
    row.querySelectorAll("td").forEach((cell, k) => (cell.textContent = cells[k]));
    fragment.append(row);
  }
  body.append(fragment);
  setText("output-list-count", trigger ? `${b.rows.length} 条记录（${s.outputs.length} 条输出）` : `${s.outputs.length} 条输出`);
  $("output-list-empty").hidden = b.rows.length > 0;
  byId("output-copy-data", HTMLButtonElement).disabled = !s.model.outputGroups.some((g) => g.name === "data");
  setText("output-list-empty", s.outputs.length ? "尚未满足触发条件" : "尚未输出");
}

// -- 节点详情 ----------------------------------------------------------------

export function renderInspector(): void {
  const l = state.loaded;
  const s = state.session;
  const path = state.selected;
  const node = l && s && path ? l.model.jki.get(path) : undefined;
  const group = l && s && path ? l.model.jks.get(path) : undefined;
  setText("selected-id", path ?? "—");
  const any = Boolean(node || group);
  $("node-inspector").classList.toggle("has-selection", any);
  document.querySelector("[data-cosmic-window=\"inspector\"]")?.classList.toggle("has-selection", any);
  const q = node && s && path ? String(s.ex.q.get(path)) : "";
  setText("node-q", q || "—");
  $("node-q").dataset.value = q;
  $("node-empty").hidden = any;
  $("node-sections").hidden = !node;
  $("group-sections").hidden = !group;
  if (l && s && path && node) renderNode(l, s, path, node);
  else if (l && s && path && group) renderGroup(l, s, path, group);
}

function renderNode(l: Loaded, s: Session, path: string, node: Jki): void {
  setText("node-initial", node.q);
  const tags = node.pro?.tag ?? [];
  const tagKey = JSON.stringify(tags);
  const tagContainer = $("node-tags");
  if (tagContainer.dataset.tags !== tagKey) {
    tagContainer.replaceChildren();
    for (const text of tags) {
      const tag = clone("node-purpose-tag-template");
      tag.textContent = text;
      tagContainer.append(tag);
    }
    if (!tags.length) tagContainer.textContent = "未设置";
    tagContainer.dataset.tags = tagKey;
  }
  const model = l.model;
  const all = "all" in node.trigger;
  setText("node-trigger-mode", all ? "all · 全部来源到达" : "any · 任一来源到达");
  const refs = model.triggerRefs.get(path) ?? [];
  setText("node-trigger", refs.join("\n") || (isInputEntry(model, path) ? "外部输入入口（§3.2）" : "无触发来源"));
  const registration = model.regOf.get(path);
  setText("node-registration", registration ? `${registration[0]} / ${registration[1]}` : "未登记");
  const operations = node.sources?.ex ?? [];
  const hasEX = operations.length > 0;
  setText("node-ex-count", hasEX ? `${operations.length} 步` : "空 EX");
  $("node-ex-empty").hidden = hasEX;
  $("node-ex-fields").hidden = !hasEX;
  const seed = node.sources?.seed;
  setText("node-seed", hasEX ? (seed === undefined ? "q_before · 执行入口的当前 q" : `固定 seed = ${seed}`) : "—");
  setText("node-ex", hasEX ? operations.join(" → ") : "—");
  setText("node-sources", hasEX ? (model.sourceRefs.get(path) ?? []).map((ref, index) => `${index + 1}. ${operations[index]} ← ${ref}`).join("\n") : "—");
  const mode = publishMode(node);
  setText("node-publish", `${mode} · ${hasEX ? `完成后发布：${PUBLISH_RULES[mode][0]}` : `触发时发布：${PUBLISH_RULES[mode][1]}`}`);
  const gate = registration && GATED_TYPES.has(registration[1]) ? registration : null;
  const subscribers = (model.subscribers.get(path) ?? []).map((sub, index) =>
    `${index + 1}. ${sub}${gate && model.gated(gate[0], sub) ? `（受 ${gate[0]} 的 ${gate[1]} 整合）` : ""}`);
  setText("node-subscribers", subscribers.join("\n") || "没有订阅者");
  setText("node-pending", `${s.pendingTasks(path)} 个（thread 任务 FIFO）`);
  $("node-arrivals").hidden = !all;
  setText("node-all", all ? JSON.stringify(s.ex.triggerAll.get(path)) : "—");
  setText("node-json", pretty(node));
}

function renderGroup(l: Loaded, s: Session, path: string, group: Jks): void {
  const model = l.model;
  setText("group-path", path);
  setText("group-thread", group.thread);
  const direct = group.members.filter((member) => !("members" in member)).length;
  setText("group-members", `${direct} 个直接 JKI · ${group.members.length - direct} 个子 JKS · 共 ${model.members.get(path)?.size ?? 0} 个 JKI`);
  setText("group-tags", group.pro?.tag?.join(" · ") || "未设置");
  const registrations = model.regTypes.get(path) ?? new Map<string, string[]>();
  setText("group-registrations", [...registrations].map(([type, prereqs]) =>
    `${type}（${REGISTRATION_RULES[type] ?? "按 any 处理"}）\n  ${prereqs.join("\n  ")}`).join("\n") || "没有登记");
  const gated = [...(model.prereqs.get(path) ?? [])].map((prereq) => {
    const reg = model.regOf.get(prereq);
    if (!reg || !GATED_TYPES.has(reg[1])) return `${prereq}（${reg?.[1] ?? "any"}，不整合）`;
    const subs = (model.subscribers.get(prereq) ?? []).filter((sub) => model.gated(path, sub));
    return `${prereq}（${reg[1]}）→ ${subs.length ? subs.join("、") : "（无）"}`;
  });
  setText("group-gated", gated.join("\n") || "（无前置成员）");
  const rounds = s.groupRounds(path);
  setText("group-rounds", Object.keys(rounds).length
    ? Object.entries(rounds).map(([kind, record]) => `${kind}：本轮已到达 ${JSON.stringify(record)}（共需 ${registrations.get(kind)?.length ?? 0} 个）`).join("\n")
    : "没有 all 或 transaction 登记，不按轮收集");
}

// -- 本单元 ------------------------------------------------------------------

function levelName(depth: number): string {
  return depth === 0 ? "thread" : `第 ${depth} 层事务`;
}

function taskText(item: string | TaskItem): string {
  if (typeof item === "string") return item;
  return item.kind === "node" ? `EX ${item.node}` : `TX ${item.g}（前置 ${item.prereqs.join(", ")}）`;
}

/** 一步的说明行，按执行顺序。全部取自执行器报告的执行细节与运行日志。 */
export function stepLines(l: Loaded, step: Step): string[] {
  const lines: string[] = [];
  let order = 0;
  for (const e of step.entries) {
    if (e.kind === "feed") {
      const result = e.type === "transaction_any" ? "形成事务任务"
        : !e.complete ? "未到齐，受整合订阅者暂不接收"
          : e.type === "all" ? "到齐，每个前置向受整合订阅者放行一次" : "到齐，形成事务任务";
      lines.push(`登记 ${e.g} 的 ${e.type}：记入 ${e.source}，本轮 ${JSON.stringify(e.record)} · ${result}`);
    } else if (e.kind === "receive") {
      const outcome = {
        wait: "未齐备，等待其余来源",
        task: `形成节点任务（追加到${levelName(e.depth)}的任务 FIFO）`,
        notify: "空 EX，按当前 q 发布",
        none: "空 EX，按当前 q 不发布",
      }[e.outcome];
      lines.push(`#${++order} → ${e.path}${e.gated ? "（经整合放行）" : ""}${e.all ? ` · all 记录 ${JSON.stringify(e.all)}` : ""} · ${outcome}`);
    } else if (e.kind === "compute") {
      const node = l.model.jki.get(e.path)!;
      const ops = node.sources?.ex ?? [];
      const refs = l.model.sourceRefs.get(e.path) ?? [];
      lines.push(`计算：q_before=${e.qBefore}，q_start=${e.start}（${node.sources?.seed === undefined ? "取 q_before" : "seed"}）`);
      e.x.forEach((x, i) => lines.push(`  ${ops[i]} ${refs[i]}=${x} → acc=${e.acc[i]}`));
      lines.push(`  result=${e.acc.at(-1) ?? e.start} · publish ${e.mode}：${e.publish ? "发布" : "不发布"}`);
    } else if (e.kind === "q") {
      lines.push(`写入 q：${e.from} → ${e.to}`);
    } else if (e.kind === "notify") {
      lines.push(`发布 ${e.path}：产生一次通知`);
    } else if (e.kind === "output") {
      lines.push(`输出：${e.path} 的通知投递时读取 [${e.values.join(", ")}]`);
    } else if (e.kind === "tx") {
      lines.push(`开始第 ${e.depth} 层事务 ${e.g}：前置 ${e.prereqs.join(", ")}，建立事务事件 FIFO 与事务任务 FIFO`);
    } else if (e.kind === "tx_end") {
      lines.push(`第 ${e.depth} 层事务 ${e.g} 结束：两个 FIFO 都已为空`);
    } else if (e.kind === "tx_enqueue") {
      lines.push(`形成事务任务 ${e.g}（前置 ${e.prereqs.join(", ")}）→ ${e.depth === 0 ? "thread 的任务 FIFO" : `第 ${e.depth} 层事务任务 FIFO（嵌套事务）`}`);
    }
  }
  return lines;
}

export function renderUnit(): void {
  const l = state.loaded;
  const unit = state.unit;
  const list = $("unit-steps");
  list.replaceChildren();
  $("unit-levels").hidden = true;
  $("unit-limit").hidden = true;
  if (!unit || !l) {
    setText("unit-summary", "尚未处理单元。");
    setText("unit-step-label", "—");
    return;
  }
  setText("unit-summary", `第 ${unit.n} 个处理单元 · ${UNIT_LABELS[unit.kind]} ${unit.path}`
    + (unit.detailed ? ` · ${unit.steps.length} 步` : " · 跳过动画时处理，未记录细节"));
  setText("unit-step-label", !unit.steps.length ? "—"
    : state.unitStep >= 0 ? `第 ${state.unitStep + 1} / ${unit.steps.length} 步` : `共 ${unit.steps.length} 步`);
  const limits = APP_CONFIG.view.unit;
  for (const [index, step] of unit.steps.slice(0, limits.steps).entries()) {
    const item = clone("unit-step-template");
    item.classList.toggle("active", index === state.unitStep);
    item.querySelector("[data-depth]")!.textContent = levelName(step.depth);
    item.querySelector("[data-kind]")!.textContent = STEP_LABELS[step.kind];
    item.querySelector("[data-target]")!.textContent = step.path;
    const lines = item.querySelector("[data-lines]")!;
    const text = stepLines(l, step);
    for (const line of text.slice(0, limits.lines)) {
      const li = clone("unit-line-template");
      li.textContent = line;
      lines.append(li);
    }
    if (text.length > limits.lines) {
      const li = clone("unit-line-template");
      li.textContent = `……还有 ${text.length - limits.lines} 行`;
      lines.append(li);
    }
    item.querySelector("button")!.addEventListener("click", () => hooks.showStep(index));
    list.append(item);
  }
  if (unit.steps.length > limits.steps) {
    $("unit-limit").hidden = false;
    setText("unit-limit", `只列出前 ${limits.steps} 步，本单元共 ${unit.steps.length} 步。`);
  }
  const step = unit.steps[state.unitStep >= 0 ? state.unitStep : unit.steps.length - 1];
  if (step?.levels.length) {
    $("unit-levels").hidden = false;
    const levels = $("unit-level-list");
    levels.replaceChildren();
    for (const level of step.levels) {
      const row = clone("unit-level-template");
      row.querySelector("[data-level]")!.textContent = `第 ${level.depth} 层事务`;
      row.querySelector("[data-events]")!.textContent = `事件 FIFO：${level.events.length ? level.events.join("、") : "空"}`;
      row.querySelector("[data-tasks]")!.textContent = `任务 FIFO：${level.tasks.length ? level.tasks.map(taskText).join("、") : "空"}`;
      levels.append(row);
    }
  }
}

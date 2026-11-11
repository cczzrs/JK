/**
 * 展示页的自动验收（tools/show.ts 打开页面时运行）。通过页面控件操作：加载示例或模型、执行运行脚本、
 * 发送输入并单步、时间轴跳转、切换渲染器与布局、图片转输入、GPU 对拍；再把页面导出的执行记录、
 * 页面与场景显示的状态交回，与 CPU 后端（命令行计算的期望值）比较。
 */

import type { Bit, RunScript } from "../../src/model.ts";
import type { ShowApi } from "./main.ts";
import { observeKey } from "./scene/model-view.ts";

export type CaseKind = "script" | "animate" | "manual" | "timeline" | "canvas" | "image" | "txlimit" | "invalid" | "layouts";

export interface ShowCase {
  name: string;
  kind: CaseKind;
  /** 通过“JKRD7 示例”加载的模型；没有时用 model 经“校验并加载”载入。 */
  example?: string;
  model?: unknown;
  script: RunScript;
  /** CPU 后端（src/executor.ts）的执行记录文本。 */
  expected: string;
  units: number;
  outputs: number;
  q: Record<string, Bit>;
  /** 每个 JKI 的 q 写入次数。 */
  counts: Record<string, number>;
  /** 场景中观察点的个数（JKM.output 的成员数）。 */
  observeNodes: number;
  /** 再用 GPU 后端执行这么多个实例并对拍。 */
  gpu?: number;
  /** 时间轴：第 k 个与第 k−1 个处理单元时的 q。 */
  timeline?: { k: number; qAt: Record<string, Bit>; qBefore: Record<string, Bit> };
  /** 逐个单步时，每个单元的步数（来自执行细节）。 */
  steps?: number[];
  /** 图片转输入：像素（1 为白、0 为黑）、尺寸与两个入口。 */
  image?: { pixels: Bit[]; width: number; height: number; zero: string; one: string };
  /** 期望的错误信息片段（事务超限、旧格式模型）。 */
  error?: string;
}

export interface ShowJob {
  mode: "show";
  cases: ShowCase[];
  timeoutMs: number;
}

export interface CaseResult {
  case: string;
  passed: boolean;
  detail: string;
}

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`页面缺少 #${id}`);
  return element as T;
};
const text = (id: string): string => el(id).textContent ?? "";
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function until(what: string, ok: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!ok()) {
    if (performance.now() > deadline) throw new Error(`等待超时：${what}（页面消息：${text("message")}）`);
    await sleep(20);
  }
}

function setValue(id: string, value: string, event: "input" | "change" = "change"): void {
  const field = el<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id);
  field.value = value;
  field.dispatchEvent(new Event(event));
}

function setChecked(id: string, checked: boolean): void {
  const box = el<HTMLInputElement>(id);
  if (box.checked !== checked) {
    box.checked = checked;
    box.dispatchEvent(new Event("change"));
  }
}

function click(id: string): void {
  el<HTMLButtonElement>(id).click();
}

function failed(): boolean {
  return el("message").classList.contains("error");
}

function sameQ(api: ShowApi, expected: Record<string, Bit>, where: string, problems: string[]): void {
  const q = api.session().ex.q;
  const wrong = Object.entries(expected).filter(([path, value]) => q.get(path) !== value).map(([path]) => path);
  if (wrong.length) problems.push(`${where}：${wrong.length} 个 JKI 的 q 不同（如 ${wrong[0]}）`);
}

/** 页面导出的记录、页面显示的状态、场景显示的 q 与次数，与 CPU 后端的结果是否一致。 */
function compare(api: ShowApi, c: ShowCase, problems: string[], quiet = true): void {
  const records = api.exportRecords();
  if (records !== c.expected) {
    const a = records.split("\n");
    const b = c.expected.split("\n");
    const line = a.findIndex((value, i) => value !== b[i]);
    problems.push(`执行记录不同：第 ${line + 1} 行，页面 ${a[line] ?? "（无）"}，CPU ${b[line] ?? "（无）"}`);
  }
  if (text("stat-units") !== String(c.units)) problems.push(`处理单元显示 ${text("stat-units")}，CPU ${c.units}`);
  if (quiet) {
    if (text("events-count") !== "0" || text("tasks-count") !== "0") problems.push(`静止后 FIFO 显示 ${text("events-count")}／${text("tasks-count")}`);
    if (text("run-state") !== "静止") problems.push(`运行状态显示“${text("run-state")}”`);
  }
  if (c.outputs > 0 && !text("output-status").startsWith(`${c.outputs} 次输出`)) problems.push(`输出状态显示“${text("output-status")}”，CPU ${c.outputs} 次输出`);
  const listed = el("output-list-body").children;
  if (listed.length !== c.outputs) problems.push(`输出列表有 ${listed.length} 行，CPU ${c.outputs} 次输出`);
  const lastOutput = c.expected.split("\n").filter((l) => l.startsWith('{"output"')).at(-1);
  if (lastOutput && listed.length) {
    const record = JSON.parse(lastOutput) as { output: string; values: Record<string, number[]> };
    const cells = [...listed[listed.length - 1].children].map((cell) => cell.textContent);
    const values = Object.entries(record.values).map(([name, bits]) => `${name} [${bits.join(", ")}]`).join(" · ");
    if (cells[2] !== record.output || cells[3] !== values) problems.push(`输出列表最后一行是 ${cells.join(" ")}，应为 ${lastOutput}`);
  }
  // 指定触发组（事件到达、全部输出数据）：每组的行数等于来源属于该组的输出记录数；核对后恢复为每条输出。
  const groups = Object.entries(JSON.parse(el<HTMLTextAreaElement>("output-json").value) as Record<string, string[]>);
  // 下拉框设值；标签页（记录方式、渲染模式）点击对应的标签。
  const choose = (id: string, value: string) => {
    const element = el(id);
    if (element.getAttribute("role") === "tablist") {
      element.querySelector<HTMLButtonElement>(`[role="tab"][data-value="${value}"]`)!.click();
      return;
    }
    const select = element as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event("change"));
  };
  for (const [name, members] of groups) {
    choose("output-mode", "trigger");
    choose("output-trigger-when", "arrive");
    choose("output-trigger-content", "all");
    choose("output-trigger-group", name);
    const want = c.expected.split("\n").filter((l) => l.startsWith('{"output"') && members.includes((JSON.parse(l) as { output: string }).output)).length;
    const got = el("output-list-body").children.length;
    if (got !== want) problems.push(`输出列表按触发组 ${name} 记录了 ${got} 行，应为 ${want} 行`);
    // 按输出格式：每条输出各给一组输出节点动画，场景只保留成行的输出（全部成员）；不勾选时全部保留。
    const { model, outputs } = api.session();
    const transfers = outputs.flatMap((_, n) => model.output.map((path) => ({ source: path, target: observeKey(path), value: "", relation: "observe" as const, output: n })));
    const step = { depth: 0, kind: "event" as const, path: "", entries: [], transfers, pulses: [], levels: [] };
    const kept = (checked: boolean) => {
      setChecked("by-output-format", checked);
      const shown = api.sceneStep(step).transfers;
      return { outputs: new Set(shown.map((t) => t.output)).size, transfers: shown.length };
    };
    const on = kept(true);
    if (on.outputs !== want || on.transfers !== want * model.output.length) problems.push(`按输出格式（触发组 ${name}）场景保留 ${on.outputs} 条输出、${on.transfers} 段动画，应为 ${want} 条、${want * model.output.length} 段`);
    const off = kept(false);
    if (off.outputs !== outputs.length) problems.push(`不按输出格式时场景保留 ${off.outputs} 条输出，应为 ${outputs.length} 条`);
    setChecked("by-output-format", true);
  }
  choose("output-mode", "all");
  // 不勾选切片记录（真实运行）：每条输出一行，只记到达的成员；输出节点的动画每条输出只画这一个成员（不论是否按输出格式）。
  setChecked("slice-record", false);
  {
    const rows = el("output-list-body").children;
    if (rows.length !== c.outputs) problems.push(`真实运行记录有 ${rows.length} 行，应为 ${c.outputs} 行`);
    if (lastOutput && rows.length) {
      const record = JSON.parse(lastOutput) as { output: string; values: Record<string, number[]> };
      const [name, members] = groups.find(([, paths]) => paths.includes(record.output))!;
      const want = `${name} [${record.output}=${record.values[name][members.indexOf(record.output)]}]`;
      const cell = rows[rows.length - 1].children[3].textContent;
      if (cell !== want) problems.push(`真实运行记录最后一行的 values 是“${cell}”，应为“${want}”`);
    }
    const { model, outputs } = api.session();
    const transfers = outputs.flatMap((_, n) => model.output.map((path) => ({ source: path, target: observeKey(path), value: "", relation: "observe" as const, output: n })));
    for (const byFormat of [true, false]) {
      setChecked("by-output-format", byFormat);
      const shown = api.sceneStep({ depth: 0, kind: "event", path: "", entries: [], transfers, pulses: [], levels: [] }).transfers;
      const real = shown.every((t) => t.source === outputs[t.output!].source) && shown.length === outputs.length;
      if (!real) problems.push(`不勾选切片记录${byFormat ? "、按输出格式" : ""}时场景保留 ${shown.length} 段输出动画，应为每条输出只画到达的成员（${outputs.length} 段）`);
    }
    setChecked("by-output-format", true);
  }
  setChecked("slice-record", true);
  // 输出渲染跟随输出列表：kara 之后为 0 行，全部渲染后等于列表行数。
  const click = (id: string) => el<HTMLButtonElement>(id).click();
  click("render-clear");
  if (text("render-count") !== "渲染 0 行") problems.push(`kara 之后输出渲染显示“${text("render-count")}”`);
  click("render-all");
  if (text("render-count") !== `渲染 ${c.outputs} 行`) problems.push(`全部渲染后显示“${text("render-count")}”，应为 ${c.outputs} 行`);
  // ASCII 二进制：按 done 组触发时，每条 done 输出的 data 组转成一个字符（不可打印时写十六进制码）。
  const done = groups.find(([name]) => name === "done")?.[1];
  if (done && groups.some(([name]) => name === "data")) {
    choose("output-mode", "trigger");
    choose("output-trigger-group", "done");
    choose("output-render-mode", "ascii");
    const want = c.expected.split("\n").filter((l) => l.startsWith('{"output"')).map((l) => JSON.parse(l) as { output: string; values: Record<string, number[]> })
      .filter((r) => done.includes(r.output)).map((r) => {
        const code = parseInt(r.values.data.join(""), 2);
        return r.values.data.length === 8 && code >= 32 && code <= 126 ? String.fromCharCode(code) : `[0x${code.toString(16).toUpperCase()}]`;
      }).join("");
    if (text("output-ascii") !== want) problems.push(`ASCII 渲染为“${text("output-ascii")}”，应为“${want}”`);
    choose("output-render-mode", "rgb");
    choose("output-mode", "all");
  }
  const lines = c.expected.split("\n").filter(Boolean);
  const rows = el("trace-list").children;
  if (lines.length && !rows.length) problems.push("执行记录窗口没有显示记录");
  if (lines.length && rows.length) {
    const last = rows[rows.length - 1] as HTMLElement;
    if (last.title !== JSON.stringify(JSON.parse(lines[lines.length - 1]))) problems.push(`执行记录窗口的最后一行是 ${last.title}`);
  }
  let wrong = 0;
  for (const [path, value] of Object.entries(c.q)) {
    api.selectNode(path);
    if (text("node-q") !== String(value) && wrong++ < 3) problems.push(`节点详情 ${path} 的当前 q 显示 ${text("node-q")}，CPU ${value}`);
  }
  api.selectNode(null);
  if (wrong > 3) problems.push(`另有 ${wrong - 3} 个节点详情的 q 不同`);
  const scene = api.scene();
  let sceneWrong = 0;
  for (const [path, value] of Object.entries(c.q)) {
    const node = scene.nodes[path];
    const count = c.counts[path] ?? 0;
    if (!node || node.q !== value || node.count !== count) {
      if (sceneWrong++ < 3) problems.push(`场景中 ${path} 显示 q=${node?.q} · ${node?.count} 次，CPU q=${value} · ${count} 次`);
    }
  }
  if (sceneWrong > 3) problems.push(`另有 ${sceneWrong - 3} 个场景节点不同`);
  if (scene.observe !== c.observeNodes) problems.push(`场景中有 ${scene.observe} 个观察点，应为 ${c.observeNodes} 个`);
}

async function load(api: ShowApi, c: ShowCase, timeoutMs: number): Promise<void> {
  if (c.model !== undefined) {
    setValue("model-json", JSON.stringify(c.model));
    click("model-apply");
    const name = (c.model as { jkm?: string }).jkm ?? "";
    await until(`加载 ${name}`, () => text("model-name") === name || text("model-error") !== "", timeoutMs);
    if (text("model-error")) throw new Error(text("model-error"));
  } else {
    api.loadExample(c.example!);
    await until(`加载 ${c.example}`, () => text("model-name") === c.example, timeoutMs);
  }
  setValue("model-path", c.script.model);
}

async function runScript(api: ShowApi, c: ShowCase, timeoutMs: number): Promise<void> {
  setValue("script-json", JSON.stringify(c.script));
  click("script-run");
  if (text("script-error")) throw new Error(text("script-error"));
  await until("运行脚本完成", () => !api.isRunning() || api.isSettled(), timeoutMs);
  if (!text("message").startsWith("运行脚本完成")) throw new Error(text("message"));
}

async function gpuCompare(c: ShowCase, timeoutMs: number, problems: string[]): Promise<void> {
  setValue("script-json", JSON.stringify(c.script));
  setValue("gpu-instances", String(c.gpu));
  click("gpu-run");
  await until("GPU 对拍完成", () => !el<HTMLButtonElement>("gpu-run").disabled && text("gpu-result") !== "正在 GPU 上执行…", timeoutMs);
  if (!text("gpu-result").includes("逐字节相同")) problems.push(`GPU 对拍：${text("gpu-result")}`);
}

/** 画一张黑白图（1 为白、0 为黑），经文件输入框交给页面。 */
async function chooseImage(image: NonNullable<ShowCase["image"]>, timeoutMs: number): Promise<void> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d")!;
  image.pixels.forEach((bit, i) => {
    ctx.fillStyle = bit ? "#ffffff" : "#000000";
    ctx.fillRect(i % image.width, Math.floor(i / image.width), 1, 1);
  });
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const files = new DataTransfer();
  files.items.add(new File([blob], "pattern.png", { type: "image/png" }));
  const field = el<HTMLInputElement>("image-file");
  field.files = files.files;
  field.dispatchEvent(new Event("change"));
  await until("图片解码", () => {
    const preview = el<HTMLCanvasElement>("image-preview").getContext("2d")!.getImageData(0, 0, 1, 1).data;
    return preview[3] > 0 || text("image-error") !== "";
  }, timeoutMs);
  if (text("image-error")) throw new Error(text("image-error"));
}

async function runCase(api: ShowApi, c: ShowCase, timeoutMs: number): Promise<string> {
  const problems: string[] = [];
  if (c.kind === "invalid") {
    const before = text("model-name");
    setValue("model-json", JSON.stringify(c.model));
    click("model-apply");
    await until("静态检查结果", () => text("model-error") !== "", timeoutMs);
    if (!text("model-error").includes(c.error ?? "")) problems.push(`错误信息是“${text("model-error").slice(0, 80)}”`);
    if (text("model-name") !== before) problems.push("当前模型被替换了");
    if (problems.length) throw new Error(problems.join("；"));
    return `旧格式模型被拒绝，列出 ${text("model-error").split("\n").length - 1} 条违规，当前模型保留`;
  }
  await load(api, c, timeoutMs);
  if (c.kind === "layouts") {
    for (const mode of ["1D", "2D", "3D", "4D", "5D", "auto"]) {
      document.querySelector<HTMLButtonElement>(`[data-layout="${mode}"]`)!.click();
      await until(`${mode} 布局`, () => text("layout-status") !== "正在排列…", timeoutMs);
      if (text("layout-status").startsWith("布局失败")) problems.push(`${mode}：${text("layout-status")}`);
      else if (mode !== "auto" && api.scene().layout !== mode) problems.push(`${mode}：场景布局是 ${api.scene().layout}`);
    }
    const group = [...api.session().model.jks.keys()][0];
    api.selectNode(group);
    if (el("group-sections").hidden || text("group-registrations") === "—") problems.push(`选中 ${group} 后没有显示 JKS 详情`);
    // JKS 边界框的默认显示由 config.ts 决定；核对时临时打开，核对后恢复。
    const boxes = document.querySelector<HTMLButtonElement>("#jks-boxes")!;
    const wasOn = boxes.getAttribute("aria-pressed") === "true";
    if (!wasOn) boxes.click();
    const groups = api.scene().groups;
    if (groups < 1) problems.push("打开 JKS 边界后，场景中没有 JKS 边界框");
    if (!wasOn) boxes.click();
    api.selectNode(null);
    if (problems.length) throw new Error(problems.join("；"));
    return `六种布局都完成；选中 ${group} 显示 JKS 详情；打开 JKS 边界后场景中有 ${groups} 个边界框`;
  }
  setChecked("skip", c.kind !== "animate");
  setValue("speed", c.kind === "animate" ? el<HTMLInputElement>("speed").max : "1", "input");
  let extra = "";
  if (c.kind === "canvas") {
    await api.renderer("canvas");
    if (text("render-status") !== "Canvas 3D") problems.push(`渲染显示“${text("render-status")}”`);
  }
  if (c.kind === "manual") {
    const steps: number[] = [];
    for (const [i, batch] of c.script.batches.entries()) {
      setValue("input-json", JSON.stringify(batch));
      click("send");
      if (failed()) throw new Error(text("message"));
      if (text("events-count") !== String(batch.length)) problems.push(`第 ${i + 1} 批发送后事件 FIFO 显示 ${text("events-count")} 项`);
      const first = el("events-list").querySelector("[data-target]")?.textContent;
      if (first !== batch[0]) problems.push(`第 ${i + 1} 批发送后事件 FIFO 首项是 ${first}`);
      let guard = 0;
      while (text("run-state") !== "静止") {
        click("step");
        if (failed()) throw new Error(text("message"));
        steps.push(api.lastUnit()?.steps.length ?? -1);
        if (++guard > 100000) throw new Error("单步次数过多");
      }
    }
    const unit = api.lastUnit();
    if (unit && el("unit-steps").children.length !== Math.min(unit.steps.length, 200)) problems.push(`本单元窗口列出 ${el("unit-steps").children.length} 步，单元有 ${unit.steps.length} 步`);
    if (c.steps && JSON.stringify(steps) !== JSON.stringify(c.steps)) problems.push(`各单元的步数 ${JSON.stringify(steps)}，执行细节应为 ${JSON.stringify(c.steps)}`);
    extra = `；各单元步数 ${JSON.stringify(steps)}`;
  } else if (c.kind === "txlimit") {
    setValue("input-json", JSON.stringify(c.script.batches[0]));
    click("send");
    click("play");
    await until("停止", () => !api.isRunning(), timeoutMs);
    if (text("run-state") !== "已停止") problems.push(`运行状态显示“${text("run-state")}”`);
    if (!text("message").includes(c.error ?? "")) problems.push(`消息是“${text("message")}”`);
    extra = `；停在第 ${text("stat-units")} 个处理单元：${text("message")}`;
  } else if (c.kind === "image") {
    const image = c.image!;
    await chooseImage(image, timeoutMs);
    setValue("image-zero", image.zero);
    setValue("image-one", image.one);
    setValue("image-pixels", String(image.width * image.height));
    click("image-convert");
    if (text("image-error")) throw new Error(text("image-error"));
    const script = JSON.parse(el<HTMLTextAreaElement>("script-json").value) as RunScript;
    if (JSON.stringify(script.batches) !== JSON.stringify(c.script.batches)) problems.push(`生成的输入批 ${JSON.stringify(script.batches)}`);
    click("script-run");
    await until("运行脚本完成", () => !api.isRunning() || api.isSettled(), timeoutMs);
    extra = `；图片生成 ${script.batches.length} 批`;
  } else {
    await runScript(api, c, timeoutMs);
  }
  compare(api, c, problems, c.kind !== "txlimit");
  if (c.kind === "timeline" && c.timeline) {
    const t = c.timeline;
    setValue("unit-jump", String(t.k));
    click("unit-jump-go");
    if (api.session().units !== t.k) problems.push(`跳转后在第 ${api.session().units} 个处理单元`);
    sameQ(api, t.qAt, `跳到第 ${t.k} 个处理单元`, problems);
    click("step-back");
    if (api.session().units !== t.k - 1) problems.push(`后退后在第 ${api.session().units} 个处理单元`);
    sameQ(api, t.qBefore, `后退到第 ${t.k - 1} 个处理单元`, problems);
    setValue("unit-jump", String(c.units));
    click("unit-jump-go");
    if (api.exportRecords() !== c.expected) problems.push("跳回终点后执行记录与 CPU 不同");
    if (text("run-state") !== "静止") problems.push(`跳回终点后运行状态显示“${text("run-state")}”`);
    extra = `；跳到第 ${t.k} 个、后退到第 ${t.k - 1} 个、再跳回第 ${c.units} 个，状态与记录都与 CPU 相同`;
  }
  if (c.kind === "canvas") {
    await api.renderer("auto");
    if (text("render-status") !== "WebGPU") problems.push(`恢复后渲染显示“${text("render-status")}”`);
    extra = "；Canvas 2D 渲染下运行，再恢复 WebGPU";
  }
  if (c.gpu) await gpuCompare(c, timeoutMs, problems);
  if (problems.length) throw new Error(problems.join("；"));
  return `${c.expected.split("\n").length - 1} 条记录、${c.units} 个处理单元、${Object.keys(c.q).length} 个 q（节点详情与场景）与 CPU 后端一致`
    + `${extra}${c.gpu ? `；${text("gpu-result")}` : ""}`;
}

export async function verify(api: ShowApi, job: unknown): Promise<void> {
  const { cases, timeoutMs } = job as ShowJob;
  const results: CaseResult[] = [];
  let fatal: string | null = null;
  try {
    await api.ready;
    await until("示例加载", () => api.examples().size > 0, timeoutMs);
    // 打开要读取的窗口：隐藏或收起的窗口不重建列表。
    for (const key of ["events", "tasks", "history", "inspector", "output", "render", "observe", "unit"]) api.open(key);
    for (const c of cases) {
      try {
        results.push({ case: c.name, passed: true, detail: await runCase(api, c, timeoutMs) });
      } catch (error) {
        results.push({ case: c.name, passed: false, detail: error instanceof Error ? error.message : String(error) });
      }
      void fetch("/__log", { method: "POST", body: `${results.at(-1)!.passed ? "通过" : "失败"}  ${c.name}` });
    }
  } catch (error) {
    fatal = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  }
  await fetch("/__result", {
    method: "POST",
    body: JSON.stringify({ fatal, cases: results, render: text("render-status"), layout: text("layout-status"), userAgent: navigator.userAgent }),
  });
}

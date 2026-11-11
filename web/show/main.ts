/**
 * 展示页入口：把窗口、控件、3D 场景、面板、播放与 GPU 对拍连接起来。
 *
 * 执行全部由 JK 的执行器完成：交互用 CPU 后端（session.ts 包装 src/cpu.ts），GPU 后端（src/gpu/backend.ts）
 * 在“运行脚本”中整段执行并与 CPU 逐字节对拍。页面只负责显示与交互（JKRD7 §9.2 的展示模块）。
 * 面板在 panels.ts，播放与时间轴在 playback.ts，GPU 对拍在 gpu-run.ts。
 */

import { APP_CONFIG } from "./config.ts";
import { type Jkm, type RunScript, Model, checkRunScript, formatJkmJson, isInputEntry, sortPaths } from "../../src/model.ts";
import { formatRecords } from "../../src/record.ts";
import { Session, type Step, type Unit } from "./session.ts";
import { type Loaded, current, state } from "./state.ts";
import { clearRender, listedMembers, outputDataText, outputListText, renderAll, renderInspector, renderPanels, renderUnit, setPanelHooks } from "./panels.ts";
import { Playback } from "./playback.ts";
import { GpuRunner } from "./gpu-run.ts";
import { SharedDevice } from "./gpu-device.ts";
import { NetworkView } from "./scene/view.ts";
import { setupSceneFullscreen } from "./scene/fullscreen.ts";
import { NodeTree } from "./ui/node-tree.ts";
import { CosmicWorkspace } from "./ui/cosmic-workspace.ts";
import { NetworkStylePanel } from "./ui/network-style-panel.ts";
import { pixelsToBatches } from "./ui/image-input.ts";
import { byId, clone, errorMessage } from "./ui/dom.ts";
import { OutputChoiceStore } from "./ui/output-choices.ts";

const $ = (id: string): HTMLElement => byId(id);
const input = (id: string): HTMLInputElement => byId(id, HTMLInputElement);
const area = (id: string): HTMLTextAreaElement => byId(id, HTMLTextAreaElement);
const choice = (id: string): HTMLSelectElement => byId(id, HTMLSelectElement);
const button = (id: string): HTMLButtonElement => byId(id, HTMLButtonElement);
const canvasOf = (id: string): HTMLCanvasElement => byId(id, HTMLCanvasElement);
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);
const setText = (id: string, text: unknown): void => {
  const element = document.getElementById(id);
  if (element) element.textContent = String(text);
};

const jkmPanel = $("jkm-panel");
jkmPanel.style.setProperty("--cosmic-rail-bg", APP_CONFIG.desktop.theme.rail);
jkmPanel.style.setProperty("--cosmic-fg", APP_CONFIG.desktop.theme.foreground);
jkmPanel.style.setProperty("--cosmic-scene-background-edge", APP_CONFIG.scene.appearance.backgroundEdge);
for (const section of $("node-inspector").querySelectorAll<HTMLDetailsElement>("[data-inspector-section]")) {
  section.open = APP_CONFIG.view.inspector.sections[section.dataset.inspectorSection ?? ""] ?? false;
}
byId("events-records", HTMLDetailsElement).open = APP_CONFIG.view.queues.events.records.expanded;
byId("jkm-metadata-details", HTMLDetailsElement).open = APP_CONFIG.view.disclosures.jkm.metadata;
const labelsButton = button("node-labels");
/** “隐藏名称和次数”按钮：aria-pressed 为已隐藏，文字是点击后的动作。 */
function showLabelsButton(hidden: boolean): void {
  labelsButton.setAttribute("aria-pressed", String(hidden));
  labelsButton.textContent = hidden ? "显示名称和次数" : "隐藏名称和次数";
}
button("black-background").setAttribute("aria-pressed", String(APP_CONFIG.scene.blackBackground));
button("jks-boxes").setAttribute("aria-pressed", String(APP_CONFIG.scene.jks.visible));

let examples = new Map<string, Jkm>();
let imageBitmap: ImageBitmap | null = null;
let imageLoadVersion = 0;
let disposed = false;
let gpuDispatches = 0;
let gpuRecords: { run: string; text: string } | null = null;
let frameRequested = false;
const fileVersions = new Map<string, number>();
const devices = new SharedDevice();
const gpuRunner = new GpuRunner();

const nodeTree = new NodeTree({
  element: $("node-tree"),
  groupTemplate: byId("node-tree-group-template", HTMLTemplateElement),
  nodeTemplate: byId("node-tree-node-template", HTMLTemplateElement),
  tagTemplate: byId("node-purpose-tag-template", HTMLTemplateElement),
  onSelect: selectNode,
  expandedDepth: APP_CONFIG.view.inspector.tree.expandedDepth,
});

const view = new NetworkView({
  container: $("viewport"),
  onSelect: selectNode,
  device: () => devices.acquire(),
  onStatus: (status) => {
    setText("render-status", status.label);
    $("render-status").title = status.reason ?? status.label;
    $("gpu-message").hidden = status.backend !== "error";
    setText("gpu-detail", status.reason ?? "");
  },
  onLayout: (layout) => {
    if (layout.pending) setText("layout-status", "正在排列…");
    else if (layout.error) setText("layout-status", `布局失败：${layout.error}`);
    else setText("layout-status", layout.label ?? `${layout.mode} 布局`);
  },
  onStep: (index) => {
    state.unitStep = index;
    if (desktop.isOpen("unit")) renderUnit();
  },
});

const desktop = new CosmicWorkspace({
  root: jkmPanel,
  config: APP_CONFIG.desktop,
  onAppearanceChange: (key, appearance) => {
    if (key !== "scene") return;
    const result = view.applyAppearance(appearance);
    if (result.blackBackgroundChanged) button("black-background").setAttribute("aria-pressed", "false");
  },
});
jkmPanel.addEventListener("network-style-error", (event) => message((event as CustomEvent<{ message: string }>).detail.message, true));
jkmPanel.addEventListener("cosmic-workspace-error", (event) => message((event as CustomEvent<{ message: string }>).detail.message, true));
// 窗口显示或展开时补上它的内容（隐藏、收起的窗口不随执行刷新）。
jkmPanel.addEventListener("cosmic-window-show", () => render());
/** 输出数据格式及列表、输出渲染的选择与运行控制的三个勾选框：恢复上次的选择，改动时保存并刷新。 */
const { skip, slice, byOutputFormat } = APP_CONFIG.playback;
const outputChoices = new OutputChoiceStore({
  ...APP_CONFIG.view.outputChoices,
  defaults: { ...APP_CONFIG.view.outputChoices.defaults, skip, slice, byOutputFormat, labelsHidden: APP_CONFIG.scene.nodeLabelsHidden },
}, () => renderPanels());
showLabelsButton(outputChoices.labelsHidden);
view.setLabels(!outputChoices.labelsHidden);
const networkStylePanel = new NetworkStylePanel({
  root: jkmPanel,
  config: APP_CONFIG.scene.styles,
  onChange: (styles) => view.setNetworkStyles(styles),
});

const playback = new Playback({
  render: () => render(),
  requestRender: () => requestRender(),
  animate: (unit, single) => {
    if (!unit) return 0;
    view.update(current().session, state.selected);
    return view.onUnit({ ...unit, steps: unit.steps.map(forScene) }, { force: single });
  },
  message: (text, error) => message(text, error),
  skip: () => input("skip").checked,
  speed: () => Number(input("speed").value),
});

setPanelHooks({
  isOpen: (key) => desktop.isOpen(key),
  select: selectNode,
  showStep,
  running: () => playback.running,
  gpuDispatches: () => gpuDispatches,
  timeline: () => playback.timeline(),
});

// -- 小工具 ---------------------------------------------------------------

function message(text: string, error = false): void {
  setText("message", text);
  $("message").classList.toggle("error", error);
}

function options(element: HTMLSelectElement, items: [string, string][], selectedValue?: string): void {
  element.replaceChildren();
  for (const [value, label] of items) {
    const option = clone<HTMLOptionElement>("option-template");
    option.value = value;
    option.textContent = label;
    element.append(option);
  }
  if (selectedValue !== undefined) element.value = selectedValue;
}

function download(name: string, value: unknown, type = "application/json"): void {
  const text = typeof value === "string" ? value : pretty(value) + "\n";
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = clone<HTMLAnchorElement>("download-template");
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, "_");
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readJsonFile(file: File): Promise<unknown> {
  if (file.size > APP_CONFIG.view.fileBytes) throw new Error("文件超过 32 MiB 限制");
  return JSON.parse(await file.text()) as unknown;
}

function action(id: string, fn: () => unknown, errorId?: string): void {
  $(id).addEventListener("click", async () => {
    if (errorId) setText(errorId, "");
    try {
      await fn();
    } catch (error) {
      if (errorId) setText(errorId, errorMessage(error));
      message(errorMessage(error), true);
      render();
    }
  });
}

function updatePlayback(): void {
  const skip = input("skip").checked;
  const speed = Number(input("speed").value);
  view.setPlayback({ running: playback.running, speed, skip });
  setText("speed-label", skip ? "计算速度" : "动画速度");
  setText("speed-budget", skip ? `每帧预算 ${APP_CONFIG.engine.frameBudgetMs * speed} ms` : `每单元 ${(APP_CONFIG.playback.duration / speed).toFixed(2)} 秒`);
}

/** 立即刷新全部显示。 */
function render(): void {
  frameRequested = false;
  if (!state.loaded || !state.session) return;
  // 播放按钮只有两种状态，显示当前状态：播放中、暂停中。
  setText("play", playback.running ? "▶ 播放中" : "Ⅱ 暂停中");
  $("play").setAttribute("aria-pressed", String(playback.running));
  updatePlayback();
  renderPanels();
  view.update(state.session, state.selected);
}

/** 在下一帧刷新：播放中一帧最多刷新一次。 */
function requestRender(): void {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    if (frameRequested) render();
  });
}

function selectNode(path: string | null): void {
  const model = state.loaded?.model;
  if (path !== null && !(model?.jki.has(path) || model?.jks.has(path))) return;
  state.selected = path;
  nodeTree.select(path);
  renderInspector();
  if (state.session) view.update(state.session, state.selected);
}

/**
 * 场景中的一步，取舍输出节点的动画：
 * - 不勾选“切片记录”时与真实运行一样，每条输出只画到达的成员，没有读取其他成员的动画；
 * - 勾选“按输出格式”时，只保留在“输出数据格式及列表”中成行的输出，并且只画该行记录的成员。
 */
function forScene(step: Step): Step {
  const slice = input("slice-record").checked;
  const byFormat = input("by-output-format").checked;
  if (slice && !byFormat) return step;
  const session = current().session;
  return {
    ...step,
    transfers: step.transfers.filter((t) => {
      if (t.relation !== "observe" || t.output === undefined) return true;
      if (!slice && t.source !== session.outputs[t.output]?.source) return false;
      if (!byFormat) return true;
      const members = listedMembers(session, t.output);
      return members === "all" || Boolean(members?.has(t.source));
    }),
  };
}

/** 在场景中重播本单元的第 index 步，并在本单元窗口中标出。 */
function showStep(index: number): void {
  const step = state.unit?.steps[index];
  if (!step) return;
  state.unitStep = index;
  view.showStep(forScene(step), index);
  renderUnit();
}

function currentScript(batches?: string[][]): RunScript {
  return {
    run: APP_CONFIG.model.runName,
    model: state.modelPath,
    batches: batches ?? [JSON.parse(area("input-json").value) as string[]],
  };
}

/** 解析并检查运行脚本（§9.4）。 */
function checkedScript(text: string): RunScript {
  const { loaded: l } = current();
  const script = JSON.parse(text) as unknown;
  const problems = checkRunScript(script, l.model);
  if (problems.length) throw new Error("运行脚本不合法：\n" + problems.join("\n"));
  return script as RunScript;
}

/** 页面导出的执行记录：与 node tools/reference.ts --script 的输出逐字节相同（§9.4）。 */
function exportRecords(): string {
  return formatRecords(current().session.ex.record());
}

function modelDefaults(model: Model, inputs: string[], builtin: boolean): { path: string; input: string[] } {
  const config = APP_CONFIG.model;
  const name = model.name ?? "model";
  const preset = builtin && Object.hasOwn(config.presets, name) ? config.presets[name] : null;
  const { startIndex, count } = config.defaults.input;
  return {
    path: preset?.path ?? `${name}.jkm.json`,
    input: structuredClone(preset?.input ?? inputs.slice(startIndex, startIndex + count)),
  };
}

// -- 模型 -----------------------------------------------------------------

function loadModel(data: unknown, path?: string, builtin = false): void {
  const name = typeof (data as { jkm?: unknown })?.jkm === "string" ? (data as { jkm: string }).jkm : "JKM";
  const model = new Model(data, path ?? name);
  if (model.errors.length) {
    const shown = model.errors.slice(0, 12).join("\n");
    throw new Error(`模型未通过 JKRD7 静态检查（共 ${model.errors.length} 条）：\n${shown}${model.errors.length > 12 ? "\n……" : ""}`);
  }
  const raw = data as Jkm;
  const inputs = sortPaths([...model.jki.keys()].filter((p) => isInputEntry(model, p)));
  const defaults = modelDefaults(model, inputs, builtin);
  const session = new Session(model, APP_CONFIG.view.traceRows); // 多个 thread 时 CPU 后端拒绝执行（§9.3）
  // 模型与执行器都检查通过之后再替换当前状态。
  const edges = [...model.triggerRefs.values()].reduce((sum, list) => sum + list.length, 0)
    + [...model.sourceRefs.values()].reduce((sum, list) => sum + list.length, 0);
  const operations = [...model.jki.values()].reduce((sum, node) => sum + (node.sources?.ex?.length ?? 0), 0);
  const loaded: Loaded = { raw, model, inputs, edges, operations };
  state.loaded = loaded;
  playback.begin(session);
  state.modelPath = path ?? defaults.path;
  state.selected = null;
  gpuRunner.reset();
  setText("model-name", raw.jkm);
  setText("model-md5", `JKRD ${raw.version}`);
  setText("cosmic-model-name", raw.jkm);
  $("cosmic-model-name").title = raw.jkm;
  setText("cosmic-model-md5", raw.version);
  setText("model-summary", `${raw.version} · ${model.jki.size} JKI / ${model.jks.size} JKS · JKRD7 静态检查通过`);
  setText("metadata", pretty({ jkm: raw.jkm, version: raw.version, threads: raw.threads, input: raw.input, output: raw.output, roots: raw.roots.map((g) => g.id) }));
  for (const id of ["events-queue-name", "tasks-queue-name"]) setText(id, `thread ${session.thread ?? "—"}`);
  area("model-json").value = formatJkmJson(raw);
  input("model-path").value = state.modelPath;
  area("input-json").value = pretty(defaults.input);
  area("script-json").value = pretty(currentScript());
  area("output-json").value = pretty(raw.output);
  outputChoices.setGroups(Object.keys(raw.output));
  $("input-buttons").replaceChildren();
  for (const entryPath of inputs) {
    const entry = clone<HTMLButtonElement>("input-template");
    const node = model.jki.get(entryPath)!;
    const tag = node.pro?.tag?.filter((value) => value !== "pre").join(" ");
    entry.querySelector("strong")!.textContent = tag || node.id;
    entry.querySelector("span")!.textContent = entryPath;
    entry.title = `注入 ${entryPath}`;
    entry.addEventListener("click", () => {
      try {
        playback.inject([entryPath]);
        message(`已注入 ${entryPath}；${playback.running ? "播放中，将自动处理。" : "点击播放或单步处理。"}`);
      } catch (error) {
        message(errorMessage(error), true);
      }
      render();
    });
    $("input-buttons").append(entry);
  }
  nodeTree.setModel(raw, null);
  const mapping = APP_CONFIG.image.inputMapping;
  for (const [id, index] of [["image-zero", mapping.zeroIndex], ["image-one", mapping.oneIndex]] as const) {
    options(choice(id), inputs.map((p) => [p, p]));
    choice(id).value = inputs[Math.min(index, inputs.length - 1)] ?? "";
  }
  gpuRecords = null;
  button("gpu-download").disabled = true;
  setText("gpu-result", "尚未在 GPU 上执行。");
  networkStylePanel.setModel(model);
  view.setModel(model);
  render();
  message(`已加载 ${raw.jkm} · JKRD7 静态检查通过。`);
}

/** 以新的会话重新开始（重载、运行脚本）。 */
function restart(script: string[][] | null = null): void {
  const { loaded: l } = current();
  playback.begin(new Session(l.model, APP_CONFIG.view.traceRows), script);
}

// -- 控件 -----------------------------------------------------------------

for (const element of document.querySelectorAll<HTMLElement>("[data-close]")) {
  element.addEventListener("click", () => desktop.hide(element.dataset.close ?? ""));
}
for (const [id, limits] of [["speed", APP_CONFIG.playback.speed], ["image-pixels", APP_CONFIG.image.limits.pixels],
  ["image-threshold", APP_CONFIG.image.limits.threshold], ["gpu-instances", APP_CONFIG.gpu.instances]] as const) {
  input(id).min = String(limits.min);
  input(id).max = String(limits.max);
  input(id).step = String(limits.step);
}
for (const [id, size] of [["output-board", APP_CONFIG.view.board], ["image-preview", APP_CONFIG.image.preview]] as const) {
  canvasOf(id).width = size.width;
  canvasOf(id).height = size.height;
}
input("speed").value = String(APP_CONFIG.playback.speed.value);
setText("speed-value", `${input("speed").value}×`);
input("image-threshold").value = String(APP_CONFIG.image.threshold);
input("image-pixels").value = String(APP_CONFIG.image.maxPixels);
input("gpu-instances").value = String(APP_CONFIG.gpu.instances.value);
input("unit-jump").value = "0";
updatePlayback();
for (const layoutButton of jkmPanel.querySelectorAll<HTMLElement>("[data-layout]")) {
  const active = layoutButton.dataset.layout === APP_CONFIG.scene.layout;
  layoutButton.classList.toggle("active", active);
  layoutButton.setAttribute("aria-pressed", String(active));
  layoutButton.addEventListener("click", () => {
    view.setLayout(layoutButton.dataset.layout ?? "");
    for (const item of jkmPanel.querySelectorAll<HTMLElement>("[data-layout]")) {
      item.classList.toggle("active", item === layoutButton);
      item.setAttribute("aria-pressed", String(item === layoutButton));
    }
  });
}
input("speed").addEventListener("input", () => {
  setText("speed-value", `${input("speed").value}×`);
  updatePlayback();
});
input("skip").addEventListener("change", updatePlayback);
choice("example-select").addEventListener("change", () => {
  try {
    playback.pause();
    const raw = examples.get(choice("example-select").value);
    if (!raw) throw new Error("没有这个示例");
    loadModel(structuredClone(raw), undefined, true);
  } catch (error) {
    message(errorMessage(error), true);
  }
});

action("gpu-retry", () => view.recover());
action("camera-reset", () => view.fit());
action("node-labels", () => {
  const hidden = labelsButton.getAttribute("aria-pressed") !== "true";
  showLabelsButton(hidden);
  outputChoices.setLabelsHidden(hidden);
  view.setLabels(!hidden);
});
action("black-background", () => {
  const black = button("black-background").getAttribute("aria-pressed") !== "true";
  button("black-background").setAttribute("aria-pressed", String(black));
  view.setBlackBackground(black);
});
action("jks-boxes", () => {
  const visible = button("jks-boxes").getAttribute("aria-pressed") !== "true";
  button("jks-boxes").setAttribute("aria-pressed", String(visible));
  view.setGroupsVisible(visible);
});

const sceneWindow = jkmPanel.querySelector<HTMLElement>("[data-cosmic-window=\"scene\"]")!;
// 双板全屏显示渲染区；单板全屏保留当前桌面（包括各窗口的显隐与收起状态）。
button("scene-fullscreen").addEventListener("click", () => {
  if (button("scene-fullscreen").getAttribute("aria-pressed") === "true" || desktop.single) return;
  desktop.show("scene");
  if (desktop.isCollapsed("scene")) desktop.collapse("scene");
});
const sceneFullscreen = setupSceneFullscreen(button("scene-fullscreen"), () => desktop.single
  ? { element: jkmPanel.querySelector<HTMLElement>(".cosmic-scene-area")!, className: "cosmic-panel-fullscreen", label: `左侧${APP_CONFIG.desktop.display.modes.single.label}` }
  : { element: sceneWindow, className: "scene-fullscreen", label: `${APP_CONFIG.desktop.display.modes.dual.label} 3D 场景` });
jkmPanel.addEventListener("cosmic-display-mode-change", () => {
  sceneFullscreen.refresh();
  render();
});

const UNIT_KINDS = { event: "事件", node: "节点任务", tx: "事务任务" } as const;
action("play", () => playback.play());
action("step", () => {
  const unit = playback.step();
  message(unit ? `已处理第 ${unit.n} 个处理单元（${UNIT_KINDS[unit.kind]} ${unit.path}${unit.steps.length > 1 ? `，共 ${unit.steps.length} 步` : ""}）。` : "两个 FIFO 都为空，没有可处理的单元。");
});
action("step-back", () => {
  playback.back();
  message(`已后退到第 ${current().session.units} 个处理单元（从初值重新执行，输入按记录的位置重新注入）。`);
});
action("unit-jump-go", () => {
  playback.jumpTo(Number(input("unit-jump").value));
  message(`已跳到第 ${current().session.units} 个处理单元。`);
});
action("unit-prev", () => showStep(Math.max(0, (state.unitStep >= 0 ? state.unitStep : 1) - 1)));
action("unit-next", () => showStep(Math.min((state.unit?.steps.length ?? 1) - 1, state.unitStep + 1)));
action("reset", () => {
  restart();
  render();
  message("已恢复 JKM 初值。");
});
action("send", () => {
  const count = playback.inject(JSON.parse(area("input-json").value));
  render();
  message(`已注入 ${count} 条输入通知；${playback.running ? "播放中，将自动处理。" : "点击播放或单步处理。"}`);
});
action("trace-download", () => {
  playback.pause();
  download(`${current().loaded.raw.jkm}.trace.jsonl`, exportRecords(), "application/x-ndjson");
});
action("import-btn", () => {
  area("model-json").value = formatJkmJson(current().loaded.raw);
  setText("model-error", "");
  desktop.show("models-dialog");
});
action("model-apply", () => {
  playback.pause();
  loadModel(JSON.parse(area("model-json").value));
  desktop.hide("models-dialog");
}, "model-error");
action("model-download", () => download(`${current().loaded.raw.jkm}.jkm.json`, formatJkmJson(current().loaded.raw) + "\n"));

function jsonFileInput(id: string, apply: (raw: unknown, file: File, isCurrent: () => boolean) => void, errorId: string): void {
  const element = input(id);
  element.addEventListener("change", async () => {
    const file = element.files?.[0];
    if (!file) return;
    const generation = (fileVersions.get(id) ?? 0) + 1;
    fileVersions.set(id, generation);
    const isCurrent = () => fileVersions.get(id) === generation;
    try {
      const raw = await readJsonFile(file);
      if (isCurrent()) apply(raw, file, isCurrent);
    } catch (error) {
      if (isCurrent()) setText(errorId, errorMessage(error));
    } finally {
      if (isCurrent()) element.value = "";
    }
  });
}

jsonFileInput("model-file", (raw, file, isCurrent) => {
  if (!isCurrent()) return;
  playback.pause();
  loadModel(raw, file.name);
  desktop.hide("models-dialog");
}, "model-error");

action("script-open", () => {
  setText("script-error", "");
  desktop.show("script-dialog");
});
input("model-path").addEventListener("change", () => {
  state.modelPath = input("model-path").value.trim();
});
jsonFileInput("script-file", (raw) => {
  area("script-json").value = pretty(raw);
  checkedScript(area("script-json").value);
}, "script-error");
action("script-download", () => {
  const script = checkedScript(area("script-json").value);
  download(`${script.run}.run.json`, script);
}, "script-error");
action("script-run", () => {
  const script = checkedScript(area("script-json").value);
  state.modelPath = input("model-path").value.trim();
  if (script.model !== state.modelPath) throw new Error("脚本 model 与当前 JKM 文件标识不一致；请先加载对应模型并核对标识。");
  restart(script.batches);
  desktop.hide("script-dialog");
  message(`正在执行运行脚本 ${script.run} · ${script.batches.length} 批。`);
  playback.play();
}, "script-error");

/** GPU 后端：从初值整段执行运行脚本（每个实例一个调用），与 CPU 后端逐字节对拍。 */
async function gpuRun(): Promise<void> {
  const { loaded: l } = current();
  const script = checkedScript(area("script-json").value);
  if (script.model !== input("model-path").value.trim()) throw new Error("脚本 model 与当前 JKM 文件标识不一致。");
  const count = Number(input("gpu-instances").value);
  const limits = APP_CONFIG.gpu.instances;
  if (!Number.isInteger(count) || count < limits.min || count > limits.max) throw new Error(`实例数必须是 ${limits.min}—${limits.max} 的整数`);
  button("gpu-run").disabled = true;
  setText("gpu-result", "正在 GPU 上执行…");
  try {
    const device = await devices.acquire();
    const result = await gpuRunner.run(device, l, script, count);
    gpuDispatches += result.dispatches;
    gpuRecords = result.records ? { run: script.run, text: result.records } : null;
    button("gpu-download").disabled = !gpuRecords;
    setText("gpu-result", result.text + (devices.adapter ? ` · ${devices.adapter}` : ""));
  } finally {
    button("gpu-run").disabled = false;
    render();
  }
}
action("gpu-run", () => gpuRun(), "gpu-result");
action("gpu-download", () => {
  if (gpuRecords) download(`${gpuRecords.run}.gpu.trace.jsonl`, gpuRecords.text, "application/x-ndjson");
});

action("observe-open", () => desktop.show("observe-dialog"));
action("render-clear", () => {
  clearRender(current().session);
  renderPanels();
});
action("render-all", () => {
  renderAll(current().session);
  renderPanels();
});

/** 复制输出列表的文本；成功或失败都在按钮旁显示，2 秒后清除。 */
let copyTimer: ReturnType<typeof setTimeout> | undefined;
async function copyOutput(text: () => string, done: string, failed: string): Promise<void> {
  let message = done;
  try {
    await navigator.clipboard.writeText(text());
  } catch {
    message = failed;
  }
  clearTimeout(copyTimer);
  setText("output-copy-tip", message);
  copyTimer = setTimeout(() => setText("output-copy-tip", ""), 2000);
}
action("output-copy", () => copyOutput(() => outputListText(current().session), "已复制全部", "复制失败"));
action("output-copy-data", () => copyOutput(() => outputDataText(current().session), "已复制 data 数据", "复制失败"));

action("image-input", () => {
  setText("image-error", "");
  desktop.show("image-dialog");
});
input("image-file").addEventListener("change", async () => {
  const element = input("image-file");
  try {
    const file = element.files?.[0];
    if (!file) return;
    const generation = ++imageLoadVersion;
    if (file.size > APP_CONFIG.view.fileBytes) throw new Error("图片文件超过限制");
    const bitmap = await createImageBitmap(file);
    if (generation !== imageLoadVersion) {
      bitmap.close();
      return;
    }
    if (bitmap.width * bitmap.height > APP_CONFIG.image.limits.decodedPixels) {
      bitmap.close();
      throw new Error("图片解码尺寸超过限制");
    }
    imageBitmap?.close();
    imageBitmap = bitmap;
    const canvas = canvasOf("image-preview");
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    ctx.drawImage(bitmap, 0, 0, bitmap.width * scale, bitmap.height * scale);
    setText("image-error", "");
  } catch (error) {
    setText("image-error", errorMessage(error));
  } finally {
    element.value = "";
  }
});
action("image-convert", () => {
  const { loaded: l } = current();
  const bitmap = imageBitmap;
  if (!bitmap) throw new Error("请先选择图片");
  const zero = choice("image-zero").value;
  const one = choice("image-one").value;
  if (!l.inputs.includes(zero) || !l.inputs.includes(one) || zero === one) throw new Error("请选择两个不同的输入入口");
  const max = Number(input("image-pixels").value);
  const threshold = Number(input("image-threshold").value);
  const limits = APP_CONFIG.image.limits;
  if (!Number.isInteger(max) || max < 1 || max > limits.pixels.max || !Number.isInteger(threshold) || threshold < 0 || threshold > limits.threshold.max) {
    throw new Error("请检查像素上限与灰度阈值");
  }
  const count = Math.min(max, bitmap.width * bitmap.height);
  const canvas = new OffscreenCanvas(Math.min(bitmap.width, count), Math.ceil(count / bitmap.width));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = APP_CONFIG.image.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  area("script-json").value = pretty(currentScript(pixelsToBatches(pixels, count, { zero, one, threshold })));
  desktop.hide("image-dialog");
  desktop.show("script-dialog");
}, "image-error");

window.addEventListener("pagehide", () => {
  disposed = true;
  playback.pause();
  desktop.dispose();
  nodeTree.dispose();
  networkStylePanel.dispose();
  view.dispose();
  gpuRunner.dispose();
  imageBitmap?.close();
  devices.dispose();
});

// -- 启动 -----------------------------------------------------------------

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`无法读取 ${path}（HTTP ${response.status}）`);
  return response.text();
}

/** 内置示例：一个 JSON 文件，名称 → JKM（由 tools/examples.ts 从 JKRD7 第 10 节与十选一附件生成）。 */
async function loadExamples(): Promise<Map<string, Jkm>> {
  const data = JSON.parse(await fetchText(APP_CONFIG.model.examples)) as Record<string, Jkm>;
  return new Map(Object.entries(data));
}

/** 自动验收（tools/show.ts）使用的页面接口：只读取状态，或调用页面已有的操作。 */
export interface ShowApi {
  examples(): ReadonlyMap<string, Jkm>;
  loadExample(name: string): void;
  session(): Session;
  exportRecords(): string;
  selectNode(path: string | null): void;
  ready: Promise<void>;
  isRunning(): boolean;
  /** 静止且没有待注入的输入（播放到静止不停下，用它判断运行脚本已完成）。 */
  isSettled(): boolean;
  lastUnit(): Unit | null;
  /** 场景中实际播放的一步（按“按输出格式”取舍输出节点的动画）。 */
  sceneStep(step: Step): Step;
  scene(): ReturnType<NetworkView["inspect"]>;
  renderer(mode: "auto" | "canvas"): Promise<void>;
  open(key: string): void;
}

try {
  examples = await loadExamples();
  options(choice("example-select"), [...examples.keys()].map((name) => [name, name]), APP_CONFIG.model.example);
  const initial = examples.get(APP_CONFIG.model.example);
  if (!initial) throw new Error(`没有默认示例 ${APP_CONFIG.model.example}`);
  loadModel(structuredClone(initial), undefined, true);
  await view.ready;
  playback.play(); // 刚打开默认为播放中：静止时等待输入，输入后自动处理
} catch (error) {
  if (!disposed) message(`初始化失败：${errorMessage(error)}`, true);
} finally {
  // 窗口布局与外观变量已设置，下一帧再显示窗口区（cosmic.css 在此之前隐藏它）。
  requestAnimationFrame(() => {
    jkmPanel.dataset.ready = "";
  });
}

const job = await fetch("/__job", { cache: "no-store" }).then((r) => (r.ok ? r.json() as Promise<unknown> : null)).catch(() => null);
if (job) {
  const api: ShowApi = {
    examples: () => examples,
    loadExample: (name) => {
      choice("example-select").value = name;
      choice("example-select").dispatchEvent(new Event("change"));
    },
    session: () => current().session,
    exportRecords,
    selectNode,
    ready: view.ready,
    isRunning: () => playback.running,
    isSettled: () => playback.settled,
    lastUnit: () => state.unit,
    sceneStep: (step) => forScene(step),
    scene: () => view.inspect(),
    renderer: (mode) => view.recover({ mode }),
    open: (key) => {
      desktop.show(key);
      if (desktop.isCollapsed(key)) desktop.collapse(key);
    },
  };
  const { verify } = await import("./verify.ts");
  await verify(api, job);
}

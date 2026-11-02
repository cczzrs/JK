import "./style.css";
import { compileModel, JKEngine } from "../src/jk/engine.js";
import { exportCurrentModel } from "../src/jk/model-schema.js";
import { Playback } from "../src/ui/playback.js";
import { FrameUpdates } from "../src/ui/frame-updates.js";
import { loadDisplay } from "../src/ui/output-display.js";
import { OutputDisplayUI, lampDetails } from "../src/ui/output-display-ui.js";
import { NetworkView } from "../src/scene/view.js";
import { ImageInputUI } from "../src/ui/image-input-ui.js";
import { displayNodeId } from "../src/jk/node-id.js";
import { setupSceneFullscreen } from "../src/scene/fullscreen.js";
import { ModelManager } from "../src/ui/model-manager.js";
import { APP_CONFIG } from "./config.js";
const $ = (id) => document.getElementById(id);
const cloneTemplate = (id) => $(id).content.firstElementChild.cloneNode(true);
const speedConfig = APP_CONFIG.playback.speed;
for (const key of ["min", "max", "step"]) $("speed")[key] = speedConfig[key];
$("speed").value = speedConfig.value;
$("skip").checked = APP_CONFIG.playback.skipAnimation;
$("queue").style.setProperty(
  "--queue-row-height",
  `${APP_CONFIG.lists.queue.rowHeight}px`,
);
for (const button of $("layout-buttons").querySelectorAll("[data-layout]")) {
  button.setAttribute(
    "aria-pressed",
    String(button.dataset.layout === APP_CONFIG.scene.layout),
  );
}
$("layout-status").textContent = `${APP_CONFIG.scene.layout} 拓扑布局`;
$("node-labels").setAttribute(
  "aria-pressed",
  String(APP_CONFIG.scene.nodeLabelsHidden),
);
$("node-labels").textContent = APP_CONFIG.scene.nodeLabelsHidden
  ? "显示名称和次数"
  : "隐藏名称和次数";
$("black-background").setAttribute(
  "aria-pressed",
  String(APP_CONFIG.scene.blackBackground),
);
let model,
  engine,
  playback,
  selected,
  view,
  modelVersion = 0;
const frameUpdates = new FrameUpdates(update, (event) =>
  view?.syncOutputs(engine, event),
);
const outputElements = new Map(),
  outputPublicationElements = new Map(),
  pickerElements = new Map();
const displayUI = new OutputDisplayUI(
  $("output-display-dialog"),
  (config) => {
    view?.setOutputDisplay(config);
    modelManager.syncOutputBoard(config);
    renderInspector();
  },
);
const imageUI = new ImageInputUI(
  $("image-input-dialog"),
  (json, version) => {
    if (version !== modelVersion)
      throw new Error("模型已更换，请重新提取像素数据。");
    $("input-json").value = json;
    message("已填入图片像素数据，点击“发送信号”执行。");
  },
  () => $("input-json").focus(),
);
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
function select(key, toggle = true) {
  selected = toggle && selected === key ? null : key;
  view?.select(selected);
  for (const [k, b] of pickerElements)
    b.classList.toggle("active", k === selected);
  $("inspector")
    .closest(".inspector")
    .classList.toggle("has-selection", selected != null);
  renderInspector();
}
function renderInspector() {
  if (!model) return;
  const panels = $("inspector").querySelectorAll("[data-inspector-panel]");
  for (const panel of panels) panel.hidden = true;
  if (selected?.startsWith("lamp:")) {
    const index = Number(selected.slice(5));
    const pixel = view?.outputState.config.pixels[index];
    $("selected-id").textContent = `灯 ${index + 1}`;
    $("inspector-lamp").hidden = false;
    $("inspector-lamp-readout").hidden = !pixel;
    $("inspector-lamp-edit").hidden = !pixel;
    $("inspector-lamp-missing").hidden = !!pixel;
    if (pixel)
      $("inspector-lamp-readout").textContent = lampDetails(
        pixel,
        view.outputState.results[index],
      );
    return;
  }
  const node = model.nodes.find((node) => node.key === selected);
  $("selected-id").textContent =
    node?.displayName ?? node?.id ?? selected ?? "—";
  if (!node) {
    if (selected == null) {
      $("inspector-empty").hidden = false;
    } else if (model.inputs.includes(selected)) {
      $("inspector-input").hidden = false;
      $("inspector-input-value").textContent =
        `当前可读值：${engine.latest.get(selected) ?? "尚未输入"}`;
    } else {
      const output = model.outputs.find((output) => output.id === selected);
      if (output) {
        $("inspector-output").hidden = false;
        $("inspector-output-source").textContent =
          `输出来源 ${output.error ? (output.originalSource ?? output.source) : displayNodeId(model, output.source)}`;
        $("inspector-output-value").textContent =
          output.error ??
          `最近输出事件数据：${engine.outputs.get(output.id) ?? "尚未输出"}`;
        $("inspector-output-publication").textContent =
          `最近发布：${engine.outputPublications.get(output.id) ?? "尚未发布"} · 收到事件时立即输出`;
      }
    }
    return;
  }
  $("inspector-jk").hidden = false;
  $("inspector-fixed-id").textContent = node.id;
  $("inspector-expression").textContent = String(node.ex ?? "缺失 ex");
  $("inspector-node-errors").hidden = !node.errors.length;
  $("inspector-node-errors").textContent = node.errors.join("；");
  $("inspector-jk-state").hidden = !!node.errors.length;
  $("inspector-jk-events").hidden = !!node.errors.length;
  $("inspector-count").textContent = engine.counts.get(node.key);
  if (node.errors.length) {
    $("inspector-evaluation").hidden = true;
    return;
  }
  const stateful = node.initial !== null;
  $("inspector-q").textContent = engine.q.get(node.id) ?? "尚未计算";
  $("inspector-initial").textContent = stateful ? node.initial : "0";
  $("inspector-type").textContent = stateful ? "有状态 Qi_q" : "无状态 Qi_J0";
  $("inspector-state-rule").textContent = stateful
    ? "initial_q 声明保存状态；每次从当前 q 开始，首项 J0 仍会清零。"
    : "未列入 initial_q；每次完整 EX 从 J0 清零，结果只用于传播与观察，不作为下次起点。";
  $("inspector-latest").textContent = engine.latest.get(node.id) ?? "尚未发布";
  $("inspector-propagation").textContent = node.pro;
  const waiting = engine.waiting(node).map((id) => displayNodeId(model, id));
  const cached = [...engine.cache.get(node.key)]
    .map(([id, value]) => `${displayNodeId(model, id)}=${value}`)
    .join(", ");
  $("inspector-waiting").textContent = node.required.length
    ? `Qi_J0 到达屏障 · 等待 ${waiting.join("、") || "已齐"}${cached ? " · 已保存 " + cached : ""}；Xi 与 Qi_q 仅在执行时读取当前值。`
    : "无 Qi_J0 屏障 · 每次非自身来源事件生成独立任务，出队时固定参数后完整执行 EX。";
  const last = engine.last.get(node.key);
  $("inspector-publication").textContent = last
    ? `最近求值 q=${last.value} · ${last.published ? "已发布一次来源事件" : node.pro === "q=" ? "不传播（q=）" : "未满足传播条件，已过滤事件"}；当前 q 已提交。`
    : "尚未求值；初始化只设置 q，不发布事件。";
  const evaluation = $("inspector-evaluation");
  evaluation.hidden = !last;
  if (last) {
    // Preserve an explicitly collapsed details element through live updates.
    if (evaluation.dataset.node !== node.key) evaluation.open = true;
    evaluation.dataset.node = node.key;
    $("inspector-evaluation-title").textContent =
      `最近求值 #${last.total} · 实际读取参数`;
    $("inspector-reads").textContent = JSON.stringify(last.reads);
    const steps = document.createDocumentFragment();
    for (const operation of last.operations) {
      const row = cloneTemplate("evaluation-step-template");
      row.textContent = `${operation.token} : ${operation.before} ${operation.token[0] === "J" ? "AND" : "XOR"} ${operation.input} → ${operation.after}`;
      steps.append(row);
    }
    $("inspector-operations").replaceChildren(steps);
  }
}
function renderQueue() {
  if (!engine) return;
  const host = $("queue");
  const { rowHeight, overscanBefore, overscanCount } = APP_CONFIG.lists.queue;
  $("queue-count").textContent = engine.length.toLocaleString();
  host.style.setProperty(
    "--queue-total-height",
    `${engine.length * rowHeight}px`,
  );
  const maxScroll = Math.max(0, engine.length * rowHeight - host.clientHeight);
  if (host.scrollTop > maxScroll) host.scrollTop = maxScroll;
  const start = Math.max(
    0,
    Math.floor(host.scrollTop / rowHeight) - overscanBefore,
  );
  const end = Math.min(
    engine.length,
    start + Math.ceil(host.clientHeight / rowHeight) + overscanCount,
  );
  host.style.setProperty("--queue-scroll-offset", `${start * rowHeight}px`);
  const fragment = document.createDocumentFragment();
  for (let index = start; index < end; index++) {
    const item = engine.itemAt(index);
    const row = cloneTemplate("queue-row-template");
    row.querySelector("button").dataset.nodeKey =
      model.byId.get(item.node)?.[0]?.key ?? item.node;
    row.querySelector("em").textContent = `${item.queue} #${item.ticket}`;
    row.querySelector("[data-node-name]").textContent =
      displayNodeId(model, item.node);
    const values = row.querySelector(".values");
    values.textContent = JSON.stringify(item.arrivals);
    values.title = "任务锁存的 Qi_J0 数据；Xi 与有状态 q 在任务执行时读取最新值";
    fragment.append(row);
  }
  $("queue-rows").replaceChildren(fragment);
  $("queue-empty").hidden = engine.length > 0;
}
function update() {
  if (!engine) return;
  for (const o of model.outputs) {
    const cell = outputElements.get(o.id),
      v = engine.outputs.get(o.id);
    cell.textContent = o.error ? "异常" : v === null ? "未输出" : String(v);
    cell.classList.toggle("empty", v === null);
    const published = engine.outputPublications.get(o.id);
    outputPublicationElements.get(o.id).textContent = o.error
      ? "绑定异常"
      : published == null ? "尚未发布" : `最近发布 ${published}`;
  }
  $("output-status").textContent = model.canExecute === false
    ? "模型校验未通过 · 正式输出不可用"
    : "Yi 按事件即时输出 · 队列排空不生成新输出";
  $("output-status").classList.toggle("pending", engine.length > 0);
  $("total").textContent = engine.total.toLocaleString();
  $("event-total").textContent = engine.eventTotal.toLocaleString();
  $("play").textContent = playback.running ? "Ⅱ 暂停" : "▶ 继续";
  $("total2").textContent = engine.total.toLocaleString();
  $("EXtotal").textContent = engine.exTotal.toLocaleString();
  $("send").disabled = $("step").disabled = $("play").disabled = model.canExecute === false;
  const status = model.canExecute === false
    ? "校验未通过"
    : !playback.running
      ? "已暂停"
      : engine.length || playback.active || playback.visuals.length
        ? "运行中"
        : model.valid.some((n) => engine.waiting(n).length)
          ? "等待输入"
          : "就绪";
  $("run-status").textContent = status;
  $("footer-state").textContent =
    `${model.inputs.length} 输入 / ${model.nodes.length} JK / ${model.outputs.length} 输出 · ${engine.length} EX 任务待执行`;
  const fragment = document.createDocumentFragment();
  for (const event of engine.history
    .slice(-APP_CONFIG.lists.history.visibleEntries)
    .reverse()) {
    const row = cloneTemplate("history-row-template");
    row.querySelector("span").textContent =
      event.type === "input"
        ? "↗ " + (event.accepted.join(" · ") || "无匹配输入")
        : event.type === "task"
          ? `${event.queue} #${event.ticket} ${displayNodeId(model, event.node)}`
          : `求值 #${event.total} ${displayNodeId(model, event.node)}`;
    row.querySelector("b").textContent =
      event.type === "input"
        ? "已入队"
        : event.type === "task"
          ? event.skipped ? "参数不可读 · 已结束" : `${event.executions.length} 次求值`
          : `${event.before === null ? "·" : event.before} → ${event.value} · ${event.published ? "发布" : event.pro === "q=" ? "不传播" : "已过滤"}`;
    row.classList.toggle("filtered", event.type === "execution" && !event.published);
    fragment.append(row);
  }
  $("history").replaceChildren(fragment);
  renderQueue();
  view?.refresh(engine);
  displayUI.update(engine.outputs);
  renderInspector();
}
function install(raw) {
  const next = compileModel(raw); // Validate before replacing the current model.
  model = next;
  engine = new JKEngine(model);
  selected = model.valid[0]?.key ?? model.nodes[0]?.key ?? model.inputs[0];
  imageUI.setModel(model.inputs, ++modelVersion);
  playback = new Playback(engine, {
    onChange: (event) => frameUpdates.request(event),
    onVisual: (event) =>
      event ? view?.showTransfers(event.transfers) : view?.clearSignals(),
    onProgress: (t) => view?.progress(t),
  });
  playback.running = APP_CONFIG.playback.running && engine.length === 0;
  playback.speed = Number($("speed").value);
  playback.skip = $("skip").checked;
  updateSpeedControl();
  $("model-name").textContent = String(raw.name ?? "未命名模型");
  const verifiedMD5 = typeof raw.md5 === "string"
    && raw.md5 === model.integrity.fingerprints?.md5;
  $("model-md5").textContent = raw.md5 == null
    ? "MD5: 未提供"
    : `MD5${verifiedMD5 ? " 已核验" : " 未通过核验"}: ${raw.md5}`;
  $("model-md5").title = model.integrity.fingerprints
    ? `计算结构指纹 format_md5: ${model.integrity.fingerprints.format_md5}`
    : "模型结构存在异常，无法生成规范结构指纹。";
  $("stat-nodes").textContent = model.nodes.length;
  $("stat-state").textContent = model.nodes.filter(
    (n) => n.initial !== null,
  ).length;
  $("stat-edges").textContent =
    model.nodes.reduce(
      (sum, n) => sum + n.tokens.filter((t) => t.source).length,
      0,
    ) + model.outputs.length;
  $("stat-ex").textContent = model.nodes.reduce(
    (sum, n) => sum + n.tokens.length,
    0,
  );
  const issues = [
    ...model.issues,
    ...model.nodes.flatMap((n) =>
      n.errors.map((e) => `${n.displayName ?? n.id}：${e}`),
    ),
    ...model.outputs.filter((o) => o.error).map((o) => `${o.id}：${o.error}`),
  ];
  $("model-errors").hidden = !issues.length;
  $("model-errors").textContent = issues.join("\n");
  $("model-validation").textContent = model.canExecute === false
    ? "模型校验未通过，已阻止运行；请修正下列问题。"
    : model.integrity.status === "verified"
      ? "完整快照校验通过。"
      : "简式模型结构合法；未提供完整快照字段。";
  $("model-validation").title = model.integrity.missing.length
    ? `缺少字段：${model.integrity.missing.join("、")}`
    : "校验覆盖结构、统计、端口、容量与规范指纹；功能结果需按输入序列验证。";
  $("metadata").textContent = JSON.stringify(
    Object.fromEntries(
      Object.entries(raw).filter(
        ([k]) => !["nodes", "initial_q", "q_y"].includes(k),
      ),
    ),
    null,
    2,
  );
  $("output-rows").replaceChildren();
  $("outputs-empty").hidden = model.outputs.length > 0;
  outputElements.clear();
  outputPublicationElements.clear();
  for (const output of model.outputs) {
    const row = cloneTemplate("output-row-template");
    row.querySelector("[data-output-id]").textContent = output.id;
    row.querySelector(".source").textContent = output.error
      ? (output.originalSource ?? output.source)
      : displayNodeId(model, output.source);
    const value = row.querySelector(".output-value");
    $("output-rows").append(row);
    outputElements.set(output.id, value);
    outputPublicationElements.set(output.id, row.querySelector(".output-publication"));
  }
  $("node-picker").replaceChildren();
  pickerElements.clear();
  const pickerItems = [
    ...model.inputs.map((id) => ({ id, key: id })),
    ...model.nodes,
    ...model.outputs.map((output) => ({
      id: output.id,
      key: output.id,
      errors: output.error ? [output.error] : [],
    })),
  ];
  for (const item of pickerItems) {
    const button = cloneTemplate("node-button-template");
    button.textContent = item.displayName ?? item.id;
    button.classList.toggle("bad", !!item.errors?.length);
    button.dataset.nodeKey = item.key;
    $("node-picker").append(button);
    pickerElements.set(item.key, button);
  }
  const defaults = Object.fromEntries(
    model.inputs.map((id) => [id, APP_CONFIG.signals.defaultValue]),
  );
  if (model.inputs.join(",") === Object.keys(APP_CONFIG.signals.example).join(",")) {
    Object.assign(defaults, APP_CONFIG.signals.example);
  }
  $("input-json").value = JSON.stringify(defaults);
  $("queue").scrollTop = 0;
  const display = loadDisplay(raw.display?.outputBoard);
  view?.setModel(model);
  const shows = [...$("layout-buttons").querySelectorAll("[data-layout]")].map(button => button.dataset.layout);
  view?.requestLayout(shows.includes(raw.display?.show) ? raw.display.show : APP_CONFIG.scene.layout);
  view?.syncOutputs(engine);
  view?.setOutputDisplay(display.config);
  displayUI.load(display.config, model.outputs, display.error);
  select(selected, false);
  frameUpdates.request();
  document.querySelector(".left-panel").scrollTop = 0;
  message(
    display.error ?? "已加载模型。发送信号或暂停后单步执行。",
    !!display.error,
  );
}
$("inspector-lamp-edit").addEventListener("click", () => {
  if (selected?.startsWith("lamp:")) displayUI.open(Number(selected.slice(5)));
});
for (const host of [$("queue-rows"), $("node-picker")]) {
  host.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-node-key]");
    if (button && host.contains(button)) select(button.dataset.nodeKey);
  });
}
$("queue").addEventListener("scroll", () => frameUpdates.invalidate());
new ResizeObserver(() => frameUpdates.invalidate()).observe($("queue"));
$("image-input").onclick = () => imageUI.open();
$("send").onclick = () => {
  try {
    const e = playback.send(JSON.parse($("input-json").value));
    message(
      `已更新 ${e.accepted.length} 个 Xi 并加入 Xi.FIFO 复制任务${!playback.running ? "；保持暂停" : ""}。`,
    );
  } catch (e) {
    message(e.message, true);
  }
};
$("play").onclick = () => {
  try {
    playback.running ? playback.pause() : playback.resume();
  } catch (e) {
    message(e.message, true);
  }
};
$("step").onclick = () => {
  try {
    playback.step();
  } catch (e) {
    playback.pause();
    message(e.message, true);
  }
};
$("reset").onclick = () => {
  playback.reset();
  message("已恢复快照中的 q 与 FIFOS；Xi 尚不可读，到达集合和本次显示记录已清空；保持暂停。");
};
function updateSpeedControl() {
  const skip = $("skip").checked,
    speed = Number($("speed").value),
    budget =
      playback?.skipFrameBudgetMs ?? APP_CONFIG.playback.skipBudgetMs * speed;
  $("speed-label").textContent = skip ? "计算速度" : "动画速度";
  $("speed-value").textContent = speed + "×";
  $("speed-budget").hidden = !skip;
  $("speed-budget").textContent = `每帧预算 ${budget} ms`;
  $("speed").setAttribute(
    "aria-valuetext",
    skip ? `${speed} 倍，每帧计算预算 ${budget} 毫秒` : `动画速度 ${speed} 倍`,
  );
  $("speed").title = skip
    ? `每帧最多计算约 ${budget} 毫秒；高倍速可能降低画面流畅度，单项计算不会中断。`
    : "调节传播动画的播放速度";
}
$("speed").oninput = () => {
  if (playback) playback.speed = Number($("speed").value);
  updateSpeedControl();
};
$("skip").onchange = () => {
  if (playback) playback.skip = $("skip").checked;
  updateSpeedControl();
  frameUpdates.invalidate();
};
function layoutStatus(result) {
  for (const button of $("layout-buttons").querySelectorAll("[data-layout]"))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.layout === result.requestedMode),
    );
  $("layout-buttons").setAttribute("aria-busy", String(!!result.pending));
  if (result.pending) {
    $("layout-status").textContent = "正在排列…";
    return;
  }
  if (result.error) {
    $("layout-status").textContent = `布局失败：${result.error}`;
    return;
  }
  $("layout-status").textContent =
    `${result.automatic ? "自动 → " : ""}${result.mode} · 间距 1`;
  $("layout-status").title =
    `${result.description}；实际连线总长 ${result.metrics.wireLength.toFixed(2)}；自动可读性评分为启发式结果`;
  $("viewport").dataset.layout = result.mode;
}
$("layout-buttons").onclick = (event) => {
  const button = event.target.closest("[data-layout]");
  if (button && view?.model) view.requestLayout(button.dataset.layout);
};
$("output-render").onclick = () => displayUI.open();
$("camera-reset").onclick = () => view?.resetCamera();
setupSceneFullscreen(
  document.querySelector(".main-view"),
  $("scene-fullscreen"),
  document.querySelector(".inspector"),
);
$("node-labels").onclick = () => {
  const button = $("node-labels"),
    hidden = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(hidden));
  button.textContent = hidden ? "显示名称和次数" : "隐藏名称和次数";
  view?.setNodeLabelsHidden(hidden);
};
$("black-background").onclick = () => {
  const enabled = $("black-background").getAttribute("aria-pressed") !== "true";
  $("black-background").setAttribute("aria-pressed", String(enabled));
  view?.setBlackBackground(enabled);
};
function currentSnapshot(raw = model.raw) {
  return exportCurrentModel(raw, model?.raw, engine,
    view?.layoutMode ?? model?.raw.display?.show, displayUI.config);
}
const modelManager = new ModelManager(install, message, currentSnapshot);
function pauseAfterError(error, prefix) {
  let detail = "";
  try {
    playback?.pause();
  } catch (syncError) {
    detail = `；状态同步失败：${syncError.message}`;
  } finally {
    frameUpdates.invalidate();
  }
  message(`${prefix}：${error.message}${detail}`, true);
}
function renderingFailed(error) {
  pauseAfterError(error, "3D 渲染中断");
  $("backend").textContent = "渲染已停止";
  $("gpu-message").hidden = false;
  $("gpu-detail").textContent = error.message;
  message(
    `3D 渲染中断：${error.message}。可点击“恢复 3D”，模型与计算状态仍保留。`,
    true,
  );
}
$("gpu-retry").onclick = async () => {
  $("gpu-retry").disabled = true;
  try {
    await view.recover();
    $("gpu-message").hidden = true;
    message("3D 已恢复，计算保持暂停，可继续或单步。");
  } catch (e) {
    renderingFailed(e);
  } finally {
    $("gpu-retry").disabled = false;
  }
};
async function start() {
  view = new NetworkView($("viewport"), select, renderingFailed, layoutStatus, backend => {
    $("backend").textContent = backend === "canvas" ? "Canvas 2D · 软件渲染" : "WebGPU · 已连接";
  });
  $("backend").textContent = "渲染器初始化中";
  await modelManager.loadInitial();
  frameUpdates.flush();
  let previous = performance.now(),
    lastStatus = "";
  function frame(now) {
    try {
      const dt = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      try {
        playback.tick(dt);
      } catch (e) {
        pauseAfterError(e, "执行错误");
      }
      const status = `${playback.running}:${!!playback.active}:${playback.visuals.length}:${engine.length}`;
      if (status !== lastStatus) {
        lastStatus = status;
        frameUpdates.invalidate();
      }
      try {
        frameUpdates.flush();
      } catch (e) {
        pauseAfterError(e, "界面更新错误");
      }
      try {
        view.render(playback.running);
      } catch (e) {
        view.fail(e);
      }
    } finally {
      requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);
  try {
    await view.init();
    view.setModel(model);
    view.refresh(engine);
    view.select(selected);
  } catch (e) {
    $("backend").textContent = "渲染不可用";
    $("gpu-message").hidden = false;
    $("gpu-detail").textContent = e.message;
  }
}
start().catch((e) => message(`启动失败：${e.message}`, true));

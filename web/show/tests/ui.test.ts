/**
 * 展示页界面纯函数的单元测试（不依赖浏览器）：本地偏好的校验、图片转输入、展示投影、布局与输出列表的推导。
 * 整页行为由 tools/show.ts 的整体验收核对。
 *
 *   npm run test:ui
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Jkm, Model, parseJson } from "../../../src/model.ts";
import { APP_CONFIG } from "../config.ts";
import { ListBuilder, type ListSettings, outputCells, outputChar, outputNumber } from "../output-list.ts";
import { Session } from "../session.ts";
import { gridPoints, quickLayout } from "../scene/layout.ts";
import { createDisplayModel, observeKey, observedPath } from "../scene/model-view.ts";
import { edgeStyleType } from "../scene/network-style.ts";
import { defaultWorkspaceState, normalizeWorkspaceState } from "../ui/cosmic-state.ts";
import { pixelsToBatches } from "../ui/image-input.ts";
import { defaultNetworkStyles, normalizeNetworkStyles } from "../ui/network-style-state.ts";
import { bounded, color, object, own } from "../ui/normalize.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const ascii = parseJson(readFileSync(resolve(ROOT, "assets/ascii-bit-design/digits.jkm.json"), "utf8")) as Jkm;
const asciiModel = new Model(ascii, "ascii");

/** 十选一依次输入 0、1、9 并运行到静止的会话。 */
function asciiSession(): Session {
  const s = new Session(asciiModel);
  for (const digit of [0, 1, 9]) {
    s.injectBatch([`G1.Q${digit + 1}`]);
    while (s.step(false)) { /* 运行到静止 */ }
  }
  return s;
}

const settings = (overrides: Partial<ListSettings> = {}): ListSettings =>
  ({ mode: "all", group: "done", when: "arrive", content: "all", slice: "slice", ...overrides });

test("偏好校验：不合法的值换成默认值", () => {
  assert.equal(object({}), true);
  assert.equal(object([]), false);
  assert.equal(object(null), false);
  assert.equal(own({ a: 1 }, "a"), 1);
  assert.equal(own({}, "toString"), undefined);
  assert.equal(color("#ABCDEF", "#000000"), "#abcdef");
  assert.equal(color("red", "#000000"), "#000000");
  assert.equal(bounded(5, 0.5, { min: 0, max: 1 }), 1);
  assert.equal(bounded("x", 0.5, { min: 0, max: 1 }), 0.5);
  assert.deepEqual(normalizeWorkspaceState("垃圾", APP_CONFIG.desktop), defaultWorkspaceState(APP_CONFIG.desktop));
  const styles = APP_CONFIG.scene.styles;
  assert.deepEqual(normalizeNetworkStyles(null, styles), defaultNetworkStyles(styles));
  const broken = normalizeNetworkStyles({ version: styles.storage.version, edges: { J: { color: "绿", opacity: 9 } } }, styles);
  assert.equal(broken.edges.J.color, styles.edges.types.J.color);
  assert.equal(broken.edges.J.opacity, styles.edges.limits.opacity.max);
});

test("图片转输入：按灰度阈值逐像素生成一批", () => {
  const pixels = [255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255];
  assert.deepEqual(pixelsToBatches(pixels, 3, { zero: "G1.Q1", one: "G1.Q2", threshold: 128 }), [["G1.Q2"], ["G1.Q1"], ["G1.Q2"]]);
  assert.throws(() => pixelsToBatches(pixels, 3, { zero: "G1.Q1", one: "G1.Q1", threshold: 128 }));
  assert.throws(() => pixelsToBatches(pixels, 4, { zero: "G1.Q1", one: "G1.Q2", threshold: 128 }));
});

test("展示投影与布局：观察点取自 output，临时布局覆盖全部节点", () => {
  assert.equal(observedPath(observeKey("G1.Q24")), "G1.Q24");
  const display = createDisplayModel(asciiModel);
  assert.equal(display.nodes.length, asciiModel.jki.size);
  assert.deepEqual(new Set(display.outputs.map((o) => o.source)), new Set(asciiModel.output)); // 观察点按路径排序
  const trigger = display.nodes.flatMap((n) => n.tokens).find((t) => t.relation === "trigger")!;
  assert.equal(edgeStyleType(trigger), "trigger");
  assert.equal(gridPoints(10, 2).length, 10);
  const layout = quickLayout(display);
  for (const n of display.nodes) assert.ok(layout.positions.has(n.key), n.key);
});

test("输出数值：三种格式与可打印字符", () => {
  const bits = [0, 0, 1, 1, 0, 0, 0, 0];
  assert.equal(outputNumber(bits, "bin"), "00110000");
  assert.equal(outputNumber(bits, "dec"), "48");
  assert.equal(outputNumber(bits, "hex"), "0x30");
  assert.equal(outputChar(bits), "0");
  assert.equal(outputChar([0, 0, 0, 0, 1, 0, 1, 0]), "");
  assert.equal(outputChar([1, 0, 1]), "");
});

test("输出列表：每条输出（切片与真实运行）", () => {
  const s = asciiSession();
  const slice = new ListBuilder(s, settings(), "");
  slice.update();
  assert.equal(slice.rows.length, s.outputs.length);
  assert.equal(slice.rows.length, 27);
  const real = new ListBuilder(s, settings({ slice: "real" }), "");
  real.update();
  assert.equal(real.rows.length, 27);
  const last = outputCells(s, real.rows.at(-1)!, 26, "bin");
  assert.equal(last[2], "G1.Q24");
  assert.equal(last[3], "done [G1.Q24=1]");
});

test("输出列表：指定触发组", () => {
  const s = asciiSession();
  const done = new ListBuilder(s, settings({ mode: "trigger" }), "");
  done.update();
  assert.deepEqual(done.rows.map((row) => outputCells(s, row, 0, "hex")[4]), ["data 0x30 · done 0x1", "data 0x31 · done 0x1", "data 0x39 · done 0x1"]);
  const q0 = new ListBuilder(s, settings({ mode: "trigger", when: "q0" }), "");
  q0.update();
  assert.equal(q0.rows.length, 0);
  // 只记已标记节点：每次 Q24 之前 8 个数据位都有事件到达
  const marked = new ListBuilder(s, settings({ mode: "trigger", content: "marked" }), "");
  marked.update();
  assert.equal(marked.rows.length, 3);
  assert.equal(marked.rows[0].paths?.size, 9);
  // 真实运行：“全部输出数据”只剩触发的成员；已标记节点用到达时的 q
  const real = new ListBuilder(s, settings({ mode: "trigger", slice: "real" }), "");
  real.update();
  assert.deepEqual(real.rows.map((row) => [...row.paths!]), [["G1.Q24"], ["G1.Q24"], ["G1.Q24"]]);
  const realMarked = new ListBuilder(s, settings({ mode: "trigger", slice: "real", content: "marked" }), "");
  realMarked.update();
  assert.equal(outputCells(s, realMarked.rows[2], 2, "hex")[4], "data 0x39 · done 0x1");
});

test("输出列表：增量推导与一次推导相同", () => {
  const s = new Session(asciiModel);
  const builder = new ListBuilder(s, settings({ mode: "trigger" }), "");
  for (const digit of [0, 1, 9]) {
    s.injectBatch([`G1.Q${digit + 1}`]);
    while (s.step(false)) builder.update();
  }
  const once = new ListBuilder(s, settings({ mode: "trigger" }), "");
  once.update();
  assert.deepEqual(builder.rows, once.rows);
});

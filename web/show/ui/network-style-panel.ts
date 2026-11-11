/**
 * 网络样式面板：把页面上已有的控件连到展示偏好；模型定义不变。
 */

import type { StylesConfig } from "../config.ts";
import { type Model, isInputEntry } from "../../../src/model.ts";
import { resolveNodeStyle } from "../scene/network-style.ts";
import { type NetworkStyles, type NodeStyle, defaultNetworkStyles, normalizeNetworkStyles } from "./network-style-state.ts";
import { byId, cloneFrom, need } from "./dom.ts";

/** 面板控件，按元素类型分组（id 为 network- 加名称）。 */
const INPUT_NAMES = [
  "edge-color", "edge-opacity", "edge-length", "edge-visible", "node-color", "node-size", "node-visible", "node-labels",
  "node-marker-visible", "node-marker-color",
] as const;
const SELECT_NAMES = ["edge-type", "node-type"] as const;
const TEXT_NAMES = ["edge-opacity-value", "edge-length-value", "node-size-value", "node-marker-visible-field", "node-marker-color-field"] as const;
const BUTTON_NAMES = ["edge-reset", "node-reset"] as const;

type Group<T extends readonly string[], E> = Record<T[number], E>;

interface TagNode {
  isInput: boolean;
  hasEX: boolean;
  tags: string[];
}

interface Selection {
  key?: string;
  tag?: string;
  computation?: string;
  style: NodeStyle;
}

export interface NetworkStylePanelOptions {
  root: HTMLElement;
  config: StylesConfig;
  onChange?: (styles: NetworkStyles) => void;
}

export class NetworkStylePanel {
  private readonly root: HTMLElement;
  private readonly config: StylesConfig;
  private readonly onChange: (styles: NetworkStyles) => void;
  private readonly listeners: (() => void)[] = [];
  private tagNodes = new Map<string, TagNode>();
  private readonly inputs: Group<typeof INPUT_NAMES, HTMLInputElement>;
  private readonly selects: Group<typeof SELECT_NAMES, HTMLSelectElement>;
  private readonly texts: Group<typeof TEXT_NAMES, HTMLElement>;
  private readonly buttons: Group<typeof BUTTON_NAMES, HTMLButtonElement>;
  private readonly edgeToggles: HTMLElement[];
  private readonly optionTemplate: HTMLTemplateElement;
  private state: NetworkStyles;

  constructor({ root, config, onChange = () => {} }: NetworkStylePanelOptions) {
    this.root = root;
    this.config = config;
    this.onChange = onChange;
    const group = <T extends readonly string[], E extends HTMLElement>(names: T, type?: { new (): E; prototype: E }) =>
      Object.fromEntries(names.map((name) => [name, need<E>(root, `#network-${name}`, type)])) as Group<T, E>;
    this.inputs = group(INPUT_NAMES, HTMLInputElement);
    this.selects = group(SELECT_NAMES, HTMLSelectElement);
    this.texts = group(TEXT_NAMES);
    this.buttons = group(BUTTON_NAMES, HTMLButtonElement);
    this.edgeToggles = [...root.querySelectorAll<HTMLElement>("[data-network-edge-toggle]")];
    this.optionTemplate = byId("network-style-option-template", HTMLTemplateElement);
    this.state = this.restore();
    const f = this.inputs;
    this.selects["edge-type"].value = config.edges.defaultType;
    this.selects["node-type"].value = config.nodes.defaultType;
    const ranges = [["edge-opacity", config.edges.limits.opacity], ["edge-length", config.edges.limits.length], ["node-size", config.nodes.limits.size]] as const;
    for (const [name, limits] of ranges) {
      f[name].min = String(limits.min);
      f[name].max = String(limits.max);
      f[name].step = String(limits.step);
    }
    this.listen(this.selects["edge-type"], "change", () => this.syncEdge());
    this.listen(this.selects["node-type"], "change", () => this.syncNode());
    for (const name of ["edge-color", "edge-opacity", "edge-length"] as const) this.listen(f[name], "input", () => this.updateEdge());
    this.listen(f["edge-visible"], "change", () => this.updateEdge());
    this.listen(this.buttons["edge-reset"], "click", () => this.resetEdge());
    for (const button of this.edgeToggles) this.listen(button, "click", () => this.toggleEdge(button.dataset.networkEdgeToggle ?? ""));
    this.listen(f["node-color"], "input", () => this.updateNode("color"));
    this.listen(f["node-size"], "input", () => this.updateNode("size"));
    this.listen(f["node-visible"], "change", () => this.updateNode("visible"));
    this.listen(f["node-labels"], "change", () => this.updateNode("labels"));
    this.listen(f["node-marker-visible"], "change", () => this.updateMarker("visible"));
    this.listen(f["node-marker-color"], "input", () => this.updateMarker("color"));
    this.listen(this.buttons["node-reset"], "click", () => this.resetNode());
    this.syncEdge();
    this.syncNode();
    this.syncLegend();
    this.onChange(this.state);
  }

  private listen(element: EventTarget, type: string, handler: () => void): void {
    element.addEventListener(type, handler);
    this.listeners.push(() => element.removeEventListener(type, handler));
  }

  private restore(): NetworkStyles {
    try {
      return normalizeNetworkStyles(JSON.parse(localStorage.getItem(this.config.storage.key) ?? "null"), this.config);
    } catch {
      return defaultNetworkStyles(this.config);
    }
  }

  private commit(next: NetworkStyles): void {
    this.state = normalizeNetworkStyles(next, this.config);
    this.syncEdge();
    this.syncNode();
    this.syncLegend();
    this.onChange(this.state);
    try {
      localStorage.setItem(this.config.storage.key, JSON.stringify(this.state));
    } catch {
      this.root.dispatchEvent(new CustomEvent("network-style-error", {
        bubbles: true, detail: { message: "浏览器未能保存网络样式；本页设置仍然生效。" },
      }));
    }
  }

  setModel(model: Model): void {
    const select = this.selects["node-type"];
    const selected = select.value;
    this.tagNodes = new Map();
    for (const [path, definition] of model.jki) {
      const node: TagNode = { isInput: isInputEntry(model, path), hasEX: (definition.sources?.ex?.length ?? 0) > 0, tags: definition.pro?.tag ?? [] };
      for (const tag of node.tags) if (!this.tagNodes.has(tag)) this.tagNodes.set(tag, node);
    }
    for (const option of select.querySelectorAll("[data-network-style-tag]")) option.remove();
    for (const tag of this.tagNodes.keys()) {
      const option = cloneFrom<HTMLOptionElement>(this.optionTemplate);
      option.value = `tag:${tag}`;
      option.textContent = `用途：${tag}`;
      option.dataset.networkStyleTag = "";
      select.append(option);
    }
    const keep = (selected.startsWith("tag:") && this.tagNodes.has(selected.slice(4)))
      || Object.hasOwn(this.state.nodes, selected)
      || (selected.startsWith("computation:") && Object.hasOwn(this.state.computation, selected.slice(12)));
    select.value = keep ? selected : this.config.nodes.defaultType;
    this.syncNode();
  }

  private nodeSelection(): Selection {
    const key = this.selects["node-type"].value;
    if (Object.hasOwn(this.state.nodes, key)) return { key, style: this.state.nodes[key] };
    if (key.startsWith("computation:") && Object.hasOwn(this.state.computation, key.slice(12))) {
      const computation = key.slice(12);
      const { marker: _marker, ...overrides } = this.state.computation[computation];
      return { computation, style: { ...this.state.nodes.node, ...overrides } };
    }
    if (key.startsWith("tag:")) {
      const tag = key.slice(4);
      const node = this.tagNodes.get(tag);
      if (node) {
        const style = Object.hasOwn(this.state.tags, tag) ? this.state.tags[tag] : resolveNodeStyle({ ...node, tags: [] }, this.state);
        if (style) return { tag, style };
      }
    }
    const fallback = this.config.nodes.defaultType;
    return { key: fallback, style: this.state.nodes[fallback] };
  }

  private syncLegend(): void {
    for (const element of this.root.querySelectorAll<HTMLElement>("[data-network-node-color]")) {
      const key = element.dataset.networkNodeColor ?? "";
      if (Object.hasOwn(this.state.nodes, key)) element.style.backgroundColor = this.state.nodes[key].color;
    }
    for (const element of this.root.querySelectorAll<HTMLElement>("[data-network-edge-color]")) {
      const key = element.dataset.networkEdgeColor ?? "";
      if (Object.hasOwn(this.state.edges, key)) element.style.backgroundColor = this.state.edges[key].color;
    }
  }

  private syncEdge(): void {
    for (const button of this.edgeToggles) {
      const key = button.dataset.networkEdgeToggle ?? "";
      if (!Object.hasOwn(this.state.edges, key)) continue;
      const { visible } = this.state.edges[key];
      const { label } = this.config.edges.types[key];
      button.setAttribute("aria-pressed", String(visible));
      button.setAttribute("aria-label", `显示或隐藏${label}`);
      button.title = `${visible ? "隐藏" : "显示"}${label}`;
      const text = button.querySelector("[data-network-edge-visibility]");
      if (text) text.textContent = visible ? "已显示" : "已隐藏";
    }
    const f = this.inputs;
    const key = this.selects["edge-type"].value;
    if (!Object.hasOwn(this.state.edges, key)) return;
    const style = this.state.edges[key];
    f["edge-color"].value = style.color;
    f["edge-opacity"].value = String(style.opacity);
    this.texts["edge-opacity-value"].textContent = `${Math.round(style.opacity * 100)}%`;
    f["edge-length"].value = String(style.length);
    this.texts["edge-length-value"].textContent = `${Math.round(style.length * 100)}%`;
    f["edge-visible"].checked = style.visible;
  }

  private syncNode(): void {
    const { tag, computation, style } = this.nodeSelection();
    const f = this.inputs;
    f["node-color"].value = style.color;
    f["node-size"].value = String(style.size);
    this.texts["node-size-value"].textContent = `${Math.round(style.size * 100)}%`;
    f["node-visible"].checked = style.visible;
    f["node-labels"].checked = style.labels;
    const isEX = computation === "ex";
    const marker = this.state.computation.ex.marker!;
    this.texts["node-marker-visible-field"].hidden = !isEX;
    this.texts["node-marker-color-field"].hidden = !isEX;
    f["node-marker-visible"].checked = marker.visible;
    f["node-marker-color"].value = marker.color;
    this.buttons["node-reset"].textContent = tag === undefined && computation !== "q" ? "恢复该类默认样式" : "恢复继承样式";
  }

  private updateEdge(): void {
    const f = this.inputs;
    const key = this.selects["edge-type"].value;
    if (!Object.hasOwn(this.state.edges, key)) return;
    this.commit({
      ...this.state,
      edges: {
        ...this.state.edges,
        [key]: { color: f["edge-color"].value, opacity: Number(f["edge-opacity"].value), length: Number(f["edge-length"].value), visible: f["edge-visible"].checked },
      },
    });
  }

  private resetEdge(): void {
    const key = this.selects["edge-type"].value;
    if (!Object.hasOwn(this.state.edges, key)) return;
    this.commit({ ...this.state, edges: { ...this.state.edges, [key]: defaultNetworkStyles(this.config).edges[key] } });
  }

  private toggleEdge(key: string): void {
    if (!Object.hasOwn(this.state.edges, key)) return;
    const style = this.state.edges[key];
    this.commit({ ...this.state, edges: { ...this.state.edges, [key]: { ...style, visible: !style.visible } } });
  }

  private updateNode(property: keyof NodeStyle): void {
    const { key, tag, computation } = this.nodeSelection();
    const f = this.inputs;
    const style: NodeStyle = {
      color: f["node-color"].value, size: Number(f["node-size"].value),
      visible: f["node-visible"].checked, labels: f["node-labels"].checked,
    };
    if (tag !== undefined) this.commit({ ...this.state, tags: { ...this.state.tags, [tag]: style } });
    else if (computation !== undefined) {
      this.commit({ ...this.state, computation: { ...this.state.computation, [computation]: { ...this.state.computation[computation], [property]: style[property] } } });
    } else if (key !== undefined) this.commit({ ...this.state, nodes: { ...this.state.nodes, [key]: style } });
  }

  private resetNode(): void {
    const { key, tag, computation } = this.nodeSelection();
    const defaults = defaultNetworkStyles(this.config);
    if (tag !== undefined) this.commit({ ...this.state, tags: Object.fromEntries(Object.entries(this.state.tags).filter(([name]) => name !== tag)) });
    else if (computation !== undefined) this.commit({ ...this.state, computation: { ...this.state.computation, [computation]: defaults.computation[computation] } });
    else if (key !== undefined) this.commit({ ...this.state, nodes: { ...this.state.nodes, [key]: defaults.nodes[key] } });
  }

  private updateMarker(property: "visible" | "color"): void {
    if (this.nodeSelection().computation !== "ex") return;
    const ex = this.state.computation.ex;
    const value = property === "visible" ? this.inputs["node-marker-visible"].checked : this.inputs["node-marker-color"].value;
    this.commit({ ...this.state, computation: { ...this.state.computation, ex: { ...ex, marker: { ...ex.marker!, [property]: value } } } });
  }

  dispose(): void {
    this.listeners.forEach((remove) => remove());
    this.listeners.length = 0;
  }
}

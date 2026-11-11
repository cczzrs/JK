/**
 * 按 JKS 包含关系浏览节点；选中的地址总是模型中真实的 JKI 或 JKS 绝对路径。
 */

import { type Jki, type Jks, type Jkm, comparePaths } from "../../../src/model.ts";
import { cloneFrom } from "./dom.ts";

interface Item {
  path: string;
  element: HTMLElement;
  row: HTMLElement;
  parent: Item | null;
  group: HTMLElement | null;
  children: Item[];
}

export interface NodeTreeOptions {
  element: HTMLElement;
  groupTemplate: HTMLTemplateElement;
  nodeTemplate: HTMLTemplateElement;
  tagTemplate: HTMLTemplateElement;
  onSelect: (path: string) => void;
  expandedDepth: number;
}

const KEYS = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "];

export class NodeTree {
  private readonly o: NodeTreeOptions;
  private readonly items = new Map<string, Item>();
  private roots: Item[] = [];
  private focused: Item | null = null;
  private selected: Item | null = null;
  private model: Jkm | null = null;
  private readonly handleClick: (event: MouseEvent) => void;
  private readonly handleFocus: (event: FocusEvent) => void;
  private readonly handleKey: (event: KeyboardEvent) => void;

  constructor(options: NodeTreeOptions) {
    this.o = options;
    this.handleClick = (event) => {
      const row = (event.target as Element).closest?.("[data-tree-row]");
      if (!row || !this.o.element.contains(row)) return;
      const item = this.items.get((row.parentElement as HTMLElement).dataset.path ?? "");
      if (!item) return;
      this.focus(item);
      // JKS 行：展开或收起，同时选中这个 JKS；JKI 行：选中这个 JKI。
      if (item.group) this.expand(item, Boolean(item.group.hidden));
      this.select(item.path);
      this.o.onSelect(item.path);
    };
    this.handleFocus = (event) => {
      const item = this.fromTarget(event.target as Element);
      if (item) this.rove(item);
    };
    this.handleKey = (event) => this.keydown(event);
    options.element.addEventListener("click", this.handleClick);
    options.element.addEventListener("focusin", this.handleFocus);
    options.element.addEventListener("keydown", this.handleKey);
  }

  private fromTarget(target: Element): Item | null {
    const element = target.closest?.<HTMLElement>("[role=\"treeitem\"]");
    return element && this.o.element.contains(element) ? this.items.get(element.dataset.path ?? "") ?? null : null;
  }

  setModel(raw: Jkm, selected: string | null): void {
    if (raw === this.model) {
      this.select(selected);
      return;
    }
    this.model = raw;
    this.items.clear();
    this.focused = null;
    this.selected = null;
    const build = (nodes: readonly (Jki | Jks)[], parent: Item | null = null, depth = 1): Item[] =>
      [...nodes].sort((a, b) => comparePaths(a.id, b.id)).map((node, index, siblings) => {
        const branch = "members" in node;
        const path = parent ? `${parent.path}.${node.id}` : node.id;
        const element = cloneFrom(branch ? this.o.groupTemplate : this.o.nodeTemplate);
        const row = element.querySelector<HTMLElement>("[data-tree-row]")!;
        const tags = node.pro?.tag ?? [];
        element.dataset.path = path;
        element.title = path;
        element.setAttribute("aria-label", `${path}${tags.length ? ` · ${tags.join(" · ")}` : ""}`);
        element.setAttribute("aria-level", String(depth));
        element.setAttribute("aria-posinset", String(index + 1));
        element.setAttribute("aria-setsize", String(siblings.length));
        element.querySelector("[data-tree-name]")!.textContent = node.id;
        const tagContainer = element.querySelector<HTMLElement>("[data-tree-tags]")!;
        for (const text of tags) {
          const tag = cloneFrom(this.o.tagTemplate);
          tag.textContent = text;
          tagContainer.append(tag);
        }
        tagContainer.hidden = tags.length === 0;
        const item: Item = { path, element, row, parent, group: branch ? element.querySelector<HTMLElement>("[role=\"group\"]") : null, children: [] };
        this.items.set(path, item);
        if (branch && item.group) {
          item.children = build(node.members, item, depth + 1);
          item.group.append(...item.children.map((child) => child.element));
          this.expand(item, depth <= this.o.expandedDepth);
        }
        return item;
      });
    this.roots = build(raw.roots);
    this.o.element.replaceChildren(...this.roots.map((item) => item.element));
    this.rove(this.roots[0] ?? null);
    this.select(selected);
  }

  private visible(): Item[] {
    const items: Item[] = [];
    const visit = (branches: Item[]) => branches.forEach((item) => {
      items.push(item);
      if (item.group && !item.group.hidden) visit(item.children);
    });
    visit(this.roots);
    return items;
  }

  private rove(item: Item | null): void {
    if (this.focused) this.focused.element.tabIndex = -1;
    this.focused = item;
    if (item) item.element.tabIndex = 0;
  }

  private focus(item: Item | null | undefined): void {
    if (!item) return;
    this.rove(item);
    item.element.focus({ preventScroll: true });
    this.scrollRow(item);
  }

  private expand(item: Item, open: boolean): void {
    if (!item.group) return;
    item.group.hidden = !open;
    item.element.setAttribute("aria-expanded", String(open));
    if (!open && this.focused !== item && this.focused && item.element.contains(this.focused.element)) {
      const ownsFocus = item.group.contains(this.o.element.ownerDocument.activeElement);
      if (ownsFocus) this.focus(item);
      else this.rove(item);
    }
  }

  select(path: string | null): void {
    const next = (path === null ? undefined : this.items.get(path)) ?? null;
    if (this.selected === next) return;
    if (this.selected) {
      this.selected.element.setAttribute("aria-selected", "false");
      this.selected.element.classList.remove("active");
    }
    this.selected = next;
    if (!next) return;
    next.element.setAttribute("aria-selected", "true");
    next.element.classList.add("active");
    // 选中节点不改变手动展开的分支；实时更新或场景选择时保留键盘焦点。
    if (!this.o.element.contains(this.o.element.ownerDocument.activeElement) && this.visible().includes(next)) this.rove(next);
  }

  private scrollRow(item: Item): boolean {
    const element = this.o.element;
    if (!element.clientHeight) return false;
    const box = element.getBoundingClientRect();
    const row = item.row.getBoundingClientRect();
    const top = box.top + element.clientTop;
    const bottom = top + element.clientHeight;
    if (row.top < top) element.scrollTop += row.top - top;
    else if (row.bottom > bottom) element.scrollTop += row.bottom - bottom;
    return true;
  }

  private keydown(event: KeyboardEvent): void {
    const item = this.fromTarget(event.target as Element);
    if (!item || !KEYS.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const visible = this.visible();
    const index = visible.indexOf(item);
    switch (event.key) {
      case "ArrowDown": this.focus(visible[Math.min(visible.length - 1, index + 1)]); break;
      case "ArrowUp": this.focus(visible[Math.max(0, index - 1)]); break;
      case "Home": this.focus(visible[0]); break;
      case "End": this.focus(visible.at(-1)); break;
      case "ArrowRight":
        if (item.group?.hidden) this.expand(item, true);
        else if (item.group) this.focus(item.children[0]);
        break;
      case "ArrowLeft":
        if (item.group && !item.group.hidden) this.expand(item, false);
        else this.focus(item.parent);
        break;
      default:
        if (item.group) this.expand(item, Boolean(item.group.hidden));
        this.select(item.path);
        this.o.onSelect(item.path);
    }
  }

  dispose(): void {
    this.o.element.removeEventListener("click", this.handleClick);
    this.o.element.removeEventListener("focusin", this.handleFocus);
    this.o.element.removeEventListener("keydown", this.handleKey);
  }
}

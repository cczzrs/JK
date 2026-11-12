/**
 * 标签页（ARIA tabs 模式）：标签是 role="tab" 的按钮，面板是 role="tabpanel"，用 aria-labelledby 指向标签。
 * 选中跟随焦点：方向键、Home、End 移动并选中；只有选中的标签在 Tab 顺序中（tabindex=0）。初始状态写在 HTML 中。
 */

import { byId } from "./dom.ts";

function tabsOf(list: HTMLElement): HTMLButtonElement[] {
  return [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
}

/** 选中标签 tab：同步 aria-selected、tabindex 与面板的 hidden。 */
function select(list: HTMLElement, tab: HTMLButtonElement): void {
  for (const each of tabsOf(list)) {
    const on = each === tab;
    each.setAttribute("aria-selected", String(on));
    each.tabIndex = on ? 0 : -1;
    const panel = document.querySelector<HTMLElement>(`[role="tabpanel"][aria-labelledby="${each.id}"]`);
    if (panel) panel.hidden = !on;
  }
}

/** 选中标签组 id 中 data-value 为 value 的标签（不通知）；没有这一项时不变。 */
export function selectTab(id: string, value: string): void {
  const list = byId(id);
  const tab = tabsOf(list).find((each) => each.dataset.value === value);
  if (tab) select(list, tab);
}

/** 标签组 id 当前选中标签的 data-value。 */
export function tabValue(id: string): string {
  return byId(id).querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.dataset.value ?? "";
}

/** 给标签组 id 绑定点击与方向键、Home、End；选中改变时调用 onChange。 */
export function setupTabs(id: string, onChange: (value: string) => void): void {
  const list = byId(id);
  const choose = (tab: HTMLButtonElement) => {
    if (tab.disabled || tab.getAttribute("aria-selected") === "true") return;
    select(list, tab);
    onChange(tab.dataset.value ?? "");
  };
  list.addEventListener("click", (event) => {
    const tab = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]');
    if (tab && list.contains(tab)) choose(tab);
  });
  list.addEventListener("keydown", (event) => {
    const tabs = tabsOf(list).filter((tab) => !tab.disabled);
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    tab.focus();
    choose(tab);
  });
}

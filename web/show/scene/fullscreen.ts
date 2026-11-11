/** 全屏展示：放大已有的内容，不重建渲染器、相机或窗口。 */

export interface FullscreenTarget {
  element: HTMLElement;
  className: string;
  label?: string;
}

export interface FullscreenControl {
  refresh(): void;
  /** 在工作区或显示类型改变之前退出全屏。 */
  exit(): Promise<void>;
}

export function setupSceneFullscreen(button: HTMLButtonElement, resolveTarget: () => FullscreenTarget): FullscreenControl {
  const doc = button.ownerDocument;
  const label = button.querySelector("[data-fullscreen-label]");
  let target: FullscreenTarget | null = null;
  let fallback = false;
  let pending: Promise<void> | null = null;
  let phase: "enter" | "exit" | null = null;
  let active = false;
  const isActive = (): boolean => Boolean(target && (fallback || doc.fullscreenElement === target.element));
  const sync = (): void => {
    const wasActive = active;
    active = isActive();
    target?.element.classList.toggle(target.className, active);
    doc.documentElement.classList.toggle("scene-fullscreen-open", active);
    let description: FullscreenTarget | null = target;
    if (!description) {
      try {
        description = resolveTarget();
      } catch {
        // 进入失败时保留重试的可能。
      }
    }
    const enterText = `全屏展示${description?.label || "模型网络"}`;
    const exitText = description?.label ? `退出${description.label}全屏` : "退出全屏";
    if (label) label.textContent = active ? "退出全屏" : "全屏";
    else button.textContent = active ? "⛶ 退出全屏" : "⛶ 全屏";
    button.setAttribute("aria-pressed", String(active));
    if (label) button.setAttribute("aria-label", active ? exitText : enterText);
    button.title = active ? `${exitText}（Esc）${fallback ? " · 当前为页面内全屏" : ""}` : enterText;
    if (wasActive && !active) button.focus({ preventScroll: true });
    // 浏览器完成 requestFullscreen() 之前，请求仍绑定在原来的目标上。
    if (!active && phase !== "enter") target = null;
  };
  const change = (enter: boolean): Promise<void> => {
    if (pending) return pending;
    button.disabled = true;
    phase = enter ? "enter" : "exit";
    const operation = (async () => {
      try {
        if (!enter) {
          if (target && doc.fullscreenElement === target.element) await doc.exitFullscreen();
          fallback = false;
        } else {
          const next = resolveTarget();
          if (!next?.element || next.element.ownerDocument !== doc || !next.className || /\s/.test(next.className)) {
            throw new Error("全屏目标不可用");
          }
          target = { ...next };
          if (target.element.requestFullscreen && doc.fullscreenEnabled !== false) {
            try {
              await target.element.requestFullscreen();
            } catch {
              fallback = true;
            }
          } else {
            fallback = true;
          }
        }
      } finally {
        phase = null;
        button.disabled = false;
        sync();
      }
    })();
    pending = operation;
    operation.then(() => { if (pending === operation) pending = null; }, () => { if (pending === operation) pending = null; });
    return operation;
  };
  button.addEventListener("click", async () => {
    if (pending) return;
    const enter = !isActive();
    try {
      await change(enter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      button.title = `${enter ? "进入" : "退出"}全屏失败：${message}${enter ? "" : "；可按 Esc 退出"}`;
    }
  });
  doc.addEventListener("fullscreenchange", sync);
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && active && !doc.querySelector("dialog[open]")) {
      button.click();
      event.preventDefault();
    }
  });
  sync();
  return {
    refresh: sync,
    async exit() {
      if (pending) await pending;
      if (isActive()) await change(false);
    },
  };
}

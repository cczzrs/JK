/** Presentation only: fullscreen never reads or changes the simulator. */
export function setupFullscreen({ panel, button, onChange = () => {} }) {
  if (!panel || !button) throw new TypeError('Fullscreen requires a panel and a button.');
  const doc = panel.ownerDocument;
  const win = doc.defaultView;
  let fallback = false;
  let active = false;
  let busy = false;
  let destroyed = false;
  let saved = null;
  let resizeFrame = null;
  let inertElements = [];

  const isNative = () => doc.fullscreenElement === panel;
  const isActive = () => fallback || isNative();
  const notify = () => {
    if (resizeFrame !== null) win.cancelAnimationFrame(resizeFrame);
    resizeFrame = win.requestAnimationFrame(() => {
      resizeFrame = null;
      if (!destroyed) onChange({ active: isActive(), mode: fallback ? 'window' : isNative() ? 'native' : null });
    });
  };

  function remember() {
    if (saved) return;
    saved = {
      focus: doc.activeElement,
      x: win.scrollX,
      y: win.scrollY,
      bodyOverflow: doc.body.style.overflow,
      rootOverflow: doc.documentElement.style.overflow,
    };
  }

  function lockBackground() {
    doc.body.style.overflow = 'hidden';
    doc.documentElement.style.overflow = 'hidden';
    // Keep keyboard focus inside the window-filling fallback, including when
    // the canvas is nested in a workspace rather than directly under body.
    let branch = panel;
    while (branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling === branch || ['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) continue;
        inertElements.push([sibling, sibling.inert]);
        sibling.inert = true;
      }
      if (parent === doc.body) break;
      branch = parent;
    }
  }

  function restore() {
    for (const [element, inert] of inertElements) element.inert = inert;
    inertElements = [];
    if (!saved) return;
    doc.body.style.overflow = saved.bodyOverflow;
    doc.documentElement.style.overflow = saved.rootOverflow;
    const previous = saved;
    saved = null;
    win.scrollTo({ left: previous.x, top: previous.y, behavior: 'instant' });
    if (previous.focus?.isConnected && typeof previous.focus.focus === 'function') {
      previous.focus.focus({ preventScroll: true });
    }
  }

  function sync() {
    const next = isActive();
    panel.classList.toggle('canvas-fullscreen', next);
    panel.classList.toggle('canvas-fullscreen-fallback', fallback);
    button.classList.add('canvas-fullscreen-button');
    button.textContent = next ? '退出全屏' : '全屏';
    button.title = next ? '退出画板全屏（Esc）' : '画板全屏';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(next));
    if (next !== active) {
      active = next;
      if (next) button.focus({ preventScroll: true });
      else restore();
    }
    notify();
  }

  async function enter() {
    if (busy || isActive() || destroyed) return;
    remember();
    busy = true;
    try {
      if (typeof panel.requestFullscreen !== 'function' || doc.fullscreenEnabled === false) {
        throw new Error('Native fullscreen is unavailable.');
      }
      await panel.requestFullscreen();
      if (!isNative()) throw new Error('Native fullscreen did not activate.');
    } catch {
      if (!destroyed && !isNative()) {
        fallback = true;
        lockBackground();
      }
    } finally {
      busy = false;
      if (!destroyed) sync();
    }
  }

  async function exit() {
    if (busy || !isActive()) return;
    busy = true;
    try {
      if (fallback) fallback = false;
      if (isNative() && typeof doc.exitFullscreen === 'function') await doc.exitFullscreen();
    } finally {
      busy = false;
      sync();
    }
  }

  async function toggle() {
    if (isActive()) await exit();
    else await enter();
  }

  function click(event) {
    event.preventDefault();
    // If the browser refuses an exit request, keep the button in its actual
    // active state; the browser's own Escape shortcut remains available.
    toggle().catch(sync);
  }

  function keydown(event) {
    if (event.key === 'Escape' && isActive()) {
      event.preventDefault();
      exit().catch(sync);
    }
  }

  function destroy() {
    destroyed = true;
    button.removeEventListener('click', click);
    doc.removeEventListener('fullscreenchange', sync);
    doc.removeEventListener('keydown', keydown, true);
    win.removeEventListener('resize', notify);
    win.visualViewport?.removeEventListener('resize', notify);
    if (resizeFrame !== null) win.cancelAnimationFrame(resizeFrame);
    if (isNative()) doc.exitFullscreen?.().catch(() => {});
    fallback = false;
    panel.classList.remove('canvas-fullscreen', 'canvas-fullscreen-fallback');
    restore();
  }

  button.addEventListener('click', click);
  doc.addEventListener('fullscreenchange', sync);
  doc.addEventListener('keydown', keydown, true);
  win.addEventListener('resize', notify);
  win.visualViewport?.addEventListener('resize', notify);
  sync();
  return { enter, exit, toggle, isActive, destroy };
}

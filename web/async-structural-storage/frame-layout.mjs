// Visual preferences only: never stores or changes simulator state or ownership.
const STORAGE_KEY = 'jk-async-storage:frame-layout:v1';
const LIMIT = 6000;
const clamp = (n, min, max = LIMIT) => Math.max(min, Math.min(max, n));

function readPreferences() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => value && typeof value === 'object').map(([id, value]) => {
      const clean = {};
      for (const key of ['x', 'y', 'width', 'height']) if (Number.isFinite(value[key])) clean[key] = clamp(value[key], key === 'x' || key === 'y' ? -LIMIT : 80);
      if (/^#[\da-f]{6}$/i.test(value.color)) clean.color = value.color;
      return [id, clean];
    }));
  } catch { return {}; }
}

function rgbHex(value) {
  const values = value.match(/\d+/g);
  return values?.length >= 3 ? `#${values.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('')}` : '#6e9d94';
}

export function createFrameLayout({ scene, viewport, editor, getScale, onGeometry, onRelease, onReset }) {
  let preferences = readPreferences();
  let frames = new Map();
  let selected = 'root';
  let active = null;
  let resizeTick = null;
  let skipCapture = false;
  const scrollPositions = new Map();
  const defaultColors = new Map();
  const field = name => editor.querySelector(`[data-frame-field="${name}"]`);
  const preference = id => preferences[id] || {};
  const save = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Editing works when browser storage is unavailable. */ } };
  const observer = new ResizeObserver(() => {
    if (resizeTick !== null) return;
    resizeTick = requestAnimationFrame(() => { resizeTick = null; onGeometry(); });
  });

  function apply(frame) {
    const value = preference(frame.id);
    const { element } = frame;
    element.style.left = `${value.x || 0}px`;
    element.style.top = `${value.y || 0}px`;
    element.style.width = value.width ? `${value.width}px` : '';
    element.style.setProperty('--frame-height', value.height ? `${value.height}px` : 'auto');
    element.classList.toggle('frame-fixed-height', Boolean(value.height));
    element.classList.toggle('frame-colored', Boolean(value.color));
    element.style.setProperty('--frame-color', value.color || frame.defaultColor);
    element.style.setProperty('--frame-tint', `${value.color || frame.defaultColor}12`);
  }

  function updateEditor() {
    for (const item of frames.values()) {
      const box = getComputedStyle(item.element), heading = getComputedStyle(item.heading);
      const chrome = item.heading.offsetHeight + ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + (parseFloat(box[key]) || 0), 0) + (parseFloat(heading.marginTop) || 0) + (parseFloat(heading.marginBottom) || 0);
      item.minHeight = Math.max(80, Math.ceil(chrome + 40));
      item.element.style.setProperty('--frame-chrome', `${chrome}px`);
    }
    const frame = frames.get(selected);
    if (!frame) return;
    const value = preference(selected);
    editor.querySelector('[data-frame-name]').textContent = frame.name;
    for (const [key, number] of [['width', value.width || frame.element.offsetWidth], ['height', value.height || frame.element.offsetHeight]]) {
      if (document.activeElement !== field(key)) field(key).value = Math.round(number);
      field(key).min = frame[key === 'width' ? 'minWidth' : 'minHeight'];
    }
    field('color').value = value.color || frame.defaultColor;
    editor.querySelectorAll('[data-frame-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.frameColor === value.color)));
  }

  function select(id) {
    selected = id;
    for (const frame of frames.values()) frame.element.classList.toggle('frame-selected', frame.id === id);
    updateEditor();
  }

  function change(id, values) {
    preferences[id] = { ...preference(id), ...values };
    apply(frames.get(id));
    onGeometry();
    updateEditor();
  }

  function decorate(element, id) {
    const heading = element.querySelector(':scope > summary, :scope > h3, :scope > .outer-heading');
    if (!heading) return;
    const name = heading.firstChild?.textContent.trim() || id;
    const defaultColor = defaultColors.get(id) || rgbHex(getComputedStyle(element).borderTopColor);
    defaultColors.set(id, defaultColor);
    element.classList.add('editable-frame');
    element.dataset.frameId = id;
    heading.classList.add('frame-heading');
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'frame-drag';
    handle.dataset.frameMove = '';
    handle.textContent = '⠿';
    handle.title = `拖动 ${name}；选中后可设置宽高和颜色`;
    handle.setAttribute('aria-label', `移动画框 ${name}`);
    heading.prepend(handle);
    const body = document.createElement('div');
    body.className = 'frame-body';
    for (const child of [...element.children]) if (child !== heading && child.id !== 'edges') body.append(child);
    element.append(body);
    for (const axis of ['e', 's', 'se']) {
      const grip = document.createElement('button');
      grip.type = 'button';
      grip.className = `frame-resize frame-resize-${axis}`;
      grip.dataset.frameResize = axis;
      grip.title = axis === 'e' ? '拖动调整宽度' : axis === 's' ? '拖动调整高度' : '拖动调整宽高';
      grip.setAttribute('aria-label', `${name} ${grip.title}`);
      grip.tabIndex = axis === 'se' ? 0 : -1;
      element.append(grip);
    }
    const frame = { id, name, element, heading, body, defaultColor,
      minWidth: id === 'root' ? 360 : element.matches('.slot') ? 125 : element.matches('.module') ? 240 : 170,
      minHeight: 80 };
    frames.set(id, frame);
    apply(frame);
    observer.observe(element);
    observer.observe(body);
  }

  function mount() {
    observer.disconnect();
    frames = new Map();
    // Descendants keep their original parent. A frame's content wraps/reflows in
    // its own scroll area, so moving it cannot move its Q nodes to another module.
    for (const element of [...scene.querySelectorAll('[data-collapse], [data-queue-frame]')]) {
      decorate(element, element.dataset.collapse || `queue-${element.dataset.queueFrame}`);
    }
    decorate(scene, 'root');
    for (const [id, frame] of frames) {
      frame.body.scrollLeft = scrollPositions.get(id)?.x || 0;
      frame.body.scrollTop = scrollPositions.get(id)?.y || 0;
    }
    select(frames.has(selected) ? selected : 'root');
  }

  function capture() {
    if (skipCapture) { skipCapture = false; return; }
    for (const [id, frame] of frames) scrollPositions.set(id, { x: frame.body.scrollLeft, y: frame.body.scrollTop });
  }

  function finish(cancel = false) {
    if (!active) return;
    const previous = active;
    active = null;
    if (cancel) { preferences[previous.id] = previous.original; apply(previous.frame); }
    previous.frame.element.classList.remove('frame-adjusting');
    scene.classList.remove('layout-interacting');
    if (scene.hasPointerCapture(previous.pointerId)) scene.releasePointerCapture(previous.pointerId);
    save();
    onGeometry();
    onRelease();
  }

  scene.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const element = event.target.closest('[data-frame-id]');
    if (!element) return;
    const frame = frames.get(element.dataset.frameId);
    select(frame.id);
    const move = event.target.closest('[data-frame-move]');
    const resize = event.target.closest('[data-frame-resize]');
    if (!move && !resize) return;
    event.preventDefault();
    event.stopPropagation();
    (move || resize).focus({ preventScroll: true });
    const value = preference(frame.id);
    const scale = getScale();
    const rect = element.getBoundingClientRect();
    const parentRect = element.parentElement.getBoundingClientRect();
    const scroller = frame.id === 'root' ? viewport : element.parentElement.closest('.frame-body');
    active = { frame, id: frame.id, pointerId: event.pointerId, mode: move ? 'move' : resize.dataset.frameResize,
      clientX: event.clientX, clientY: event.clientY, scale, width: element.offsetWidth,
      height: value.height || element.offsetHeight, x: value.x || 0, y: value.y || 0,
      minX: frame.id === 'root' ? 0 : (value.x || 0) - (rect.left - parentRect.left) / scale,
      minY: frame.id === 'root' ? 0 : (value.y || 0) - (rect.top - parentRect.top) / scale,
      scroller, scrollX: scroller?.scrollLeft || 0, scrollY: scroller?.scrollTop || 0, original: { ...value } };
    element.classList.add('frame-adjusting');
    scene.classList.add('layout-interacting');
    scene.setPointerCapture(event.pointerId);
  });

  scene.addEventListener('pointermove', event => {
    if (!active || event.pointerId !== active.pointerId) return;
    const a = active;
    const coordinateScale = a.mode === 'move' && a.id === 'root' ? 1 : a.scale;
    const scrollScale = a.id === 'root' ? coordinateScale : 1;
    const dx = (event.clientX - a.clientX) / coordinateScale + ((a.scroller?.scrollLeft || 0) - a.scrollX) / scrollScale;
    const dy = (event.clientY - a.clientY) / coordinateScale + ((a.scroller?.scrollTop || 0) - a.scrollY) / scrollScale;
    if (a.mode === 'move') change(a.id, { x: clamp(a.x + dx, a.minX), y: clamp(a.y + dy, a.minY) });
    else {
      const values = {};
      if (a.mode.includes('e')) values.width = Math.round(clamp(a.width + dx, a.frame.minWidth));
      if (a.mode.includes('s')) values.height = Math.round(clamp(a.height + dy, Math.max(a.frame.minHeight, a.frame.heading.offsetHeight + 40)));
      change(a.id, values);
    }
  });
  scene.addEventListener('pointerup', () => finish());
  scene.addEventListener('pointercancel', () => finish(true));
  scene.addEventListener('lostpointercapture', () => finish());
  scene.addEventListener('click', event => {
    if (event.target.closest('[data-frame-move], [data-frame-resize]')) { event.preventDefault(); event.stopPropagation(); }
  });
  scene.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) { event.preventDefault(); finish(true); return; }
    const handle = event.target.closest('[data-frame-move], [data-frame-resize]');
    if (!handle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const id = handle.closest('[data-frame-id]').dataset.frameId;
    select(id);
    const frame = frames.get(id), value = preference(id), step = event.shiftKey ? 1 : 10;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (handle.hasAttribute('data-frame-move')) {
      const rect = frame.element.getBoundingClientRect(), parent = frame.element.parentElement.getBoundingClientRect();
      change(id, { x: clamp((value.x || 0) + dx, id === 'root' ? 0 : (value.x || 0) - (rect.left - parent.left) / getScale()), y: clamp((value.y || 0) + dy, id === 'root' ? 0 : (value.y || 0) - (rect.top - parent.top) / getScale()) });
    } else {
      const axis = handle.dataset.frameResize, values = {};
      if (axis.includes('e') && dx) values.width = clamp(frame.element.offsetWidth + dx, frame.minWidth);
      if (axis.includes('s') && dy) values.height = clamp((value.height || frame.element.offsetHeight) + dy, frame.minHeight);
      change(id, values);
    }
    save();
  });
  scene.addEventListener('scroll', onGeometry, true);
  window.addEventListener('blur', () => finish());

  function editField(event) {
    const key = event.target.dataset.frameField;
    const frame = frames.get(selected);
    if (!key || !frame) return;
    if (key === 'color') change(selected, { color: event.target.value });
    else {
      const number = Number(event.target.value);
      if (event.type === 'input' && number < frame[key === 'width' ? 'minWidth' : 'minHeight']) return;
      if (event.target.value === '') change(selected, { [key]: undefined });
      else if (Number.isFinite(number)) change(selected, { [key]: clamp(number, frame[key === 'width' ? 'minWidth' : 'minHeight']) });
    }
    save();
  }
  editor.addEventListener('input', editField);
  editor.addEventListener('change', editField);
  editor.addEventListener('click', event => {
    const color = event.target.closest('[data-frame-color]')?.dataset.frameColor;
    if (color) { change(selected, { color }); save(); }
    if (event.target.closest('[data-frame-reset]')) {
      capture(); scrollPositions.delete(selected); skipCapture = true;
      delete preferences[selected]; save(); onReset();
    }
    if (event.target.closest('[data-layout-reset]')) {
      preferences = {}; scrollPositions.clear(); skipCapture = true;
      viewport.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      save(); onReset();
    }
  });

  return { mount, capture, updateEditor, get busy() { return Boolean(active); },
    get root() { return preference('root'); } };
}

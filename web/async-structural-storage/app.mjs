import { StorageSimulator } from './engine.mjs';
import { createFrameLayout } from './frame-layout.mjs';
import { setupFullscreen } from './canvas-fullscreen.mjs';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const arr = (value) => Array.isArray(value) ? value : [];
const sim = new StorageSimulator();
let state = sim.view();
let selectedNode = null;
let selectedTask = null;
let selectedStep = null;
let tab = 'node';
let running = false;
let timer = null;
let zoom = 1;
let edgeFrame = null;
let animatingStep = null;
const closed = new Set();
let scenePending = false;
const layout = createFrameLayout({
  scene: $('#diagram-scene'), viewport: $('#diagram-viewport'), editor: $('#frame-editor'),
  getScale: () => zoom, onGeometry: resizeScene,
  onRelease: () => { if (scenePending) { scenePending = false; renderScene(); } },
  onReset: renderScene,
});
setupFullscreen({ panel: $('.diagram-panel'), button: $('[data-action="fullscreen"]'), onChange: resizeScene });

const groupDefinitions = [
  ['input', '输入节点与独立副本', '01 / INPUT'],
  ['handoff', '整帧接力 · 校验与变化记录', '02 / HANDOFF'],
  ['control', '异步处理与 JK 控制', '03 / CONTROL'],
  ['readout', '选择与逐节点读出', '04 / READOUT'],
  ['relay', '固定中转 Q', '05 / RELAY'],
  ['output', '输出节点与 FRAME_OUT', '06 / OUTPUT'],
  ['ack', 'ACK 输入与双译码', '07 / ACK'],
  ['cache', '完整递交后的保留数据', '08 / RETAINED'],
];
const names = {
  copy: '输入复制', store: '帧存储', handoff: '帧参数接力', checksum: '输入校验',
  change: '变化记录', read: '读出', select: '选择', relay: '中转', output: '输出求值',
  marker: '帧完成', ack0: '重发译码', ack1: '消费译码', ack: 'ACK 复制',
  first: '首发', replay: '重发', initial: '首发',
  'input-copy': '输入复制', 'frame-in': '封帧复制', 'frame-clear': '清暂态',
  'ack-input': 'ACK 复制', 'frame-out': '完成标记', 'marker-relay': '标记中转',
  'read-marker': '标记读出',
  selector: '帧选择', 'data-output': '数据输出', input: '输入副本', retention: '保持辅助', 'cache-data': '保留数据', control: '业务控制', 'ack-ready': 'ACK 资格', 'output-kind': '首发标记', data: '存储数据', 'slot-valid': '槽活帧', waiting: '等待', selecting: '选择中', reading: '读出中',
};
const labelKind = (value) => names[value] || value || '节点任务';
const currentRecord = () => arr(state.history).find((record) => record.step === selectedStep) || arr(state.history).at(-1);
const nodeById = (id) => arr(state.nodes).find((node) => node.id === id);
const displayGroup = (node) => node.role === 'ack-input' ? 'ack' : node.group;
const currentNode = () => nodeById(selectedNode);
const allTasks = () => Object.values(state.queues || {}).flatMap(arr);

function message(text, error = false) {
  $('#message').textContent = text;
  $('#message').classList.toggle('error', error);
}

function nodeHTML(node) {
  const last = arr(state.history).at(-1);
  const classes = ['node', node.stateful ? 'stateful' : 'stateless', node.q === 1 ? 'bit-one' : '',
    node.id === selectedNode ? 'selected' : '', node.id === last?.target ? 'last-target' : '',
    animatingStep === last?.step && arr(last?.writes).some((write) => write.target === node.id) ? 'executing-pulse' : '', node.pending ? 'pending' : ''].filter(Boolean).join(' ');
  return `<button class="${classes}" data-node="${esc(node.id)}" data-anchor="${esc(node.id)}" title="${esc(`${node.id} · ${node.label}\n${node.ex}\nq=${node.q} · ${node.queue}${node.scc ? ` · SCC ${node.scc}` : ''}`)}" aria-label="${esc(`${node.id} ${node.label} q ${node.q}`)}"><span class="node-top">${esc(node.id)}${node.scc ? '<span class="scc-dot" title="真实引用环，监督未实现">↺</span>' : ''}<span class="node-bit">${esc(node.q ?? '·')}</span></span><span class="node-label">${esc(node.label || node.role || node.type)}</span></button>`;
}

function groupHTML(key, title, code, nodes) {
  const ports = key === 'input' ? `<div class="port-row">${nodes.filter((node) => node.inputIndex !== undefined).map((node) => `<span class="port" data-anchor="X${esc(node.inputIndex)}">${node.role === 'frame-in' ? `X${esc(node.inputIndex)} / FRAME_IN` : `X${esc(node.inputIndex)}`}</span>`).join('')}</div>` : key === 'ack' ? `<div class="port-row">${nodes.filter((node) => node.inputIndex !== undefined).map((node) => `<span class="port" data-anchor="X${esc(node.inputIndex)}">X${esc(node.inputIndex)} / ACK 0、1</span>`).join('')}</div>` : '';
  const outputPorts = key === 'output' ? `<div class="port-row output-ports">${nodes.filter((node) => node.output).map((node) => `<span class="port" data-anchor="${esc(node.output)}">${esc(node.output)}${node.role === 'frame-out' ? ' / FRAME_OUT' : ''}</span>`).join('')}</div>` : '';
  const cacheStatus = key === 'cache' ? `<div class="group-status">保留身份 ${esc(state.cache?.owner || '—')} · W=${esc(state.cache?.width ?? 0)} · 有效 q=${esc(state.cache?.valid ?? 0)}${state.ready?.q !== 1 ? ' · 暂不可 ACK' : ''}</div>` : '';
  return `<details class="node-group" data-collapse="${key}" ${closed.has(key) ? '' : 'open'}><summary class="group-heading">${esc(title)}<span>${nodes.length} Q</span></summary>${ports}${cacheStatus}<div class="node-grid">${nodes.length ? nodes.map(nodeHTML).join('') : `<div class="node-empty">等待结构创建</div>`}</div>${outputPorts}</details>`;
}

function slotHTML(slot, index) {
  const dataIds = arr(slot.nodeIds);
  const controlIds = arr(slot.controlIds);
  const allIds = new Set([...dataIds, ...controlIds]);
  const matches = arr(state.nodes).filter((node) => allIds.has(node.id) || (node.slotId === slot.id && node.group === 'storage'));
  const data = matches.filter((node) => !controlIds.includes(node.id));
  const control = matches.filter((node) => controlIds.includes(node.id));
  const dependency = typeof slot.dependencies === 'number' ? slot.dependencies : arr(slot.dependencies).length;
  const key = `slot-${slot.id}`;
  const empty = !slot.frameId && !matches.length;
  return `<details class="slot ${empty ? 'empty' : ''} ${slot.consumed ? 'consumed' : ''}" data-collapse="${esc(key)}" ${closed.has(key) ? '' : 'open'}><summary class="slot-heading">槽 ${index + 1}<span class="slot-frame">${esc(slot.frameId || (slot.consumed ? '已消费' : '未使用'))}</span></summary>${empty ? '<div class="slot-label">尚未接纳帧</div>' : `<div class="slot-label">W=${esc(slot.width ?? data.length)} · ${slot.consumed ? '已消费' : '存储中'} · 依赖 ${esc(dependency)}</div><div class="node-grid">${data.map(nodeHTML).join('')}</div>${control.length ? `<div class="slot-control-label">辅助控制 Q</div><div class="node-grid">${control.map(nodeHTML).join('')}</div>` : ''}`}</details>`;
}

function storageHTML() {
  if (!arr(state.blocks).length) return '<div class="empty-storage"><b>等待第一帧建立存储结构</b><br>每块按序使用 8 槽；每帧恰好 W 个数据 Q，辅助控制 Q 另计。容量按需增长。</div>';
  return `<div class="blocks">${state.blocks.map((block) => {
    const key = `block-${block.id}`;
    const status = ({ active: '使用中', reusable: '可复用', free: '可复用', pool: '可复用', retired: '已释放', full: '名额用尽', partial: '部分使用' })[block.status] || block.status;
    const slots = Array.from({ length: 8 }, (_, index) => arr(block.slots)[index] || { id: `${block.id}.${index + 1}`, nodeIds: [], controlIds: [] });
    return `<details class="block" data-collapse="${esc(key)}" ${closed.has(key) ? '' : 'open'}><summary class="block-heading">${esc(block.label || block.id)}<span class="block-state">${esc(status)}</span><span class="block-meta">GEN ${esc(block.generation)} · 已接纳 ${esc(block.used ?? 0)}/8</span></summary><div class="slots">${slots.map(slotHTML).join('')}</div></details>`;
  }).join('')}</div>`;
}

function queueHTML(queue) {
  const tasks = arr(state.queues?.[queue]);
  return `<div class="queue-line">${tasks.length ? tasks.map((task) => `<button class="queue-task" data-task="${esc(task.id)}" title="${esc(`${task.id} → ${task.target}\n${labelKind(task.kind)}\n${json(task.cause)}`)}"><strong>${esc(task.target)} <span style="display:inline;font-size:7px">${esc(task.id)}</span></strong><span>${esc(labelKind(task.kind))}</span><span>${esc([task.frameId, task.batchId].filter(Boolean).join(' · ') || `gen ${task.generation ?? 0}`)}</span></button>`).join('') : '<div class="queue-empty">队列为空</div>'}</div>`;
}

function renderScene() {
  if (layout.busy) { scenePending = true; return; }
  layout.capture();
  const nodes = arr(state.nodes);
  const known = new Set(groupDefinitions.map(([key]) => key));
  const other = nodes.filter((node) => !known.has(node.group) && node.group !== 'storage' && !node.slotId);
  const last = arr(state.history).at(-1);
  const requestIds = new Set(arr(state.requests).map((request) => request.id));
  const active = state.activeRequest && (typeof state.activeRequest === 'string' ? arr(state.requests).find((request) => request.id === state.activeRequest) : state.activeRequest);
  const requests = [...(active && !requestIds.has(active.id) ? [active] : []), ...arr(state.requests)];
  $('#diagram-scene').innerHTML = `
    <div class="outer-heading">异步结构存储<span class="module-tag">LOGIC UNIT · LIVE STRUCTURE</span></div>
    <details class="module async-module" data-collapse="async" ${closed.has('async') ? '' : 'open'}>
      <summary class="module-heading">异步结构<span class="description">输入 → 接力 → 读出 → 递交 · ACK 控制消费</span><span class="module-tag">ASYNC</span></summary>
      <div class="async-groups">${groupDefinitions.map(([key, title, code]) => groupHTML(key, title, code, nodes.filter((node) => displayGroup(node) === key && !node.slotId))).join('')}${other.length ? groupHTML('other', '其他成员节点', 'OTHER', other) : ''}</div>
    </details>
    <details class="module storage-module" data-collapse="storage" ${closed.has('storage') ? '' : 'open'}><summary class="module-heading">存储结构<span class="description">块 → 槽 → 数据 Q / 控制 Q</span><span class="module-tag">${arr(state.blocks).length} BLOCKS</span></summary>${storageHTML()}</details>
    <div class="factory-queue">
      <details class="module factory" data-anchor="RAM.FACTORY" data-collapse="factory" ${closed.has('factory') ? '' : 'open'}><summary class="module-heading">RAM.FACTORY<span class="module-tag">管理机制</span></summary><div class="factory-body"><p class="factory-copy">在真实节点的 RAM 任务内分配、连接、写入、释放与回收。此框表示工厂机制，不是额外的 Q 节点。</p><div class="factory-stats"><span><strong>${arr(state.members).length}</strong>成员</span><span><strong>${arr(state.blocks).length}</strong>块</span></div><div class="factory-members">${arr(state.members).map((member) => esc(typeof member === 'string' ? member : member.id)).join(' · ') || '等待成员登记'}</div><div class="transaction-preview">${last ? `最近任务 ${esc(last.taskId)} → ${esc(last.target)}<br>${esc(last.message || labelKind(last.kind))}` : '结构事务结束后才选择下一任务。'}</div></div></details>
      <details class="module queues" data-collapse="ram-queue" ${closed.has('ram-queue') ? '' : 'open'}><summary class="module-heading">RAM.FIFO<span class="description">优先值 2 · ${arr(state.queues?.['RAM.FIFO']).length} 项节点任务</span><span class="module-tag">HEAD → TAIL</span></summary><div class="queue-body">${queueHTML('RAM.FIFO')}<p class="queue-note">输出也是 RAM 成员节点任务。卡片只代表待执行任务，节点仍在上方结构中。</p></div><div class="request-line">输出准备请求 · 业务顺序记录，不是额外执行队列<div class="request-chips">${requests.length ? requests.map((request) => `<span class="request-chip ${request.id === active?.id ? 'active' : ''}">${esc(request.frameId)} ${esc(labelKind(request.kind))} · ${esc(labelKind(request.status || (request.id === active?.id ? '准备中' : '等待')))}</span>`).join('') : '<span>暂无请求</span>'}</div></div></details>
    </div>
    <div class="global-queues">${[['Xi.FIFO', 1], ['DAG.FIFO', 3], ['Qi.FIFO', 5]].map(([queue, priority]) => `<div class="global-queue" data-queue-frame="${queue}"><h3>${queue}<span>优先值 ${priority} · ${arr(state.queues?.[queue]).length} 项</span></h3>${queueHTML(queue)}</div>`).join('')}</div>
    <svg id="edges" class="edges" aria-hidden="true"><defs><marker id="arrow-ref" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#497aab"/></marker><marker id="arrow-cause" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#bc8227"/></marker></defs><g id="edge-lines"></g></svg>`;
  layout.mount();
  resizeScene();
}

function resizeScene() {
  const scene = $('#diagram-scene');
  scene.style.width = `${layout.root.width || Math.max(830, $('#diagram-viewport').clientWidth - 46)}px`;
  scene.style.transform = `scale(${zoom})`;
  // Root offsets are unscaled; nested offsets are already inside the root's zoom.
  $('#diagram-size').style.width = `${scene.offsetWidth * zoom + (layout.root.x || 0)}px`;
  $('#diagram-size').style.height = `${scene.offsetHeight * zoom + (layout.root.y || 0)}px`;
  $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`;
  layout.updateEditor();
  scheduleEdges();
}

function scheduleEdges() {
  if (edgeFrame) cancelAnimationFrame(edgeFrame);
  edgeFrame = requestAnimationFrame(drawEdges);
}

function drawEdges() {
  edgeFrame = null;
  const scene = $('#diagram-scene');
  const svg = $('#edges');
  if (!svg) return;
  const rect = scene.getBoundingClientRect();
  const anchors = new Map();
  scene.querySelectorAll('[data-anchor]').forEach((element) => {
    // Closed details can retain layout rectangles despite hiding their content.
    if (element.parentElement?.closest('details:not([open])')) return;
    if (!element.getClientRects().length) return;
    const r = element.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // Do not connect to nodes hidden behind a resized frame's scroll boundary.
    for (let body = element.parentElement?.closest('.frame-body'); body; body = body.parentElement?.parentElement?.closest('.frame-body')) {
      const clip = body.getBoundingClientRect();
      if (r.left < clip.left || r.right > clip.right + 1 || r.top < clip.top || r.bottom > clip.bottom + 1) return;
    }
    anchors.set(element.dataset.anchor, { x: (r.left - rect.left) / zoom, y: (r.top - rect.top) / zoom, w: r.width / zoom, h: r.height / zoom });
  });
  const edges = [];
  const focus = selectedNode || (selectedTask && allTasks().find((task) => task.id === selectedTask)?.target);
  if ($('#edge-refs').checked) {
    for (const node of arr(state.nodes)) {
      for (const source of arr(node.refs)) {
        if ($('#all-edges').checked || node.id === focus || source === focus) edges.push({ from: source, to: node.id, type: 'ref' });
      }
    }
  }
  if ($('#edge-binding').checked) {
    for (const node of arr(state.nodes)) if (node.output) edges.push({ from: node.id, to: node.output, type: 'binding' });
  }
  const task = allTasks().find((item) => item.id === selectedTask) || currentRecord();
  if ($('#edge-cause').checked && task) {
    const taskId = task.id || task.taskId;
    const parent = arr(state.history).findLast((record) => arr(record.events).some((event) => event.type === 'enqueue' && event.taskId === taskId));
    const causeText = json(task.cause) || '';
    const sources = new Set(causeText.match(/Q\d+|X\d+|FRAME_IN|ACK\b/g) || []);
    if (parent) sources.add(parent.target);
    for (const id of causeText.match(/T\d+/g) || []) {
      const record = arr(state.history).find((item) => item.taskId === id);
      if (record) sources.add(record.target);
    }
    const targetNode = nodeById(task.target);
    if (!parent && targetNode?.inputIndex !== undefined) sources.add(`X${targetNode.inputIndex}`);
    for (const source of sources) if (source !== task.target && anchors.has(source)) edges.push({ from: source, to: task.target, type: 'cause' });
  }
  const memberIds = new Set(arr(state.members).map((member) => typeof member === 'string' ? member : member.id));
  if (focus && memberIds.has(focus)) {
    if ($('#edge-management').checked) edges.push({ from: 'RAM.FACTORY', to: focus, type: 'management' });
    if ($('#edge-membership').checked) edges.push({ from: focus, to: 'RAM.FACTORY', type: 'membership' });
  }
  const paths = edges.map((edge, index) => {
    const from = anchors.get(edge.from), to = anchors.get(edge.to);
    if (!from || !to) return '';
    const x1 = from.x + from.w / 2, x2 = to.x + to.w / 2;
    let y1, y2, d;
    if (edge.from === edge.to) {
      d = `M${from.x + from.w - 5},${from.y + 8}C${from.x + from.w + 26},${from.y - 20} ${from.x - 10},${from.y - 20} ${from.x + 6},${from.y + 5}`;
    } else if (Math.abs(from.y - to.y) < 40) {
      y1 = from.y + 3; y2 = to.y + 3;
      const top = Math.min(y1, y2) - 13 - (index % 4) * 5;
      d = `M${x1},${y1}C${x1},${top} ${x2},${top} ${x2},${y2}`;
    } else {
      y1 = from.y + (from.y < to.y ? from.h : 0); y2 = to.y + (from.y < to.y ? 0 : to.h);
      const mid = (y1 + y2) / 2;
      d = `M${x1},${y1}C${x1},${mid} ${x2},${mid} ${x2},${y2}`;
    }
    return `<path class="edge ${edge.type}" d="${d}" ${edge.type === 'ref' || edge.type === 'cause' ? `marker-end="url(#arrow-${edge.type})"` : ''}><title>${esc(`${edge.from} → ${edge.to} · ${edge.type}`)}</title></path>`;
  });
  $('#edge-lines').innerHTML = paths.join('');
  svg.setAttribute('viewBox', `0 0 ${scene.offsetWidth} ${scene.offsetHeight}`);
}

function refsHTML(refs) {
  return arr(refs).length ? `<div class="ref-list">${refs.map((id) => nodeById(id) ? `<button class="ref-button" data-locate="${esc(id)}">${esc(id)}</button>` : `<span class="badge">${esc(id)}</span>`).join('')}</div>` : '<span class="muted">无</span>';
}

function fieldsHTML(fields) {
  return `<dl class="detail-list">${fields.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value ?? '—')}</dd></div>`).join('')}</dl>`;
}

function renderInspector() {
  document.querySelectorAll('[data-tab]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
  $('.node-search').style.display = tab === 'node' ? '' : 'none';
  let html;
  if (tab === 'rules') html = rulesHTML();
  else if (tab === 'event') {
    const record = currentRecord();
    html = record ? `<div class="inspector-node-title"><h3>STEP ${esc(record.step)}</h3></div><p class="inspector-subtitle">${esc(record.message || labelKind(record.kind))}</p>${fieldsHTML([['任务', record.taskId], ['目标 Q', record.target], ['队列', record.queue], ['帧 / 批次', [record.frameId, record.batchId].filter(Boolean).join(' / ')], ['q 变化', `${record.before ?? '—'} → ${record.after ?? '—'}`]])}<div class="detail-heading">实际执行 EX</div><pre class="code-block">${esc(record.ex)}</pre><div class="detail-heading">本任务读入</div><pre class="code-block">${esc(json(record.reads ?? {}))}</pre><div class="detail-heading">原子写入 / 工厂操作</div><pre class="code-block">${esc(json({ writes: record.writes, operations: record.operations }))}</pre><div class="detail-heading">发布与后继</div><pre class="code-block">${esc(json(record.events ?? []))}</pre><p class="detail-note">本条记录对应一个已完成任务。视觉移动不拆分 EX，也不额外执行动作。</p>` : '<div class="inspector-empty"><div class="empty-symbol">↦</div><h3>等待第一步</h3><p>提交输入后单步执行，即可检查该任务使用的参数、q 变化、发布和事务操作。</p></div>';
  } else if (selectedTask) {
    const task = allTasks().find((item) => item.id === selectedTask);
    html = task ? `<div class="inspector-node-title"><h3>${esc(task.id)}</h3></div><p class="inspector-subtitle">待执行节点任务 · ${esc(labelKind(task.kind))}</p>${fieldsHTML([['目标 Q', task.target], ['归属队列', task.queue], ['帧 / 批次', [task.frameId, task.batchId].filter(Boolean).join(' / ')], ['目标世代', task.generation], ['EX 版本', task.version]])}<div class="detail-heading">目标节点</div>${refsHTML([task.target])}<div class="detail-heading">触发原因 cause</div><pre class="code-block">${esc(json(task.cause))}</pre><div class="detail-heading">独立任务参数</div><pre class="code-block">${esc(json(task.payload ?? task.parameters ?? task))}</pre><p class="detail-note">卡片是任务，不是节点副本。后续输入不会改写这个任务已经锁存的参数。</p>` : '<div class="inspector-empty"><h3>任务已完成</h3><p>可以在“本步”或执行时间线检查执行结果。</p></div>';
  } else {
    const node = currentNode();
    html = node ? `<div class="inspector-node-title"><h3>${esc(node.id)}</h3><span class="large-bit">${esc(node.q)}</span></div><p class="inspector-subtitle">${esc(node.label || node.role)}</p>${fieldsHTML([['节点类型', `${node.stateful ? '有状态' : '无状态'} · ${labelKind(node.role || node.type || 'JK')}`], ['状态声明', node.stateful ? `initial_q = ${node.initial_q}` : '每次 EX 从 J0 起算'], ['任务归属', node.queue], ['当前状态', ({completed:'本步完成',queued:'有待执行任务',idle:'空闲'})[node.status] || node.status || '就绪'], ['引用环', node.scc ? `SCC ${node.scc} · 监督未实现` : '不在多节点环内'], ['待执行任务', node.pending ?? 0], ['世代 / 版本', `${node.generation ?? 0} / ${node.version ?? 0}`], ['所属帧', node.frameId], ['所属槽', node.slotId], ['输出绑定', node.output]])}<div class="detail-heading">扁平 EX <span>J = AND · K = XOR</span></div><pre class="code-block">${esc(node.ex)}</pre><div class="detail-heading">传播过滤 pro</div><pre class="code-block">${esc(node.pro)}</pre><div class="detail-heading">EX 来源 <span>${arr(node.refs).length} 项</span></div>${refsHTML(node.refs)}<div class="detail-heading">被引用 / q_y</div>${refsHTML(node.referencedBy)}<div class="detail-heading">规则依据</div><p class="muted">${esc(json(node.source || '参见规则面板中的条款与本次确认。'))}</p><div class="detail-heading">该节点待执行任务</div>${allTasks().some((task) => task.target === node.id) ? allTasks().filter((task) => task.target === node.id).map((task) => `<button class="ref-button" data-task="${esc(task.id)}">${esc(task.id)} · ${esc(labelKind(task.kind))}</button>`).join(' ') : '<span class="muted">无</span>'}<p class="detail-note">EX 引用参与真实求值。触发原因、工厂管理与成员关系不计入 EX 引用数量。</p>` : '<div class="inspector-empty"><div class="empty-symbol">⌖</div><h3>从一个节点开始</h3><p>点击图中的 Q，查看它的状态、EX、引用、任务归属和规则来源。</p><p>点击队列卡片可检查尚未执行的独立载荷。勾选“跟随执行”可逐步定位实际目标。</p></div>';
  }
  $('#inspector').innerHTML = html;
}

function rulesHTML() {
  const rules = [
    ['01 · 队列与完整单步', '目标是工厂成员的全部节点任务进入 RAM.FIFO，包括输出及环内成员。单步完成整个 EX / RAM 事务，随后重新选择最小优先值队首。', 'E24–E29、E63；后续纠正', 'engine.mjs：_queueFor / step', '验证：Xi 抢先、RAM 输出归属、任务内不可插入'],
    ['02 · 输入与保存', 'W = 1–8，只复制实际 W 个数据通道。每帧独立参数接力，落入 JK q 后释放输入载荷；FRAME_IN=0 只清未提交暂态。', 'E04、E20–E23；input-*、storage-data', 'engine.mjs：submitFrame / _store', '验证：重复 bit、混合宽度、连续输入、清暂态'],
    ['03 · 输出与 ACK 有效期', 'W 个 Yi 后发布 FRAME_OUT；此时才建立当前队首对应的保留数据与有效 q。有效前两种 ACK 均忽略；ACK0 复用保留 Q，ACK1 消费并立即撤销有效状态。', '本次授权选择；细化 E23、E33、E63', 'engine.mjs：_completeOutput / _ackAction', '验证：提前 ACK、重发与消费交错、旧完成不可激活已消费帧'],
    ['04 · 真实节点和独立锁存', '读出、选择与输出节点各自排队执行。输出准备串行化；输出任务入队时锁存自己的参数，后续中转覆盖不改写旧批次。', 'E29；output-latch、output-detach；本次确认', 'engine.mjs：_startPreparation / _selected / _lockOutput', '验证：真实 EX、数据位序、首发 1 / 重发 0'],
    ['05 · 动态容量与引用闭合', '满 8 次接纳、全部消费且无依赖后，块才可复用。部分使用空块继续剩余槽；动态节点不采用被引用数量豁免，安全释放后复用递增世代。', 'storage-*、transaction-generation；本次确认', 'engine.mjs：_store / _collectGarbage / validate', '验证：超过 8 帧、部分块不回收、依赖保护及世代'],
  ];
  return `<p class="detail-note" style="margin-top:0">这是获授权的设计实验，不是现行 JKRD。下列说明将来源、预期行为、实现位置和验证场景对应展示。</p>${rules.map(([title, text, source, impl, verification]) => `<article class="rule-card"><h3>${title}</h3><p>${text}</p><p class="rule-source">${esc(source)}</p><p>${impl}</p><p>${verification}</p></article>`).join('')}<article class="rule-card boundary"><h3>尚未实现 · 环监督</h3><p>引用环不因 pro 过滤消失。执行预算、监督等待区及恢复协议仅保留设计说明；页面不模拟已实现。</p><span class="rule-source">E08、E65、E67 · ring-*</span></article><article class="rule-card boundary"><h3>尚未实现 · 失败重试与完整快照</h3><p>不提供事务失败注入、失败任务重试或运行现场导入导出。静态节点表不等于可继续运行的快照；重置也不是恢复。</p><span class="rule-source">transaction-failure · snapshot-*</span></article><p><a href="./engine.test.mjs" target="_blank" rel="noopener">查看定向验证脚本 ↗</a></p><a href="../../docs/logic_units/async-structural-storage-draft.md" target="_blank" rel="noopener">打开设计草稿及来源条款 ↗</a>`;
}

function renderLogs() {
  const completed = arr(state.completed);
  const history = arr(state.history);
  const doneIds = new Set(completed.map((item) => item.batchId));
  const partial = arr(state.outputs).filter((output) => !doneIds.has(output.batchId));
  const partialGroups = new Map();
  partial.forEach((item) => {
    if (!partialGroups.has(item.batchId)) partialGroups.set(item.batchId, []);
    partialGroups.get(item.batchId).push(item);
  });
  const partialHTML = [...partialGroups.values()].reverse().map((items) => `<div class="partial-output"><span>${esc(items[0]?.frameId)} · 已发布</span><code>${items.filter((item) => !item.isMarker).map((item) => esc(item.value)).join('')}</code><span>等待 FRAME_OUT</span></div>`).join('');
  $('#output-log').innerHTML = partialHTML + (completed.length ? [...completed].reverse().slice(0, 50).map((batch) => `<div class="output-batch"><span class="output-kind ${batch.kind === 'replay' ? 'replay' : ''}">${esc(labelKind(batch.kind))}</span><span class="output-frame">${esc(batch.frameId)}</span><span class="output-bits">${esc(Array.isArray(batch.bits) ? batch.bits.join('') : batch.bits)}</span><span class="output-marker">FRAME_OUT <strong>${esc(batch.marker)}</strong></span><span class="output-step">#${esc(batch.step)}</span></div>`).join('') : partialHTML ? '' : '<div class="empty-log">这里记录真实输出节点发布的 Yi。<br>数据位全部完成后，才显示该批次 FRAME_OUT 和 ACK 有效状态。</div>');
  $('#history-count').textContent = history.length ? `${state.step ?? history.length} 步 · 最近 ${Math.min(history.length, 80)} 条` : '尚未执行';
  $('#timeline').innerHTML = history.length ? [...history].reverse().slice(0, 80).map((record) => `<button class="timeline-row ${record.step === selectedStep ? 'selected' : ''}" data-step="${esc(record.step)}"><span class="timeline-step">#${esc(record.step)}</span><span class="timeline-body"><span class="timeline-top"><span class="timeline-target">${esc(record.target)}</span><span class="timeline-kind">${esc(record.queue)} · ${esc(labelKind(record.kind))}</span></span><span class="timeline-message">${esc(record.message || [record.frameId, record.batchId].filter(Boolean).join(' · '))}</span></span><span class="timeline-value">${esc(record.before ?? '·')} → ${esc(record.after ?? '·')}</span></button>`).join('') : '<div class="empty-log">输入到达、任务入队和节点执行各有归属。<br>单步后查看每次实际求值与工厂事务。</div>';
}

function render() {
  state = sim.view();
  const stats = state.stats || {};
  const metrics = [['存储帧', stats.liveFrames ?? arr(state.frames).length, '▤'], ['结构块', stats.blocks ?? arr(state.blocks).length, '▣'], ['真实节点', stats.nodes ?? arr(state.nodes).length, '◇'], ['待执行任务', stats.pending ?? allTasks().length, '↦'], ['完整递交', stats.delivered ?? arr(state.completed).length, '↗'], ['重发批次', stats.replays ?? arr(state.completed).filter((item) => item.kind === 'replay').length, '↻']];
  $('#metrics').innerHTML = metrics.map(([title, value, icon]) => `<div class="metric"><strong>${esc(value)}</strong><span>${title}</span><span class="metric-icon" aria-hidden="true">${icon}</span></div>`).join('');
  $('#step-label').textContent = `STEP ${state.step ?? 0}`;
  const valid = state.ready?.q === 1;
  $('#ack-state').textContent = valid ? `${state.ready?.frameId || '队首'} 已完整递交` : '等待完整递交';
  $('#ack-state').classList.toggle('ready', valid);
  $('#run-state').textContent = running ? '运行中' : allTasks().length ? '已暂停' : '等待任务';
  $('#run-state').classList.toggle('running', running);
  $('#run-button').textContent = running ? 'Ⅱ 暂停' : '▶ 连续运行';
  renderScene();
  renderInspector();
  renderLogs();
  animatingStep = null;
}

function locate(id, scroll = true) {
  const node = nodeById(id);
  if (!node) return false;
  selectedNode = id; selectedTask = null; tab = 'node';
  closed.delete(displayGroup(node)); closed.delete('async'); closed.delete('storage');
  if (node.blockId) closed.delete(`block-${node.blockId}`);
  if (node.slotId) closed.delete(`slot-${node.slotId}`);
  renderScene(); renderInspector();
  if (scroll && !layout.busy) requestAnimationFrame(() => {
    if (!layout.busy) $('#diagram-scene').querySelector(`[data-node="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  });
  return true;
}

function stepOnce() {
  try {
    const record = sim.step();
    if (!record) { pause(); message('所有执行队列为空，等待新的输入或 ACK。'); render(); return false; }
    selectedStep = null;
    animatingStep = record.step;
    if ($('#follow-task').checked) { selectedNode = record.target; selectedTask = null; tab = 'node'; }
    render();
    if ($('#follow-task').checked) locate(record.target);
    message(`#${record.step} · ${record.queue} · ${record.target} · ${record.message || labelKind(record.kind)}`);
    return true;
  } catch (error) {
    pause(); message(`执行停止：${error.message}。失败重试协议尚未实现，请检查本步与任务。`, true); render(); return false;
  }
}

function pause() { running = false; clearTimeout(timer); timer = null; }
function tick() {
  if (!running) return;
  if (stepOnce() && running) timer = setTimeout(tick, 1000 / Number($('#speed').value));
}
function normalizedInput() { return $('#frame-input').value.replace(/[\s,，]/g, ''); }

$('#input-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const bits = normalizedInput();
    const frame = sim.submitFrame(bits);
    render();
    message(`已提交 ${bits.length} bit 帧 ${typeof frame === 'string' ? frame : frame?.id || ''}：${bits}。可继续提交，独立任务参数已锁存。`);
  } catch (error) { message(error.message, true); }
});

$('#frame-input').addEventListener('input', () => {
  const bits = normalizedInput();
  $('#width-label').textContent = `${bits.length} bit`;
  if (bits === '' || /^[01]{1,8}$/.test(bits)) { try { sim.stage(bits); } catch (error) { message(error.message, true); } }
});

document.addEventListener('click', (event) => {
  const node = event.target.closest('[data-node]');
  if (node) { locate(node.dataset.node, false); return; }
  const located = event.target.closest('[data-locate]');
  if (located) { locate(located.dataset.locate); return; }
  const task = event.target.closest('[data-task]');
  if (task) { selectedTask = task.dataset.task; selectedNode = null; tab = 'node'; renderInspector(); scheduleEdges(); return; }
  const step = event.target.closest('[data-step]');
  if (step) { selectedStep = Number(step.dataset.step); tab = 'event'; renderInspector(); renderLogs(); scheduleEdges(); return; }
  const tabButton = event.target.closest('[data-tab]');
  if (tabButton) { tab = tabButton.dataset.tab; renderInspector(); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  try {
    if (action === 'step') { pause(); stepOnce(); }
    if (action === 'run') { if (running) pause(); else { running = true; tick(); } render(); }
    if (action === 'ack0' || action === 'ack1') { const value = action === 'ack0' ? 0 : 1; sim.ack(value); render(); message(`ACK ${value} 已独立锁存。译码节点执行时按队首和有效 q 决定动作。`); }
    if (action === 'clear') { sim.clearInput(); $('#frame-input').value = ''; $('#width-label').textContent = '0 bit'; render(); message('FRAME_IN = 0：已清除未提交输入暂态，已锁存任务和存储帧保持有效。'); }
    if (action === 'reset' && window.confirm('重置当前实验？这会清除输入、全部任务、存储帧及执行记录。')) { pause(); sim.reset(); selectedNode = null; selectedTask = null; selectedStep = null; closed.clear(); render(); message('已重置。等待新的输入。'); }
    if (action === 'show-rules') { tab = 'rules'; renderInspector(); $('.inspector-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    if (action.startsWith('zoom-')) { zoom = action === 'zoom-reset' ? 1 : Math.max(.35, Math.min(1.6, Math.round((zoom + (action === 'zoom-in' ? .1 : -.1)) * 100) / 100)); resizeScene(); }
    if (action === 'find-node') {
      const query = $('#node-search').value.trim().toLowerCase();
      if (!query) return;
      const match = arr(state.nodes).find((item) => item.id.toLowerCase() === query) || arr(state.nodes).find((item) => `${item.id} ${item.label} ${item.role}`.toLowerCase().includes(query));
      if (match) { locate(match.id); message(`已定位 ${match.id} · ${match.label}`); } else message(`没有找到“${$('#node-search').value}”对应的活动节点。`, true);
    }
  } catch (error) { message(error.message, true); }
});

$('#node-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('[data-action="find-node"]').click(); });
$('#speed').addEventListener('input', () => { $('#speed-label').textContent = `${$('#speed').value} 步/秒`; });
document.querySelectorAll('.edge-toolbar input').forEach((input) => input.addEventListener('change', scheduleEdges));
$('#diagram-scene').addEventListener('toggle', (event) => {
  const key = event.target.dataset.collapse;
  if (!key) return;
  if (event.target.open) closed.delete(key); else closed.add(key);
  resizeScene();
}, true);
window.addEventListener('resize', resizeScene);
window.addEventListener('beforeunload', () => pause());
render();

// Display a useful local-run hint if the page is opened with file:// where module
// loading may be restricted. This module itself never sends data off-device.
if (location.protocol === 'file:') message('若浏览器阻止本地模块，请在项目根目录运行 python3 -m http.server 8000，再访问 localhost:8000/web/async-structural-storage/。');

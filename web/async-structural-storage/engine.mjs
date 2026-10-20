/** Local experimental execution model; not a JKRD/V5 interchange implementation.
 * Sources and intentional refinements: async-structural-storage-draft.md section 5.
 * Every scheduler entry evaluates one actual flat EX. Factory effects are bound
 * to that entry; suppressed propagation is never presented as a Q publication.
 */
export const QUEUE_PRIORITIES = Object.freeze({ 'Xi.FIFO': 1, 'RAM.FIFO': 2, 'DAG.FIFO': 3, 'Qi.FIFO': 5 });
const clone = value => structuredClone(value);
const number = id => Number(id.slice(1));
const OR = (a, b) => `J0K(${a})J(${b})K(${a})K(${b})`;
export function sources(ex) { return [...new Set([...ex.matchAll(/\((Q\d+)\)/g)].map(m => m[1]))]; }
export function evaluateEX(ex, initial, read) {
  const tokens = [...ex.matchAll(/([JK])(?:([01])|\(([QX]\d+)\))/g)];
  if (!tokens.length || tokens.map(t => t[0]).join('') !== ex) throw new Error(`非法 EX: ${ex}`);
  let q = initial;
  const reads = [];
  for (const [, op, literal, ref] of tokens) {
    const value = ref ? read(ref) : Number(literal);
    if (value !== 0 && value !== 1) throw new Error(`${ref || literal} 不是 bit`);
    if (ref) reads.push({ source: ref, value });
    q = op === 'J' ? q & value : q ^ value;
  }
  return { q, reads };
}

export class StorageSimulator {
  constructor() { this.reset(); }
  reset() {
    this.s = { nodes: new Map(), queues: Object.fromEntries(Object.keys(QUEUE_PRIORITIES).map(k => [k, []])),
      blocks: [], frames: [], inputs: new Map(), requests: [], activeRequest: null, batches: new Map(),
      staging: [], cacheOwner: null, cacheWidth: 0, step: 0, nextNode: 0, nextTask: 1,
      nextFrame: 1, nextRequest: 1, nextBatch: 1, nextInput: 1, lastTarget: null };
    this.history = []; this.outputs = []; this.completed = []; this.error = null; this.record = null;
    this.inputIds = Array.from({ length: 10 }, (_, i) => this._node({ label: i < 8 ? `输入 ${i}` : i === 8 ? 'FRAME_IN' : 'ACK 输入',
      role: i < 8 ? 'input' : i === 8 ? 'frame-in' : 'ack-input', group: 'input', inputIndex: i,
      ex: `J0K(X${i})`, member: false, source: 'E04 / input-copy' }));
    this.handoff = [];
    for (let width = 1; width <= 8; width++) {
      const store = this._node({ label: `S${width} · 帧接力`, group: 'handoff', role: 'store', width, source: '本次确认 / input-handoff' });
      const check = this._node({ label: `C${width} · 奇偶校验`, group: 'handoff', role: 'checksum', width, source: '本次确认 / S-C 连续任务' });
      this._rawEX(store, `J0${this.inputIds.slice(0, width).map(id => `K(${id})`).join('')}K(${check})J(${this.inputIds[8]})`);
      this._rawEX(check, `K(${store})`);
      this.handoff.push({ store, check });
    }
    this.cache = this._retention(Array(8).fill(0), { group: 'cache', role: 'cache-data', label: 'H · ACK 数据', source: '本次确认 / FRAME_OUT 后保留' });
    this.flags = this._retention([0, 0], { group: 'control', role: 'control', label: '控制', source: 'E27 / 控制 q' });
    [this.busyId, this.cacheValidId] = this.flags.data;
    this.s.nodes.get(this.busyId).label = 'PREP_BUSY';
    this.s.nodes.get(this.cacheValidId).label = 'CACHE_VALID';
    this.readyId = this._node({ label: 'ACK_READY', group: 'ack', role: 'ack-ready', source: '本次确认 / FRAME_OUT 资格门' });
    this.modeId = this._node({ label: 'FIRST_KIND', group: 'control', role: 'output-kind', q: 1, source: 'output-marker' });
    this.ack0Id = this._node({ label: 'ACK0 · 重发', group: 'ack', role: 'ack0', ex: `J0K1K(${this.inputIds[9]})J(${this.readyId})`, source: 'ack-decode / 本次资格门' });
    this.ack1Id = this._node({ label: 'ACK1 · 消费', group: 'ack', role: 'ack1', ex: `J0K(${this.inputIds[9]})J(${this.readyId})`, source: 'ack-decode / 本次资格门' });
    this._rawEX(this.readyId, `J0K1K(${this.ack1Id})J(${this.readyId})`);
    this._rawEX(this.modeId, `J0K1K(${this.ack0Id})`);
    this.relayIds = this.cache.data.map((h, bitIndex) => this._node({ label: `R${bitIndex} · 中转`, group: 'relay', role: 'relay', bitIndex, ex: `J0K(${h})`, source: '本次确认 / 固定中转' }));
    this.markerRelayId = this._node({ label: 'R_FRAME', group: 'relay', role: 'marker-relay', ex: `J0K(${this.modeId})`, source: 'output-marker' });
    this.outputIds = this.relayIds.map((r, bitIndex) => this._node({ label: `O${bitIndex} → Y${bitIndex}`, group: 'output', role: 'output', bitIndex,
      ex: `J0K(${r})`, pro: 'q=0/1', output: `Y${bitIndex}`, source: 'E23 / E29 / output-latch' }));
    this.frameOutId = this._node({ label: 'FRAME_OUT → Y8', group: 'output', role: 'frame-out', ex: `J0K(${this.markerRelayId})`, pro: 'q=0/1', output: 'Y8', source: 'E33 / 本次 FRAME_OUT 资格门' });
    this._assertValid();
  }
  _node(options = {}) {
    const id = `Q${this.s.nextNode++}`;
    const node = { id, label: id, type: '有状态', stateful: true, initial_q: options.q ?? 0, q: options.q ?? 0,
      ex: '', pro: 'q=', group: 'control', role: 'control', member: true, generation: 1, version: 1, ...options };
    this.s.nodes.set(id, node);
    if (this.record) this.record.operations.push({ type: 'create', target: id, label: node.label });
    return id;
  }
  _rawEX(id, ex) { this.s.nodes.get(id).ex = ex; }
  // A genuine retention circuit: D_i AND OR(all D) = D_i. Every D and every
  // OR intermediate has a non-self consumer, even while its slot is retired.
  _retention(values, options) {
    const data = values.map((q, bitIndex) => this._node({ ...options, label: `${options.label}[${bitIndex}]`, q, bitIndex }));
    const control = [];
    if (data.length === 1) control.push(this._node({ ...options, role: 'retention', label: `${options.label} · 保持`, ex: `J0K(${data[0]})`, q: values[0] }));
    else {
      let prior = data[0], q = values[0];
      for (let i = 1; i < data.length; i++) {
        q |= values[i];
        prior = this._node({ ...options, role: 'retention', label: `${options.label} · OR${i}`, ex: OR(prior, data[i]), q });
        control.push(prior);
      }
    }
    for (const id of data) this._rawEX(id, `J(${control.at(-1)})`);
    return { data, control };
  }
  _write(id, value, reason = 'factory') {
    const node = this.s.nodes.get(id);
    if (!node || (value !== 0 && value !== 1)) throw new Error(`非法 q 写入 ${id}`);
    const before = node.q; node.q = value;
    if (this.record) this.record.writes.push({ target: id, before, after: value, reason });
  }
  _writeRetention(group, values) {
    values.forEach((value, i) => this._write(group.data[i], value));
    let q = values[0];
    group.control.forEach((id, i) => { if (values.length > 1) q |= values[i + 1]; this._write(id, q, 'factory-control'); });
  }
  _flag(id, value) {
    this._write(id, value);
    if (this.flags.data.includes(id)) this._writeRetention(this.flags, this.flags.data.map(q => this.s.nodes.get(q).q));
  }
  _q(id) { return this.s.nodes.get(id).q; }
  _queueFor(node) {
    if (node.inputIndex !== undefined) return 'Xi.FIFO';
    if (node.member) return 'RAM.FIFO';
    return node.scc ? 'DAG.FIFO' : 'Qi.FIFO';
  }
  _enqueue(target, kind, extra = {}) {
    const node = this.s.nodes.get(target);
    if (!node) throw new Error(`入队目标不存在 ${target}`);
    const queue = this._queueFor(node);
    const task = { id: `T${this.s.nextTask++}`, target, queue, kind, generation: node.generation, targetGeneration: node.generation,
      version: node.version, exVersion: node.version, cause: this.record?.taskId ?? 'external',
      sourceGenerations: Object.fromEntries(sources(node.ex).map(id => [id, this.s.nodes.get(id)?.generation])), ...extra };
    this.s.queues[queue].push(task);
    if (this.record) this.record.events.push({ type: 'enqueue', taskId: task.id, target, queue, cause: task.cause });
    return task;
  }
  _bits(input) {
    let bits;
    if (typeof input === 'string') {
      if (!/^[01]{1,8}$/.test(input.trim())) throw new Error('输入必须为 1–8 个 0 或 1。');
      bits = [...input.trim()].map(Number);
    } else bits = Array.isArray(input) ? [...input] : [];
    if (bits.length < 1 || bits.length > 8 || bits.some(x => x !== 0 && x !== 1)) throw new Error('输入必须为 1–8 个 0 或 1。');
    return bits;
  }
  stage(input) { this.s.staging = input === '' ? [] : this._bits(input); }
  clearInput() { this.s.staging = []; return this._enqueue(this.inputIds[8], 'frame-clear', { latched: { X8: 0 } }).id; }
  submitFrame(input = this.s.staging) {
    const bits = this._bits(input), id = `F${this.s.nextFrame++}`;
    const batch = { id, width: bits.length, payload: bits, copied: {}, inputSeq: this.s.nextInput++ };
    this.s.inputs.set(id, batch);
    bits.forEach((bit, i) => this._enqueue(this.inputIds[i], 'input-copy', { frameId: id, bitIndex: i, latched: { [`X${i}`]: bit } }));
    this._enqueue(this.inputIds[8], 'frame-in', { frameId: id, latched: { X8: 1 } });
    this.s.staging = [];
    return id;
  }
  ack(bit) {
    if (bit !== 0 && bit !== 1) throw new Error('ACK 必须为 0 或 1。');
    return this._enqueue(this.inputIds[9], 'ack-input', { ack: bit, latched: { X9: bit } }).id;
  }
  reconfigureNode(id, ex) {
    const node = this.s.nodes.get(id);
    if (!node) throw new Error('节点不存在');
    if (node.output || node.inputIndex !== undefined) throw new Error('固定输入/输出 EX 不可重配置');
    const pending = Object.values(this.s.queues).flat().some(t => t.target === id ||
      (sources(this.s.nodes.get(t.target).ex).includes(id) && !Object.hasOwn(t.latched ?? {}, id)));
    if (pending || this.record?.target === id) throw new Error(`${id} 存在 pending 任务，禁止重配置`);
    evaluateEX(ex, node.q, ref => this.s.nodes.get(ref)?.q);
    const priorEX = node.ex, priorVersion = node.version;
    node.ex = ex; node.version++;
    if (!this.record) {
      try { this._assertValid(); }
      catch (error) { node.ex = priorEX; node.version = priorVersion; throw error; }
    }
    if (this.record) this.record.operations.push({ type: 'rewire', target: id, ex, version: node.version });
  }
  _deleteNodes(ids) {
    const set = new Set(ids);
    for (const task of Object.values(this.s.queues).flat()) {
      if (set.has(task.target) || sources(this.s.nodes.get(task.target).ex).some(id => set.has(id) && !Object.hasOwn(task.latched ?? {}, id))) throw new Error('删除仍有任务依赖的节点');
    }
    for (const node of this.s.nodes.values()) if (!set.has(node.id) && sources(node.ex).some(id => set.has(id))) throw new Error('删除仍被引用的节点');
    for (const id of set) {
      this.s.nodes.delete(id);
      this.record?.operations.push({ type: 'delete', target: id });
    }
  }
  step() {
    if (this.error) throw new Error(this.error);
    const queue = Object.keys(QUEUE_PRIORITIES).find(key => this.s.queues[key].length);
    if (!queue) return null;
    const beforeState = clone(this.s), outputLength = this.outputs.length, completedLength = this.completed.length;
    try {
      const task = this.s.queues[queue].shift(), node = this.s.nodes.get(task.target);
      if (!node || node.generation !== task.generation || node.version !== task.version) throw new Error('任务目标世代或 EX 版本已失效');
      this.s.step++;
      this.record = { step: this.s.step, taskId: task.id, target: node.id, queue, kind: task.kind, frameId: task.frameId,
        batchId: task.batchId, ex: node.ex, before: node.q, executed: true, reads: [], writes: [], events: [], operations: [], message: '',
        payload: clone(task.framePayload ?? task.latched ?? {}), generation: node.generation, version: node.version };
      const result = evaluateEX(node.ex, node.stateful ? node.q : 0, ref => {
        if (Object.hasOwn(task.latched ?? {}, ref)) return task.latched[ref];
        const source = this.s.nodes.get(ref);
        if (!source || source.generation !== task.sourceGenerations[ref]) throw new Error(`来源世代已失效 ${ref}`);
        return source.q;
      });
      this.record.reads = result.reads.map(read => ({ ...read, locked: Object.hasOwn(task.latched ?? {}, read.source) }));
      this._write(node.id, result.q, 'EX');
      this.record.after = result.q;
      node.lastTask = task.id; node.lastBatch = task.batchId ?? null;
      this._act(task, node);
      // Yi is only emitted by this actual output node's completed EX/pro/q_y.
      if (node.output && this._publishes(node)) {
        const event = { step: this.s.step, taskId: task.id, nodeId: node.id, sourceQ: node.id, yi: node.output, value: node.q, bit: node.q,
          batchId: task.batchId, frameId: task.frameId, kind: task.outputKind, bitIndex: task.bitIndex, isMarker: node.id === this.frameOutId };
        this.outputs.push(event); this.record.events.push({ type: 'publish', ...event });
      }
      if (task.kind === 'frame-out') this._completeOutput(task);
      if (queue === 'RAM.FIFO') this._collectGarbage();
      this._assertValid();
      this.s.lastTarget = node.id;
      const record = this.record;
      if (!record.message) record.message = `${node.label}：${record.before} → ${record.after}`;
      this.history.push(record);
      this.record = null;
      return clone(record);
    } catch (error) {
      this.s = beforeState; this.outputs.length = outputLength; this.completed.length = completedLength;
      this.record = null; this.error = `执行停止，当前任务及状态保留：${error.message}`;
      throw new Error(this.error);
    }
  }
  _publishes(node) { return node.pro === 'q=0/1' || node.pro === `q=${node.q}`; }
  _act(task, node) {
    switch (task.kind) {
      case 'input-copy': this.s.inputs.get(task.frameId).copied[node.id] = node.q; break;
      case 'frame-in': {
        const batch = this.s.inputs.get(task.frameId), { store, check } = this.handoff[batch.width - 1];
        if (Object.keys(batch.copied).length !== batch.width) throw new Error('整帧复制未完成');
        const latched = { ...batch.copied, [this.inputIds[8]]: node.q };
        this._enqueue(store, 'store', { frameId: batch.id, width: batch.width, framePayload: [...batch.payload], latched });
        this._enqueue(check, 'checksum', { frameId: batch.id, width: batch.width });
        this.s.inputs.delete(batch.id);
        this.record.message = `${batch.id} 的 ${batch.width} 位复制完成；连续移交 S / C 两项 RAM 任务`;
        break;
      }
      case 'frame-clear': this.record.message = 'FRAME_IN=0；只清输入暂态，已提交任务不受影响'; break;
      case 'store': this._store(task); break;
      case 'ack-input':
        this._enqueue(this.ack0Id, 'ack0', { ack: node.q, latched: { [node.id]: node.q } });
        this._enqueue(this.ack1Id, 'ack1', { ack: node.q, latched: { [node.id]: node.q } });
        break;
      case 'ack0': case 'ack1': this._ackAction(task, node); break;
      case 'select': this._selected(task, node); break;
      case 'read': break;
      case 'read-marker': this._lockOutput(task); break;
      case 'output': case 'frame-out': case 'checksum': break;
      default: throw new Error(`未知节点任务 ${task.kind}`);
    }
  }
  _store(task) {
    let block = this.s.blocks.find(b => b.status === 'active' && b.used < 8);
    if (!block) {
      block = this.s.blocks.find(b => b.status === 'pool');
      if (block) { block.generation++; block.used = 0; block.slots = []; block.status = 'active'; this.record.operations.push({ type: 'reuse-block', blockId: block.id, generation: block.generation }); }
      else {
        const i = this.s.blocks.length;
        block = { id: `B${i + 1}`, label: i < 26 ? String.fromCharCode(65 + i) : `B${i + 1}`, generation: 1, used: 0, status: 'active', slots: [] };
        this.s.blocks.push(block); this.record.operations.push({ type: 'grow-block', blockId: block.id });
      }
    }
    const slotId = `${block.id}.${block.used + 1}`, common = { group: 'storage', blockId: block.id, slotId, frameId: task.frameId, generation: block.generation, source: 'storage-data / E27' };
    const data = this._retention(task.framePayload, { ...common, role: 'data', label: `${task.frameId} · D` });
    const valid = this._retention([1], { ...common, role: 'slot-valid', label: `${task.frameId} · 活帧` });
    const slot = { id: slotId, frameId: task.frameId, width: task.width, data, valid, nodeIds: data.data, controlIds: [...data.control, ...valid.data, ...valid.control] };
    block.slots.push(slot); block.used++;
    const wasEmpty = this.s.frames.length === 0;
    this.s.frames.push({ id: task.frameId, width: task.width, blockId: block.id, slotId });
    this.record.message = `${task.frameId} 写入 ${block.label} 块槽 ${block.used}；${task.width} 个数据 Q`;
    if (wasEmpty) this._request('first', this.s.frames[0]);
  }
  _slot(frame) { return this.s.blocks.find(b => b.id === frame.blockId)?.slots.find(s => s.id === frame.slotId); }
  _ackAction(task, node) {
    const expected = task.kind === 'ack0' ? 0 : 1;
    if (task.ack !== expected) { this.record.message = `ACK${expected} 译码不匹配：无业务动作`; return; }
    const head = this.s.frames[0];
    if (!head || !node.q || !this._q(this.readyId) || this.s.cacheOwner !== head.id) {
      this.record.message = `ACK${expected} 忽略：当前队首尚无 FRAME_OUT 完成后的有效载荷`;
      this.record.events.push({ type: 'ack-ignored', ack: expected, frameId: head?.id ?? null }); return;
    }
    this.record.frameId = head.id;
    if (expected === 0) {
      this._request('replay', head);
      this.record.message = `ACK0：为 ${head.id} 登记重发，来源为独立 H 缓存`;
    } else {
      const slot = this._slot(head);
      this._writeRetention(slot.valid, [0]);
      this.s.frames.shift(); this._flag(this.readyId, 0);
      this.record.events.push({ type: 'consume', frameId: head.id });
      this.record.message = `ACK1：消费 ${head.id}，立即撤销 ACK 资格`;
      if (this.s.frames.length) this._request('first', this.s.frames[0]);
    }
  }
  _request(kind, frame) {
    this.s.requests.push({ id: `P${this.s.nextRequest++}`, frameId: frame.id, kind, width: frame.width, blockId: frame.blockId, slotId: frame.slotId,
      cause: this.record.taskId, status: 'waiting' });
    this._startPreparation();
  }
  _startPreparation() {
    if (this._q(this.busyId) || !this.s.requests.length) return;
    const req = this.s.requests.shift();
    if (req.kind === 'replay' && this.s.cacheOwner !== req.frameId) throw new Error('重发缓存身份丢失');
    this._flag(this.busyId, 1); this._flag(this.modeId, req.kind === 'first' ? 1 : 0);
    const slot = this._slot(req), valid = req.kind === 'first' ? slot.valid.data[0] : this.cacheValidId;
    req.sourceIds = req.kind === 'first' ? [...slot.data.data] : this.cache.data.slice(0, req.width);
    req.selector = this._node({ label: `${req.id} · ${req.frameId} 选择`, role: 'selector', group: 'readout', frameId: req.frameId,
      ex: `J0K(${valid})J(${this.busyId})`, source: '本次确认 / 逐节点读出' });
    // Only idle intermediates are rewired. Output target expressions never change.
    for (let i = 0; i < req.width; i++) this.reconfigureNode(this.relayIds[i], `J0K(${req.sourceIds[i]})J(${req.selector})`);
    req.status = 'selecting'; this.s.activeRequest = req;
    this._enqueue(req.selector, 'select', { requestId: req.id, frameId: req.frameId, cause: req.cause });
  }
  _selected(task, node) {
    const req = this.s.activeRequest;
    if (req?.id !== task.requestId || node.q !== 1) throw new Error('读出选择失效');
    req.status = 'reading';
    for (let i = 0; i < req.width; i++) this._enqueue(this.relayIds[i], 'read', { requestId: req.id, frameId: req.frameId, bitIndex: i });
    this._enqueue(this.markerRelayId, 'read-marker', { requestId: req.id, frameId: req.frameId });
    this.record.message = `${req.frameId} 选择完成；${req.width} 个中转与标记分别入队`;
  }
  _lockOutput(task) {
    const req = this.s.activeRequest;
    if (req?.id !== task.requestId) throw new Error('输出准备身份不符');
    const batchId = `OUT${this.s.nextBatch++}`;
    this.s.batches.set(batchId, { id: batchId, frameId: req.frameId, kind: req.kind, width: req.width });
    for (let i = 0; i < req.width; i++) this._enqueue(this.outputIds[i], 'output', { frameId: req.frameId, batchId, outputKind: req.kind, bitIndex: i,
      latched: { [this.relayIds[i]]: this._q(this.relayIds[i]) } });
    this._enqueue(this.frameOutId, 'frame-out', { frameId: req.frameId, batchId, outputKind: req.kind,
      latched: { [this.markerRelayId]: this._q(this.markerRelayId) } });
    // Detach the completed readout before physical slot collection. No pending
    // target expression is modified; O tasks already own R's scalar values.
    for (let i = 0; i < req.width; i++) this.reconfigureNode(this.relayIds[i], `J0K(${this.cache.data[i]})`);
    this._deleteNodes([req.selector]);
    this.s.activeRequest = null; this._flag(this.busyId, 0);
    this.record.message = `${req.frameId} → ${batchId}：连续锁存 ${req.width} 个数据输出任务及 FRAME_OUT`;
    this._startPreparation();
  }
  _completeOutput(task) {
    const batch = this.s.batches.get(task.batchId);
    if (!batch) throw new Error('输出批次不存在');
    const bits = this.outputIds.slice(0, batch.width).map(id => {
      const node = this.s.nodes.get(id);
      if (node.lastBatch !== batch.id) throw new Error('FRAME_OUT 前的数据不属于同一批次');
      return node.q;
    });
    const marker = this._q(this.frameOutId);
    if (marker !== (batch.kind === 'first' ? 1 : 0)) throw new Error('FRAME_OUT 标记与批次不符');
    const stillHead = this.s.frames[0]?.id === batch.frameId;
    if (stillHead) {
      this._writeRetention(this.cache, [...bits, ...Array(8 - bits.length).fill(0)]);
      this.s.cacheOwner = batch.frameId; this.s.cacheWidth = batch.width;
      this._flag(this.cacheValidId, 1); this._flag(this.readyId, 1);
    }
    this.completed.push({ batchId: batch.id, frameId: batch.frameId, kind: batch.kind, bits, marker, step: this.s.step });
    this.s.batches.delete(batch.id);
    this.record.message = `${batch.frameId} ${batch.kind === 'first' ? '首发' : '重发'}完成，FRAME_OUT=${marker}；${stillHead ? '当前队首 ACK 有效' : '已消费帧不恢复 ACK 资格'}`;
  }
  _dependencies(slot) {
    const ids = new Set([...slot.nodeIds, ...slot.controlIds]);
    let count = 0;
    for (const req of [...this.s.requests, ...(this.s.activeRequest ? [this.s.activeRequest] : [])]) if (req.kind === 'first' && req.frameId === slot.frameId) count++;
    for (const task of Object.values(this.s.queues).flat()) if (ids.has(task.target) || sources(this.s.nodes.get(task.target).ex).some(id => ids.has(id) && !Object.hasOwn(task.latched ?? {}, id))) count++;
    return count;
  }
  _collectGarbage() {
    for (const block of this.s.blocks) {
      if (block.status !== 'active' || block.used !== 8 || block.slots.some(slot => this._q(slot.valid.data[0]) || this._dependencies(slot))) continue;
      const ids = block.slots.flatMap(slot => [...slot.nodeIds, ...slot.controlIds]);
      const set = new Set(ids);
      if ([...this.s.nodes.values()].some(n => !set.has(n.id) && sources(n.ex).some(id => set.has(id)))) continue;
      this._deleteNodes(ids); block.status = 'pool';
      // Empty pools retain block/slot history, never zero-reference dormant Q.
      block.slots.forEach(slot => { slot.retiredNodeIds = [...slot.nodeIds, ...slot.controlIds]; slot.nodeIds = []; slot.controlIds = []; });
      this.record.operations.push({ type: 'recycle-block', blockId: block.id, generation: block.generation });
    }
  }
  validate() {
    const errors = [], refs = new Map([...this.s.nodes.keys()].map(id => [id, 0]));
    for (const node of this.s.nodes.values()) {
      const incoming = sources(node.ex).filter(id => id !== node.id);
      if (node.inputIndex === undefined && !incoming.length) errors.push(`${node.id} 缺非自身来源`);
      if (node.inputIndex !== undefined && node.ex !== `J0K(X${node.inputIndex})`) errors.push(`${node.id} 输入 EX 变更`);
      for (const id of incoming) {
        if (!this.s.nodes.has(id)) errors.push(`${node.id} 悬空来源 ${id}`);
        else refs.set(id, refs.get(id) + 1);
      }
      if (node.output) refs.set(node.id, refs.get(node.id) + 1);
      try { evaluateEX(node.ex, node.q, ref => ref.startsWith('X') ? 0 : this.s.nodes.get(ref)?.q); } catch (error) { errors.push(error.message); }
    }
    for (const [id, count] of refs) if (!count) errors.push(`${id} 无非自身引用或 q_y`);
    for (const [queue, tasks] of Object.entries(this.s.queues)) for (const t of tasks) {
      const node = this.s.nodes.get(t.target);
      if (!node || this._queueFor(node) !== queue) errors.push(`${t.id} 目标/归属错误`);
      else if (t.version !== node.version || t.generation !== node.generation) errors.push(`${t.id} 版本/世代失效`);
    }
    if (this._q(this.readyId) && this.s.frames[0]?.id !== this.s.cacheOwner) errors.push('ACK 资格不属于当前队首');
    if (this._q(this.busyId) !== Number(Boolean(this.s.activeRequest))) errors.push('准备状态与控制 q 不符');
    return errors;
  }
  _assertValid() { const errors = this.validate(); if (errors.length) throw new Error(errors.join('；')); }
  _scc() {
    let next = 0; const stack = [], info = new Map(), groups = [];
    const visit = id => {
      const entry = { index: next, low: next++, stacked: true }; info.set(id, entry); stack.push(id);
      for (const ref of sources(this.s.nodes.get(id).ex).filter(ref => ref !== id)) {
        if (!info.has(ref)) { visit(ref); entry.low = Math.min(entry.low, info.get(ref).low); }
        else if (info.get(ref).stacked) entry.low = Math.min(entry.low, info.get(ref).index);
      }
      if (entry.low === entry.index) {
        const group = []; let member;
        do { member = stack.pop(); info.get(member).stacked = false; group.push(member); } while (member !== id);
        if (group.length > 1) groups.push(group);
      }
    };
    for (const id of this.s.nodes.keys()) if (!info.has(id)) visit(id);
    return groups;
  }
  view() {
    const tasks = Object.values(this.s.queues).flat(), sccs = this._scc();
    const referencedBy = new Map([...this.s.nodes.keys()].map(id => [id, []]));
    for (const n of this.s.nodes.values()) for (const ref of sources(n.ex)) if (ref !== n.id) referencedBy.get(ref)?.push(n.id);
    for (const n of this.s.nodes.values()) if (n.output) referencedBy.get(n.id).push(n.output);
    const nodes = [...this.s.nodes.values()].map(n => ({ ...n, refs: [...new Set([...n.ex.matchAll(/\(([QX]\d+)\)/g)].map(m => m[1]))], referencedBy: referencedBy.get(n.id), queue: this._queueFor(n),
      pending: tasks.filter(t => t.target === n.id).length, status: this.s.lastTarget === n.id ? 'completed' : tasks.some(t => t.target === n.id) ? 'queued' : 'idle',
      scc: sccs.findIndex(g => g.includes(n.id)) + 1 }));
    return clone({ step: this.s.step, nodes, queues: this.s.queues, error: this.error,
      blocks: this.s.blocks.map(b => ({ ...b, slots: b.slots.map(slot => ({ ...slot, consumed: b.status === 'pool' || !this._q(slot.valid.data[0]), dependencies: b.status === 'pool' ? 0 : this._dependencies(slot) })) })),
      frames: this.s.frames, requests: this.s.requests, activeRequest: this.s.activeRequest,
      outputs: this.outputs, completed: this.completed, history: this.history,
      ready: { q: this._q(this.readyId), frameId: this.s.cacheOwner, nodeId: this.readyId },
      cache: { owner: this.s.cacheOwner, width: this.s.cacheWidth, nodeIds: this.cache.data, valid: this._q(this.cacheValidId) },
      staging: this.s.staging, members: nodes.filter(n => n.member).map(n => n.id), sccs,
      stats: { liveFrames: this.s.frames.length, blocks: this.s.blocks.length, nodes: nodes.length, pending: tasks.length,
        delivered: this.completed.filter(b => b.kind === 'first').length, replays: this.completed.filter(b => b.kind === 'replay').length, steps: this.s.step } });
  }
}

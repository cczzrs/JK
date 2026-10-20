import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageSimulator } from './engine.mjs';

// Expectations here come from the selected draft protocol, not engine helpers:
// FIFO frame order, execution-head ACK, FRAME_OUT-gated readiness, eight slots
// per block generation, and independent left-to-right JK arithmetic.
const queueNames = ['Xi.FIFO', 'RAM.FIFO', 'DAG.FIFO', 'Qi.FIFO'];
const frames = view => view.frames;
const frameId = frame => frame?.frameId ?? frame?.id;
const nodeId = node => node.id;
const taskTarget = task => task.target ?? task.targetId;
const taskVersion = task => task.exVersion ?? task.version;
const nodeVersion = node => node.exVersion ?? node.version;
const taskGeneration = task => task.targetGeneration ?? task.generation;
const nodeGeneration = node => node.generation ?? node.gen;
const blockId = block => block.id ?? block.name;
const blockGeneration = block => block.generation ?? block.gen;
const pendingTasks = view => queueNames.flatMap(name => view.queues[name] ?? []);
const completedShape = view => view.completed.map(item => ({
  frameId: item.frameId, kind: item.kind, bits: item.bits, marker: item.marker,
}));

function evaluateJK(ex, initial, parameters) {
  const compact = ex.replaceAll(/\s+/g, '');
  const tokens = [...compact.matchAll(/([JK])(?:\(([QX]\d+)\)|([01]))/g)];
  assert.equal(tokens.map(token => token[0]).join(''), compact, 'EX must remain flat JK');
  let value = initial;
  for (const [, operation, source, literal] of tokens) {
    const operand = source ? parameters[source] : Number(literal);
    assert.ok(operand === 0 || operand === 1, `missing bit parameter ${source}`);
    value = operation === 'J' ? value & operand : value ^ operand;
  }
  return value;
}

function assertReadyMatchesHead(view) {
  assert.ok(view.ready.q === 0 || view.ready.q === 1);
  if (view.ready.q === 1) {
    assert.ok(frames(view).length > 0, 'ready must not outlive the stored head');
    assert.equal(view.ready.frameId, frameId(frames(view)[0]),
      'an old FRAME_OUT must never make another head ready');
  }
}

function assertLiveReferences(view) {
  const nodes = new Map(view.nodes.map(node => [nodeId(node), node]));
  const incoming = new Map(view.nodes.map(node => [nodeId(node), new Set()]));
  for (const node of view.nodes) {
    const sources = new Set([...node.ex.matchAll(/[JK]\(([QX]\d+)\)/g)]
      .map(match => match[1]).filter(source => source !== nodeId(node)));
    assert.ok(sources.size >= 1, `${nodeId(node)} lacks a non-self EX source`);
    for (const source of sources) {
      if (source.startsWith('X')) continue;
      assert.ok(nodes.has(source), `${nodeId(node)} references missing ${source}`);
      incoming.get(source).add(nodeId(node));
    }
  }
  for (const node of view.nodes) {
    const declared = node.referencedBy ?? [];
    const external = declared.filter(reference => typeof reference === 'string'
      ? /^Y\d+$/.test(reference)
      : typeof reference?.id === 'string' && /^Y\d+$/.test(reference.id));
    assert.ok(incoming.get(nodeId(node)).size + external.length >= 1,
      `${nodeId(node)} has no actual EX or q_y consumer`);
  }
}

function assertPendingTargets(view) {
  const nodes = new Map(view.nodes.map(node => [nodeId(node), node]));
  for (const task of pendingTasks(view)) {
    const target = nodes.get(taskTarget(task));
    assert.ok(target, `pending task ${task.id} lost its target`);
    if (taskVersion(task) !== undefined && nodeVersion(target) !== undefined) {
      assert.equal(taskVersion(task), nodeVersion(target),
        `pending task ${task.id} was silently rebound to another EX`);
    }
    if (taskGeneration(task) !== undefined && nodeGeneration(target) !== undefined) {
      assert.equal(taskGeneration(task), nodeGeneration(target),
        `pending task ${task.id} was silently rebound to another generation`);
    }
  }
}

function inspect(view) {
  assertReadyMatchesHead(view);
  assertLiveReferences(view);
  assertPendingTargets(view);
}

function drain(simulator, limit = 50000) {
  let steps = 0;
  inspect(simulator.view());
  while (true) {
    const record = simulator.step();
    if (record === null) return simulator.view();
    assert.ok(++steps <= limit, 'simulation failed to reach an idle boundary');
    inspect(simulator.view());
  }
}

function runUntil(simulator, predicate, limit = 50000) {
  for (let steps = 0; steps <= limit; steps += 1) {
    const view = simulator.view();
    inspect(view);
    if (predicate(view)) return view;
    assert.notEqual(simulator.step(), null, 'idle before the requested boundary');
  }
  assert.fail('requested boundary was never reached');
}

test('early ACK0 and ACK1 are ignored until the first FRAME_OUT completes', () => {
  const simulator = new StorageSimulator();
  simulator.submitFrame([0, 1, 0]);
  simulator.ack(0);
  simulator.ack(1);
  let view = drain(simulator);
  assert.equal(view.completed.length, 1);
  const id = view.completed[0].frameId;
  assert.deepEqual(completedShape(view), [
    { frameId: id, kind: 'first', bits: [0, 1, 0], marker: 1 },
  ]);
  assert.equal(frames(view).length, 1);
  assert.equal(view.ready.q, 1);
  assert.equal(view.ready.frameId, id);

  simulator.ack(0);
  view = drain(simulator);
  assert.deepEqual(completedShape(view).at(-1),
    { frameId: id, kind: 'replay', bits: [0, 1, 0], marker: 0 });
  assert.equal(frames(view).length, 1);

  simulator.ack(1);
  view = drain(simulator);
  assert.equal(frames(view).length, 0);
  assert.equal(view.ready.q, 0);
});

test('FRAME_OUT is the readiness boundary, including after consumption', () => {
  const simulator = new StorageSimulator();
  simulator.submitFrame([1, 0]);
  simulator.submitFrame([0, 0, 1]);
  let view = runUntil(simulator, current => current.outputs.length > 0);
  assert.equal(view.completed.length, 0);
  assert.equal(view.ready.q, 0, 'data Yi alone cannot activate ACK');
  view = drain(simulator);
  const first = view.completed[0].frameId;
  simulator.ack(1);
  simulator.ack(0);
  simulator.ack(1);
  view = runUntil(simulator, current => frameId(frames(current)[0]) !== first);
  assert.equal(view.ready.q, 0, 'advancing the head invalidates its ACK cache');
  const second = frameId(frames(view)[0]);
  view = drain(simulator);
  assert.equal(view.ready.frameId, second);
  assert.equal(frames(view).length, 1);
  assert.deepEqual(completedShape(view), [
    { frameId: first, kind: 'first', bits: [1, 0], marker: 1 },
    { frameId: second, kind: 'first', bits: [0, 0, 1], marker: 1 },
  ]);
});

test('accepted replay survives a following consume; stale FRAME_OUT cannot reactivate its frame', () => {
  const simulator = new StorageSimulator();
  simulator.submitFrame([1, 1, 0]);
  simulator.submitFrame([0, 1]);
  let view = drain(simulator);
  const first = view.completed[0].frameId;
  const second = frameId(frames(view)[1]);
  simulator.ack(0);
  simulator.ack(1);
  simulator.ack(0);
  view = drain(simulator);
  assert.deepEqual(completedShape(view), [
    { frameId: first, kind: 'first', bits: [1, 1, 0], marker: 1 },
    { frameId: first, kind: 'replay', bits: [1, 1, 0], marker: 0 },
    { frameId: second, kind: 'first', bits: [0, 1], marker: 1 },
  ]);
  assert.equal(frameId(frames(view)[0]), second);
  assert.equal(view.ready.frameId, second);
});

test('variable widths, repeated zero frames, and clearing staging preserve submitted frames', () => {
  const simulator = new StorageSimulator();
  simulator.stage([0]);
  simulator.submitFrame();
  simulator.stage([1, 0, 1]);
  simulator.clearInput();
  simulator.submitFrame([0]);
  simulator.submitFrame([1, 0, 1, 0, 0, 1, 1, 0]);
  let view = drain(simulator);
  const ids = frames(view).map(frameId);
  assert.equal(new Set(ids).size, 3, 'identical data still forms distinct frames');
  simulator.ack(1);
  view = drain(simulator);
  simulator.ack(1);
  view = drain(simulator);
  assert.deepEqual(completedShape(view), [
    { frameId: ids[0], kind: 'first', bits: [0], marker: 1 },
    { frameId: ids[1], kind: 'first', bits: [0], marker: 1 },
    { frameId: ids[2], kind: 'first', bits: [1, 0, 1, 0, 0, 1, 1, 0], marker: 1 },
  ]);
});

test('invalid frame widths and non-bit values are rejected before enqueue', () => {
  const simulator = new StorageSimulator();
  for (const bits of [[], Array(9).fill(0), [0, 2], [true], ['1']]) {
    assert.throws(() => simulator.submitFrame(bits));
    assert.equal(pendingTasks(simulator.view()).length, 0);
    assert.equal(frames(simulator.view()).length, 0);
  }
});

test('a partially used empty block continues its generation instead of recycling', () => {
  const simulator = new StorageSimulator();
  simulator.submitFrame([1]);
  simulator.submitFrame([0, 1]);
  let view = drain(simulator);
  const original = view.blocks[0];
  simulator.ack(1);
  drain(simulator);
  simulator.ack(1);
  view = drain(simulator);
  const empty = view.blocks.find(block => blockId(block) === blockId(original));
  assert.equal(empty.used, 2);
  assert.equal(blockGeneration(empty), blockGeneration(original));
  assert.notEqual(empty.status, 'pooled');
  simulator.submitFrame([1, 1, 1]);
  view = drain(simulator);
  assert.equal(view.blocks.length, 1);
  assert.equal(view.blocks[0].used, 3);
  assert.equal(blockGeneration(view.blocks[0]), blockGeneration(original));
});

test('storage grows past eight slots and reuses only a completely released full block', () => {
  const simulator = new StorageSimulator();
  for (let index = 0; index < 17; index += 1) simulator.submitFrame([index % 2]);
  let view = drain(simulator);
  assert.equal(view.blocks.length, 3);
  assert.deepEqual(view.blocks.map(block => block.used), [8, 8, 1]);
  const firstBlock = view.blocks[0];
  for (let index = 0; index < 8; index += 1) {
    simulator.ack(1);
    view = drain(simulator);
  }
  const released = view.blocks.find(block => blockId(block) === blockId(firstBlock));
  assert.equal(released.used, 8);
  assert.ok(released.slots.every(slot => !slot.frameId || slot.consumed));
  for (let index = 0; index < 8; index += 1) simulator.submitFrame([1, index % 2]);
  view = drain(simulator);
  assert.equal(view.blocks.length, 3, 'a safe released block must precede allocation');
  const reused = view.blocks.find(block => blockId(block) === blockId(firstBlock));
  assert.equal(blockGeneration(reused), blockGeneration(firstBlock) + 1);
  assert.equal(reused.used, 1);
  assert.equal(frames(view).length, 17);
});

test('reset returns to a closed idle graph', () => {
  const simulator = new StorageSimulator();
  simulator.submitFrame([1, 0, 1]);
  drain(simulator);
  simulator.ack(0);
  simulator.reset();
  const view = simulator.view();
  inspect(view);
  assert.equal(frames(view).length, 0);
  assert.equal(view.ready.q, 0);
  assert.equal(view.completed.length, 0);
  assert.equal(view.outputs.length, 0);
  assert.equal(pendingTasks(view).length, 0);
});

test('idle-boundary input and ACK sequences match an independent FIFO oracle', () => {
  const simulator = new StorageSimulator();
  const expectedFrames = [];
  const expectedOutputs = [];
  const sequence = [
    ...Array.from({ length: 11 }, (_, index) => ({
      bits: Array.from({ length: 1 + index % 8 }, (__, bit) => (index + bit) % 2),
    })),
    ...[0, 1, 0, 1, 1, 0, 1].map(ack => ({ ack })),
    { bits: [0] }, { bits: [0] }, { bits: [1, 1, 1, 1, 1, 1, 1, 1] },
    ...Array.from({ length: 15 }, (_, index) => ({ ack: index % 4 === 0 ? 0 : 1 })),
  ];
  for (const operation of sequence) {
    if (operation.bits) {
      const wasEmpty = expectedFrames.length === 0;
      expectedFrames.push(operation.bits);
      simulator.submitFrame(operation.bits);
      if (wasEmpty) expectedOutputs.push({ kind: 'first', bits: operation.bits, marker: 1 });
    } else {
      simulator.ack(operation.ack);
      if (expectedFrames.length && operation.ack === 0) {
        expectedOutputs.push({ kind: 'replay', bits: expectedFrames[0], marker: 0 });
      } else if (expectedFrames.length) {
        expectedFrames.shift();
        if (expectedFrames.length) {
          expectedOutputs.push({ kind: 'first', bits: expectedFrames[0], marker: 1 });
        }
      }
    }
    const view = drain(simulator);
    assert.equal(frames(view).length, expectedFrames.length);
    assert.deepEqual(view.completed.map(({ kind, bits, marker }) => ({ kind, bits, marker })),
      expectedOutputs);
    assert.equal(view.ready.q, expectedFrames.length ? 1 : 0);
  }
});

test('later inputs leave every unconsumed frame in its own W data q nodes', () => {
  const simulator = new StorageSimulator();
  const expected = [
    [1, 0, 1], [0], [1, 1, 0, 0, 1, 0, 1, 0], [0, 0], [1, 1, 1, 1],
  ];
  for (const bits of expected) simulator.submitFrame(bits);
  let view = drain(simulator);
  const originalIds = frames(view).map(frameId);
  for (let round = 0; round < 3; round += 1) {
    const nodes = new Map(view.nodes.map(node => [nodeId(node), node]));
    const parameters = Object.fromEntries(view.nodes.map(node => [nodeId(node), node.q]));
    const slots = view.blocks.flatMap(block => block.slots);
    for (let index = 0; index < originalIds.length; index += 1) {
      const slot = slots.find(candidate => candidate.frameId === originalIds[index]);
      assert.ok(slot, 'each live frame must have its own storage slot');
      assert.equal(slot.nodeIds.length, expected[index].length);
      assert.deepEqual(slot.nodeIds.map(id => nodes.get(id).q), expected[index]);
      for (const id of slot.nodeIds) {
        const node = nodes.get(id);
        assert.equal(node.pro, 'q=');
        assert.equal(evaluateJK(node.ex, node.q, parameters), node.q,
          'the live data EX must retain its bit independently of input history');
      }
    }
    simulator.submitFrame([round % 2, 1, 0, round % 2, 1, 0, 1, 0]);
    view = drain(simulator);
  }
  simulator.ack(0);
  view = drain(simulator);
  assert.deepEqual(view.completed.at(-1).bits, expected[0]);
});

test('two same-width frames enqueue S/C pairs and commit independently derived checksums', () => {
  const simulator = new StorageSimulator();
  simulator.submitFrame([1, 0]); // parity 1; initial checksum 0 => delta 1.
  simulator.submitFrame([1, 1]); // parity 0; preceding checksum 1 => delta 1.
  let view = simulator.view();
  const inputIds = new Set(view.nodes.filter(node => /^J0K\(X[0-7]\)$/.test(node.ex))
    .map(nodeId));
  const input0 = view.nodes.find(node => node.ex === 'J0K(X0)')?.id;
  const input1 = view.nodes.find(node => node.ex === 'J0K(X1)')?.id;
  assert.ok(input0 && input1);
  let pair;
  for (const candidate of view.nodes) {
    const sources = new Set([...candidate.ex.matchAll(/[JK]\((Q\d+)\)/g)]
      .map(match => match[1]));
    if (!sources.has(input0) || !sources.has(input1)
      || [...sources].filter(id => inputIds.has(id)).length !== 2) continue;
    const checksum = view.nodes.find(node => node.ex === `K(${candidate.id})`
      && sources.has(node.id));
    if (checksum) pair = { store: candidate.id, checksum: checksum.id };
  }
  assert.ok(pair, 'the fixed width-2 S/C source relationship must be inspectable');
  while (simulator.view().queues['Xi.FIFO'].length) {
    assert.notEqual(simulator.step(), null);
    inspect(simulator.view());
  }
  view = simulator.view();
  assert.deepEqual(view.queues['RAM.FIFO'].slice(0, 4).map(taskTarget),
    [pair.store, pair.checksum, pair.store, pair.checksum]);
  assert.notEqual(simulator.step(), null);
  view = simulator.view();
  assert.equal(view.nodes.find(node => node.id === pair.store).q, 1);
  assert.equal(view.nodes.find(node => node.id === pair.checksum).q, 0,
    'S and C are distinct EX tasks, not an invented atomic double evaluation');
  assert.notEqual(simulator.step(), null);
  assert.equal(simulator.view().nodes.find(node => node.id === pair.checksum).q, 1);
  assert.notEqual(simulator.step(), null);
  assert.equal(simulator.view().nodes.find(node => node.id === pair.store).q, 1);
  assert.notEqual(simulator.step(), null);
  assert.equal(simulator.view().nodes.find(node => node.id === pair.checksum).q, 0);
  drain(simulator);
});

test('only the W submitted data inputs are copied, and each copied bit is locked independently', () => {
  const simulator = new StorageSimulator();
  const submitted = [[0], [1, 0, 1], [0, 1, 0, 1, 1, 0, 0, 1]];
  const ids = submitted.map(bits => simulator.submitFrame(bits));
  const view = drain(simulator);
  const copies = view.history.filter(record => record.kind === 'input-copy');
  assert.equal(copies.length, 12);
  for (let index = 0; index < ids.length; index += 1) {
    const batchCopies = copies.filter(record => record.frameId === ids[index]);
    assert.equal(batchCopies.length, submitted[index].length);
    assert.deepEqual(batchCopies.map(record => record.after), submitted[index]);
    assert.deepEqual(batchCopies.map(record => record.reads[0].source),
      submitted[index].map((_, bit) => `X${bit}`));
    assert.ok(batchCopies.every(record => record.reads[0].locked));
  }
});

test('every Yi comes from its own real output EX and the fixed q_y binding', () => {
  const simulator = new StorageSimulator();
  const initial = simulator.view();
  const fixedOutputs = initial.nodes.filter(node => node.output).map(node => ({
    id: node.id, ex: node.ex, output: node.output,
  }));
  assert.equal(fixedOutputs.length, 9);
  const bits = [1, 0, 0, 1];
  const id = simulator.submitFrame(bits);
  drain(simulator);
  simulator.ack(0);
  const view = drain(simulator);
  assert.deepEqual(view.nodes.filter(node => node.output).map(node => ({
    id: node.id, ex: node.ex, output: node.output,
  })), fixedOutputs);
  const history = new Map(view.history.map(record => [record.taskId, record]));
  const nodes = new Map(view.nodes.map(node => [node.id, node]));
  for (const record of view.history) {
    assert.equal(record.executed, true);
    const parameters = {};
    for (const read of record.reads) {
      if (Object.hasOwn(parameters, read.source)) {
        assert.equal(parameters[read.source], read.value,
          'one EX must use the same fixed value for every repeated source');
      }
      parameters[read.source] = read.value;
    }
    assert.equal(evaluateJK(record.ex, record.before, parameters), record.after);
    const exWrites = record.writes.filter(write => write.reason === 'EX');
    assert.equal(exWrites.length, 1, 'one task evaluates exactly one node EX');
    assert.equal(exWrites[0].target, record.target);
    assert.equal(exWrites[0].after, record.after);
  }
  assert.equal(view.outputs.length, 2 * (bits.length + 1));
  for (const event of view.outputs) {
    const record = history.get(event.taskId);
    assert.ok(record, 'Yi must identify the task that actually executed');
    assert.equal(event.sourceQ, record.target);
    assert.equal(record.queue, 'RAM.FIFO');
    assert.equal(nodes.get(event.sourceQ).output, event.yi);
    assert.equal(event.value, record.after);
    assert.equal(record.batchId, event.batchId);
    assert.equal(record.frameId, id);
    assert.ok(record.reads.every(read => read.locked), 'O uses its own captured R values');
  }
  for (let index = 0; index < view.completed.length; index += 1) {
    const batch = view.completed[index];
    const events = view.outputs.filter(event => event.batchId === batch.batchId);
    assert.deepEqual(events.map(event => event.yi), ['Y0', 'Y1', 'Y2', 'Y3', 'Y8']);
    assert.deepEqual(events.map(event => event.value), [...bits, index === 0 ? 1 : 0]);
    assert.equal(events.at(-1).isMarker, true);
    assert.equal(batch.step, events.at(-1).step);
  }
  const dataIds = new Set(view.nodes.filter(node => node.role === 'data').map(nodeId));
  const cacheIds = new Set(view.cache.nodeIds);
  const reads = view.history.filter(record => record.kind === 'read');
  assert.equal(reads.length, 2 * bits.length);
  assert.ok(reads.slice(0, bits.length).every(record => record.reads.some(read =>
    dataIds.has(read.source) && !read.locked)), 'first delivery executes R against real D.q');
  assert.ok(reads.slice(bits.length).every(record => record.reads.some(read =>
    cacheIds.has(read.source) && !read.locked)), 'replay executes R against H.q, not D.q');
});

test('arrival before FRAME_OUT does not imply rejection when ACK executes after FRAME_OUT', () => {
  const simulator = new StorageSimulator();
  simulator.submitFrame([1, 0, 1]);
  let view = runUntil(simulator, current => current.outputs.length === 1);
  assert.equal(view.ready.q, 0);
  simulator.ack(1);
  view = drain(simulator);
  assert.equal(view.completed.length, 1);
  assert.equal(view.frames.length, 0,
    'the already queued continuous output batch precedes the appended ACK tasks');
  const consume = view.history.find(record => record.events.some(event => event.type === 'consume'));
  assert.ok(consume.step > view.completed[0].step);
});

test('pending target and unlocked source dependencies reject EX reconfiguration', () => {
  const simulator = new StorageSimulator();
  simulator.submitFrame([1, 0]);
  const view = runUntil(simulator, current => current.queues['RAM.FIFO']
    .some(task => task.kind === 'read'));
  const read = view.queues['RAM.FIFO'].find(task => task.kind === 'read');
  const target = view.nodes.find(node => node.id === read.target);
  const selector = view.nodes.find(node => node.role === 'selector');
  assert.ok(selector);
  assert.equal(pendingTasks(view).filter(task => task.target === selector.id).length, 0);
  assert.throws(() => simulator.reconfigureNode(target.id, target.ex));
  assert.throws(() => simulator.reconfigureNode(selector.id, selector.ex),
    'a completed selector remains protected while an unlatched R task reads it');
  const output = view.nodes.find(node => node.output);
  assert.throws(() => simulator.reconfigureNode(output.id, output.ex));
  assert.deepEqual(simulator.view().nodes, view.nodes,
    'rejected changes must preserve the node table and EX versions');
  drain(simulator);
});

test('an accepted old-frame replay survives reuse of its original storage block', () => {
  const simulator = new StorageSimulator();
  const data = Array.from({ length: 9 }, (_, index) => [index % 2, 0, 1]);
  const ids = data.map(bits => simulator.submitFrame(bits));
  let view = drain(simulator);
  for (let count = 0; count < 7; count += 1) {
    simulator.ack(1);
    view = drain(simulator);
  }
  assert.equal(view.ready.frameId, ids[7]);
  const originalBlock = view.blocks[0];
  simulator.ack(0);
  simulator.ack(1);
  for (let count = 0; count < 8; count += 1) simulator.submitFrame([0, 1, 0, 1]);
  view = runUntil(simulator, current => current.blocks.some(block =>
    blockId(block) === blockId(originalBlock)
      && blockGeneration(block) > blockGeneration(originalBlock)));
  assert.ok(!view.completed.some(batch => batch.frameId === ids[7] && batch.kind === 'replay'),
    'the regression must actually exercise reuse before old replay completion');
  view = drain(simulator);
  const replay = view.completed.find(batch => batch.frameId === ids[7] && batch.kind === 'replay');
  assert.ok(replay);
  assert.deepEqual(replay.bits, data[7]);
  assert.equal(replay.marker, 0);
  assert.equal(view.ready.frameId, ids[8]);
});

test('invalid idle EX reconfiguration rolls back the expression and version', () => {
  const simulator = new StorageSimulator();
  const before = simulator.view();
  const relay = before.nodes.find(node => node.role === 'relay');
  assert.throws(() => simulator.reconfigureNode(relay.id, 'J0K1'));
  assert.deepEqual(simulator.view().nodes, before.nodes);
});

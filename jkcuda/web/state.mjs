/* Pure presentation helpers. No JK evaluation, scheduling, or state mutation. */
export function display(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
export function typedKey(value, declaredType) {
  if (value === null || value === undefined) return 'null';
  if (declaredType === 'integer') return `integer:${value}`;
  if (declaredType === 'string') return `string:${JSON.stringify(value)}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}
export function groupTokens(tokens) {
  const groups = new Map();
  for (const token of tokens) {
    const keyed = token.mode === 'KEYED';
    const key = JSON.stringify([token.target, token.port, token.mode, keyed ? typedKey(token.key, token.key_type) : null]);
    if (!groups.has(key)) groups.set(key, {target: token.target, port: token.port,
      key: keyed ? token.key : undefined, key_type: keyed ? token.key_type : undefined,
      mode: token.mode, items: []});
    groups.get(key).items.push(token);
  }
  return [...groups.values()];
}
export function compareIds(a, b) {
  try { const x = BigInt(a); const y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  catch { return String(a).localeCompare(String(b)); }
}
export function counterDelta(current, previous) {
  try { return Math.max(0, Number(BigInt(current) - BigInt(previous))); }
  catch { return 0; }
}
export function mergeTraces(existing, incoming, max = 1000) {
  const rows = new Map(existing.map(row => [String(row.seq), row]));
  for (const row of incoming) rows.set(String(row.seq), row);
  return [...rows.values()].sort((a, b) => compareIds(a.seq, b.seq)).slice(-max);
}
export function subscriptionIdentity(edge) {
  return JSON.stringify([edge.source, edge.target, edge.port, String(edge.order)]);
}
export function pendingSubscriptionKeys(events, subscriptions, ownerTaskId) {
  const keys = new Set();
  if (ownerTaskId === null || ownerTaskId === undefined) return keys;
  for (const event of events) {
    if (String(event.owner_task_id) !== String(ownerTaskId) || event.complete) continue;
    const delivered = Number(event.delivered), fanout = Number(event.fanout);
    if (!(fanout > delivered)) continue;
    const edges = subscriptions.filter(edge => edge.source === event.source)
      .sort((a, b) => compareIds(a.order, b.order));
    for (const edge of edges.slice(delivered, fanout)) keys.add(subscriptionIdentity(edge));
  }
  return keys;
}
export function parseKey(text) {
  if (!text.trim()) return null;
  const key = JSON.parse(text);
  if (key !== null && typeof key !== 'string' && !(typeof key === 'number' && Number.isSafeInteger(key))) {
    throw new Error('业务 key 只接受 null、字符串或安全整数；大整数请通过宿主 Python 接口提交。');
  }
  return key;
}
export const phaseNames = {IDLE:'空闲',QUEUED:'等待调度',ACTIVE:'已领取 / 待执行',EXECUTED:'已执行 / 待提交',PROPAGATING:'传播与任务形成',COMPLETE:'完整结束',MISSING:'缺少参数 / 待结束'};
export const kindNames = {enqueue:'任务入队',select:'领取任务',bind:'绑定与求值',commit:'提交',event:'发布事件',delivery:'订阅投递',match:'触发匹配',complete:'任务完成',output:'输出',structure:'结构更新'};

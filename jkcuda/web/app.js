import {display, typedKey, groupTokens, compareIds, counterDelta, mergeTraces, parseKey, phaseNames, kindNames, subscriptionIdentity, pendingSubscriptionKeys} from './state.mjs';
import {buildRuntimeGraph,layerGraph,graphActivity,isStateSourceEdge} from './graph.mjs';
let buildFactoryGraph,factoryDefinitions,factoryNodeStatus,layoutFactoryGraph;

const $ = id => document.getElementById(id);
const S = {data:null, model:null, modelVersion:null, token:null, live:false, receivedAt:0, traces:[], samples:[], selected:null, follow:true, zoom:1, historyCursor:0, historyMode:false, modelLoading:false, stream:null, busy:false, lastGraphSignature:null,graph:null,graphLayout:null,graphElements:new Map(),graphEdgeElements:new Map(),graphBuiltFor:null,modelInstance:null,modelJSON:''};
const NS = 'http://www.w3.org/2000/svg';
const F = {bundle:null,graph:null,layout:null,elements:new Map(),edges:new Map(),zoom:1,loading:false,view:'runtime'};
function el(tag, cls, text) { const node = document.createElement(tag); if(cls) node.className = cls; if(text !== undefined) node.textContent = display(text); return node; }
function svg(tag, attrs = {}, text) { const node = document.createElementNS(NS, tag); for(const [k,v] of Object.entries(attrs)) node.setAttribute(k, String(v)); if(text !== undefined) node.textContent = display(text); return node; }
function set(id, value) { $(id).textContent = display(value); }
function empty(text, icon) { const node = el('div','empty'); if(icon) node.append(el('span','',icon)); node.append(document.createTextNode(text)); return node; }
function clear(id) { const n = typeof id === 'string' ? $(id) : id; n.replaceChildren(); return n; }
function short(value, max = 90) { const str = display(value); return str.length > max ? str.slice(0, max) + '…' : str; }
function fmt(value) { if(value == null) return '—'; if(typeof value === 'string') return value.replace(/\B(?=(\d{3})+(?!\d))/g, ','); return Number.isInteger(value) ? value.toLocaleString('en-US') : String(value); }
function bytes(value) { const n = Number(value); if(!Number.isFinite(n)) return '—'; if(n < 1024) return `${n} B`; if(n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`; return `${(n / 1024 ** 2).toFixed(1)} MiB`; }
function kv(entries) { const list = el('dl','kv'); for(const [name,value] of entries) { list.append(el('dt','',name), el('dd','',value)); } return list; }
function bit(value) { return el('span', `bit${value === 0 ? ' zero' : ''}`, value); }
function fail(error) { const banner = $('error-banner'); banner.hidden = false; banner.textContent = error instanceof Error ? error.message : display(error); }
async function api(path, options = {}) { const response = await fetch(path, {cache:'no-store', ...options}); let data; try { data = await response.json(); } catch { throw new Error(`服务响应无法解析（HTTP ${response.status}）`); } if(!response.ok) throw new Error(typeof data.error === 'string' ? data.error : display(data.error || data.detail || `HTTP ${response.status}`)); return data; }

function setConnection(live, note) { S.live = live; $('connection').className = `connection ${live ? 'live' : 'stale'}`; $('connection').replaceChildren(el('i'), document.createTextNode(note || (live ? '实时连接' : '连接中断 · 正在重连'))); updateButtons(); }
function updateButtons() {
  const running = Boolean(S.data?.control?.running);
  document.querySelectorAll('[data-action]').forEach(button => {
    const action = button.dataset.action;
    button.disabled = !S.live || !S.token || Boolean(S.data?.status?.fatal_error) || (running && ['run','step','step_work','retry_failed','resume_budget'].includes(action));
    if(action === 'pause') button.disabled = !S.live || !S.token || (!running && S.data?.status?.active_task == null);
  });
  document.querySelectorAll('[data-submit-input]').forEach(button => {button.disabled = !S.live || !S.token || Boolean(S.data?.status?.fatal_error);});
}
function requestId() { return `web:${globalThis.crypto?.randomUUID ? crypto.randomUUID() : Date.now() + ':' + Math.random().toString(36).slice(2)}`; }
function showResult(result) { const out = $('command-result'); out.classList.toggle('failed', result.state === 'failed' || Boolean(result.error)); out.textContent = JSON.stringify(result, null, 2); }
async function command(action, payload = {}) {
  if(!S.live) return fail('连接不可用；请等待重新取得运行现场。');
  try {
    $('error-banner').hidden = true;
    const result = await api('/api/command', {method:'POST',headers:{'Content-Type':'application/json','X-JK-Token':S.token},body:JSON.stringify({action,request_id:requestId(),payload})});
    showResult(result);
    if(result.state === 'failed') fail(result.error || '命令失败');
    if(result.state === 'queued' && result.command_id) watchCommand(result.command_id, action);
    return result;
  } catch(error) { fail(error); showResult({action,state:'failed',error:error.message}); }
}
async function watchCommand(id, action) {
  let count = 0;
  while(count++ < 600) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try { const result = await api(`/api/commands/${encodeURIComponent(id)}`); if(result.state === 'failed') {showResult(result);fail(result.error || '命令执行失败');return;} if(result.state === 'completed') {showResult(result);return;} }
    catch(error) { fail(error); return; }
  }
  showResult({command_id:id,action,state:'queued',note:'命令仍在执行，后续状态见运行状态与轨迹。'});
}
function payloadFor(button) {
  switch(button.dataset.action) {
    case 'run': return {max_tasks:Number($('max-tasks').value),interval_ms:Number($('run-interval').value),granularity:$('run-granularity').value};
    case 'step_work': return {max_work:1};
    case 'ack_frame': return {value:Number(button.dataset.value)};
    case 'ack_output': return {output_id:button.dataset.outputId};
    case 'grow': return {capacities:JSON.parse($('grow-json').value)};
    case 'resume_budget': { const raw = $('budget-group').value.trim(), group = Number(raw); if(!raw || !Number.isSafeInteger(group)) throw new Error('请输入模型声明的整数预算组 ID。'); return {group,additional:Number($('budget-add').value)}; }
    default: return {};
  }
}
document.addEventListener('click', event => { const button = event.target.closest('button[data-action]'); if(!button || button.disabled) return; try {command(button.dataset.action, payloadFor(button));} catch(error) {fail(error);} });

function observe(data) {
  if(S.data && S.data.instance_id !== data.instance_id) {S.token=null;api('/api/session').then(session=>{S.token=session.token;updateButtons();}).catch(fail);S.traces=[];S.samples=[];S.selected=null;S.historyCursor=0;S.historyMode=false;S.model=null;S.lastGraphSignature=null;}
  const old = S.data;
  S.data = data; S.receivedAt = Date.now(); setConnection(true);
  const status = data.status || {};
  const time = Number(data.sampled_at) || Date.now();
  const last = S.samples[S.samples.length - 1];
  const elapsed = last ? (time - last.time)/1000 : 0;
  const rate = elapsed > 0 ? counterDelta(status.completed || 0, last.completed)/elapsed : 0;
  if(!last || time > last.time) { S.samples.push({time, completed:status.completed || 0, pending:Number(status.pending || 0), events:Number(data.events?.pending || 0), tokens:Number(data.tokens?.pending || 0), rate}); S.samples = S.samples.filter(point => point.time >= time - 60000).slice(-600); }
  set('device',status.device || '未知设备'); $('device').className = `badge ${String(status.device).startsWith('cuda') ? 'cuda' : 'cpu'}`;
  set('instance-id',data.instance_id); set('sample-age','刚刚更新');
  const native = status.device === 'native-cpu'; $('backend-note').hidden = !native;
  if(native) set('backend-note','当前连接 native-cpu：运行同一 C++ 状态机的本机验证路径。以下为真实运行数据；CUDA 编译、设备执行与 GPU 性能尚未由此验证。');
  if(status.mirror_valid === false) {setConnection(false,'设备故障 · 宿主镜像已失效');fail(`设备故障：${display(status.fatal_error)}。下方保留的是最后宿主镜像，不代表当前设备状态；执行控制已禁用。`);}
  set('architecture-device',`${display(status.device)} 运行时`);
  set('m-complete',fmt(status.completed)); set('m-pending',fmt(status.pending)); set('m-events',fmt(data.events?.pending)); set('m-tokens',fmt(data.tokens?.pending)); set('m-delivery',`${fmt(status.metrics?.G)} / ${fmt(status.metrics?.D)}`); set('m-rate',rate.toFixed(1));
  const running = data.control?.running;
  const stopped = status.fatal_error || status.reason || data.control?.last_error;
  set('run-state',stopped ? '运行受阻' : running ? '正在推进' : '已停止推进');
  set('run-reason',stopped || (status.active_task != null ? '保留当前活动任务现场' : status.pending ? '等待任务可继续运行' : '等待外部输入'));
  $('run-light').className = stopped ? 'error' : running ? 'running' : '';
  set('phase-pill',status.phase || 'IDLE');
  renderFlow(); renderActive(); renderQueues(); renderTokens(); renderStorage(); renderOutputs(); renderFrames();
  S.traces = mergeTraces(S.traces, data.trace?.items || []);
  if(!S.historyMode) renderTrace();
  renderChart();
  updateGraphState();
  if(!S.model || String(S.modelVersion) !== String(data.model_version)) loadModel();
  if(S.selected && ['node','graph'].includes(S.selected.type)) renderInspector();
  updateButtons();
  if(old?.control?.last_error !== data.control?.last_error && data.control?.last_error) fail(data.control.last_error);
}
function renderFlow() {
  const status = S.data.status, active = S.data.active_task;
  const hasDeliveries = (S.data.events?.items || []).some(event => String(event.owner_task_id) === String(status.active_task) && !event.complete && Number(event.fanout) > Number(event.delivered));
  const propagationStages = Number(S.data.events?.pending || 0) === 0 ? ['complete'] : hasDeliveries ? ['events','propagate','match'] : ['events'];
  const stages = status.phase === 'ACTIVE' ? ['select','execute'] : status.phase === 'EXECUTED' ? ['commit'] : status.phase === 'PROPAGATING' ? propagationStages : status.phase === 'MISSING' ? ['complete'] : [];
  document.querySelectorAll('.flow-node').forEach(node => node.classList.toggle('highlight', stages.includes(node.dataset.stage)));
  const currentPhase = status.phase === 'PROPAGATING' && Number(S.data.events?.pending || 0) === 0 ? '事件义务已清空 / 待完成任务' : status.phase === 'PROPAGATING' && !hasDeliveries ? '等待事件完成标记' : phaseNames[status.phase] || status.phase;
  const desc = active ? `任务 #${active.task_id} · ${display(active.node || active.control || active.kind)} · ${currentPhase}。事件 ${display(active.event_done)} / ${display(active.event_count)} 已处理。` : `当前没有活动任务。${status.pending ? `${status.pending} 个任务等待按优先级与 FIFO 选取。` : '输入会先成为独立任务，再进入执行闭环。'}`;
  set('flow-context',desc);
}
function renderActive() {
  const target = clear('active-task'), task = S.data.active_task;
  if(!task) target.append(empty('当前没有活动任务','◇'));
  else {
    const title = el('div','task-id',`#${task.task_id}`);target.append(title);
    target.append(kv([['节点 / 类型',task.node || task.control || task.kind],['所属 FIFO',task.queue],['程序 / 世代',`${display(task.program_version)} / ${display(task.generation)}`],['当前阶段',phaseNames[task.phase] || task.phase],['锁存载荷',task.payload || task.params],['固定 seed',task.seed],['候选结果',task.result],['业务 key',typedKey(task.key,task.key_type)],['因果来源',`任务 ${display(task.cause_task)} · 事件 ${display(task.cause_event)}`]]));
    title.title = '点击查看完整任务记录';title.style.cursor='pointer';title.addEventListener('click',()=>select('task',task));
  }
  const p = S.data.status.propagation || {};
  set('propagation-config',`${p.mode || '—'} 传播 · 分块 ${display(p.chunk)} · block ${display(p.block_size)}。配置值不等于实际并行量。`);
}
function taskCard(task, index) {
  const card = el('button','record-card'); card.type='button';card.append(el('b','',`#${task.task_id} ${index === 0 ? '← 队首' : ''}`),el('small','',task.node || task.control || task.kind),el('div','payload',short(task.payload || task.params,55)));card.title=JSON.stringify(task,null,2);card.addEventListener('click',()=>select('task',task)); return card;
}
function renderQueues() {
  const target = clear('fifo-buckets');
  for(const queue of S.data.queues || []) {
    const row = el('div','fifo-row'), heading = el('div','fifo-label');heading.append(el('span','',queue.name),el('small','',`priority ${queue.priority}`),el('span','queue-count',`${fmt(queue.pending)} 项`));
    const track = el('div','bucket-track'); (queue.tasks || []).slice(0,60).forEach((task,index)=>track.append(taskCard(task,index)));
    if(!queue.tasks?.length) track.append(empty('队列为空'));
    row.append(heading,track);
    if(queue.truncated || queue.tasks?.length > 60) row.append(el('p','truncate-note',`仅显示队首 ${Math.min(60,queue.tasks?.length || 0)} 条；实际等待 ${fmt(queue.pending)} 条。`));
    target.append(row);
  }
  if(!S.data.queues?.length) target.append(empty('模型没有可显示队列'));
  set('event-total',`保留的历史事件 ${fmt(S.data.events?.total)}`);
  const events = clear('event-bucket'), records = el('div','event-records');
  for(const event of (S.data.events?.items || []).slice(0,40)) {
    const card = el('button','record-card event');card.append(el('b','',`事件 #${event.event_id}`),el('small','',`${event.source} = ${event.value}`),el('small','',`owner #${event.owner_task_id}`),el('div','payload',`投递 ${event.delivered} / ${event.fanout}`));
    const progress = el('div','progress-bar'), bar = el('span');bar.style.width=`${Number(event.fanout) ? Math.min(100,Number(event.delivered)/Number(event.fanout)*100) : 100}%`;progress.append(bar);card.append(progress);card.addEventListener('click',()=>select('event',event));records.append(card);
  }
  if(!S.data.events?.items?.length) records.append(empty('当前任务没有待传播事件'));
  events.append(records);
  if(S.data.events?.truncated || S.data.events?.items?.length > 40) events.append(el('p','truncate-note',`显示 ${Math.min(40,S.data.events?.items?.length || 0)} / ${fmt(S.data.events?.pending)} 个待传播事件；其余位于展示窗口外。`));
}
function renderTokens() {
  const target = clear('token-buckets'), tokens = S.data.tokens?.items || [], groups = groupTokens(tokens);
  let shownTokens = 0;
  for(const group of groups.slice(0,40)) {
    const card = el('div','token-group'), head = el('header');head.append(el('span','',`${group.target}.${group.port}`),el('span','',group.mode));
    const grouping = group.mode === 'KEYED' ? `key ${typedKey(group.key,group.key_type)}` : group.mode === 'ALL_LATEST' ? '每来源最新值，不按 key 分桶' : '来源 FIFO / 不按 key 分桶';
    card.append(head,el('p','subtle',grouping));
    const visible = group.items.slice(0,24); shownTokens += visible.length;
    const values = el('div','token-values');for(const item of visible) { const node=el('button','',`${item.value} · e${item.event_id}`);node.title=`token #${item.token_id} · key ${typedKey(item.key,item.key_type)}`;node.addEventListener('click',()=>select('token',item));values.append(node); }card.append(values);
    if(group.items.length > visible.length)card.append(el('p','truncate-note',`显示 ${visible.length} / 观测到的 ${group.items.length} 条；此桶还有记录未展开。`));
    target.append(card);
  }
  if(!groups.length) target.append(empty('没有未配齐输入；有效值 0 仍会正常显示。'));
  if(S.data.tokens?.truncated || groups.length > 40 || shownTokens < tokens.length) target.append(el('p','truncate-note',`显示 ${Math.min(40,groups.length)} / 观测到的 ${groups.length} 个桶，${shownTokens} / 观测到的 ${tokens.length} 条 token；有效 token 总数 ${fmt(S.data.tokens?.pending)}。展示或观测窗口已截断。`));
}
function renderStorage() {
  const target=clear('capacity-bars');
  for(const section of (S.data.storage || [])) {
    const row=el('div','capacity-row'), capacity=Number(section.capacity), used=Number(section.used), reserved=Number(section.reserved || 0), ratio=capacity>0?used/capacity:0;
    const bar=el('div',`bar${ratio>.8?' high':''}`), usedBar=el('span','bar-used'), reservedBar=el('span','bar-reserved');usedBar.style.width=`${Math.min(100,ratio*100)}%`;reservedBar.style.width=`${Math.min(100,capacity>0?reserved/capacity*100:0)}%`;bar.append(usedBar,reservedBar);row.append(el('span','',section.name),bar,el('span','count',`${fmt(section.used)} / ${fmt(section.capacity)}`));row.title=`已用 ${section.used} · 预留 ${section.reserved || 0} · 容量 ${section.capacity} · 单位 ${section.unit === 'int64_words' ? 'int64 字' : '记录'}`;target.append(row);
  }
  const p=S.data.status.physical_metrics || {};set('memory-summary',bytes(p.host_arena_bytes));
  const out=clear('physical-metrics');for(const [label,value] of [['H2D',bytes(p.h2d_bytes)],['D2H',bytes(p.d2h_bytes)],['传播批次',fmt(p.parallel_batches)],['实际最大分块',fmt(p.max_parallel_chunk)]]) {const tag=el('span','',label+' ');tag.append(el('b','',value));out.append(tag);}
}
function select(type, record) {S.selected={type,record};renderInspector();renderGraph();if(F.graph)updateFactorySearch();}
function renderInspector() {
  const target=clear('inspector');
  if(!S.selected) {set('inspector-title','节点与记录详情');target.append(empty('点击节点、任务卡片或轨迹查看详情','⌖'));return;}
  const {type,record}=S.selected;set('inspector-title',({node:'节点详情',task:'任务详情',event:'事件详情',token:'等待 token',trace:'因果轨迹',stage:'运行阶段',output:'输出记录',graph:'运行角色与状态',graph_edge:'连接类型与条件',factory:'JKS / JKI 设计详情',factory_edge:'设计连接与条件'})[type] || '记录详情');
  if(type==='node') {
    const node=record;target.append(el('h3','detail-title',node.id));
    target.append(kv([['FIFO',node.queue],['generation',node.generation],['程序版本',node.version],['EX',node.ex],['状态槽',node.state],['当前状态',!modelIsCurrent()?'模型版本同步中':node.state ? S.data?.status?.states?.[node.state] : '无状态'],['触发契约',node.trigger],['发布条件',node.publish],['输出端口',node.output]]));
    const activity=modelIsCurrent()?S.data?.task_activity?.nodes?.[node.id]:null;
    if(activity){target.append(kv([['任务总数',activity.total],['待调度',activity.pending],['已完成',activity.completed],['活动任务',activity.active_task_id],['最近任务',activity.last_task_id]]),el('p','micro-note','按逻辑节点 ID 累计，包含历史世代与程序版本；真实任务保留其入队时绑定的版本。'));if(activity.last_task)target.append(el('h3','','最近真实任务'),el('pre','code-block',JSON.stringify(activity.last_task,null,2)));}
    else target.append(el('p','micro-note','完整任务统计尚未取得；需要当前版本匹配并启用 task_activity。'));
    target.append(el('h3','', '来源绑定'),el('pre','code-block',JSON.stringify(node.sources || {},null,2)));
    if(S.model?.business_module && node.state?.endsWith('.S_W'))target.append(el('p','micro-note','业务构造中 S、C 同层收齐 PRE；S 先于 C 来自订阅 order 与同一 FIFO，S 读取旧 C_W，并不存在 S → C 触发边。'));
  } else if(type==='factory') {
    target.append(el('h3','detail-title',record.label),el('p','graph-description',record.description || 'JKRD7 已纳入的工厂设计定义。'));
    target.append(kv([['来源','JKRD7 7.0.0 · 静态设计'],['结构类型',record.kind],['管理归属',record.owner],['状态',factoryNodeStatus(record)]]));
    target.append(el('p','micro-note','这里没有实际任务计数；state 是初始化定义，不能当作当前 CUDA 状态。'));
    if(record.definition?.members)target.append(kv([['成员',record.definition.members],['事务入口',record.definition.trigger],['独立入口 FIFO',record.definition.queue]]));
    if(record.definition?.sources)target.append(kv([['状态定义',record.definition.state],['完整触发',record.definition.trigger],['J/K 来源与顺序',record.definition.sources],['发布条件',record.definition.publish]]));
    target.append(el('pre','code-block',JSON.stringify(record.definition || record.record || record,null,2)));
    for(const edge of F.graph?.edges.filter(edge=>edge.source===record.id||edge.target===record.id)||[])target.append(el('p','graph-relation',`${edge.kind} · ${edge.label}`));
  } else if(type==='factory_edge') {
    target.append(el('h3','detail-title',record.kind),el('p','graph-description',record.label),kv([['来源',record.source],['目标',record.target],['前进分层',record.rank?'是':'否：组成、取值、条件或反馈']]));
    if(record.record)target.append(el('pre','code-block',JSON.stringify(record.record,null,2)));
    target.append(el('p','micro-note','这是设计契约，不能据此认定条件已经成立或操作已经执行。'));
  } else if(type==='graph') {
    target.append(el('h3','detail-title',record.label),el('p','graph-description',record.description || '当前模型中的显式结构项。'));
    const activity=modelIsCurrent()?graphActivity(record,S.data):null;
    target.append(kv([['图类型',record.kind],['阶段 / 职责',record.stage],['当前事实',modelIsCurrent()?graphNodeValue(record):'模型版本同步中']]));
    if(record.kind==='control')target.append(el('p','micro-note','此框是运行时控制任务类型，不是额外 JK 节点。每个实际任务仍有自己的 task_id、FIFO 位置和载荷。'));
    if(activity){target.append(kv([['总任务',activity.total],['待调度',activity.pending],['已完成',activity.completed],['活动 task_id',activity.active_task_id],['最近 task_id',activity.last_task_id],['最近阶段',activity.last_phase],['等待任务 ID',activity.queued_task_ids]]));if(activity.queued_truncated)target.append(el('p','truncate-note','等待任务 ID 为截断窗口；完整数量以上方统计为准。'));if(activity.last_task)target.append(el('h3','','最近真实任务 / 锁存载荷'),el('pre','code-block',JSON.stringify(activity.last_task,null,2)));}
    else if(record.kind==='control')target.append(el('p','micro-note','未取得此控制类型统计；请重启服务启用 task_activity。'));
    const connected=S.graph?.edges.filter(edge=>edge.source===record.id||edge.target===record.id)||[];target.append(el('h3','','相关条件与效果'));for(const edge of connected)target.append(el('p','graph-relation',`${edge.kind} · ${edge.label}`));
  } else if(type==='graph_edge') {
    target.append(el('h3','detail-title',record.kind),el('p','graph-description',record.label),kv([['来源',record.source],['目标',record.target],['参与前进分层',record.rank?'是（SCC 内保持同层）':'否：反馈 / 条件读取 / 写回']]));
    if(record.subscription)target.append(el('pre','code-block',JSON.stringify(record.subscription,null,2)));
    target.append(el('p','micro-note','连接表示模型契约或已实现的运行时关系，不表示目标任务可以绕过 FIFO，也不表示当前条件一定已成立。'));
  } else {target.append(el('pre','code-block',JSON.stringify(record,null,2)));}
}
async function loadModel() {
  if(S.modelLoading) return;S.modelLoading=true;
  try {
    const data=await api('/api/model');
    if(!S.data || String(data.instance_id)!==String(S.data.instance_id) || String(data.model_version)!==String(S.data.model_version)) {
      set('model-json-note','结构版本正在同步；此时不将旧结构叠加到新运行状态。');
      updateGraphState();return;
    }
    S.model=data.model;S.modelVersion=data.model_version;S.modelInstance=data.instance_id;
    S.exactModelJSON=typeof data.model_json==='string';
    S.modelJSON=S.exactModelJSON?data.model_json:JSON.stringify(data.model,null,2);
    S.graph=buildRuntimeGraph(S.model);S.graphLayout=layerGraph(S.graph);S.graphBuiltFor=null;
    if(S.selected?.type==='node'){const fresh=S.model.nodes.find(node=>node.id===S.selected.record.id);if(fresh)S.selected.record=fresh;else S.selected=null;renderInspector();}
    if(S.selected?.type==='graph'){const fresh=S.graph.nodes.find(node=>node.id===S.selected.record.id);if(fresh)S.selected.record=fresh;else S.selected=null;renderInspector();}
    renderInput();renderGraph();
    if(F.view==='runtime')set('model-count',`${fmt(S.graph.normalCount)} 个普通节点 · ${fmt(S.graph.subscriptionCount)} 条真实订阅`);
    set('architecture-model',`${S.model.profile} · ${fmt(S.model.nodes?.length || 0)} 节点 · 版本 ${display(data.model_version)}`);
    set('model-json',S.modelJSON);set('model-json-version',`已安装版本 ${display(data.model_version)}`);
    set('model-json-note',`实例 ${data.instance_id} · 完整已安装模型，独立于图中搜索、缩放与显示选项。${S.exactModelJSON?'服务端原始 JSON 文本保留 int64 数字字面值，可完整复制或下载。':'旧服务未返回精确 JSON 文本；当前为安全传输对象视图，大整数可能为字符串，复制和下载已禁用。'}`);
    $('model-json-copy').disabled=!S.exactModelJSON;$('model-json-download').disabled=!S.exactModelJSON;
  } catch(error) {fail(error);} finally {S.modelLoading=false;}
}
function modelIsCurrent() {return S.model && S.data && String(S.modelVersion)===String(S.data.model_version) && String(S.modelInstance)===String(S.data.instance_id);}
function graphNodeValue(node) {
  const frames=S.data?.frames || {};
  if(node.kind==='node'||node.kind==='control') {
    const activity=graphActivity(node,S.data);
    if(!activity)return '需重启服务启用任务统计';
    if(activity.active_task_id!=null)return `活动 #${activity.active_task_id} · 待 ${activity.pending} · 完 ${activity.completed}`;
    return `待 ${activity.pending} · 完 ${activity.completed} · 总 ${activity.total}`;
  }
  if(node.kind==='state') {const value=S.data?.status?.states?.[node.stateId];return value?`值 ${value.value} · 版本 ${value.version}`:'状态未安装 / 尚未取得';}
  if(node.kind==='value')return `不可变值 ${short(node.value,24)}`;
  if(node.id==='runtime:pre_storage')return frames.business?`PRE 等待 ${frames.business.pending ?? frames.business.pre_queue?.length ?? '—'} · 活动帧 ${display(frames.business.active_frame)}`:'PRE 模块尚未初始化';
  if(node.id==='runtime:post_storage')return `队首帧 ${display(frames.head)} · 保留帧 ${display(frames.frame_total)}`;
  if(node.id==='runtime:outbox')return `输出 ${display(S.data?.outputs?.total)} · 未确认 ${display(S.data?.outputs?.unacknowledged)}`;
  if(node.id==='runtime:qualified') {const head=(frames.frames || []).find(frame=>String(frame.frame_id)===String(frames.head));return head?`队首 ${head.frame_id} · 资格 ${head.qualified?'有':'无'} · token ${head.token}`:'当前队首资格未取得';}
  if(node.id==='runtime:receive')return `保留批次 ${display(frames.batch_total)} · 显式宿主动作`;
  if(node.kind==='effect')return '任务内部操作 · 无独立 task_id';
  if(node.kind==='transaction')return `${node.transaction.steps.length} 个有序内部操作`;
  return node.kind==='external'?'外部显式请求 / 不自动执行':node.stage;
}
function graphLabel(node) {
  if(node.kind!=='node')return node.label;
  if(node.role) {const suffix=node.label.includes('.COMP.')?node.label.split('.COMP.')[1]:node.label.includes('.PRE.')?node.label.split('.PRE.')[1]:node.label.includes('.POST.')?node.label.split('.POST.')[1]:node.label.includes('.NEXT.')?node.label.split('.NEXT.')[1]:'';return `${node.width?`W${node.width} · `:''}${node.role}${suffix?` ${suffix}`:''}`;}
  return node.label;
}
function renderGraph() {
  if(!S.graph || !S.graphLayout)return;
  const graph=clear('model-graph'),layout=S.graphLayout,sourceVisible=$('show-sources').checked;
  S.graphElements=new Map();S.graphEdgeElements=new Map();
  graph.setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`);graph.style.width=`${layout.width*S.zoom}px`;graph.style.height=`${layout.height*S.zoom}px`;
  set('graph-zoom',`${Math.round(S.zoom*100)}%`);$('graph-empty').hidden=S.graph.nodes.length>0;
  const defs=svg('defs');
  for(const [id,color] of [['subscription','#be915b'],['spawn','#5baeb4'],['feedback','#c391d3'],['source','#8c7eac'],['other','#788da4']]){const marker=svg('marker',{id:`runtime-arrow-${id}`,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto'});marker.append(svg('path',{d:'M0 0 L10 5 L0 10z',fill:color}));defs.append(marker);}graph.append(defs);
  const navigation=clear('graph-layers'),overview=clear('graph-overview');
  const overviewItems=S.graph.business?[['外部输入','runtime:input'],['PRE 接纳 / 领取','runtime:PRE_ACCEPT'],['PRE → S/C → GO',S.graph.nodes.find(node=>node.role==='PRE')?.id],['COMP → COMMIT',S.graph.nodes.find(node=>node.role==='COMP')?.id],['POST / NEXT → FINISH',S.graph.nodes.find(node=>node.role==='POST')?.id],['STORE → 输出 EX','runtime:STORE'],['显式接收 → 完成控制','runtime:FRAME_COMPLETE'],['外部 ACK → DEC / ACT','runtime:ACK_DEC']]:S.graph.frame?[['输入帧','runtime:input'],['INPUT_BIT → STORE','runtime:INPUT_BIT'],['输出 EX','runtime:emit'],['宿主交接 / 完成控制','runtime:FRAME_COMPLETE'],['外部 ACK / 重发消费','runtime:ACK_DEC']]:[['外部 / 声明入口',S.graph.nodes.find(node=>node.kind==='external')?.id],['全部 JK 节点',S.graph.nodes.find(node=>node.kind==='node')?.id],['已提交输出',S.graph.nodes.find(node=>node.id==='runtime:outbox')?.id]];
  for(const [label,id] of overviewItems){if(!id)continue;const button=el('button','',label);button.addEventListener('click',()=>locateGraph(id));overview.append(button);}
  overview.title='导航只定位真实结构；箭头的成立条件见实际连接详情。ACK 由外部独立输入，完成控制不会自动发出 ACK。';
  for(const layer of layout.layers){graph.append(svg('rect',{x:layer.x-10,y:12,width:206,height:layout.height-28,rx:10,class:'graph-layer-background'}),svg('text',{x:layer.x,y:35,class:'graph-layer-title'},`L${layer.index} · ${layer.count} 项`),svg('text',{x:layer.x,y:55,class:'graph-layer-subtitle'},short(layer.stages.join(' / '),28)));const button=el('button','',`L${layer.index} ${short(layer.stages.join('/'),16)}`);button.addEventListener('click',()=>$('graph-viewport').scrollTo({left:Math.max(0,(layer.x-30)*S.zoom),behavior:'smooth'}));navigation.append(button);}
  let feedbackIndex=0;
  for(const edge of S.graph.edges) {
    const from=layout.positions.get(edge.source),to=layout.positions.get(edge.target);
    if(!sourceVisible&&isStateSourceEdge(edge))continue;
    const x1=from.x+from.width,y1=from.y+from.height/2,x2=to.x,y2=to.y+to.height/2;
    let path;
    if(edge.kind==='feedback'){const y=layout.height-20-(feedbackIndex++%8)*14;path=`M${from.x+from.width/2} ${from.y+from.height} V${y} H${to.x+to.width/2} V${to.y+to.height}`;}
    else if(x2>x1)path=`M${x1} ${y1} C${(x1+x2)/2} ${y1},${(x1+x2)/2} ${y2},${x2} ${y2}`;
    else {const bend=Math.max(x1,to.x+to.width)+24+(feedbackIndex++%4)*8;path=`M${x1} ${y1} C${bend} ${y1},${bend} ${y2},${to.x+to.width} ${y2}`;}
    const marker=['subscription','spawn','feedback','source'].includes(edge.kind)?edge.kind:['guard','write'].includes(edge.kind)?'source':'other';
    const line=svg('path',{d:path,class:`runtime-edge edge-${edge.kind}`,'marker-end':`url(#runtime-arrow-${marker})`,tabindex:0,role:'button','aria-label':`${edge.source} 到 ${edge.target}：${edge.label}`});line.append(svg('title',{},`${edge.kind} · ${edge.label}`));line.addEventListener('click',()=>select('graph_edge',edge));line.addEventListener('keydown',event=>{if(event.key==='Enter')select('graph_edge',edge);});graph.append(line);S.graphEdgeElements.set(edge.id,line);
  }
  for(const node of S.graph.nodes) {
    if(!sourceVisible&&['state','value'].includes(node.kind))continue;
    const pos=layout.positions.get(node.id),group=svg('g',{class:`runtime-node kind-${node.kind}`,tabindex:0,role:'button','aria-label':`${node.kind==='control'?'控制任务类型':node.kind==='node'?'普通JK节点':node.kind} ${node.label}`});
    group.append(svg('rect',{x:pos.x,y:pos.y,width:pos.width,height:pos.height,rx:node.kind==='control'?2:node.kind==='external'?18:7}));
    const type=node.kind==='node'?'JK EX':node.kind==='control'?'控制任务类型':node.kind==='effect'?'非任务操作':node.kind==='storage'?'存储区':node.kind==='external'?'外部动作':node.kind==='state'?'STATE':node.kind==='value'?'VALUE':'声明事务';
    group.append(svg('text',{x:pos.x+11,y:pos.y+16,class:'runtime-node-type'},`${type}${pos.cyclic?' · SCC':''}`),svg('text',{x:pos.x+11,y:pos.y+37,class:'runtime-node-label'},short(graphLabel(node),26)));
    const value=svg('text',{x:pos.x+11,y:pos.y+57,class:'runtime-node-state'},'等待观测');group.append(value);
    if(node.kind==='node')group.append(svg('text',{x:pos.x+11,y:pos.y+70,class:'runtime-node-id'},short(node.label,31)));
    group.append(svg('title',{},`${node.label}
${node.description || node.modelNode?.ex || ''}`));
    group.addEventListener('click',()=>node.kind==='node'?select('node',node.modelNode):select('graph',node));group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();node.kind==='node'?select('node',node.modelNode):select('graph',node);}});graph.append(group);S.graphElements.set(node.id,{group,value});
  }
  S.graphBuiltFor=S.modelVersion;updateGraphState();
}
function updateGraphState() {
  if(!S.graph)return;
  const current=modelIsCurrent();
  if(!current){set('graph-note','已安装结构版本正在同步；暂不叠加实时状态。');set('model-json-version',`保留版本 ${display(S.modelVersion)} · 正在同步`);set('model-json-note','当前模型版本已变化；此 JSON 为上次取得的完整模型，正在获取新版本。');$('model-json-copy').disabled=true;$('model-json-download').disabled=true;}
  const query=$('node-search').value.trim().toLowerCase(),matching=S.graph.nodes.filter(node=>`${node.label} ${node.stage} ${node.control || ''}`.toLowerCase().includes(query)),matchIds=new Set(matching.map(node=>node.id));
  for(const node of S.graph.nodes){const item=S.graphElements.get(node.id);if(!item)continue;const activity=current?graphActivity(node,S.data):null,active=activity?.active_task_id!=null;item.group.classList.toggle('active',Boolean(active));item.group.classList.toggle('queued',!active&&Number(activity?.pending)>0);item.group.classList.toggle('has-history',!active&&Number(activity?.completed)>0);item.group.classList.toggle('selected',S.selected?.type==='node'?node.nodeId===S.selected.record.id:S.selected?.type==='graph'&&node.id===S.selected.record.id);item.group.classList.toggle('search-dim',Boolean(query)&&!matchIds.has(node.id));item.value.textContent=current?short(graphNodeValue(node),32):'结构版本同步中';}
  const pending=current?pendingSubscriptionKeys(S.data?.events?.items || [],S.model.subscriptions || [],S.data?.status?.active_task):new Set();
  for(const edge of S.graph.edges){const line=S.graphEdgeElements.get(edge.id);if(!line)continue;line.classList.toggle('active',edge.kind==='subscription'&&pending.has(subscriptionIdentity(edge.subscription)));line.classList.toggle('search-dim',Boolean(query)&&!matchIds.has(edge.source)&&!matchIds.has(edge.target));}
  if(current)set('graph-note',`完整显示 ${S.graph.normalCount} / ${S.model.nodes.length} 个普通节点、${S.graph.subscriptionCount} 条订阅及 ${S.graph.nodes.length-S.graph.normalCount} 个运行时角色/存储项。${query?`搜索匹配 ${matching.length} 项，其他项仅淡化，未删除。 `:''}L 为前进依赖层；反馈、状态写回与条件读取不规定调度顺序。控制框表示任务类型，实例计数来自真实 task_activity；点击边查看成立条件。${S.data?.task_activity?'':' 当前服务缺少完整活动统计，请重启服务启用。'}`);
}
function locateGraph(id) {const pos=S.graphLayout?.positions.get(id);if(!pos)return;$('graph-viewport').scrollTo({left:Math.max(0,(pos.x-40)*S.zoom),top:Math.max(0,(pos.y-110)*S.zoom),behavior:'smooth'});}

async function showStructureView(view) {
  F.view=view;
  for(const name of ['runtime','factory']){$(`${name}-structure-view`).hidden=name!==view;$(`${name}-tab`).setAttribute('aria-selected',String(name===view));}
  if(S.selected && ['factory','factory_edge','node','graph','graph_edge'].includes(S.selected.type)){S.selected=null;renderInspector();}
  if(view==='factory') {
    if(!F.bundle)await loadFactoryDesign();else renderFactoryGraph();
  } else if(S.graph)set('model-count',`${fmt(S.graph.normalCount)} 个普通节点 · ${fmt(S.graph.subscriptionCount)} 条真实订阅`);
}
async function loadFactoryDesign() {
  if(F.loading)return;F.loading=true;$('factory-reload').disabled=true;
  set('factory-note','正在读取 JKRD7 工厂定义；不安装模型或推进运行时。');
  try {
    const bundle=await api('/api/factory-design');
    ({buildFactoryGraph,factoryDefinitions,factoryNodeStatus,layoutFactoryGraph}=await import('./factory.mjs'));
    factoryDefinitions(bundle); // Validate required documents before replacing a visible definition.
    F.bundle=bundle;renderFactoryTree();renderFactoryJSON();renderFactoryGraph(true);
  } catch(error) {set('factory-note',`工厂定义读取失败：${error.message}。${F.bundle?'保留上次静态定义。':'请重启更新后的 serve 进程；实时模型视图仍可使用。'}`);}
  finally {F.loading=false;$('factory-reload').disabled=false;}
}
function renderFactoryTree() {
  const target=clear('factory-tree'),{definitions}=factoryDefinitions(F.bundle);
  function branch(id,path=new Set()) {
    const definition=definitions.get(id);
    if(!definition)return el('span','','未解析：'+id);
    const button=el('button','factory-tree-item',definition.members?`${id} · ${definition.trigger.transaction?'局部事务':'普通 JKS'}`:`${id} · JKI`);
    button.addEventListener('click',()=>{
      if(!F.graph?.nodes.some(n=>n.id===`design:${id}`)){$('factory-scope').value='all';renderFactoryGraph();}
      selectFactory(F.graph.nodes.find(n=>n.id===`design:${id}`));locateFactory(`design:${id}`);
    });
    if(!definition.members)return button;
    const details=el('details'),summary=el('summary');summary.append(button);details.append(summary);details.open=id==='R1';
    if(!path.has(id)){const next=new Set(path);next.add(id);const children=el('div','factory-tree-children');for(const member of definition.members)children.append(branch(member,next));details.append(children);}
    return details;
  }
  target.append(branch('R1'));
}
function selectFactory(record,type='factory') {if(!record)return;S.selected={type,record};renderInspector();updateFactorySearch();}
function locateFactory(id) {const p=F.layout?.positions.get(id);if(p)$('factory-viewport').scrollTo({left:Math.max(0,(p.x-35)*F.zoom),top:Math.max(0,(p.y-90)*F.zoom),behavior:'smooth'});}
function renderFactoryGraph(fit=false) {
  if(!F.bundle)return;
  F.graph=buildFactoryGraph(F.bundle,$('factory-scope').value);
  const visibleNodes=F.graph.nodes.filter(n=>$('factory-sources').checked||n.kind!=='binding'),visibleIds=new Set(visibleNodes.map(n=>n.id));
  const visible={...F.graph,nodes:visibleNodes,edges:F.graph.edges.filter(e=>visibleIds.has(e.source)&&visibleIds.has(e.target))};
  F.layout=$('factory-layout').value==='vertical'?layoutFactoryGraph(visible,Math.floor(($('factory-viewport').clientWidth-70)/220)):layerGraph(visible);
  if(fit)F.zoom=Math.max(.06,Math.min(1,$('factory-viewport').clientWidth/F.layout.width));
  const canvas=clear('factory-graph'),{width,height}=F.layout;
  canvas.setAttribute('viewBox',`0 0 ${width} ${height}`);canvas.style.width=`${width*F.zoom}px`;canvas.style.height=`${height*F.zoom}px`;
  F.elements=new Map();F.edges=new Map();$('factory-empty').hidden=F.graph.nodes.length>0;set('factory-zoom',`${Math.round(F.zoom*100)}%`);
  const defs=svg('defs'),marker=svg('marker',{id:'factory-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto'});marker.append(svg('path',{d:'M0 0 L10 5 L0 10z',fill:'#a7c6d8'}));defs.append(marker);canvas.append(defs);
  const nav=clear('factory-nav');
  for(const [label,id] of [['R1 / RAM.FACTORY','R1'],['F1 / JKI.FACTORY','F1'],['输入接纳','R1.ACCEPT'],['PRE 领取','R1.CLAIM'],['POST / NEXT','R1.RESULT'],['输出 EX','R1.SEND'],['完成资格','R1.COMPLETE'],['ACK0 / ACK1','R1.DEC0'],['回收','R1.GC']])if(F.graph.nodes.some(n=>n.id===`design:${id}`)){const button=el('button','',label);button.addEventListener('click',()=>locateFactory(`design:${id}`));nav.append(button);}
  for(const layer of F.layout.layers) {
    if(F.layout.vertical)canvas.append(svg('text',{x:24,y:layer.y-3,class:'graph-layer-title'},`L${layer.index} · ${layer.count} 项`));
    else canvas.append(svg('rect',{x:layer.x-10,y:12,width:206,height:height-28,rx:10,class:'graph-layer-background'}),svg('text',{x:layer.x,y:35,class:'graph-layer-title'},`L${layer.index} · ${layer.count} 项`));
  }
  let offset=0;
  for(const edge of F.graph.edges) {
    if(!$('factory-sources').checked&&(edge.kind==='source'||edge.source.startsWith('binding:')))continue;
    const a=F.layout.positions.get(edge.source),b=F.layout.positions.get(edge.target);
    if(!a||!b)continue;
    const x=a.x+a.width,y=a.y+a.height/2,tx=b.x,ty=b.y+b.height/2;
    const bottom=height-15-(offset++%8)*14;
    let path;
    if(F.layout.vertical) {
      const ax=a.x+a.width/2,ay=a.y+a.height,bx=b.x+b.width/2,by=b.y,side=width-14-(offset%3)*8;
      path=edge.rank&&by>ay?`M${ax} ${ay} C${ax} ${(ay+by)/2},${bx} ${(ay+by)/2},${bx} ${by}`:`M${x} ${y} H${side} V${ty} H${b.x+b.width}`;
    } else path=edge.kind==='feedback'?`M${x-20} ${a.y+a.height} V${bottom} H${tx+20} V${b.y+b.height}`:tx>x?`M${x} ${y} C${(x+tx)/2} ${y},${(x+tx)/2} ${ty},${tx} ${ty}`:`M${x} ${y} C${x+35} ${y},${x+35} ${ty},${tx+b.width} ${ty}`;
    const line=svg('path',{d:path,class:`runtime-edge edge-${edge.kind}`,'marker-end':'url(#factory-arrow)',tabindex:0,role:'button','aria-label':edge.label});line.append(svg('title',{},`${edge.kind} · ${edge.label}`));line.addEventListener('click',()=>selectFactory(edge,'factory_edge'));line.addEventListener('keydown',e=>{if(e.key==='Enter')selectFactory(edge,'factory_edge');});canvas.append(line);F.edges.set(edge.id,line);
  }
  const typeNames={jks:'JKS / 事务',jki:'JKI / 完整 EX',operation:'结构 / 协议操作',port:'事件 / 数据接口',storage:'JKI 存储区域',binding:'取值绑定定义',template:'未实例化模板'};
  for(const node of F.graph.nodes) {
    if(node.kind==='binding'&&!$('factory-sources').checked)continue;
    const p=F.layout.positions.get(node.id),group=svg('g',{class:`runtime-node factory-node kind-${node.kind}`,tabindex:0,role:'button','data-design-id':node.definitionId||node.id,'aria-label':`${typeNames[node.kind]} ${node.label}`});
    group.append(svg('rect',{x:p.x,y:p.y,width:p.width,height:p.height,rx:node.kind==='operation'?2:8}),svg('text',{x:p.x+10,y:p.y+17,class:'runtime-node-type'},typeNames[node.kind]),svg('text',{x:p.x+10,y:p.y+38,class:'runtime-node-label'},short(node.label,25)),svg('text',{x:p.x+10,y:p.y+59,class:'runtime-node-state'},short(factoryNodeStatus(node),30)));
    group.append(svg('title',{},`${node.label}\n${node.description||factoryNodeStatus(node)}`));group.addEventListener('click',()=>selectFactory(node));group.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectFactory(node);}});canvas.append(group);F.elements.set(node.id,group);
  }
  updateFactorySearch();
  if(F.view==='factory') {
    const all=[...factoryDefinitions(F.bundle).definitions.values()];
    set('model-count',`${all.filter(n=>n.members).length} 个 JKS · ${all.filter(n=>n.state).length} 个 JKI · 静态定义`);
  }
}
function updateFactorySearch() {
  if(!F.graph)return;
  const query=$('factory-search').value.trim().toLowerCase(),matching=new Set(F.graph.nodes.filter(n=>`${n.label} ${n.definitionId||''} ${n.stage}`.toLowerCase().includes(query)).map(n=>n.id));
  for(const [id,group] of F.elements){group.classList.toggle('search-dim',Boolean(query)&&!matching.has(id));group.classList.toggle('selected',S.selected?.type==='factory'&&S.selected.record.id===id);}
  for(const edge of F.graph.edges)F.edges.get(edge.id)?.classList.toggle('search-dim',Boolean(query)&&!matching.has(edge.source)&&!matching.has(edge.target));
  set('factory-note',`${F.bundle.version} 定义视图：${F.graph.jksCount} 个 JKS、${F.graph.jkiCount} 个 JKI、${F.graph.operationCount} 个结构操作。${query?`匹配 ${matching.size} 项，其余仅淡化。`:''}虚线的组成、取值和条件不规定执行次序；反馈不参与前进分层。q / seed 为定义值，未叠加当前 V6.1 实例状态；动态槽模板尚未实例化。`);
}
function renderFactoryJSON() {
  const raw=F.bundle?.document_json?.[$('factory-json-source').value];set('factory-json',raw||'定义尚未读取');
  $('factory-json-copy').disabled=!raw;$('factory-json-download').disabled=!raw;
}

function renderTrace(rows=S.historyMode ? (S.historyRows || []) : S.traces) {
  const target=clear('trace-body'), filter=$('trace-filter').value, items=rows.filter(row=>filter==='all'||row.kind===filter).slice(-350);
  for(const row of items) {
    const tr=el('tr');tr.append(el('td','',row.seq));const kind=el('td');kind.append(el('span',`kind-label ${row.kind}`,kindNames[row.kind] || row.kind));tr.append(kind,el('td','',`t ${display(row.task)} · e ${display(row.event)}`),el('td','',row.source?`${row.source} → ${row.target}.${row.port}`:row.node),el('td','',row.params!=null?JSON.stringify(row.params):row.value??row.seed??row.outcome),el('td','',typedKey(row.key,row.key_type)));tr.addEventListener('click',()=>select('trace',row));target.append(tr);
  }
  if(!items.length) {const tr=el('tr'),td=el('td','',S.data?.trace?.total?'当前筛选没有记录。':'还没有轨迹；提交输入后可逐步执行。');td.colSpan=6;tr.append(td);target.append(tr);}
  const total=S.data?.trace?.total || 0;
  set('trace-note',S.historyMode?`历史分页 · 已读到游标 ${S.historyCursor}。实时现场继续更新；点击“跟随最新”返回。`:`运行时累计 ${fmt(total)} 条轨迹；本页保留最近 ${S.traces.length} 条，当前显示 ${items.length} 条。高速采样可能省略中间记录，可“读取历史”分页查看。`);
  if(S.follow&&!S.historyMode) {const scroll=target.closest('.table-scroll');scroll.scrollTop=scroll.scrollHeight;}
}
async function loadHistory() {
  try {const data=await api(`/api/trace?after=${encodeURIComponent(S.historyCursor)}&limit=200`);S.historyCursor=data.next_cursor;S.historyMode=true;S.historyRows=data.items || [];S.follow=false;set('trace-follow','跟随最新：关');renderTrace();$('load-history').textContent=data.has_more?'下一页历史':'从头读取历史';if(!data.has_more)S.historyCursor=0;} catch(error){fail(error);}
}
function renderChart() {
  const canvas=$('trend-chart'), rect=canvas.getBoundingClientRect(), dpr=window.devicePixelRatio||1;
  if(!rect.width)return;canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=rect.width,h=rect.height,p={l:40,r:43,t:14,b:25};
  const points=S.samples,maxQ=Math.max(4,...points.flatMap(point=>[point.pending,point.events,point.tokens])),maxR=Math.max(1,...points.map(point=>point.rate));
  ctx.font='9px ui-monospace, monospace';ctx.textBaseline='middle';
  for(let i=0;i<=4;i++){const y=p.t+(h-p.t-p.b)*i/4;ctx.strokeStyle='#26374a';ctx.setLineDash([3,5]);ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#66809a';ctx.textAlign='right';ctx.fillText((maxQ*(1-i/4)).toFixed(0),p.l-7,y);ctx.textAlign='left';ctx.fillText((maxR*(1-i/4)).toFixed(1),w-p.r+7,y);}
  const end=points.at(-1)?.time||Date.now(),start=end-60000;
  for(const [key,color,scale] of [['pending','#4bd9d1',maxQ],['events','#ffb362',maxQ],['tokens','#b299fa',maxQ],['rate','#77dfa5',maxR]]) {ctx.strokeStyle=color;ctx.lineWidth=1.7;ctx.beginPath();points.forEach((point,index)=>{const x=p.l+(point.time-start)/60000*(w-p.l-p.r),y=p.t+(1-Math.min(scale,point[key])/scale)*(h-p.t-p.b);if(index)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();}
  ctx.fillStyle='#6d879f';ctx.textAlign='left';ctx.fillText('−60 s',p.l,h-9);ctx.textAlign='right';ctx.fillText('现在',w-p.r,h-9);
  if(points.length<2){ctx.textAlign='center';ctx.fillText('等待连续采样',w/2,h/2);}
}
function renderInput() {
  const target=clear('input-form'), model=S.model;
  if(model.inputs?.length) {
    const form=el('form','send-form'), fields=el('div','input-fields');
    for(const input of model.inputs) {const label=el('label','',input.name), select=el('select');select.dataset.port=input.name;select.setAttribute('aria-label',`输入 ${input.name}`);for(const [value,text] of [['0','0'],['1','1'],['skip','不发送']]){const option=el('option','',text);option.value=value;select.append(option);}label.append(select);fields.append(label);}
    const keyRow=el('div','key-row'),key=el('input');key.type='text';key.placeholder='null、1 或 "frame-1"';key.setAttribute('aria-label','业务 key（JSON）');keyRow.append(el('label','','业务 key'),key);
    const send=el('button','primary','发送输入');send.type='submit';send.dataset.submitInput='true';form.append(fields,keyRow,send);form.addEventListener('submit',event=>{event.preventDefault();try {const values=Object.create(null);fields.querySelectorAll('select').forEach(select=>{if(select.value!=='skip')values[select.dataset.port]=Number(select.value);});if(!Object.keys(values).length)throw new Error('至少选择一个输入端口。');command('send',{values,key:parseKey(key.value)});}catch(error){fail(error);}});target.append(form);
  }
  if(model.frame_module) {
    const form=el('form','frame-input'),label=el('label','form-label','输入帧 · JSON bit 数组'),input=el('textarea');input.value=model.business_module?'[1]':'[0, 1, 0, 1]';input.setAttribute('aria-label','帧输入值');label.append(input);const button=el('button','primary','提交一帧');button.type='submit';button.dataset.submitInput='true';form.append(label,button);form.addEventListener('submit',event=>{event.preventDefault();try {const values=JSON.parse(input.value);if(!Array.isArray(values)||!values.length||!values.every(value=>value===0||value===1))throw new Error('请输入非空的 0/1 数组。');command('submit_frame',{values});}catch(error){fail(error);}});target.append(form);
  }
  if(!model.inputs?.length&&!model.frame_module)target.append(empty('此模型未声明外部输入端口或帧模块。'));
  updateButtons();
}
function renderOutputs() {
  const target=clear('outputs'), outputs=S.data.outputs?.items || [];
  for(const record of outputs.slice(-80)) {
    const row=el('div','output-row'),details=el('div');details.append(el('span','',`${record.port} · #${record.output}`),el('small','',`任务 ${record.task} · ${record.node} · key ${typedKey(record.key,record.key_type)}`));details.addEventListener('click',()=>select('output',record));row.append(bit(record.value),details);
    if(record.acknowledged)row.append(el('span','delivered','已确认'));
    else if(record.output_id) {const button=el('button','','交付确认');button.dataset.action='ack_output';button.dataset.outputId=record.output_id;button.title='确认此 output_id 的应用交付；不是帧业务 ACK。';row.append(button);}
    target.append(row);
  }
  if(!outputs.length)target.append(empty('暂无已提交输出','↗'));
  if(Number(S.data.outputs?.total)>Math.min(80,outputs.length))target.append(el('p','truncate-note',`显示最近 ${Math.min(80,outputs.length)} / 累计 ${fmt(S.data.outputs.total)} 条输出；其余位于展示或观测窗口外。`));
  $('ack-controls').hidden=!S.data.frames?.enabled;
}
function renderFrames() {
  const state=S.data.frames||{}; $('frames-panel').hidden=!state.enabled;if(!state.enabled)return;
  set('frame-head',`队首帧 ${display(state.head)}`);
  set('business-status',state.business?`活动业务帧 ${display(state.business.active_frame)} · PRE 等待 ${display(state.business.pre_queue)} · 每帧的原始 PRE、POST 和状态槽分别保存。`:(state.initialized?'参数化帧模块：保存 → 输出 EX → 宿主交接 → 完成控制 → ACK 译码与动作。':'帧模块尚未初始化；只读观察不会创建帧或控制任务。'));
  const target=clear('frame-cards');
  for(const frame of (state.frames||[]).slice(0,60)) {
    const card=el('div',`frame-card${frame.consumed?' consumed':''}`),head=el('h3');head.append(el('span','',`FRAME ${frame.frame_id}`),el('span','phase-tag',frame.consumed?'已消费':frame.qualified?'ACK 合格':frame.stored?'已保存':'输入中'));card.append(head,el('p','',`世代 ${frame.generation} · 槽 ${frame.slot} / ${frame.slot_generation}`),el('p','',`输入到达 ${frame.arrived} / ${frame.input_width ?? frame.width} · 输出宽度 ${frame.width}`),el('p','',`持有批次 ${frame.held_batches}`));
    if(frame.pre_values)card.append(el('p','bits',`PRE   ${frame.pre_values.map(v=>v===null?'·':v).join(' ')}`));
    if(frame.post_values)card.append(el('p','bits',`POST  ${frame.post_values.join(' ')}`));
    if(frame.values && !frame.pre_values)card.append(el('p','bits',`DATA  ${frame.values.map(v=>v===null?'·':v).join(' ')}`));
    if(frame.values_truncated)card.append(el('p','truncate-note','载荷较长，仅显示前一部分。'));
    if(frame.pre_stage!=null)card.append(el('p','',`阶段码 ${frame.pre_stage} · 领取 t${display(frame.claim_task_id)} · 完成 t${display(frame.finish_task_id)}`));
    card.addEventListener('click',()=>select('frame',frame));target.append(card);
  }
  if(!state.frames?.length)target.append(empty('没有帧记录'));
  if(state.truncated || state.frames?.length>60 || state.batches?.length>40 || state.blocks?.length>40)target.append(el('p','truncate-note',`显示 ${Math.min(60,state.frames?.length || 0)} / ${fmt(state.frame_total ?? state.frames?.length ?? 0)} 帧、${Math.min(40,state.batches?.length || 0)} / ${fmt(state.batch_total ?? state.batches?.length ?? 0)} 批次、${Math.min(40,state.blocks?.length || 0)} / ${fmt(state.block_total ?? state.blocks?.length ?? 0)} 块。展示或观测窗口已截断，优先展示在途所有权。`));
  if(state.business?.truncated)target.append(el('p','truncate-note',`PRE 等待队列显示 ${state.business.pre_queue?.length || 0} / ${fmt(state.business.pending)} 帧；其余位于观测窗口外。`));
  const batches=clear('batch-cards');for(const batch of (state.batches||[]).slice(0,40)) {const item=el('button','block-card',`BATCH ${batch.batch_id} · frame ${batch.frame_id} · ${batch.replay?'重发':'首发'} · ${batch.produced}/${Number(batch.width)+1} 输出 · ${batch.received?'已接收':'待接收'} · 完成控制 t${display(batch.completion_task_id)}`);item.addEventListener('click',()=>select('batch',batch));batches.append(item);}
  const blocks=clear('block-cards');for(const block of (state.blocks||[]).slice(0,40))blocks.append(el('div','block-card',`BLOCK ${block.block_id} · g${block.generation} · used ${block.used} / live ${block.live} · 持有 ${block.held_batches}`));
}

const stageDescriptions={ingress:{阶段:'接入与锁存',说明:'外部输入与控制请求先形成 FIFO 任务；accepted、device_visible、durable 分别表示接纳、设备可见和持久。传输完成不触发模型事件。'},queue:{阶段:'任务队列',说明:'task_queue 包含模型声明的多条 FIFO。当前活动任务完整结束后，选择最小 priority 的非空队列队首。'},select:{阶段:'领取唯一活动任务',说明:'同实例最多一个活动任务。任务被取出后不计入等待 FIFO 数量；失败或资源等待保留其身份。'},execute:{阶段:'参数绑定与 EX',说明:'PARAM 已锁存；STATE 与固定 seed 在实际执行时绑定。阶段推进不是单条 J/K 指令单步。'},commit:{阶段:'提交与发布',说明:'按任务契约提交状态与不可变结果。只有满足发布条件才生成事件；EX 算完不等于任务完整结束。'},events:{阶段:'当前任务事件队列',说明:'只消费当前 active_task 所属事件。待传播数与保留历史事件总数分开。'},propagate:{阶段:'传播与投递',说明:'沿实际订阅边投递，保留事件内逻辑顺序；同一任务内可以并行处理扇出。'},match:{阶段:'输入匹配与任务形成',说明:'ANY、ALL_LATEST、ZIP、KEYED 依契约匹配，0 是有效值。形成的目标任务只入 FIFO；未齐 token 留在等待区。'},complete:{阶段:'完整任务边界',说明:'执行提交、事件传播、目标匹配和新任务正式入队均完成，才结束任务并重新选择 FIFO。事件队列瞬时为空不能单独证明完成。'}};
document.querySelectorAll('[data-stage]').forEach(node=>{node.addEventListener('click',()=>select('stage',stageDescriptions[node.dataset.stage]));node.addEventListener('keydown',event=>{if(event.key==='Enter')select('stage',stageDescriptions[node.dataset.stage]);});});
$('clear-selection').addEventListener('click',()=>{S.selected=null;renderInspector();renderGraph();if(F.graph)updateFactorySearch();});
$('node-search').addEventListener('input',()=>{updateGraphState();const query=$('node-search').value.trim().toLowerCase();if(query){const found=S.graph?.nodes.find(node=>`${node.label} ${node.stage} ${node.control || ''}`.toLowerCase().includes(query));if(found)locateGraph(found.id);}});$('show-sources').addEventListener('change',()=>renderGraph());
$('zoom-in').addEventListener('click',()=>{S.zoom=Math.min(2.5,S.zoom+.2);renderGraph();});$('zoom-out').addEventListener('click',()=>{S.zoom=Math.max(.15,S.zoom-.15);renderGraph();});$('zoom-reset').addEventListener('click',()=>{if(S.graphLayout)S.zoom=Math.max(.15,Math.min(1,$('graph-viewport').clientWidth/S.graphLayout.width));renderGraph();$('graph-viewport').scrollTo(0,0);});
$('trace-filter').addEventListener('change',()=>renderTrace());$('load-history').addEventListener('click',loadHistory);
$('trace-follow').addEventListener('click',()=>{S.follow=!S.follow;if(S.follow)S.historyMode=false;set('trace-follow',`跟随最新：${S.follow?'开':'关'}`);renderTrace();});
$('zoom-actual').addEventListener('click',()=>{S.zoom=1;renderGraph();});
$('graph-active').addEventListener('click',()=>{const task=S.data?.active_task;if(task)locateGraph(task.node?`node:${task.node}`:`runtime:${task.control}`);});
$('model-json-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(S.modelJSON);set('model-json-note','已复制当前完整模型 JSON；图中搜索不影响复制内容。');}catch{set('model-json-note','浏览器未开放剪贴板。可展开 JSON 手动选择，或使用下载按钮。');}});
$('model-json-download').addEventListener('click',()=>{if(!modelIsCurrent())return;const url=URL.createObjectURL(new Blob([S.modelJSON+'\n'],{type:'application/json;charset=utf-8'})),anchor=el('a');anchor.href=url;anchor.download=`jkcuda-model-v${S.modelVersion}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('runtime-tab').addEventListener('click',()=>showStructureView('runtime'));$('factory-tab').addEventListener('click',()=>showStructureView('factory'));
$('factory-reload').addEventListener('click',loadFactoryDesign);$('factory-scope').addEventListener('change',()=>{S.selected=null;renderInspector();renderFactoryGraph(true);});
$('factory-layout').addEventListener('change',()=>renderFactoryGraph(true));
$('factory-fit').addEventListener('click',()=>{renderFactoryGraph(true);$('factory-viewport').scrollTo(0,0);});$('factory-actual').addEventListener('click',()=>{F.zoom=1;renderFactoryGraph();});
$('factory-zoom-in').addEventListener('click',()=>{F.zoom=Math.min(2.5,F.zoom+.15);renderFactoryGraph();});$('factory-zoom-out').addEventListener('click',()=>{F.zoom=Math.max(.06,F.zoom-.15);renderFactoryGraph();});
$('factory-search').addEventListener('input',()=>{updateFactorySearch();const query=$('factory-search').value.trim().toLowerCase();if(query){const found=F.graph?.nodes.find(n=>`${n.label} ${n.definitionId||''} ${n.stage}`.toLowerCase().includes(query));if(found)locateFactory(found.id);}});
$('factory-sources').addEventListener('change',()=>renderFactoryGraph());$('factory-json-source').addEventListener('change',renderFactoryJSON);
$('factory-json-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(F.bundle.document_json[$('factory-json-source').value]);}catch{set('factory-note','剪贴板不可用，可展开 JSON 手动选择或下载。');}});
$('factory-json-download').addEventListener('click',()=>{const raw=F.bundle?.document_json?.[$('factory-json-source').value];if(!raw)return;const url=URL.createObjectURL(new Blob([raw],{type:'application/json;charset=utf-8'})),anchor=el('a');anchor.href=url;anchor.download=$('factory-json-source').value;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
renderFactoryJSON();
window.addEventListener('resize',renderChart);
const sectionObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)document.querySelectorAll('nav a').forEach(link=>link.classList.toggle('selected',link.getAttribute('href')===`#${entry.target.id}`));},{rootMargin:'-80px 0px -65% 0px'});
['overview','queues','topology','telemetry','io'].forEach(id=>sectionObserver.observe($(id)));
setInterval(()=>{if(!S.receivedAt)return;const age=Date.now()-S.receivedAt;set('sample-age',`采样于 ${(age/1000).toFixed(1)} 秒前`);if(age>5000)setConnection(false,'数据已过期 · 正在重连');},1000);

async function start() {
  updateButtons();
  try {
    const session=await api('/api/session');S.token=session.token;
    const initial=await api('/api/state?limit=200');observe(initial);await loadModel();
    if(new URLSearchParams(location.search).get('view')==='factory') {
      await showStructureView('factory');
      if(location.hash==='#topology')$('topology').scrollIntoView({block:'start',behavior:'instant'});
    }
  }
  catch(error){fail(error);setConnection(false,'初始连接失败 · 自动重试');setTimeout(start,3000);return;}
  const stream=new EventSource('/api/stream');S.stream=stream;
  const receive=event=>{try{observe(JSON.parse(event.data));}catch(error){fail(error);}};
  stream.addEventListener('state',receive);stream.onmessage=receive;
  stream.onerror=()=>setConnection(false);
}
start();

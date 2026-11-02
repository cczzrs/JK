/* Read-only structure projection. Edges describe contracts, never execute them.
 * Business/control overlays: business.py _construct and native/frames.hpp.
 * Layering: condensation of true forward dependencies; feedback/guards excluded.
 */
const nid = id => `node:${id}`;
const rid = id => `runtime:${id}`;
const sid = id => `state:${id}`;

export function buildRuntimeGraph(model) {
  const nodes = [], edges = [], ids = new Set();
  const add = (id, label, kind, extra={}) => {if(!ids.has(id)){ids.add(id);nodes.push({id,label,kind,...extra});}return id;};
  const link = (source,target,kind,label,extra={}) => edges.push({id:`edge:${edges.length}`,source,target,kind,label,rank:!['guard','feedback','write','membership'].includes(kind),...extra});
  const control = (name,label,description) => add(rid(name),label,'control',{control:name,stage:'运行时控制',description});
  const normal = new Map((model.nodes || []).map(node => [node.id,node]));
  const business=model.business_module, frame=model.frame_module;
  const roles=new Map();
  if(business) for(const profile of business.widths || []) {
    const prefix=`${business.spec.prefix}.w${profile.input_width}`;
    for(const id of profile.pre_nodes)roles.set(id,{stage:'PRE 复制',width:profile.input_width,role:'PRE'});
    roles.set(profile.finish_node,{stage:'FINISH',width:profile.input_width,role:'FINISH'});
    for(const id of profile.protected_nodes || []) {
      if(roles.has(id))continue;
      const suffix=id.startsWith(prefix+'.')?id.slice(prefix.length+1):'';
      const role=suffix.split('.')[0];
      if(['S','C','GO','COMP','COMMIT','POST','NEXT'].includes(role))roles.set(id,{stage:role==='S'||role==='C'?'S / C':role==='POST'||role==='NEXT'?'POST / NEXT':role,width:profile.input_width,role});
    }
  }
  if(frame){roles.set(frame.data_node,{stage:'输出 EX',role:'DATA'});roles.set(frame.marker_node,{stage:'输出 EX',role:'MARKER'});}
  for(const node of model.nodes || []) add(nid(node.id),node.id,'node',{nodeId:node.id,modelNode:node,stage:'JK 计算',...roles.get(node.id)});
  for(const edge of model.subscriptions || []) link(nid(edge.source),nid(edge.target),'subscription',`${edge.port} · order ${edge.order}`,{subscription:edge});
  for(const state of model.states || []) add(sid(state.id),state.id,'state',{stage:'独立状态槽',stateId:state.id,description:'STATE 在任务实际执行时读取；写回不直接生成任务。',initial:state.initial});
  for(const [id,value] of Object.entries(model.values || {})) add(`value:${id}`,id,'value',{stage:'不可变值',value,description:'模型声明的已有不可变 VALUE。'});
  for(const node of model.nodes || []) {
    for(const [name,source] of Object.entries(node.sources || {})) {
      if(source.kind==='STATE')link(sid(source.state),nid(node.id),'source',`读取 STATE · ${name}`);
      if(source.kind==='VALUE')link(`value:${source.value_id}`,nid(node.id),'source',`读取 VALUE · ${name}`);
    }
    if(node.state)link(nid(node.id),sid(node.state),'write','提交写回状态槽');
  }
  for(const input of model.inputs || []) {const id=add(`input:${input.name}`,input.name,'external',{stage:'外部输入',description:'send 校验与锁存后形成此输入节点的独立 FIFO 任务。',input});link(id,nid(input.node),'spawn',`输入任务 · ${input.param}`);}
  for(const name of model.entrypoints || []) {const id=add(`entry:${name}`,`submit(${name})`,'external',{stage:'手动入口',description:'显式入口产生正常 FIFO 任务。'});link(id,nid(name),'spawn','声明入口入队');}
  for(const transaction of model.transactions || []) {const id=add(`transaction:${transaction.name}`,transaction.name,'transaction',{stage:'声明事务',description:'单个 FIFO 事务任务；内部操作按声明顺序，不是逐个独立领取任务。',transaction});for(const [index,step] of (transaction.steps||[]).entries())link(id,nid(step.node),'membership',`内部步骤 ${index+1}（不表示独立入队）`);}
  const hasOutputs=(model.nodes || []).some(node=>node.output!=null);
  if(hasOutputs) {
    add(rid('outbox'),'已提交输出 / outbox','storage',{stage:'宿主输出',description:'不可变输出记录；观察此区域不会执行宿主接收或 ACK。'});
    add(rid('receive'),'显式接收输出','external',{stage:'宿主交接',description:frame?'read_output / read_frame_batches 在完整批次交接前可靠排入 FRAME_COMPLETE；接收本身不建立资格。':'应用调用 read_output 接收已提交的不可变输出；ack_output 是应用交付确认。'});
    for(const node of model.nodes || []) if(node.output!=null)link(nid(node.id),rid('outbox'),'publish',`满足发布条件 → ${node.output}`);
    link(rid('outbox'),rid('receive'),'receipt',frame?'整批数据 + marker 就绪且显式接收':'显式调用 read_output');
  }
  if(frame) {
    add(rid('input'),'submit_frame / 输入帧','external',{stage:'外部接入',description:'每帧 W 个 bit 分别成为 INPUT_BIT 任务，持有独立输入载荷。'});
    control('INPUT_BIT','INPUT_BIT · 输入位','每位独立 FIFO 控制任务；写入原始输入；最后一位到达才形成 PRE_ACCEPT（业务模型）或 STORE。');
    control('STORE','STORE · 帧存储','保存已取得的帧值并接入输出帧队列；只有原队列为空时立即形成首发输出任务。');
    add(rid('post_storage'),'保存帧 / 输出队列','storage',{stage:'帧存储',description:'独立保存帧值、块/槽世代和输出队首；慢 ACK 延长保留。'});
    add(rid('emit'),'形成 DATA / marker 批次','effect',{stage:'输出任务形成',description:'native emit 是 STORE / ACK_ACT 内部操作，不是额外模型节点或独立任务；批次中每个输出 EX 分别入 FIFO。'});
    control('FRAME_COMPLETE','FRAME_COMPLETE · 完成通知','核对批次与世代；仅有效首发、未消费的当前队首建立资格。重发完成不重新建立首发资格。');
    add(rid('qualified'),'队首资格 / token','storage',{stage:'ACK 资格',description:'由 FRAME_COMPLETE 执行时有条件更新；不自动生成 ACK_DEC。'});
    add(rid('ack_input'),'外部 ACK 0 / 1','external',{stage:'ACK 外部接入',description:'ack_frame(0/1) 形成独立 ACK_DEC FIFO 任务。ACK0 重发，ACK1 消费。'});
    control('ACK_DEC','ACK_DEC · 译码','实际执行时读取当前队首与资格；有资格才绑定帧/槽世代和 token，形成 ACK_ACT。无资格正常结束。');
    control('ACK_ACT','ACK_ACT · 动作','只处理 DEC 绑定的帧，核对队首、世代和 token；过期无效果，不重新选择后继帧。');
    add(rid('consume'),'消费与队首推进','effect',{stage:'ACK1 效果',description:'有效 ACK1 在 ACK_ACT 内消费原帧并推进队首；有后继才形成后继首发输出。不是独立任务。'});
    link(rid('input'),rid('INPUT_BIT'),'spawn','W 个输入任务分别入 FIFO');
    link(rid('STORE'),rid('post_storage'),'write','登记帧 / 块 / 输出队列');
    link(rid('STORE'),rid('emit'),'effect','条件：输出队列原为空 → 内部形成首发批次 marker=1');
    link(rid('emit'),nid(frame.data_node),'spawn','逐数据位形成独立 EX 任务');
    link(rid('emit'),nid(frame.marker_node),'spawn','数据之后形成 marker EX 任务');
    link(rid('receive'),rid('FRAME_COMPLETE'),'spawn','完整批次交接前可靠排入完成控制');
    link(rid('FRAME_COMPLETE'),rid('qualified'),'effect','有效首发 + 当前队首 + 未消费 → 建立资格');
    link(rid('ack_input'),rid('ACK_DEC'),'spawn','独立 ACK 输入任务');
    link(rid('qualified'),rid('ACK_DEC'),'guard','执行时读取；无资格正常结束');
    link(rid('post_storage'),rid('ACK_DEC'),'guard','执行时读取当前队首');
    link(rid('ACK_DEC'),rid('ACK_ACT'),'spawn','仅有资格：锁存帧 / 世代 / token / ACK');
    link(rid('ACK_ACT'),rid('emit'),'feedback','ACK0 且绑定仍有效 → 同帧重发 marker=0');
    link(rid('ACK_ACT'),rid('consume'),'effect','ACK1 且绑定仍有效 → 消费原帧');
    link(rid('consume'),rid('emit'),'feedback','仅有后继帧 → 后继首发 marker=1');
    link(rid('consume'),rid('post_storage'),'write','推进输出帧队首');
    link(rid('consume'),rid('qualified'),'write','ACK1 清除原帧资格与 token');
    if(business) {
      control('PRE_ACCEPT','PRE_ACCEPT · 接纳','原始输入已齐才把帧加入 PRE 队列；仅无活动业务帧且队首尚未被领取时形成 CLAIM。');
      control('CLAIM','CLAIM · 领取业务帧','领取 PRE 队首并锁定唯一活动业务帧；按本帧宽度形成独立 PRE 复制 EX 任务。');
      add(rid('pre_storage'),'原始 PRE / 等待帧','storage',{stage:'PRE 等待区',description:'原始输入与计算后 POST 分开保存；下一业务帧在当前 FINISH 后才能领取。'});
      link(rid('INPUT_BIT'),rid('pre_storage'),'write','各位写原始 PRE；0 是有效值');
      link(rid('INPUT_BIT'),rid('PRE_ACCEPT'),'spawn','条件：最后一个输入位到达');
      link(rid('PRE_ACCEPT'),rid('pre_storage'),'write','加入 PRE 等待 FIFO');
      link(rid('PRE_ACCEPT'),rid('CLAIM'),'spawn','条件：业务空闲且队首尚未被领取');
      link(rid('pre_storage'),rid('CLAIM'),'guard','领取队首；检查宽度与完整输入');
      for(const profile of business.widths || []) {
        for(const id of profile.pre_nodes)link(rid('CLAIM'),nid(id),'spawn',`匹配 W=${profile.input_width}：锁存对应输入位`);
        link(nid(profile.finish_node),rid('STORE'),'spawn',`W=${profile.input_width} FINISH 提交：保存已有 POST，形成 STORE`);
        link(nid(profile.finish_node),rid('post_storage'),'write','转存已锁存 POST 值（不重算 COMP）');
        link(nid(profile.finish_node),rid('CLAIM'),'feedback','并列分支：释放当前业务帧；PRE 非空才排下一 CLAIM');
      }
    } else link(rid('INPUT_BIT'),rid('STORE'),'spawn','条件：最后一个输入位到达');
  }
  return {nodes,edges:edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)),normalCount:normal.size,subscriptionCount:(model.subscriptions || []).length,business:Boolean(business),frame:Boolean(frame)};
}

export function layerGraph(graph) {
  const ids=graph.nodes.map(node=>node.id), adjacency=new Map(ids.map(id=>[id,[]])), reverse=new Map(ids.map(id=>[id,[]]));
  for(const edge of graph.edges)if(edge.rank!==false){adjacency.get(edge.source).push(edge.target);reverse.get(edge.target).push(edge.source);}
  const visited=new Set(),order=[];
  // Iterative Kosaraju avoids recursion limits on large models.
  for(const root of ids) {
    if(visited.has(root))continue;
    visited.add(root);const stack=[[root,0]];
    while(stack.length){const top=stack[stack.length-1],children=adjacency.get(top[0]);if(top[1]<children.length){const child=children[top[1]++];if(!visited.has(child)){visited.add(child);stack.push([child,0]);}}else{order.push(top[0]);stack.pop();}}
  }
  const component=new Map(),members=[];
  for(const root of order.reverse()){if(component.has(root))continue;const group=members.length,list=[],stack=[root];component.set(root,group);while(stack.length){const id=stack.pop();list.push(id);for(const previous of reverse.get(id))if(!component.has(previous)){component.set(previous,group);stack.push(previous);}}members.push(list);}
  const outgoing=members.map(()=>new Set()),indegree=members.map(()=>0),levels=members.map(()=>0);
  for(const edge of graph.edges)if(edge.rank!==false){const a=component.get(edge.source),b=component.get(edge.target);if(a!==b&&!outgoing[a].has(b)){outgoing[a].add(b);indegree[b]++;}}
  const ready=[];indegree.forEach((degree,id)=>{if(!degree)ready.push(id);});for(let cursor=0;cursor<ready.length;cursor++){const id=ready[cursor];for(const next of outgoing[id]){levels[next]=Math.max(levels[next],levels[id]+1);if(--indegree[next]===0)ready.push(next);}}
  const byLayer=new Map(),nodeMap=new Map(graph.nodes.map(node=>[node.id,node]));
  for(const id of ids){const level=levels[component.get(id)];if(!byLayer.has(level))byLayer.set(level,[]);byLayer.get(level).push(nodeMap.get(id));}
  // Keep width branches together while preserving all nodes in each layer.
  const priority={external:0,port:0,control:1,jks:1,node:2,jki:2,transaction:3,operation:3,effect:4,template:4,storage:5,state:6,value:7,binding:7};
  for(const list of byLayer.values())list.sort((a,b)=>(a.width??0)-(b.width??0)||(priority[a.kind]-priority[b.kind])||a.label.localeCompare(b.label,undefined,{numeric:true}));
  const positions=new Map(),layers=[];let height=0;
  for(const [index,list] of [...byLayer.entries()].sort((a,b)=>a[0]-b[0])) {
    const x=40+index*230;layers.push({index,x,stages:[...new Set(list.map(node=>node.stage))],count:list.length});
    list.forEach((node,row)=>positions.set(node.id,{x,y:88+row*104,width:186,height:76,layer:index,scc:component.get(node.id),cyclic:members[component.get(node.id)].length>1||adjacency.get(node.id).includes(node.id)}));
    height=Math.max(height,88+list.length*104);
  }
  const feedbackCount=graph.edges.filter(edge=>edge.kind==='feedback').length;
  return {positions,layers,width:Math.max(800,byLayer.size*230+90),height:Math.max(390,height+50+Math.min(feedbackCount,8)*14),components:members};
}

export function graphActivity(node, observation) {
  if(node.kind==='node')return observation?.task_activity?.nodes?.[node.nodeId] ?? null;
  if(node.kind==='control')return observation?.task_activity?.controls?.[node.control] ?? null;
  return null;
}
export function isStateSourceEdge(edge) {
  return ['state:','value:'].some(prefix=>edge.source.startsWith(prefix)||edge.target.startsWith(prefix));
}

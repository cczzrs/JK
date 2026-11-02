/* JKRD7 definition projection only. Never evaluates EX or borrows V6.1 activity. */
import {layerGraph} from './graph.mjs';
const key = id => `design:${id}`;
const titles = {
  F1:'JKI.FACTORY · F1', R1:'RAM.FACTORY · R1', RAM1:'RAM 结构 · RAM1',
  'F1.CONTROL':'控制 / 检查 / 生成',
  'R1.ACCEPT':'输入接纳', 'R1.CLAIM':'PRE 领取', 'R1.RESULT':'POST / NEXT 保存',
  'R1.READ':'读出与批次准备', 'R1.RELAY':'中转 / 输出锁存', 'R1.SEND':'输出 EX',
  'R1.COMPLETE':'输出完成 / 资格', 'R1.DEC0':'ACK0 译码', 'R1.DEC1':'ACK1 译码',
  'R1.ACT0':'ACK0 重发动作', 'R1.ACT1':'ACK1 消费动作', 'R1.GC':'安全回收',
  'R1.READY':'业务 READY 接入',
};
const factoryRoles = {
  Q1:'b0 状态类型', Q2:'b1 初始值', Q3:'b2 允许 0', Q4:'b3 允许 1', Q5:'b4 变化限制',
  Q6:'b0 有效标志', Q7:'b1 有效标志', Q8:'b2 有效标志', Q9:'b3 有效标志', Q10:'b4 有效标志',
  Q11:'b5=0 清空检测', Q12:'b5 前态 / 上升沿', Q13:'五位完整性检查',
};
const stageOrder = ['R1.ACCEPT','R1.READY','R1.CLAIM','COMP','R1.RESULT','R1.READ',
  'R1.RELAY','R1.SEND','R1.COMPLETE','R1.DEC0','R1.DEC1','R1.ACT0','R1.ACT1','R1.GC'];

export function factoryDefinitions(bundle) {
  const definitions = new Map(), owners = new Map();
  for (const name of ['JKI.FACTORY.json','RAM.FACTORY.json']) {
    const root = bundle.documents?.[name];
    if (!root) throw new Error(`缺少设计文件：${name}`);
    definitions.set(root.id,root); owners.set(root.id,root.id);
    for (const [id,definition] of Object.entries(root.pro.definitions || {})) {
      definitions.set(id,definition); owners.set(id,root.id);
    }
  }
  return {definitions,owners};
}

export function factoryNodeStatus(node) {
  if (node.kind === 'jki') {
    const state = node.definition.state;
    return `定义 ${'q' in state ? 'q' : 'seed'}=${state.q ?? state.seed} · 非实时`;
  }
  return node.kind === 'operation' ? '结构 / 协议操作 · 非 J/K' :
    node.kind === 'jks' ? (node.definition.trigger.transaction ? '局部事务 · 定义' : '普通组合 · 定义') : '静态设计 · 未观测';
}

export function layoutFactoryGraph(graph, columns=3) {
  const ranked=layerGraph(graph), positions=new Map(), layers=[];
  columns=Math.max(1,Math.min(3,columns));let y=54;
  for(const layer of ranked.layers) {
    const members=graph.nodes.filter(n=>ranked.positions.get(n.id).layer===layer.index);
    const top=y;
    members.forEach((node,index)=>positions.set(node.id,{...ranked.positions.get(node.id),x:24+(index%columns)*220,y:top+Math.floor(index/columns)*110}));
    y+=Math.ceil(members.length/columns)*110+35;
    layers.push({...layer,y:top-14,height:y-top});
  }
  return {...ranked,positions,layers,vertical:true,width:columns*220+70,height:y+35};
}

export function buildFactoryGraph(bundle, scope='overview') {
  if (!['overview','factory','ram','all'].includes(scope)) throw new Error('未知工厂视图');
  const {definitions,owners} = factoryDefinitions(bundle), nodes = [], edges = [], ids = new Set();
  const add = (id,label,kind,extra={}) => {
    if (!ids.has(id)) {ids.add(id);nodes.push({id,label,kind,design:true,...extra});}
    return id;
  };
  const link = (source,target,kind,label,extra={}) => {
    if (ids.has(source) && ids.has(target)) edges.push({id:`factory-edge:${edges.length}`,source,target,kind,label,
      rank:!['membership','source','guard','write','feedback'].includes(kind),design:true,...extra});
  };
  const defNode = id => {
    const definition = definitions.get(id);
    if (!definition) return null;
    const composite = Array.isArray(definition.members);
    return add(key(id),titles[id] || (id.startsWith('F1.WRITE') ? `输入 b${id.at(-1)} 写入` : factoryRoles[id] ? `${id} · ${factoryRoles[id]}` : id),composite?'jks':'jki',
      {definition,definitionId:id,owner:owners.get(id),stage:composite?'JKS 组合 / 事务':owners.get(id)==='F1'?'工厂 JKI':'RAM JKI',
       description:composite?'成员引用表达组成；事务边界由活动调用上下文决定。':'真实 JKI 定义；初始值不是已安装实例的当前状态。'});
  };
  const port = (id,label=id,description='设计中的事件或数据接口，不是额外 JKI。') => add(`port:${id}`,label,'port',{stage:'组合接口',description});
  const operation = (id,label,record) => add(id,label,'operation',{stage:'运行时结构 / 协议操作',record,description:'由运行时按所属 JKS 的操作契约实施；此处不执行该操作。'});
  const ram = definitions.get('R1');
  const dispatch = new Map(Object.entries(ram.pro.dispatch.internal_sources));
  for(const [source,targets] of Object.entries(ram.pro.dispatch))if(Array.isArray(targets))dispatch.set(`${ram.id}.${source}`,targets[0]);
  dispatch.set('COMP_REQUEST','COMP'); dispatch.set('R1.OUTPUT_DONE','R1.COMPLETE');
  const stageFor = nodeId => [...definitions.values()].find(item=>item.trigger?.transaction && item.id.startsWith('R1.') && item.members[0]===nodeId)?.id;

  if (scope==='overview') {
    for (const id of ['R1','F1','RAM1',...stageOrder.filter(id=>id!=='COMP')]) defNode(id);
    const input=port('FRAME_IN','DATA / FRAME_IN'), ack=port('ACK','独立外部 ACK 0 / 1');
    const comp=port('COMP','外接业务 JKS','业务计算由接入方明确声明；RAM 不代算 COMP。');
    const output=port('Y','Y[0..W-1] / FRAME_OUT');
    const pre=add('storage:PRE','PRE · 原始帧 JKI','storage',{stage:'原始帧等待区'});
    const post=add('storage:POST','POST / NEXT · 独立 JKI','storage',{stage:'结果 / 下一状态'});
    const qualified=add('storage:ACK','保留 H / ACK 资格','storage',{stage:'ACK 保留状态'});
    const draft=operation('operation:draft','生成待配置 JKI JSON',definitions.get('F1').pro.actions.find(a=>a.on.node==='Q13'&&a.on.value===1));
    const install=operation('operation:install','R1 配置 / 校验 / 安装',ram.pro.templates.install);
    link(key('R1'),key('F1'),'membership','R1 包含 F1；请求方身份保留 R1');
    link(key('R1'),key('RAM1'),'membership','R1 包含 RAM 结构');
    for (const id of definitions.get('RAM1').members) link(key('RAM1'),key(id),'membership','RAM 子结构 / 局部事务');
    link(key('F1'),draft,'effect','b5 上升沿且五位有效：生成一个草稿');
    link(draft,install,'effect','生成成功后清输入；草稿由 R1 配置，尚非活动节点');
    link(install,pre,'write','登记实际节点 / 槽 / 成员；原子安装');
    link(install,post,'write','数据由真实 EX 装载，不直接 write_q');
    link(input,key('R1.ACCEPT'),'spawn','FRAME_IN=1 且实际输入完整；0 只清未提交接入');
    link(key('R1.ACCEPT'),pre,'write','接业务时保存 PRE；单独存储模式直接 POST');
    link(key('R1.ACCEPT'),post,'write','独立存储模式：按序保存实际 W 位');
    link(pre,key('R1.CLAIM'),'guard','有效 PRE 队首 + READY + 未领取');
    link(comp,key('R1.RESULT'),'receipt','RESULT_IN：实际结果 / 下一状态已产生');
    link(key('R1.RESULT'),post,'write','POST 与 NEXT 分别执行装载 EX');
    link(post,key('R1.READ'),'guard','准备请求为队首、BUSY=0、实际来源已绑定');
    link(key('R1.SEND'),output,'publish','按位序输出实际 W 位，再输出 marker');
    link(key('R1.COMPLETE'),qualified,'effect','仅有效首发完成：保留 H 与资格共同提交');
    for (const dec of ['R1.DEC0','R1.DEC1']) {link(ack,key(dec),'spawn','ACK 独立到达，不由完成通知自动生成');link(qualified,key(dec),'guard','各 DEC 实际执行时读取当时资格与队首');}
    link(key('R1.ACT1'),post,'write','匹配原绑定帧才消费 / 推进队首');
    link(key('R1.ACT1'),qualified,'write','消费与撤销原资格同一提交');
    for (const binding of ram.pro.actions) {
      const from=stageFor(binding.on.node); if (!from) continue;
      for (const step of binding.steps) {
        const emitted=step.op==='after_commit'?step.emit:step.op==='stage_bound_action'?[{source:step.port}]:step.op==='after_publication_receipts'?[{source:step.emit,when:step.require}]:[];
        for (const event of Array.isArray(emitted)?emitted:[]) {
          const to=dispatch.get(event.source); if (!to) continue;
          const target=to==='COMP'?comp:key(to);
          const backwards=stageOrder.indexOf(to)<=stageOrder.indexOf(from);
          link(key(from),target,backwards?'feedback':'spawn',`${step.op==='after_publication_receipts'?'实际交付完成后':'提交后'}${event.when?`；条件：${event.when}`:''}`,{record:step});
        }
      }
    }
    return finish();
  }

  const include = id => scope==='all' || owners.get(id)===(scope==='factory'?'F1':'R1') || id==='F1';
  for (const id of definitions.keys()) if (include(id)) defNode(id);
  for (const [id,definition] of definitions) {
    if (!include(id)) continue;
    if (definition.members) {
      for (const member of definition.members) link(key(id),key(member),'membership','同实例的重复成员引用共享状态，不复制节点');
      continue;
    }
    for (const source of definition.trigger.any) {
      const from=ids.has(key(source))?key(source):port(source);
      link(from,key(id),source==='F1.CLEAR'?'feedback':'subscription','JKI trigger.any：每项实际投递产生一次激活');
    }
    const owner=definitions.get(owners.get(id));
    for (let index=0;index<definition.sources.s.length;index++) {
      const source=definition.sources.s[index]; let from=key(source);
      if (!ids.has(from)) from=add(`binding:${owner.id}:${source}`,source,'binding',{stage:'取值绑定定义',record:owner.pro.bindings[source],description:'PARAM 锁存、STATE 在实际 EX 入口读取；来源本身不新增触发或等待。'});
      link(from,key(id),'source',`${definition.sources.ex[index]} · sources[${index}]`,{record:owner.pro.bindings[source]});
    }
  }
  for (const owner of [definitions.get('F1'),ram]) {
    if (scope!=='all' && owner.id!==(scope==='factory'?'F1':'R1')) continue;
    for (const [bindingIndex,binding] of owner.pro.actions.entries()) {
      let previous=key(binding.on.node);
      for (const [index,step] of binding.steps.entries()) {
        const id=operation(`operation:${owner.id}:${bindingIndex}:${index}`,step.op,step);
        link(previous,id,'effect',index===0?`${binding.on.node} 完整 EX 后，结果=${binding.on.value}`:'声明操作次序；guard 未通过时终止本分支',{record:binding.on}); previous=id;
        if (step.op==='emit_internal') link(id,port(step.source),'feedback',`内部控制 ${step.source}=${step.v}`);
        if (step.op==='stage_reply') link(id,port(`${owner.id}.${step.port}`,step.port),'publish','根提交后才对外可见；父事务内部可交接实际结果');
        const emitted=step.op==='after_commit'?step.emit:step.op==='stage_bound_action'?[{source:step.port}]:step.op==='after_publication_receipts'?[{source:step.emit}]:[];
        for(const event of Array.isArray(emitted)?emitted:[]) {
          const feedback=['R1.READ_REQUEST','R1.TRY_CLAIM'].includes(event.source);
          link(id,port(event.source),feedback?'feedback':'spawn',`正式后继 / 接口投递${event.when?'；条件：'+event.when:''}`,{record:event});
        }
      }
    }
  }
  if (scope==='ram'||scope==='all') {
    const template=add('template:storage','动态槽 / 数据 JKI 模板','template',{stage:'尚未实例化',record:ram.pro.templates,description:'模板不是已安装节点；实例化后分配实际 id，并配置完整 trigger/sources、执行装载与合法性检查。'});
    link(key('F1'),template,'effect','每个实际节点均走完整工厂创建序列');
    link(template,key('RAM1'),'membership','原子登记后才成为活动 RAM 成员');
  }
  return finish();

  function finish() {
    return {nodes,edges,design:true,scope,definitionCount:definitions.size,
      jksCount:nodes.filter(n=>n.kind==='jks').length,jkiCount:nodes.filter(n=>n.kind==='jki').length,
      operationCount:nodes.filter(n=>n.kind==='operation').length};
  }
}

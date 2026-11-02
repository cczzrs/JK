import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildFactoryGraph,factoryDefinitions,factoryNodeStatus,layoutFactoryGraph} from './factory.mjs';
import {layerGraph,graphActivity} from './graph.mjs';

const documents=Object.fromEntries(['JKI.FACTORY.json','RAM.FACTORY.json'].map(name=>
  [name,JSON.parse(readFileSync(new URL(`../../assets/jks-factory-v7-design/${name}`,import.meta.url),'utf8'))]));
const bundle={version:'7.0.0',documents},original=JSON.stringify(bundle);
const definitions=factoryDefinitions(bundle).definitions;
assert.deepEqual(definitions.get('R1').members,['F1','RAM1']);
assert.equal(definitions.get('F1').pro.name,'JKI.FACTORY');
assert.deepEqual(definitions.get('F1').trigger,{});
assert.deepEqual(definitions.get('R1').trigger,{});
const graph=buildFactoryGraph(bundle),has=(source,target,kind)=>graph.edges.some(e=>e.source===source&&e.target===target&&(!kind||e.kind===kind));
// Expectations come from JKRD7 §13: stage calls are conditional, not membership order.
assert(has('design:R1','design:F1','membership'));
assert(has('design:R1.READ','design:R1.RELAY','spawn'));
assert(has('design:R1.RELAY','design:R1.SEND','spawn'));
assert(has('design:R1.SEND','design:R1.COMPLETE','spawn'));
assert(has('design:R1.DEC0','design:R1.ACT0','spawn'));
assert(has('design:R1.DEC1','design:R1.ACT1','spawn'));
assert(has('design:R1.ACT0','design:R1.READ','feedback'));
assert(has('design:R1.ACT1','design:R1.READ','feedback'));
assert(has('design:R1.ACT1','design:R1.GC','spawn'));
assert(has('port:ACK','design:R1.DEC0','spawn'));
assert(!has('design:R1.COMPLETE','design:R1.DEC0'));
assert(!has('design:R1.COMPLETE','port:ACK'));
assert(has('design:R1.CLAIM','port:COMP','spawn'));
assert(has('port:COMP','design:R1.RESULT','receipt'));
const layout=layerGraph(graph);
for(const [a,b] of [['R1.READ','R1.RELAY'],['R1.RELAY','R1.SEND'],['R1.SEND','R1.COMPLETE'],['R1.DEC0','R1.ACT0']])
  assert(layout.positions.get(`design:${a}`).layer<layout.positions.get(`design:${b}`).layer);
for(const edge of graph.edges.filter(e=>['feedback','guard','membership','source','write'].includes(e.kind)))assert.equal(edge.rank,false);
for(const columns of [1,2,3]) {
  const vertical=layoutFactoryGraph(graph,columns);
  assert(vertical.width<=730);
  for(const edge of graph.edges.filter(e=>e.rank)) {
    const a=vertical.positions.get(edge.source),b=vertical.positions.get(edge.target);
    assert(a.scc===b.scc||a.y<b.y);
  }
}
const factory=buildFactoryGraph(bundle,'factory'),all=buildFactoryGraph(bundle,'all');
assert.equal(factory.jkiCount,13);
assert.equal(all.jkiCount,65);
assert.equal(all.jksCount,22);
assert.equal(new Set(all.nodes.map(n=>n.id)).size,all.nodes.length);
for(const edge of all.edges)assert(all.nodes.some(n=>n.id===edge.source)&&all.nodes.some(n=>n.id===edge.target));
assert(factory.edges.some(e=>e.source==='port:F1.CLEAR'&&e.target==='design:Q1'&&e.kind==='feedback'));
assert(factory.nodes.some(n=>n.record?.op==='build_jki_draft'));
assert(all.nodes.some(n=>n.kind==='template'));
assert(all.nodes.some(n=>n.kind==='operation'));
const q1=factory.nodes.find(n=>n.definitionId==='Q1');
assert.equal(q1.kind,'jki');
assert(factoryNodeStatus(q1).includes('定义 q=0'));
assert(factoryNodeStatus(q1).includes('非实时'));
assert.equal(graphActivity(q1,{task_activity:{nodes:{Q1:{pending:99,completed:42}}}}),null);
assert.equal(JSON.stringify(bundle),original,'rendering must not mutate source JSON');
assert.throws(()=>buildFactoryGraph({documents:{}}),/缺少设计文件/);
assert.throws(()=>buildFactoryGraph(bundle,'unknown'),/未知工厂视图/);
console.log(`Factory definition checks passed: ${all.jksCount} JKS, ${all.jkiCount} JKI; conditional flow, shared references and observation isolation.`);

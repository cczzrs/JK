import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildRuntimeGraph,layerGraph,graphActivity,isStateSourceEdge} from './graph.mjs';

const business=JSON.parse(readFileSync(new URL('../../examples/cuda/business.json',import.meta.url),'utf8'));
const graph=buildRuntimeGraph(business),layout=layerGraph(graph),has=(source,target,kind)=>graph.edges.some(edge=>edge.source===source&&edge.target===target&&(!kind||edge.kind===kind));
assert.equal(graph.nodes.filter(node=>node.kind==='node').length,business.nodes.length);
assert.equal(graph.edges.filter(edge=>edge.kind==='subscription').length,business.subscriptions.length);
assert.deepEqual(graph.nodes.filter(node=>node.kind==='node').map(node=>node.nodeId).sort(),business.nodes.map(node=>node.id).sort());
assert.equal(graph.nodes.filter(node=>node.kind==='control').length,7);
assert(has('runtime:ack_input','runtime:ACK_DEC','spawn'));
assert(has('runtime:qualified','runtime:ACK_DEC','guard'));
assert(!has('runtime:FRAME_COMPLETE','runtime:ACK_DEC'));
assert(has('runtime:ACK_ACT','runtime:emit','feedback'));
assert(has('runtime:consume','runtime:emit','feedback'));
assert(has('runtime:consume','runtime:qualified','write'));
assert(has('runtime:STORE','runtime:emit','effect'));
assert(!has('runtime:STORE','runtime:CLAIM'));
for(const profile of business.business_module.widths){
  assert(has(`node:${profile.finish_node}`,'runtime:STORE','spawn'));
  assert(has(`node:${profile.finish_node}`,'runtime:CLAIM','feedback'));
  for(const pre of profile.pre_nodes)assert(has('runtime:CLAIM',`node:${pre}`,'spawn'));
  const stem=`${business.business_module.spec.prefix}.w${profile.input_width}`;
  assert(!has(`node:${stem}.S`,`node:${stem}.C`,'subscription'));
  assert(layout.positions.get(`node:${stem}.GO`).layer>layout.positions.get(`node:${stem}.S`).layer);
  assert(layout.positions.get(`node:${stem}.FINISH`).layer>layout.positions.get(`node:${stem}.COMMIT`).layer);
}
for(const edge of graph.edges.filter(edge=>edge.rank)){
  const a=layout.positions.get(edge.source),b=layout.positions.get(edge.target);
  assert(a.scc===b.scc||a.layer<b.layer,`${edge.source} should precede ${edge.target}`);
}
assert(!isStateSourceEdge(graph.edges.find(edge=>edge.source==='runtime:STORE'&&edge.target==='runtime:post_storage')));
assert(isStateSourceEdge(graph.edges.find(edge=>edge.kind==='source')));
assert.equal(graphActivity({kind:'node',nodeId:'A'},{}),null);
assert.equal(graphActivity({kind:'control',control:'ACK_DEC'},{task_activity:{controls:{ACK_DEC:{total:2}}}}).total,2);

const many={nodes:Array.from({length:121},(_,i)=>({id:`N${i}`,queue:'q',sources:{}})),subscriptions:[]};
assert.equal(buildRuntimeGraph(many).nodes.filter(node=>node.kind==='node').length,121);
const cycle=buildRuntimeGraph({nodes:[{id:'A',sources:{}},{id:'B',sources:{}},{id:'C',sources:{}}],subscriptions:[{source:'A',target:'B',port:'x',order:0},{source:'B',target:'A',port:'y',order:0},{source:'B',target:'C',port:'x',order:1}]});
const cyclic=layerGraph(cycle);
assert.equal(cyclic.positions.get('node:A').layer,cyclic.positions.get('node:B').layer);
assert(cyclic.positions.get('node:A').cyclic);
assert(cyclic.positions.get('node:C').layer>cyclic.positions.get('node:B').layer);
const generic=buildRuntimeGraph({nodes:[{id:'A',sources:{s:{kind:'STATE',state:'S'}},state:'S',output:'Y'}],states:[{id:'S',initial:0}],subscriptions:[],inputs:[{name:'X',node:'A',param:'x'}]});
assert.equal(generic.nodes.filter(node=>node.kind==='control').length,0);
assert(generic.edges.some(edge=>edge.source==='input:X'&&edge.target==='node:A'));
assert(generic.edges.some(edge=>edge.source==='node:A'&&edge.target==='runtime:outbox'));
console.log(`Complete graph checks passed: ${graph.normalCount} ordinary nodes, ${graph.subscriptionCount} subscriptions, ${graph.nodes.length} total roles, ${layout.layers.length} dependency layers.`);

import assert from 'node:assert/strict';
import {display, typedKey, groupTokens, compareIds, counterDelta, mergeTraces, parseKey, subscriptionIdentity, pendingSubscriptionKeys} from './state.mjs';

assert.equal(display(0), '0');
assert.equal(display(null), '—');
assert.notEqual(typedKey(1), typedKey('1'));
assert.equal(compareIds('9007199254740993', '9007199254740992'), 1);
assert.equal(counterDelta('9007199254741000', '9007199254740993'), 7);
assert.deepEqual(groupTokens([
  {target:'Q',port:'a',mode:'KEYED',key:1,value:0},
  {target:'Q',port:'a',mode:'KEYED',key:'1',value:1},
  {target:'Q',port:'a',mode:'KEYED',key:1,value:1},
]).map(group=>group.items.map(token=>token.value)), [[0,1],[1]]);
assert.deepEqual(mergeTraces([{seq:'9007199254740993',kind:'event'}],[{seq:'9007199254740994',kind:'complete'},{seq:'9007199254740993',kind:'event'}]).map(row=>row.kind), ['event','complete']);
assert.equal(parseKey('0'), 0);
assert.equal(parseKey('"1"'), '1');
assert.equal(parseKey(''), null);
assert.throws(()=>parseKey('[]'));
assert.throws(()=>parseKey('9007199254740993'));
assert.notEqual(typedKey('9007199254740993','integer'), typedKey('9007199254740993','string'));
assert.equal(groupTokens([
  {target:'Q',port:'a',mode:'KEYED',key:'9007199254740993',key_type:'integer'},
  {target:'Q',port:'a',mode:'KEYED',key:'9007199254740993',key_type:'string'},
]).length, 2);
// N03 / core.earliest: ZIP preserves each source FIFO across business keys.
const zip = groupTokens([
  {target:'Q',port:'a',mode:'ZIP',key:1,value:0,token_id:1},
  {target:'Q',port:'a',mode:'ZIP',key:'1',value:1,token_id:2},
  {target:'Q',port:'a',mode:'ZIP',key:null,value:0,token_id:3},
]);
assert.equal(zip.length, 1);
assert.deepEqual(zip[0].items.map(token=>token.token_id), [1,2,3]);
assert.equal(zip[0].key, undefined);
assert.equal(groupTokens([
  {target:'Q',port:'a',mode:'ALL_LATEST',key:1},
  {target:'Q',port:'a',mode:'ALL_LATEST',key:'1'},
]).length, 1);
assert.equal(groupTokens([
  {target:'Q',port:'a',mode:'ZIP',key:1},
  {target:'Q',port:'b',mode:'ZIP',key:1},
  {target:'R',port:'a',mode:'ZIP',key:1},
]).length, 3);
const subscriptions = [
  {source:'A',target:'C',port:'a',order:4},
  {source:'A',target:'B',port:'a',order:1},
  {source:'D',target:'B',port:'d',order:0},
];
// No published event (e.g. publish=never) means no propagation edge highlight.
assert.equal(pendingSubscriptionKeys([],subscriptions,7).size,0);
// Transaction task has no node; its real event source still identifies edges.
assert.deepEqual([...pendingSubscriptionKeys([
  {event_id:1,owner_task_id:7,source:'A',delivered:0,fanout:2,complete:false},
],subscriptions,7)], [subscriptionIdentity(subscriptions[1]),subscriptionIdentity(subscriptions[0])]);
// Cursor is an index into source subscriptions sorted by logical order.
assert.deepEqual([...pendingSubscriptionKeys([
  {event_id:1,owner_task_id:7,source:'A',delivered:1,fanout:2,complete:false},
],subscriptions,7)], [subscriptionIdentity(subscriptions[0])]);
assert.equal(pendingSubscriptionKeys([
  {event_id:1,owner_task_id:7,source:'A',delivered:2,fanout:2,complete:false},
],subscriptions,7).size,0);
assert.equal(pendingSubscriptionKeys([
  {event_id:1,owner_task_id:6,source:'A',delivered:0,fanout:2,complete:false},
],subscriptions,7).size,0);
assert.equal(pendingSubscriptionKeys([
  {event_id:1,owner_task_id:7,source:'A',delivered:0,fanout:2,complete:true},
],subscriptions,7).size,0);
console.log('Presentation helpers: 25 assertions passed.');

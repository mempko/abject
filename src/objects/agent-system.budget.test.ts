import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalManager } from './goal-manager.js';
const send=(g:any,method:string,payload:unknown,from='llm')=>g.handlers.get(method)({routing:{from},payload});
function fixture():any {
  const g:any=new GoalManager(); g.changed=()=>{}; g.discoverDep=async()=> 'llm';
  g.goals.set('root',{id:'root',createdBy:'owner',status:'active',scratchpad:{}});
  g.goals.set('child',{id:'child',parentId:'root',createdBy:'owner',status:'active',scratchpad:{}});
  return g;
}
test('concurrent child model reservations share the root goal budget',async()=>{
  const g=fixture(); await send(g,'configureBudget',{goalId:'root',maxTokens:100,maxCostUsd:1},'owner');
  const receipts=await Promise.all(['a','b'].map(operationId=>send(g,'reserveUsage',{goalId:'child',operationId,tokens:60,costUsd:.4})));
  assert.equal(receipts.filter(r=>r.accepted).length,1);
  assert.match(receipts.find(r=>!r.accepted).reason,/budget/);
});
test('usage reconciliation is idempotent and releases unused reservation',async()=>{
  const g=fixture(); await send(g,'configureBudget',{goalId:'root',maxTokens:100},'owner');
  await send(g,'reserveUsage',{goalId:'root',operationId:'a',tokens:90});
  await send(g,'settleUsage',{goalId:'root',operationId:'a',tokens:20,costUsd:.1});
  assert.equal((await send(g,'settleUsage',{goalId:'root',operationId:'a',tokens:20,costUsd:.1})).duplicate,true);
  assert.equal((await send(g,'reserveUsage',{goalId:'root',operationId:'b',tokens:80})).accepted,true);
  const budget=await send(g,'getBudget',{goalId:'child'}); assert.equal(budget.usedTokens,20); assert.equal(budget.usedCostUsd,.1);
});
test('unreported usage is visibly estimated instead of charged as zero',async()=>{
  const g=fixture(); await send(g,'reserveUsage',{goalId:'root',operationId:'a',tokens:90,costUsd:.4});
  await send(g,'settleUsage',{goalId:'root',operationId:'a',error:'provider disconnected'});
  const budget=await send(g,'getBudget',{goalId:'root'}); assert.equal(budget.usedTokens,90); assert.equal(budget.receipts.a.estimated,true);
});
test('unknown model price cannot bypass a configured dollar limit',async()=>{
  const g=fixture(); await send(g,'configureBudget',{goalId:'root',maxCostUsd:1},'owner');
  assert.equal((await send(g,'reserveUsage',{goalId:'root',operationId:'a',tokens:90})).accepted,false);
  await assert.rejects(send(g,'reserveUsage',{goalId:'root',operationId:'b',tokens:1},'untrusted'),/Only LLM/);
  await assert.rejects(send(g,'configureBudget',{goalId:'root',maxCostUsd:9},'untrusted'),/goal creator/);
});
test('superseded tasks cannot be admitted into the active goal',async()=>{
  const g=fixture(); g.tupleSpaceId='tuples'; g.request=async()=>[{id:'t',fields:{status:'superseded'}}];
  assert.equal((await send(g,'admitTask',{goalId:'root',taskId:'t'})).accepted,false);
});

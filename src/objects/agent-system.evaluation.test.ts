import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentEvaluation } from './agent-evaluation.js';
import { AGENT_EVALUATION_CASES } from '../evaluation/agent-cases.js';
const call=(e:any,method:string,payload:unknown)=>e.handlers.get(method)({routing:{from:'user'},payload});
test('evaluation catalog contains the declared 40 scenarios',()=>{
  assert.equal(new Set(AGENT_EVALUATION_CASES.map(c=>c.id)).size,40);
  assert.deepEqual(Object.fromEntries(['object','repository','mixed','recovery'].map(group=>[group,AGENT_EVALUATION_CASES.filter(c=>c.group===group).length])),{object:10,repository:15,mixed:5,recovery:10});
});
test('evaluation counts false success and failed setup across all memory conditions',async()=>{
  const e:any=new AgentEvaluation(); e.storageId='storage';e.changed=()=>{};
  let cleanup=0;
  e.request=async(m:any)=>{
    const method=m.routing.method,p=m.payload;
    if(method==='set')return true;
    if(method==='get')return null;
    if(method==='ask')return 'Version 1: separate memory per trial; fixed configuration; independent acceptance';
    if(method==='evaluationProtocol')return {version:1,supportsConditions:['fresh','frozen','learning']};
    if(method==='prepareEvaluation'){if(p.caseId==='agent-02')throw new Error('fixture setup unavailable'); return {id:p.trialId,configurationFingerprint:'fixed-model-budget',baselineMemoryFingerprint:'starting-patterns',condition:p.condition,isolated:true};}
    if(method==='executeEvaluation')return {success:true,tokens:10,costUsd:.01};
    if(method==='verifyEvaluation')return {accepted:false,evidence:'visible count never changed'};
    if(method==='cleanupEvaluation'){cleanup++;return true;}
    throw new Error(method);
  };
  const {id}=await call(e,'run',{driverId:'driver',verifierId:'verifier',options:{caseIds:['agent-01','agent-02']}});
  for(let n=0;n<100 && e.runs.get(id).status==='running';n++)await new Promise(resolve=>setTimeout(resolve,1));
  const run=await call(e,'get',{id});assert.equal(run.status,'complete');assert.equal(run.outcomes.length,6);assert.equal(cleanup,6);
  for(const report of Object.values(run.report) as any[]){assert.equal(report.episodes,2);assert.equal(report.accepted,0);assert.equal(report.falseSuccess,1);assert.equal(report.failures,1);}
});

test('evaluation rejects unmatched comparisons and reports missing prices honestly',async()=>{
  const e:any=new AgentEvaluation();e.storageId='storage';e.changed=()=>{};
  const storage=new Map<string,unknown>();
  e.request=async(m:any)=>{
    const p=m.payload;
    switch(m.routing.method){
      case 'set':storage.set(p.key,structuredClone(p.value));return true;
      case 'get':return structuredClone(storage.get(p.key)??null);
      case 'ask':return 'Version 1';
      case 'evaluationProtocol':return {version:1,supportsConditions:['fresh','frozen','learning']};
      case 'prepareEvaluation':return {configurationFingerprint:p.condition==='learning'?'different-model':'fixed',baselineMemoryFingerprint:'initial',condition:p.condition,isolated:true};
      case 'executeEvaluation':return {success:true,tokens:20};
      case 'verifyEvaluation':return {accepted:true,evidence:{observedCount:1}};
      case 'cleanupEvaluation':return true;
      default:throw new Error(m.routing.method);
    }
  };
  const {id}=await call(e,'run',{driverId:'driver',verifierId:'verifier',options:{caseIds:['agent-01']}});
  for(let n=0;n<100 && e.runs.get(id).status==='running';n++)await new Promise(resolve=>setTimeout(resolve,1));
  const run=await call(e,'get',{id});
  assert.equal(run.report.fresh.accepted,1);assert.equal(run.report.fresh.costPerAccepted,null);
  assert.equal(run.report.learning.accepted,0);assert.match(run.outcomes[2].error,/configuration.*changed/);
  e.runs.clear();
  const restored=await call(e,'get',{id});assert.equal(restored.outcomes.length,3);
  assert.equal((await call(e,'list',{})).length,1);
});

test('evaluation restart preserves partial reports without replaying unknown effects',async()=>{
  const e:any=new AgentEvaluation();e.storageId='storage';
  const storage=new Map<string,unknown>([['evaluation:index',['interrupted']],['evaluation:interrupted',{id:'interrupted',status:'running',seed:1,startedAt:1,outcomes:[]}]]);
  e.request=async(m:any)=>{
    if(m.routing.method==='get')return structuredClone(storage.get(m.payload.key)??null);
    assert.equal(m.routing.method,'set');storage.set(m.payload.key,structuredClone(m.payload.value));return true;
  };
  assert.equal((await call(e,'get',{id:'interrupted'})).status,'interrupted');
  assert.equal((storage.get('evaluation:interrupted') as any).status,'interrupted');
});

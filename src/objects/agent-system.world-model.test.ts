import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { GoalManager } from './goal-manager.js';
import { AgentAbject } from './agent-abject.js';
import { TaskSession } from './task-session.js';
import { TaskReviewer } from './task-reviewer.js';
import { KnowledgeBase } from './knowledge-base.js';
import { WasmAbject } from './wasm-abject.js';
import { storeWasmModule } from '../sandbox/wasm-module-store.js';
import { extractWasmManifest } from '../sandbox/wasm-instance.js';

class Endpoint extends Abject {
  constructor(name: string) { super({manifest:{name,version:'1',description:'Learning fixture',interface:{id:`test:${name}`,name,description:'fixture',methods:[]},requiredCapabilities:[],providedCapabilities:[]}}); }
  public override on(method: string, handler: MessageHandlerFn) { super.on(method,handler); }
  call(to: string, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id,to,method,payload),10000); }
}
class Reviewer extends TaskReviewer {
  protected override async onInit() {}
  call(to: string, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id,to,method,payload),10000); }
}
class Runtime extends AgentAbject { protected override async onInit() {} }
class MemoryKnowledge extends KnowledgeBase { protected override async onInit() {} }
class Store extends Endpoint {
  values = new Map<string,unknown>(); failKnowledge = false; failJournal = false;
  constructor(name: string) {
    super(name);
    const key = (p:any) => `${p.name ?? ''}:${p.key}`;
    this.on('set', m => { const p=m.payload as any; if (this.failJournal && p.key.startsWith('goals:learning:')) throw new Error('Journal offline'); if(this.failKnowledge && p.key.startsWith('knowledge-base:entry:')) return {success:false}; this.values.set(key(p),structuredClone(p.value)); return true; });
    this.on('get', m => structuredClone(this.values.get(key(m.payload)) ?? null));
    this.on('keys', () => [...this.values.keys()].filter(k=>k.startsWith(':')).map(k=>k.slice(1)));
    this.on('getAll', m => Object.fromEntries([...this.values].filter(([k])=>k.startsWith(`${(m.payload as any).name}:`)).map(([k,v])=>[k.slice(`${(m.payload as any).name}:`.length),structuredClone(v)])));
    for(const method of ['create','subscribe','unsubscribe']) this.on(method,()=>true);
  }
}
async function fixture(native = false) {
  const bus=new MessageBus(), registry=new Registry(), objects:Abject[]=[registry]; await registry.init(bus);
  const dir=await mkdtemp(path.join(tmpdir(),'abject-world-model-')), previous=process.env.ABJECTS_DATA_DIR; process.env.ABJECTS_DATA_DIR=dir;
  async function add<T extends Abject>(o:T) { o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id,o.manifest); objects.push(o); return o; }
  const storage=await add(new Store('Storage')); await add(new Store('SharedState'));
  const identity=new Endpoint('Identity'); identity.on('getIdentity',()=>({peerId:'learning-fixture'})); await add(identity);
  const runtime=await add(new Endpoint('AgentAbject')); runtime.on('releaseTask',()=>true); runtime.on('startTask',m=>({ticketId:(m.payload as any).taskId}));
  let goals=await add(new GoalManager());
  let reviewer=await add(new Reviewer()); Object.assign(reviewer,{agentAbjectId:runtime.id,goalManagerId:goals.id});
  let source:string|undefined, manifest:any;
  if(native) { const bytes=await readFile(new URL('../../native/knowledge-base/main.wasm',import.meta.url)); source=await storeWasmModule(bytes); manifest=await extractWasmManifest(bytes); }
  let kb:Abject;
  async function loadKnowledge() {
    kb=await add(source?new WasmAbject({manifest,source}):new MemoryKnowledge());
    Object.assign(reviewer,{knowledgeBaseId:kb.id});
    if(!source) for(const [key,value] of storage.values) if(key.startsWith(':knowledge-base:entry:')) (kb as any).entries.set(key.slice(':knowledge-base:entry:'.length),structuredClone(value));
    // Wait for native owner startup, without asking it to mutate anything.
    await new Promise(resolve=>setTimeout(resolve,30)); return kb;
  }
  await loadKnowledge();
  const {goalId}=await runtime.call(goals.id,'createGoal',{title:'Verify repository',description:'Verify the current project'});
  const record={taskId:'worker',goalId,task:'Verify repo',phase:'completed',agentName:'Verifier',steps:1,transcript:'Owner reports tests passed',injectedKnowledge:[],result:{project:'abject',revision:'fixture-inputs',tests:198,passed:198,exitCode:0},predictions:[{step:1,expect:'Repository has no working tests',actual:'198/198 passed, exit 0',outcome:'success',verdict:'supported'}]};
  await runtime.call(goals.id,'recordTaskEvidence',{goalId,taskId:'worker',record});
  (reviewer as any).taskExtras.set('review',{kind:'review',goalId,records:[record],knowledgeRefs:{}});
  async function seed(title:string,content:string,origin='agent') { const {id}=await runtime.call(kb.id,'remember',{title,content,type:'fact',origin}); const entry=await runtime.call(kb.id,'get',{id}); (reviewer as any).taskExtras.get('review').knowledgeRefs[id]=entry.knowledgeRef; if(!native) await runtime.call(storage.id,'set',{key:`knowledge-base:entry:${id}`,value:entry}); return entry; }
  async function decision(effects:unknown[], context:any={evidence:'Owner verification on abject fixture-inputs passed 198 tests',evidenceRefs:['learning/task/worker']}) {
    return (await reviewer.call(goals.id,'recordLearningDecision',{goalId,reviewTaskId:'review',operationId:crypto.randomUUID(),context,effects})).decision;
  }
  async function apply(d:any,index=0) { return reviewer.call(kb.id,'applyLearningDecision',{goalId,decisionId:d.id,effectId:d.effects[index].id}); }
  return {add,runtime,get reviewer(){return reviewer;},get goals(){return goals;},storage,goalId,seed,decision,apply,get kb(){return kb;},restartKnowledge:async()=>{await kb.stop();return loadKnowledge();},
    restartOwners:async()=>{await reviewer.stop();await goals.stop();registry.unregisterObject(goals.id);goals=await add(new GoalManager());reviewer=await add(new Reviewer());Object.assign(reviewer,{agentAbjectId:runtime.id,goalManagerId:goals.id,knowledgeBaseId:kb.id});},
    stop:async()=>{for(const o of objects.reverse())await o.stop(); if(previous===undefined)delete process.env.ABJECTS_DATA_DIR;else process.env.ABJECTS_DATA_DIR=previous;await rm(dir,{recursive:true,force:true});}};
}

for(const native of [false,true]) {
  test(`${native ? 'native' : 'typescript'}: supersession requires a reconciled replacement and preserves its selected claim`, async () => {
    const f = await fixture(native);
    try {
      const old = await f.seed('No test runner', 'No test runner exists');
      const replacement = await f.seed('Corrected tests', 'There are standalone tests but no package test script');
      const base = { action: 'supersede_entry', id: old.id, knowledgeRef: old.knowledgeRef, replacementId: replacement.id, scope: 'project:abject' };
      const unchecked = await f.decision([base]);
      assert.equal((await f.apply(unchecked)).success, false, 'an existing replacement alone is insufficient');
      const stale = await f.decision([{ ...base, replacementRef: replacement.knowledgeRef, replacementEvidence: 'This version was reviewed against the episode' }]);
      const revision = await f.decision([{ action: 'update_entry', id: replacement.id, knowledgeRef: replacement.knowledgeRef, content: 'The package test script ran 198 tests successfully' }]);
      assert.equal((await f.apply(revision)).success, true);
      assert.equal((await f.apply(stale)).success, false, 'replacement revisions invalidate an earlier review');
      const current = await f.runtime.call(f.kb.id, 'get', { id: replacement.id });
      const confirmed = await f.decision([{ ...base, replacementRef: current.knowledgeRef, replacementEvidence: 'The full replacement states that the package test script ran 198 tests, matching owner verification' }]);
      const applied = await f.apply(confirmed); assert.equal(applied.success, true, JSON.stringify(applied));
      assert.equal(applied.receipt.replacement.content, current.content);
      assert.equal(applied.receipt.replacement.knowledgeRef, current.knowledgeRef);
      const recalled = await f.runtime.call(f.kb.id, 'recall', { scope: 'project:abject' });
      assert(!recalled.some((e: any) => e.id === old.id));
    } finally { await f.stop(); }
  });
  const implementation=native?'wasm':'typescript';
  test(`${implementation}: a correction bundle inherits explicit evidence, survives lost ack/restart, and changes subsequent recall`,async()=>{
    const f=await fixture(native);
    try {
      const old1=await f.seed('Abject tests absent','Abject has no tests'),old2=await f.seed('Abject fallback advice','Run ad hoc checks because no test script exists'),current=await f.seed('Abject verification','Partially corrected');
      const d=await f.decision([
        {action:'update_entry',id:current.id,knowledgeRef:current.knowledgeRef,content:'Abject fixture-inputs: pnpm test passes 198 tests; pnpm typecheck is available.'},
        {action:'supersede_entry',id:old1.id,knowledgeRef:old1.knowledgeRef,replacementId:current.id,scope:'project:abject'},
        {action:'supersede_entry',id:old2.id,knowledgeRef:old2.knowledgeRef,replacementId:current.id,scope:'project:abject'},
      ]);
      const accepted=await f.apply(d); assert.equal(accepted.success,true,JSON.stringify(accepted));
      await f.restartKnowledge();
      const replay=await f.apply(d); assert.equal(replay.duplicate,true); assert.deepEqual(replay.receipt,accepted.receipt);
      await f.reviewer.call(f.goals.id,'changeLearningEffect',{goalId:f.goalId,decisionId:d.id,effectId:d.effects[0].id,change:{state:'applied',receipt:replay.receipt}});
      for(let i=1;i<3;i++) assert.equal((await f.apply(d,i)).success,true);
      const recall=await f.runtime.call(f.kb.id,'recall',{scope:'project:abject'});
      assert.deepEqual(recall.map((e:any)=>e.id),[current.id]); assert.match(recall[0].content,/198 tests/);
      const nextRuntime:any=await f.add(new Runtime());
      const task:any={state:{id:'next-task',task:'Verify the abject repository'},config:{knowledgeScope:'project:abject',terminalActions:{},intermediateActions:[]}};
      await nextRuntime.initializeConversation(task);
      assert(task.injectedKnowledge.some((e:any)=>e.id===current.id&&e.knowledgeRef));
      assert(!task.injectedKnowledge.some((e:any)=>e.id===old1.id||e.id===old2.id));
      const unrelated=await f.runtime.call(f.kb.id,'recall',{scope:'project:other'});
      assert(unrelated.some((e:any)=>e.id===old1.id),'different scopes must not inherit the retirement');
      const history=await f.runtime.call(f.kb.id,'get',{id:old1.id});
      assert.equal(history.learning.history[0].evidence['learning/task/worker'].result.exitCode,0);
      assert.equal(history.learning.history[0].input.evidence,d.context.evidence);
    }finally{await f.stop();}
  });
  test(`${implementation}: pattern feedback retains the applied revision and is durable across replay`,async()=>{
    const f=await fixture(native);
    try {
      const {id}=await f.runtime.call(f.kb.id,'remember',{title:'VERIFY RESTORATION',type:'pattern',content:'Context: persistent settings\nForces: live state can conceal loss\nTherefore: restore and compare\nEvidence: candidate'});
      const selected=await f.runtime.call(f.kb.id,'get',{id});
      const {applicationRef}=await f.runtime.call(f.kb.id,'beginPatternApplication',{id,patternRef:selected.patternRef,applicationId:'worker:1',goalId:f.goalId,context:'Check persistence'});
      const d=await f.decision([{action:'record_pattern_application',id,applicationRef,verdict:'harmful',evidence:'This application restored stale values over newer edits',outcome:'success'}]);
      assert.equal((await f.apply(d)).success,true);
      await f.restartKnowledge(); assert.equal((await f.apply(d)).duplicate,true);
      const current=await f.runtime.call(f.kb.id,'get',{id});
      assert.equal(current.pattern.learning.applications.length,1);
      assert.equal(current.pattern.learning.applications[0].patternRevision,1);
      assert.equal(current.pattern.learning.applications[0].verdict,'harmful');
      assert.equal(current.learning.history.length,1);
      const conflicting=await f.decision([{...d.effects[0].input,verdict:'helpful'}]);
      assert.equal((await f.apply(conflicting)).success,false);
    }finally{await f.stop();}
  });
  test(`${implementation}: persistence failure, concurrent revisions, protected disputes and stale peer writes remain truthful`,async()=>{
    const f=await fixture(native);
    try {
      const claim=await f.seed('Claim','Old content');
      const a=await f.decision([{action:'update_entry',id:claim.id,knowledgeRef:claim.knowledgeRef,content:'Corrected content'}]);
      const b=await f.decision([{action:'archive_entry',id:claim.id,knowledgeRef:claim.knowledgeRef}]);
      f.storage.failKnowledge=true; assert.equal((await f.apply(a)).success,false);
      assert.equal((await f.runtime.call(f.kb.id,'get',{id:claim.id})).content,'Old content');
      f.storage.failKnowledge=false; assert.equal((await f.apply(a)).success,true);
      assert.equal((await f.apply(b)).success,false,'a concurrent edit must conflict');
      const user=await f.seed('Protected claim','User supplied claim','user');
      const protection=await f.decision([{action:'archive_entry',id:user.id,knowledgeRef:user.knowledgeRef}]); assert.equal((await f.apply(protection)).success,false);
      const dispute=await f.decision([{action:'dispute_entry',id:user.id,knowledgeRef:user.knowledgeRef,evidence:'Conflicting observation; general applicability is uncertain',scope:'project:abject'}]); assert.equal((await f.apply(dispute)).success,true);
      assert.match((await f.runtime.call(f.kb.id,'recall',{query:'Protected',previews:true}))[0].snippet,/DISPUTED/);
      const live=await f.runtime.call(f.kb.id,'get',{id:claim.id});
      if(!native) {
        assert.equal((f.kb as any).applyRemoteEntry(claim.id,{entry:{...claim,updatedAt:live.updatedAt+100000},updatedAt:live.updatedAt+100000,peerId:'stale'}),false);
      } else {
        // Same SharedState subscription message consumed by the native owner.
        await f.runtime.call(f.kb.id,'changed',{aspect:'stateChanged',value:{name:'knowledge-base',key:`entry:${claim.id}`,value:{entry:{...claim,updatedAt:live.updatedAt+100000},updatedAt:live.updatedAt+100000,peerId:'stale'}}});
      }
      assert.equal((await f.runtime.call(f.kb.id,'get',{id:claim.id})).learning.revision,1);
    }finally{await f.stop();}
  });
}

test('reviewer captures replacement versions from full reads and repairs the original decision', async () => {
  const f = await fixture();
  try {
    const old = await f.seed('Tests unavailable', 'No test script');
    const replacement = await f.seed('Current verification', 'The package test script passed 198 tests');
    const act = (action: unknown) => f.runtime.call(f.reviewer.id, 'agentAct', { taskId: 'review', action });
    const input = { action: 'supersede_entry', id: old.id, replacementId: replacement.id, scope: 'project:abject', replacementRef: replacement.knowledgeRef, replacementEvidence: 'The replacement matches owner verification of 198 passing tests' };
    const first = await act({ action: 'learn', context: { evidence: 'Owner verified the test script', evidenceRefs: ['learning/task/worker'] }, effects: [input] });
    let decision = first.data;
    assert.equal(decision.effects[0].state, 'needs_repair', 'a model-supplied reference cannot claim the replacement was fully read');
    await f.runtime.call(f.reviewer.id, 'recordKnowledgeSelection', { taskId: 'review', selection: { id: replacement.id, knowledgeRef: replacement.knowledgeRef, complete: false } });
    const partial = await act({ action: 'repair_learning', decisionId: decision.id, effectId: decision.effects[0].id, input });
    decision = partial.data;
    assert.equal(decision.effects[0].state, 'needs_repair');
    await f.runtime.call(f.reviewer.id, 'recordKnowledgeSelection', { taskId: 'review', selection: { id: replacement.id, knowledgeRef: replacement.knowledgeRef, complete: true } });
    const repaired = await act({ action: 'repair_learning', decisionId: decision.id, effectId: decision.effects[0].id, input });
    assert.equal(repaired.data.id, decision.id); assert.equal(repaired.data.effects[0].state, 'applied');
    assert.equal(repaired.data.effects[0].receipt.replacement.knowledgeRef, replacement.knowledgeRef);
  } finally { await f.stop(); }
});

test('review completion retains malformed effects, links assessments, and does not queue another retrospective',async()=>{
  const f=await fixture();
  try {
    const stale=await f.seed('Abject has no tests','No test scripts');
    const result=await f.runtime.call(f.reviewer.id,'completeReview',{taskId:'review',result:{
      evidence:'Owner verification contradicts the no-tests claim for these project inputs',evidenceRefs:['learning/task/worker'],
      assessments:[{taskId:'worker',step:1,verdict:'contradicted',explanation:'The tests ran and passed'}],
      knowledgeUpdates:[{action:'archive_entry',id:stale.id},null,{action:'archive_entry',id:'missing-target'}],
    }});
    assert.equal(result.accepted,true); assert.equal(result.result.decisions[0].effects[0].state,'applied');
    assert.equal(result.result.pending.length,2); assert.equal(result.result.pending[1].input.id,'missing-target');
    assert.equal(result.result.decisions[0].evidence['learning/assessment/worker:1'].verdict,'contradicted');
    await f.reviewer.call(f.goals.id,'ackReview',{goalId:f.goalId,report:result.result});
    assert.equal((await f.runtime.call(f.goals.id,'pendingReviews')).length,0);
    const pending=await f.runtime.call(f.goals.id,'pendingLearningDecisions'); assert.equal(pending.length,1);
    const persisted:any=f.storage.values.get(`:goals:learning:${f.goalId}`); assert(persisted.scratchpad[`learning/decision/${pending[0].id}`]);
    await f.runtime.call(f.goals.id,'clearCompleted'); assert(await f.runtime.call(f.goals.id,'getGoal',{goalId:f.goalId}));
  }finally{await f.stop();}
});

test('missing semantic evidence stays actionable, repair is claimed once, and journal failures acknowledge nothing',async()=>{
  const f=await fixture();
  try {
    const stale=await f.seed('Uncertain','Unknown');
    const result=await f.runtime.call(f.reviewer.id,'completeReview',{taskId:'review',result:{unresolvedReason:'No evidence association supplied',knowledgeUpdates:[{action:'archive_entry',id:stale.id}]}});
    const d=result.result.decisions[0]; assert.equal(d.effects[0].state,'needs_repair'); assert.equal(d.effects[0].original.id,stale.id);
    assert.equal((await f.reviewer.call(f.goals.id,'claimLearningRepair',{goalId:f.goalId,decisionId:d.id})).success,true);
    assert.equal((await f.reviewer.call(f.goals.id,'claimLearningRepair',{goalId:f.goalId,decisionId:d.id})).success,false);
    assert.equal((await f.runtime.call(f.kb.id,'get',{id:stale.id})).archived,false);
    f.storage.failJournal=true;
    await assert.rejects(f.decision([{action:'archive_entry',id:stale.id}]),/Journal offline/);
    assert.equal((await f.runtime.call(f.goals.id,'pendingLearningDecisions')).length,1);
  }finally{await f.stop();}
});

test('assessment replay detects conflicts and explicit revision keeps previous evidence',async()=>{
  const f=await fixture();
  try {
    const p={goalId:f.goalId,taskId:'worker',step:1,verdict:'contradicted',explanation:'198 passing tests contradict absence'};
    const first=await f.reviewer.call(f.goals.id,'recordPredictionAssessment',p); assert.equal(first.assessment.revision,1);
    assert.equal((await f.reviewer.call(f.goals.id,'recordPredictionAssessment',p)).duplicate,true);
    assert.equal((await f.reviewer.call(f.goals.id,'recordPredictionAssessment',{...p,verdict:'unresolved'})).conflict,true);
    const revised=await f.reviewer.call(f.goals.id,'recordPredictionAssessment',{...p,verdict:'unresolved',explanation:'Environment applicability remains uncertain',expectedRevision:1,evidenceRefs:['learning/task/worker']});
    assert.equal(revised.assessment.revision,2); assert.equal(revised.assessment.history[0].verdict,'contradicted');
  }finally{await f.stop();}
});


test('lost delivery acknowledgment recovers only the durable effect after owner restart',async()=>{
  const f=await fixture();
  try {
    const entry=await f.seed('Recover me','Old claim');
    const original=(f.reviewer as any).request.bind(f.reviewer); let lost=false;
    (f.reviewer as any).request=async(message:any,...args:any[])=>{ const result=await original(message,...args); if(message.routing.method==='applyLearningDecision'&&!lost){lost=true;throw new Error('Reply lost');} return result; };
    await f.runtime.call(f.reviewer.id,'completeReview',{taskId:'review',result:{evidence:'Owner evidence corrects this claim',evidenceRefs:['learning/task/worker'],knowledgeUpdates:[{action:'update_entry',id:entry.id,content:'Corrected claim'}]}});
    assert(lost); const pending=await f.runtime.call(f.goals.id,'pendingLearningDecisions');
    assert.equal(pending[0].effects[0].state,'proposed'); assert.equal(pending[0].effects[0].attempts,1);
    await f.restartOwners();
    await new Promise(resolve=>setTimeout(resolve,2050));
    await (f.reviewer as any).drainLearningDecisions();
    assert.equal((await f.runtime.call(f.goals.id,'pendingLearningDecisions')).length,0);
    assert.equal((await f.runtime.call(f.kb.id,'get',{id:entry.id})).learning.revision,1);
    const status=await f.runtime.call(f.goals.id,'getLearningStatus'); assert.equal(status.repairModelAttempts,0); assert.equal(status.applied,1);
  }finally{await f.stop();}
});

test('one focused repair gets original evidence; an incomplete repair never loops',async()=>{
  const f=await fixture();
  try {
    const entry=await f.seed('Maybe stale','Claim with uncertain applicability');
    await f.runtime.call(f.reviewer.id,'completeReview',{taskId:'review',result:{evidenceRefs:['learning/task/worker'],knowledgeUpdates:[{action:'archive_entry',id:entry.id}]}});
    const launched:any[]=[]; f.runtime.on('startTask',m=>{launched.push(m.payload);return {ticketId:(m.payload as any).taskId};});
    await (f.reviewer as any).drainLearningDecisions(); assert.equal(launched.length,1); assert.equal(launched[0].config.maxSteps,3);
    assert.match(JSON.stringify(launched[0].initialMessages),/learning\/task\/worker/);
    await f.runtime.call(f.reviewer.id,'completeReview',{taskId:launched[0].taskId,result:{unresolvedReason:'Need current evidence for applicability'}});
    await f.runtime.call(f.reviewer.id,'taskResult',{ticketId:launched[0].taskId,success:true});
    await (f.reviewer as any).drainLearningDecisions(); assert.equal(launched.length,1);
    const status=await f.runtime.call(f.goals.id,'getLearningStatus'); assert.equal(status.pending,1); assert.equal(status.repairModelAttempts,1);
    assert.equal((await f.runtime.call(f.kb.id,'get',{id:entry.id})).archived,false);
  }finally{await f.stop();}
});

test('goal cancellation pauses durable learning and generic scratchpad writes cannot forge receipts',async()=>{
  const f=await fixture();
  try {
    const entry=await f.seed('Stop this edit','Original');
    const d=await f.decision([{action:'update_entry',id:entry.id,knowledgeRef:entry.knowledgeRef,content:'Changed'}]);
    await assert.rejects(f.runtime.call(f.goals.id,'writeGoalData',{goalId:f.goalId,key:`learning/decision/${d.id}`,value:{effects:[]}}),/reviewer-owned/);
    await f.runtime.call(f.goals.id,'stopGoal',{goalId:f.goalId});
    assert.equal((await f.apply(d)).success,false);
    await (f.reviewer as any).drainLearningDecisions();
    const pending=await f.runtime.call(f.goals.id,'pendingLearningDecisions'); assert.equal(pending[0].paused,true); assert.equal(pending[0].effects[0].state,'waiting');
    assert.equal((await f.runtime.call(f.kb.id,'get',{id:entry.id})).content,'Original');
  }finally{await f.stop();}
});

test('legacy partial proposals are journaled once and recover as focused work without guessed evidence',async()=>{
  const f=await fixture();
  try {
    const a=await f.seed('No tests old one','No tests'),b=await f.seed('No tests old two','No tests');
    await f.reviewer.call(f.goals.id,'ackReview',{goalId:f.goalId,report:{status:'partial',pending:[],limitations:['Missing archive evidence']}});
    const record=await f.runtime.call(f.goals.id,'readGoalData',{goalId:f.goalId,key:'learning/task/worker'});
    f.runtime.on('getRetainedReviewProposals',()=>[{taskId:'old-review',goalId:f.goalId,result:{knowledgeUpdates:[{action:'archive_entry',id:a.id},{action:'archive_entry',id:b.id}]},records:[record]}]);
    await (f.reviewer as any).recoverLegacyReviews(); await (f.reviewer as any).recoverLegacyReviews();
    const pending=await f.runtime.call(f.goals.id,'pendingLearningDecisions'); assert.equal(pending.length,1); assert.equal(pending[0].effects.length,2);
    assert(pending[0].effects.every((e:any)=>e.state==='needs_repair'&&!e.input.evidence));
    assert.equal(pending[0].evidence['learning/task/worker'].result.passed,198);
    assert.equal((await f.runtime.call(f.kb.id,'get',{id:a.id})).archived,false);
  }finally{await f.stop();}
});

test('semantic evaluation penalizes false corrections, missing scope and invented usefulness',async()=>{
  const {evaluate}=await import('../../scripts/evaluate-learning.js');
  const corpus=JSON.parse(await readFile(new URL('../../tests/fixtures/learning-judgment.json',import.meta.url),'utf8'));
  const answers=corpus.map((c:any)=>({id:c.id,verdict:c.expected.verdict,disposition:c.expected.dispositions[0],scope:c.expected.scope,patternVerdict:c.expected.patternVerdict}));
  assert.equal(evaluate(corpus,answers).correct,corpus.length,'check evaluator plumbing, not model intelligence');
  answers.find((a:any)=>a.id==='preview-is-not-loss').disposition='archive';
  answers.find((a:any)=>a.id==='stale-tests').scope=undefined;
  answers.find((a:any)=>a.id==='injection-not-use').patternVerdict='helpful';
  answers.find((a:any)=>a.id==='successful-commit-wrong-hunks').verdict='supported';
  answers.find((a:any)=>a.id==='staged-stats-not-agreement').verdict='supported';
  const scored=evaluate(corpus,answers); assert.equal(scored.correct,corpus.length-5); assert.equal(scored.unsupportedChanges,2);
});

test('semantic evaluation rejects exit-code heuristics across command and protocol meanings',async()=>{
  const {evaluate}=await import('../../scripts/evaluate-learning.js');
  const corpus=JSON.parse(await readFile(new URL('../../tests/fixtures/learning-judgment.json',import.meta.url),'utf8'));
  const cases=corpus.filter((c:any)=>c.operation);
  assert.equal(cases.length,8);
  // These are deliberately wrong judgments, not simulated model responses.
  const answers=cases.map((c:any)=>({id:c.id,
    verdict:c.operation.runtimeOutcome==='success'?'supported':'contradicted',
    disposition:c.expected.dispositions[0],scope:c.expected.scope}));
  const scored=evaluate(cases,answers);
  assert.deepEqual(scored.rows.filter(r=>r.passed).map(r=>r.id),['diff-one-not-zero']);
  for(const id of ['diff-one-found-differences','search-one-no-matches','expected-rejection-observed']) {
    assert.equal(scored.rows.find(r=>r.id===id)?.passed,false);
  }
});

test('reviewer semantic support preserves a nonzero operation observation through the bus',async()=>{
  const f=await fixture();
  try {
    const record={taskId:'comparison',goalId:f.goalId,task:'Compare files',phase:'done',agentName:'ExternalCreator',steps:1,
      transcript:'git diff --no-index -- before.txt after.txt returned a complete patch; exit 1 denotes differences',
      predictions:[{step:1,action:'bash',expect:'The complete differences will be available',outcome:'failure',verdict:'unresolved',
        actual:JSON.stringify({exitCode:1,stdout:'-before\n+after',stderr:''})}]};
    await f.runtime.call(f.goals.id,'recordTaskEvidence',{goalId:f.goalId,taskId:record.taskId,record});
    (f.reviewer as any).taskExtras.get('review').records.push(record);
    const act=(action:unknown)=>f.runtime.call(f.reviewer.id,'agentAct',{taskId:'review',action});
    const before=await f.runtime.call(f.goals.id,'readGoalData',{goalId:f.goalId,key:'learning/task/comparison'});
    const evidence=await act({action:'read_evidence',taskId:'comparison'});
    assert.equal(evidence.success,true);assert.match(evidence.data,/git diff --no-index/);assert.match(evidence.data,/exitCode/);
    const assessment=await act({action:'assess_prediction',taskId:'comparison',step:1,verdict:'supported',
      explanation:'The complete patch was returned. For git diff --no-index, exit 1 reports differences found and supports availability of the diff.'});
    assert.equal(assessment.success,true,JSON.stringify(assessment));
    const saved=await f.runtime.call(f.goals.id,'readGoalData',{goalId:f.goalId,key:'learning/assessment/comparison:1'});
    assert.equal(saved.verdict,'supported');
    const after=await f.runtime.call(f.goals.id,'readGoalData',{goalId:f.goalId,key:'learning/task/comparison'});
    assert.deepEqual(after,before,'semantic interpretation must not rewrite the raw execution evidence');
  }finally{await f.stop();}
});

test('unfinished learning restores from its owner journal without the old goal index or SharedState metadata',async()=>{
  const f=await fixture();
  try {
    const d=await f.decision([{action:'archive_entry',id:'pending-target'}]);
    await f.runtime.call(f.storage.id,'set',{key:'goals:index',value:[]});
    await f.restartOwners();
    const pending=await f.runtime.call(f.goals.id,'pendingLearningDecisions');
    assert.equal(pending[0].id,d.id); assert.equal(pending[0].evidence['learning/task/worker'].result.passed,198);
  }finally{await f.stop();}
});

test('revising an assessment queues reconsideration of dependent knowledge without undoing acknowledged history',async()=>{
  const f=await fixture();
  try {
    const entry=await f.seed('Tests absent','No tests');
    const result=await f.runtime.call(f.reviewer.id,'completeReview',{taskId:'review',result:{
      evidence:'Owner ran 198 tests',evidenceRefs:['learning/task/worker'],assessments:[{taskId:'worker',step:1,verdict:'contradicted',explanation:'The test suite ran'}],
      knowledgeUpdates:[{action:'update_entry',id:entry.id,content:'Tests are available for these project inputs'}],
    }});
    assert.equal(result.result.status,'complete');
    await f.reviewer.call(f.goals.id,'recordPredictionAssessment',{goalId:f.goalId,taskId:'worker',step:1,expectedRevision:1,verdict:'unresolved',explanation:'The owner evidence needs a scope check',evidenceRefs:['learning/task/worker']});
    const pending=await f.runtime.call(f.goals.id,'pendingLearningDecisions'); assert.equal(pending.length,1);
    assert.equal(pending[0].context.previousDecisionId,result.result.decisions[0].id);
    assert.equal(pending[0].effects[0].state,'needs_repair'); assert.equal(pending[0].effects[0].input.id,entry.id);
    assert.equal((await f.runtime.call(f.kb.id,'get',{id:entry.id})).learning.revision,1,'changing an assessment alone does not silently rewrite knowledge');
  }finally{await f.stop();}
});


test('a failed replacement leaves its dependent retirement pending even when archives were listed first',async()=>{
  const f=await fixture();
  try {
    const old=await f.seed('Old duplicate','No tests'),replacement=await f.seed('Canonical','Uncorrected');
    const extra=(f.reviewer as any).taskExtras.get('review'); extra.knowledgeRefs[replacement.id]='stale-version';
    const response=await f.runtime.call(f.reviewer.id,'completeReview',{taskId:'review',result:{evidence:'Owner ran tests',evidenceRefs:['learning/task/worker'],assessments:[{taskId:'worker',step:1,verdict:'contradicted',explanation:'The test suite ran'}],knowledgeUpdates:[
      {action:'archive_entry',id:old.id},{action:'update_entry',id:replacement.id,content:'Tests pass'},
    ]}});
    assert.equal(response.result.decisions[0].effects[0].state,'proposed');
    assert.equal(response.result.decisions[0].effects[1].state,'needs_repair');
    assert.equal((await f.runtime.call(f.kb.id,'get',{id:old.id})).archived,false);
  }finally{await f.stop();}
});


test('the runtime recovers the original completion proposal through TaskSession messages',async()=>{
  const bus=new MessageBus(),registry=new Registry(),storage=new Store('Storage'),runtime:any=new Runtime(),sessions=new TaskSession(),reviewer=new Endpoint('TaskReviewer');
  const objects:Abject[]=[registry,storage,runtime,sessions,reviewer];
  try {
    for(const o of objects){o.setRegistryHint(registry.id);await o.init(bus);registry.registerObject(o.id,o.manifest);}
    runtime.sessionStoreId=sessions.id;
    const result={knowledgeUpdates:[{action:'archive_entry',id:'first-stale'},{action:'archive_entry',id:'second-stale'}]};
    await runtime.request(request(runtime.id,sessions.id,'checkpoint',{id:'legacy-review',expectedRevision:0,agentName:'TaskReviewer',intent:'Review completed task',status:'accepted',snapshot:{state:{llmMessages:[{role:'assistant',content:'```json\n'+JSON.stringify({action:'done',result})+'\n```'}]},specialist:{kind:'review',goalId:'retained-goal',records:[{taskId:'worker'}]}}}));
    await runtime.request(request(runtime.id,sessions.id,'checkpoint',{id:'empty-review',expectedRevision:0,agentName:'TaskReviewer',intent:'Uncheckpointed review',status:'partial'}));
    const recovered=await reviewer.call(runtime.id,'getRetainedReviewProposals');
    assert.equal(recovered.length,1);assert.deepEqual(recovered[0].result,result);assert.equal(recovered[0].goalId,'retained-goal');
  }finally{for(const o of objects.reverse())await o.stop();}
});

test('semantic repair cannot replace an operation whose delivery outcome is still unknown',async()=>{
  const f=await fixture();
  try {
    const d=await f.decision([{action:'update_entry',id:'unknown-delivery'},{action:'archive_entry',id:'rejected'}]);
    const change=(index:number,value:unknown)=>f.reviewer.call(f.goals.id,'changeLearningEffect',{goalId:f.goalId,decisionId:d.id,effectId:d.effects[index].id,change:value});
    await change(0,{state:'waiting',attempt:true,error:'Delivery retry budget exhausted'});
    await change(1,{state:'needs_repair',error:'Missing evidence'});
    const claimed=await f.reviewer.call(f.goals.id,'claimLearningRepair',{goalId:f.goalId,decisionId:d.id});
    assert.equal(claimed.decision.effects[0].repairClaimed,undefined);
    assert.equal(claimed.decision.effects[1].repairClaimed,true);
    await assert.rejects(change(0,{repair:{action:'no_change',evidence:'Cannot guess the delivery outcome'}}),/unknown delivery/);
  }finally{await f.stop();}
});

test('an unavailable explicit evidence reference cannot borrow validity from another episode',async()=>{
  const f=await fixture();
  try {
    const entry=await f.seed('Keep this claim','Original');
    const d=await f.decision([{action:'archive_entry',id:entry.id,knowledgeRef:entry.knowledgeRef,evidenceRefs:['learning/observation/missing:99']}]);
    assert.equal((await f.apply(d)).success,false);
    assert.equal((await f.runtime.call(f.kb.id,'get',{id:entry.id})).archived,false);
  }finally{await f.stop();}
});

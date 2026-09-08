import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { GoalManager } from './goal-manager.js';
import { KnowledgeBase } from './knowledge-base.js';
import { ScrumMaster } from './scrum-master.js';
import { TaskReviewer } from './task-reviewer.js';

class FixtureEndpoint extends Abject {
  private values=new Map<string,unknown>();
  review?:any; goalId?:string; checker?:AbjectId; questions:string[]=[];
  constructor(name:string){
    super({manifest:{name,version:'1',description:'Deterministic fixture endpoint',interface:{id:`fixture-${name}`,name,description:'fixture',methods:[]},requiredCapabilities:[],providedCapabilities:[]}});
    this.on('set',msg=>{const p=msg.payload as any;this.values.set(p.key,structuredClone(p.value));return true;});
    this.on('get',msg=>structuredClone(this.values.get((msg.payload as any).key)??null));
    this.on('registerAgent',()=>true);this.on('releaseTask',()=>true);this.on('listTasks',()=>[]);
    this.on('listAgents',()=>[{name:'Checker',agentId:this.checker,description:'Explains restoration checks',canExecute:true}]);
    this.on('listAgentQueue',()=>({inFlight:{taskId:'round',goalId:this.goalId},pending:[]}));
    this.on('startTask',msg=>{this.review=msg.payload;return {ticketId:this.review.taskId};});
    this.on('ask',msg=>{this.questions.push((msg.payload as any).question);return 'Use restoreThenVerify: a live counter is insufficient evidence of persistence.';});
  }
  protected override async handleAsk(question:string):Promise<string>{this.questions.push(question);return 'Use restoreThenVerify: live state does not prove persistence';}
  call(id:AbjectId,method:string,payload:unknown={}):Promise<any>{return this.request(request(this.id,id,method,payload),10000);}
}
class MemoryKnowledge extends KnowledgeBase {protected override async onInit():Promise<void>{}}
class FixtureScrum extends ScrumMaster {constructor(private dependencies:{runtime:AbjectId;goals:AbjectId;knowledge:AbjectId}){super();}protected override async onInit():Promise<void>{Object.assign(this,{agentAbjectId:this.dependencies.runtime,goalManagerId:this.dependencies.goals,knowledgeBaseId:this.dependencies.knowledge});}}

test('scripted learning episode carries a surprise through Scrum, retrospective and a later plan using messages',async()=>{
  const bus=new MessageBus(),runtime=new FixtureEndpoint('AgentAbject'),storage=new FixtureEndpoint('Storage'),checker=new FixtureEndpoint('Checker');
  const goals=new GoalManager(),knowledge=new MemoryKnowledge();runtime.checker=checker.id;
  const deps:Record<string,AbjectId>={AgentAbject:runtime.id,Storage:storage.id,GoalManager:goals.id,KnowledgeBase:knowledge.id};
  for(const object of [runtime,storage,checker,goals,knowledge]) (object as any).discoverDep=async(name:string)=>deps[name]??null;
  await runtime.init(bus);await storage.init(bus);await checker.init(bus);await knowledge.init(bus);await goals.init(bus);
  const scrum=new FixtureScrum({runtime:runtime.id,goals:goals.id,knowledge:knowledge.id}),reviewer=new TaskReviewer();
  (reviewer as any).discoverDep=async(name:string)=>deps[name]??null;
  await scrum.init(bus);await reviewer.init(bus);
  try{
    const {goalId}=await runtime.call(goals.id,'createGoal',{title:'Persist settings',description:'Persistent settings must survive restoration'});runtime.goalId=goalId;
    await runtime.call(goals.id,'recordPlan',{goalId,operationId:'initial',expectedRevision:0,plan:{assumptions:['live settings imply durable settings'],tasks:['change settings']}});
    await runtime.call(goals.id,'recordObservation',{goalId,operationId:'restore',observation:{expect:'settings survive restoration',verdict:'contradicted',actual:{saved:7,restored:0},material:true}});
    await runtime.call(goals.id,'recordObservation',{goalId,operationId:'negative-control',observation:{expect:'invalid input rejected',verdict:'supported',outcome:'failure',actual:'validation rejected input'}});
    const reviewed=await runtime.call(scrum.id,'agentAct',{taskId:'round',action:{action:'review_scrum'}});
    assert.equal(reviewed.success,true);assert.equal(reviewed.data.planRevision,1);
    assert(reviewed.data.observations.some((o:any)=>o.verdict==='contradicted'));
    await runtime.call(scrum.id,'agentAct',{taskId:'round',action:{action:'poll_team',members:['Checker'],question:'What does the restoration discrepancy change?'}});
    assert(checker.questions.some(q=>q.includes(goalId)&&q.includes('restored')));
    await runtime.call(goals.id,'recordPlan',{goalId,operationId:'revised',expectedRevision:reviewed.data.planRevision,plan:{change:'Check restored state before accepting live edits',nextExperiment:'restoreThenVerify',reason:'Saved 7 but restored 0'}});
    await runtime.call(goals.id,'recordTaskEvidence',{goalId,taskId:'experiment',record:{taskId:'experiment',agentName:'Checker',goalId,phase:'error',steps:2,task:'restore settings',injectedKnowledge:[],transcript:'Restore returned zero rather than seven. '.repeat(40),predictions:reviewed.data.observations}});
    await runtime.call(goals.id,'failGoal',{goalId,error:'Restoration lost settings'});
    for(let n=0;n<100&&!runtime.review;n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert(runtime.review,'durable failed-goal review was scheduled');
    assert.equal(runtime.review.config.budgetGoalId,goalId,'retrospective reasoning remains attributable to its originating goal');
    assert.match(JSON.stringify(runtime.review.initialMessages),/Saved 7 but restored 0/);
    const saved=await runtime.call(reviewer.id,'agentAct',{taskId:runtime.review.taskId,action:{action:'save_pattern',name:'VERIFY RESTORED SETTINGS',context:'Persistent settings restored across restart',forces:'Live state can conceal failed persistence',therefore:'Inspect restored state before acceptance',evidence:'Candidate from the observed failed restoration; invalid-input rejection was expected'}});
    assert.equal(saved.success,true);
    await runtime.call(reviewer.id,'taskResult',{ticketId:runtime.review.taskId,success:true});
    assert.equal((await runtime.call(goals.id,'pendingReviews')).length,0);
    const next=await runtime.call(goals.id,'createGoal',{title:'Restore preferences',description:'Persistent settings must survive restoration'});runtime.goalId=next.goalId;
    const nextReview=await runtime.call(scrum.id,'agentAct',{taskId:'round',action:{action:'review_scrum'}});
    assert(nextReview.data.applicablePatterns.some((p:any)=>p.title==='VERIFY RESTORED SETTINGS'));
    const learned=nextReview.data.applicablePatterns.find((p:any)=>p.title==='VERIFY RESTORED SETTINGS');
    const nextPlan=await runtime.call(goals.id,'recordPlan',{goalId:next.goalId,operationId:'learned-plan',expectedRevision:0,plan:{patterns:[learned.id],change:'Restore and inspect preferences before claiming completion'}});
    assert.equal(nextPlan.revision,1);
  }finally{await reviewer.stop();await scrum.stop();await goals.stop();await knowledge.stop();await checker.stop();await storage.stop();await runtime.stop();}
});

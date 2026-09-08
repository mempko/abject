import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { AgentAbject } from './agent-abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';

class Runtime extends AgentAbject { protected override async onInit():Promise<void>{} }
class Collaborator extends Abject {
  results:any[]=[];
  waiters=new Map<string,(v:any)=>void>();
  executions=0;
  agreement:Promise<string>=Promise.resolve('Execute with independent evidence');
  constructor(private runtime:AbjectId){
    super({manifest:{name:'Collaborator',version:'1',description:'test',interface:{id:'delegation-test',name:'Collaborator',description:'test',methods:[]},requiredCapabilities:[],providedCapabilities:[]}});
    this.on('taskResult',msg=>{const p=msg.payload as any;this.results.push(p);this.waiters.get(p.ticketId)?.(p);return true;});
    this.on('executeTask',async msg=>{
      this.executions++;
      const p=msg.payload as any;
      const outcome=new Promise(resolve=>this.waiters.set(p.taskId,resolve));
      await this.call('startTask',{taskId:p.taskId,task:p.description,config:{maxSteps:999}});
      return outcome;
    });
  }
  protected override async handleAsk():Promise<string>{return this.agreement;}
  call(method:string,payload:unknown):Promise<any>{return this.request(request(this.id,this.runtime,method,payload),5000);}
}

test('same-agent delegation finishes while its parent waits and enforces the child step bound',async()=>{
  const bus=new MessageBus(),runtime:any=new Runtime(),agent=new Collaborator(runtime.id);
  await runtime.init(bus);await agent.init(bus);
  try{
    await agent.call('registerAgent',{name:'Collaborator',config:{maxSteps:30}});
    let childBudget=0;
    runtime.runStateMachine=async(entry:any)=>{
      if(entry.parentTaskId){childBudget=entry.state.maxSteps;entry.state.phase='done';entry.state.result='child evidence';return;}
      const child=await agent.call('delegateTask',{parentTaskId:entry.state.id,agentId:agent.id,task:'bounded investigation',operationId:'investigate'});
      assert.match(child.taskId,/:child:investigate$/);
      for(let n=0;n<100 && runtime.delegations.get(child.taskId).status==='running';n++)await new Promise(resolve=>setTimeout(resolve,1));
      assert.equal(runtime.delegations.get(child.taskId).status,'done');
      const duplicate=await agent.call('delegateTask',{parentTaskId:entry.state.id,agentId:agent.id,task:'bounded investigation',operationId:'investigate'});
      assert.equal(duplicate.taskId,child.taskId);
      entry.state.phase='done';entry.state.result='parent used child evidence';
    };
    await agent.call('startTask',{taskId:'parent',task:'investigate then decide'});
    for(let n=0;n<100 && !agent.results.some(r=>r.ticketId==='parent');n++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(agent.results.find(r=>r.ticketId==='parent')?.success,true);
    assert.equal(agent.executions,1);assert.equal(childBudget,15);
  }finally{await agent.stop();await runtime.stop();}
});

test('cancellation during Ask cannot start the negotiated child',async()=>{
  const bus=new MessageBus(),runtime:any=new Runtime(),agent=new Collaborator(runtime.id);
  await runtime.init(bus);await agent.init(bus);
  try{
    await agent.call('registerAgent',{name:'Collaborator'});
    let resolveAsk!:(value:string)=>void;agent.agreement=new Promise(resolve=>{resolveAsk=resolve;});
    const parent={agentId:agent.id,state:{id:'parent',phase:'thinking',maxSteps:20,step:1,llmMessages:[]}};
    runtime.taskEntries.set('parent',parent);
    const work=agent.call('delegateTask',{parentTaskId:'parent',agentId:agent.id,task:'inspect',operationId:'inspect'});
    const rejected=assert.rejects(work,/cancelled/);
    await new Promise(resolve=>setTimeout(resolve,2));
    parent.state.phase='error';runtime.cancelDescendants('parent');resolveAsk('Ready');
    await rejected;assert.equal(agent.executions,0);
  }finally{runtime.taskEntries.clear();await agent.stop();await runtime.stop();}
});

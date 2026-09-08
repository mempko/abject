import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject,DEFERRED_REPLY } from '../core/abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { request,event } from '../core/message.js';
import type {AbjectId} from '../core/types.js';
import { JobManager } from './job-manager.js';
import { domainFailure } from '../core/result-contract.js';
import { TupleSpace } from './tuple-space.js';
class Endpoint extends Abject {
  calls=0; private timers:Array<ReturnType<typeof setTimeout>>=[];
  constructor(name:string,runtime?:AbjectId,jobs?:AbjectId){
    super({manifest:{name,version:'1',description:'test',interface:{id:`test-${name}`,name,description:'test',methods:[]},requiredCapabilities:[],providedCapabilities:[]}});
    this.on('agentAct',async msg=>{await this.requireTaskRuntime(msg,runtime);this.calls++;return {success:true};});
    (this as any).discoverDep=async(name:string)=>name==='JobManager'?jobs:null;
    this.on('wait',msg=>{
      const taskId=(msg.payload as {taskId:string}).taskId;
      const timer=taskId==='a'?setInterval(()=>this.send(event(this.id,msg.routing.from,'progress',{taskId})),20):undefined;
      if(timer)this.timers.push(timer);
      this.timers.push(setTimeout(()=>{if(timer)clearInterval(timer);this.sendDeferredReply(msg,{taskId});},300));
      return DEFERRED_REPLY;
    });
  }
  protected override async onStop():Promise<void>{for(const timer of this.timers)clearTimeout(timer);}
  call(to:AbjectId,method:string,payload:unknown={},timeout=10000):Promise<any>{return this.request(request(this.id,to,method,payload),timeout);}
}
test('job callbacks authenticate the original runtime without trusting unrelated jobs',async()=>{
  const bus=new MessageBus(),runtime=new Endpoint('Runtime'),stranger=new Endpoint('Stranger'),jobs=new JobManager();
  (jobs as any).discoverDep=async()=>null;
  const target=new Endpoint('Agent',runtime.id,jobs.id);
  for(const o of [runtime,stranger,jobs,target])await o.init(bus);
  const payload={description:'callback',code:`return await call(${JSON.stringify(target.id)}, "agentAct", { taskId: "a" });`};
  try{
    const good=await runtime.call(jobs.id,'submitJob',payload);assert.equal(good.status,'completed');assert.equal(good.result.success,true);
    const bad=await stranger.call(jobs.id,'submitJob',payload);assert.equal(bad.status,'failed');assert.match(bad.error,/callback requires/);assert.equal(target.calls,1);
  }finally{for(const o of [target,jobs,stranger,runtime])await o.stop();}
});
test('one task heartbeat cannot keep another task request alive',async()=>{
  const bus=new MessageBus(),client=new Endpoint('Client'),target=new Endpoint('Target');await client.init(bus);await target.init(bus);
  try{
    const a=client.call(target.id,'wait',{taskId:'a'},150);
    const b=client.call(target.id,'wait',{taskId:'b'},150);
    await assert.rejects(b,/timeout/);assert.deepEqual(await a,{taskId:'a'});
  }finally{await target.stop();await client.stop();}
});
test('domain failure follows the receiver contract rather than transport delivery',()=>{
  assert.equal(domainFailure({success:false,error:'not permitted'},{successField:'success',errorField:'error'}),'not permitted');
  assert.equal(domainFailure({success:false},null),undefined);
  assert.equal(domainFailure({successful:false,detail:'conflict'},{successField:'successful',errorField:'detail'}),'conflict');
});
test('tuple creation and update use stable operation identity and compare expected fields',async()=>{
  const t:any=new TupleSpace(),tuples=new Map();t.changed=()=>{};
  t.getAllTuples=async()=>new Map([...tuples].map(([id,value])=>[id,structuredClone(value)]));
  t.writeTuple=async(tuple:any)=>{await new Promise(resolve=>setTimeout(resolve,1));tuples.set(tuple.id,structuredClone(tuple));};
  const send=(method:string,payload:unknown)=>t.handlers.get(method)({routing:{from:'manager'},payload});
  const p={namespace:'goal',operationId:'round-task-a',fields:{status:'pending',description:'work'}};
  const [one,two]=await Promise.all([send('put',p),send('put',p)]);assert.equal(one.tupleId,two.tupleId);assert.equal(tuples.size,1);
  await assert.rejects(send('put',{...p,fields:{status:'pending',description:'different'}}),/Conflicting/);
  const updates=await Promise.all(['done','superseded'].map(status=>send('update',{namespace:'goal',tupleId:one.tupleId,expectedFields:{status:'pending'},fields:{status}})));
  assert.equal(updates.filter(Boolean).length,1);
});

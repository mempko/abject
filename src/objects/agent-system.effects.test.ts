import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,mkdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostFileSystem } from './capabilities/host-filesystem.js';
import { ScriptableAbject } from './scriptable-abject.js';
import { Abject } from '../core/abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
class Client extends Abject {
  constructor(){super({manifest:{name:'EffectsClient',version:'1',description:'test',interface:{id:'effects-client',name:'Client',description:'test',methods:[]},requiredCapabilities:[],providedCapabilities:[]}});}
  call(id:AbjectId,method:string,payload:unknown={}):Promise<any>{return this.request(request(this.id,id,method,payload),15000);}
}
class SnapshotStore extends Abject {
  saved:any;
  constructor(){
    super({manifest:{name:'AbjectStore',version:'1',description:'message storage fixture',interface:{id:'snapshot-store',name:'Store',description:'fixture',methods:[]},requiredCapabilities:[],providedCapabilities:[]}});
    this.on('save',msg=>{this.saved=structuredClone(msg.payload);return {success:true};});
    this.on('getDurableSnapshot',()=>structuredClone(this.saved));
  }
}
test('conditional file writes reject a concurrent stale writer without losing content',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'abject-effects-'));
  const fs:any=new HostFileSystem({allowedPaths:[root],readOnly:false});
  const invoke=(method:string,payload:unknown)=>fs.handlers.get(method)({routing:{from:'client'},payload});
  try {
    const file=path.join(root,'state.txt');await writeFile(file,'base');
    const results=await Promise.all(['one','two'].map(content=>invoke('conditionalWrite',{path:file,expectedContent:'base',content})));
    assert.equal(results.filter(r=>r.success).length,1);assert.equal(results.filter(r=>r.conflict).length,1);
    assert.equal(await readFile(file,'utf8'),results[0].success?'one':'two');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('project snapshots include untracked and generated files and flag incomplete coverage',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'abject-snapshot-'));
  const fs:any=new HostFileSystem({allowedPaths:[root]});
  const snapshot=(maxFiles=100)=>fs.handlers.get('snapshotTree')({routing:{from:'client'},payload:{root,maxFiles}});
  try {
    await writeFile(path.join(root,'tracked.ts'),'one');const before=await snapshot();
    await mkdir(path.join(root,'generated'));await writeFile(path.join(root,'generated','new.ts'),'two');
    const after=await snapshot();assert.notEqual(before.revision,after.revision);assert(after.files['generated/new.ts']);assert.equal(after.complete,true);
    assert.equal((await snapshot(1)).complete,false);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('failed source activation restores working source and internal data',async()=>{
  const bus=new MessageBus(),client=new Client();await client.init(bus);
  const source='({ show(){this.data.visible=true;}, hide(){this.data.visible=false;}, increment(){return ++this.data.count;} })';
  const object=new ScriptableAbject({name:'Counter',version:'1',description:'counter',interface:{id:'counter',name:'Counter',description:'counter',methods:[]},requiredCapabilities:[],providedCapabilities:[]},source,client.id,{count:2});
  await object.init(bus);
  try {
    await client.call(object.id,'show');
    const result=await client.call(object.id,'updateSource',{expectedSource:source,source:'({ show(){this.data.count=99;throw new Error("bad activation");}, hide(){} })'});
    assert.equal(result.success,false);assert.equal(result.rolledBack,true);
    assert.equal(await client.call(object.id,'getSource'),source);
    assert.deepEqual(await client.call(object.id,'getData'),{count:2,visible:true});
    assert.equal(await client.call(object.id,'increment'),3);
  }finally{await object.stop();await client.stop();}
});

test('a failing old hide handler leaves the previous source usable and restores data',async()=>{
  const bus=new MessageBus(),client=new Client();await client.init(bus);
  const source='({ show(){this.data.visible=true;}, hide(){this.data.count=99;throw new Error("hide failed");}, increment(){return ++this.data.count;} })';
  const object=new ScriptableAbject({name:'OldLifecycle',version:'1',description:'counter',interface:{id:'old-lifecycle',name:'Counter',description:'counter',methods:[]},requiredCapabilities:[],providedCapabilities:[]},source,client.id,{count:2});
  await object.init(bus);
  try {
    const result=await client.call(object.id,'updateSource',{expectedSource:source,source:'({ show(){this.data.count=100;} })'});
    assert.equal(result.success,false);assert.equal(result.rolledBack,true);
    assert.equal(await client.call(object.id,'getSource'),source);
    assert.equal(await client.call(object.id,'increment'),3);
  }finally{await object.stop();await client.stop();}
});

test('application persistence includes exercised data and restores a usable application',async()=>{
  const bus=new MessageBus(),client=new Client(),store=new SnapshotStore();
  await client.init(bus);await store.init(bus);
  const manifest={name:'SavedCounter',version:'1',description:'counter',interface:{id:'saved-counter',name:'Counter',description:'counter',methods:[]},requiredCapabilities:[],providedCapabilities:[]};
  const source='({ increment(){return ++this.data.count;} })';
  const object=new ScriptableAbject(manifest,source,client.id,{count:2});
  (object as any).discoverDep=async(name:string)=>name==='AbjectStore'?store.id:null;
  await object.init(bus);let restored:ScriptableAbject|undefined;
  try{
    assert.equal(await client.call(object.id,'increment'),3);
    const stale=await client.call(object.id,'persistSnapshot',{expectedSource:'obsolete'});
    assert.equal(stale.conflict,true);assert.equal(store.saved,undefined);
    const receipt=await client.call(object.id,'persistSnapshot',{expectedSource:source});
    assert.equal(receipt.success,true);assert.deepEqual(receipt.data,{count:3});
    const saved=await client.call(store.id,'getDurableSnapshot');
    restored=new ScriptableAbject(saved.manifest,saved.source,client.id,structuredClone(saved.data));
    await restored.init(bus);assert.equal(await client.call(restored.id,'increment'),4);
  }finally{await restored?.stop();await object.stop();await store.stop();await client.stop();}
});

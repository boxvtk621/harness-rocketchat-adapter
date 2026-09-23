// Run in the client build image; assertions exercise the actual components.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire('/app/package.json');
const {buildSync}=require('esbuild');
for(const name of ['node-settings','provider-auth']) buildSync({entryPoints:[`/app/src/app/${name}.component.ts`],outfile:`/app/${name}-test.mjs`,bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'/app/tsconfig.json'});
await import(require.resolve('@angular/compiler'));
const {NodeSettingsComponent}=await import('/app/node-settings-test.mjs');
const {ProviderAuthComponent}=await import('/app/provider-auth-test.mjs');
globalThis.window={clearInterval(){},setInterval(){return 1}};
globalThis.document={hidden:false};
let writes=0;
const settings=new NodeSettingsComponent({post(){writes++;throw Error('unexpected write')}});
settings.sessionKey='user:session';
const saved={schemaId:'harness-node-settings-v1',nodeId:'node',draftRevision:0,appliedRevision:0,draft:{mcpServers:[],inference:{modelId:null,speedMode:null,reasoningEffort:null}},applied:null,capabilities:{nativeRestart:'unsupported'}};
settings.accept(structuredClone(saved));
assert.equal(settings.settingsStatus(),'Исходные настройки');
assert.equal(settings.hasUnsavedChanges(),false);
settings.draft().inference.modelId='selected-model';
assert.equal(settings.settingsStatus(),'Не применено');
settings.ngOnChanges({accessToken:{firstChange:false}});
assert.equal(settings.draft().inference.modelId,'selected-model','Token renewal preserves unsaved selection');
settings.apply();assert.equal(writes,0,'Unsaved/unsupported configuration cannot be applied');
settings.accept({...structuredClone(saved),draftRevision:1});
settings.apply();assert.equal(writes,0,'Unsupported apply is blocked after save too');
assert.match(settings.settingsGuidance(),/отличаются от работающих/);
settings.ngOnChanges({sessionKey:{firstChange:false}});
assert.equal(settings.draft(),null,'Another session clears configuration');

const calls=[];
let loseAck=false;
const returned={...structuredClone(saved),draftRevision:1,capabilities:{nativeRestart:'supported'}};
const http={
  put(_url,body){calls.push({method:'PUT',body});return {subscribe(observer){observer.next(structuredClone(returned));}}},
  post(_url,body){calls.push({method:'POST',body});return {subscribe(observer){
    if(loseAck) observer.error({status:0});
    else observer.next({nodeId:'node',operation:{operationId:crypto.randomUUID(),commandId:body.commandId,targetRevision:body.targetRevision,status:'running',phase:'draining'}});
  }}},
  get(){calls.push({method:'GET'});return {subscribe(observer){observer.next(structuredClone(returned));}}}
};
const active=new NodeSettingsComponent(http);
active.nodeId='node';active.canManage=true;active.accept({...structuredClone(saved),capabilities:{nativeRestart:'supported'}});
active.draft().inference.modelId='selected-model';
active.apply();
assert.deepEqual(calls.map(x=>x.method),['PUT','POST','GET']);
assert.equal(calls[0].body.expectedRevision,0);
assert.equal(calls[1].body.targetRevision,1);
assert.equal(active.hasUnsavedChanges(),false);
assert.equal(active.settingsStatus(),'Не применено');
const firstCommand=calls[1].body.commandId;
loseAck=true;
active.apply();
assert.equal(calls.at(-2).method,'POST');
assert.equal(calls.at(-2).body.commandId,firstCommand,'Retry preserves commandId after an uncertain response');
assert.equal(calls.at(-1).method,'GET','Uncertain response triggers readback');
assert.equal(calls.filter(x=>x.method==='PUT').length,1,'Retry does not save a second draft');
assert.match(active.error(),/Ответ о применении не получен/,'Unconfirmed result stays visible until readback finds the command');
const compatibility=new NodeSettingsComponent({});
compatibility.nodeId='node';compatibility.accept({...structuredClone(saved),capabilities:{nativeRestart:'supported'}});
compatibility.catalog.set({models:[{id:'new-model',speedModes:[{id:'standard'}],reasoningEfforts:[{id:'low'}]}]});
compatibility.draft().inference={modelId:'new-model',speedMode:'fast',reasoningEffort:'high'};
assert.equal(compatibility.incompatibleChoice('speed'),true,'Changing model does not silently replace speed');
assert.equal(compatibility.incompatibleChoice('reasoning'),true,'Changing model does not silently replace reasoning');
compatibility.apply();assert.equal(compatibility.busy(),false,'Incompatible values require an explicit selection');
compatibility.draft().inference.speedMode=null;compatibility.draft().inference.reasoningEffort=null;
assert.equal(compatibility.incompatibleChoice('speed'),false);
const auth=new ProviderAuthComponent({});auth.sessionKey='user:session';auth.snapshot.set({state:'authenticated'});auth.secret='not-a-real-secret';
auth.ngOnChanges({accessToken:{firstChange:false}});
assert.equal(auth.snapshot().state,'authenticated');assert.equal(auth.secret,'not-a-real-secret');
auth.ngOnChanges({sessionKey:{firstChange:false}});
assert.equal(auth.snapshot(),null);assert.equal(auth.secret,'');
console.log('PASS settings state, one-action apply, lost ACK retry, token renewal and session isolation');

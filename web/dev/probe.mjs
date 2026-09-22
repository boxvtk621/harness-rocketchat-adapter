// Read-only, bounded infrastructure probe. Never emits codes, tokens, prompts or credentials.
import https from 'node:https';
import {readFile} from 'node:fs/promises';
const ca=await readFile('/runtime/harness/server.crt');
async function get(host,path){return new Promise((resolve,reject)=>{
  const req=https.get({hostname:host,port:8443,path,ca,minVersion:'TLSv1.3',timeout:15000},res=>{
    let text='';res.on('data',chunk=>{text+=chunk;if(text.length>8*1024*1024)req.destroy(Error('response_too_large'));});
    res.on('end',()=>{if(res.statusCode!==200&&!(path==='/health/ready'&&res.statusCode===503)){reject(Error(`http_${res.statusCode}`));return;}try{resolve(JSON.parse(text));}catch{reject(Error('invalid_json_response'));}});
  });req.on('timeout',()=>req.destroy(Error('timeout')));req.on('error',()=>reject(Error('transport_unavailable')));
});}
const result={checkedAt:new Date().toISOString(),nodes:[],registry:[],safeToStop:false};
for(const kind of ['cursor','codex']){
  const node={kind,available:false,safeToStop:false};
  try{
    const config=JSON.parse(await readFile(`/runtime/harness/${kind}-node.json`,'utf8'));
    const host=`${kind}-harness`,id=config.nodeId;
    const identity=await get(host,'/v1/identity');
    if(identity.nodeId!==id)throw Error('identity_mismatch');
    const snapshot=await get(host,`/v1/nodes/${id}/snapshot`);
    const ready=await get(host,'/health/ready');
    const auth=await get(host,`/v1/provider-auth?nodeId=${id}`);
    const outstanding={};
    for(const state of ['queued','dispatching','active','unknown']){
      const page=await get(host,`/v1/nodes/${id}/requests?state=${state}&limit=1`);
      if(!Array.isArray(page.items))throw Error('invalid_request_page');
      outstanding[state]=page.items.length>0||page.nextCursor!==null;
    }
    Object.assign(node,{available:true,nodeId:id,adapter:identity.adapter,readiness:ready.readiness??"unavailable",healthError:ready.code??ready.error?.code??null,
      blockedReasons:ready.blockedReasons??[],authState:auth.state,authRevision:auth.revision,
      authOperation:auth.operation?{id:auth.operation.operationId,status:auth.operation.status}:null,
      occupancy:snapshot.node.occupancy,pendingCount:snapshot.node.pendingCount,
      activeAttempt:!!snapshot.activeAttempt||!!snapshot.node.activeAttemptId,outstanding});
    node.safeToStop=node.occupancy==='idle'&&node.pendingCount===0&&!node.activeAttempt&&
      !Object.values(outstanding).some(Boolean)&&node.authOperation?.status!=='pending';
  }catch(e){node.error=e.message;}result.nodes.push(node);
}
try{
  const token=(await readFile('/runtime/secrets/adapter_internal_token','utf8')).trim();
  const r=await fetch('http://adapter:8080/api/connections',{headers:{'X-Internal-Token':token},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('registry_unavailable');
  result.registry=(await r.json()).map(c=>({id:c.id,configEpoch:c.configEpoch,endpointKey:c.endpointKey,nodeId:c.observation.nodeId}));
}catch{result.registryError='registry_unavailable';}
result.safeToStop=result.nodes.length===2&&result.nodes.every(n=>n.safeToStop);
console.log(JSON.stringify(result));
if(process.argv.includes('--require-idle')&&!result.safeToStop)process.exitCode=3;

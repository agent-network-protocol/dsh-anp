import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {apply} from '../src/plugin.js';

async function fixture(waitMs=1000) {
  const ctx=new Context(); const tools=new Map<string,any>();
  let access:any={id:'exact-access',status:'pending',version:1};let requested=0,sent=0,reads=0;
  const docs=(url:string)=>url.endsWith('/ad.json')?{protocolType:'ANP',type:'AgentDescription',interfaces:[{url:'/openapi.json',protocol:'OpenAPI'}]}:
    {openapi:'3.1.0',paths:{'/read':{get:{operationId:'read'}},'/write':{post:{operationId:'write',requestBody:{}}},'/extra':{get:{operationId:'extra',security:[{oauth:['account.read']}]}}}};
  ctx.provide('tools',{register(tool:any){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}});
  ctx.provide('anpIdentity',{
    publicDiscovery:async()=>Response.json({'@type':'CollectionPage',items:[{'@id':'https://service.example/ad.json',name:'Service'}]}),
    resolveDomainAccess:async()=>({identityRef:{storeId:'store',identityId:'identity',did:'did:wba:identity.example'}}),
    bindAnpDomainConsumer(){return {async dispatchRead(request:Request,evidence:any){assert.equal(evidence.requiresApproval,false);assert.equal(request.method,'GET');reads++;return Response.json(request.url.endsWith('/read')?{read:true}:docs(request.url));}};},
    bindUserConsumer(){return {
      async findAccessGrant(){throw new Error('Domain writes must not reuse permanent grants');},
      async requestAccess(input:any){requested++;assert.equal(input.operation.action,'http');assert(input.purpose.includes('exact operation'));return {...access};},
      async getAccessRequest(){return {...access};},
      async cancelAccessRequest(){access={...access,status:'cancelled'};return {...access};},
      async openAuthorizedIdentity(){return {authenticatedHttp:{async dispatch(request:Request){assert.equal(access.status,'approved');assert.equal(access.mode,'once');sent++;return Response.json({executed:true});}}};},
    };},
  });
  apply(ctx,{enabled:true,autoConnect:true,approvalWaitMs:waitMs,approvalPollMs:10});
  const execute=(name:string,args:object,signal?:AbortSignal)=>tools.get(name).execute(args,{agent:{},signal});
  const discovered=await execute('anp_discover',{domain:'website.example'});
  const described=await execute('anp_describe',{agentRef:discovered.value.agents[0].agentRef});
  const api=await execute('anp_read',{resourceRef:described.value.links[0].resourceRef});
  const op=(name:string)=>api.value.operations.find((op:any)=>op.operationId===name).operationRef;
  return {ctx,execute,op,counts:()=>({requested,sent,reads}),approve(mode='once'){access={...access,status:'approved',mode,grantId:'one-grant'};},deny(){access={...access,status:'denied'};},status:()=>access.status};
}
const until=async(predicate:()=>boolean)=>{for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,5));assert(predicate());};

test('discovered reads need no extra prompt; a write waits for owner consent then sends exactly once',async()=>{
  const f=await fixture();try{
    assert.equal((await f.execute('anp_call',{operationRef:f.op('read')})).ok,true);
    assert.equal(f.counts().requested,0);
    const pending=f.execute('anp_call',{operationRef:f.op('write'),body:{message:'approved content'}});
    await until(()=>f.counts().requested===1);assert.equal(f.counts().sent,0);
    f.approve();assert.equal((await pending).ok,true);assert.equal(f.counts().sent,1);
  }finally{await f.ctx.fiber.dispose();}
});
test('extra scopes require an explicit decision even on GET; denial sends nothing',async()=>{
  const f=await fixture();try{
    const pending=f.execute('anp_call',{operationRef:f.op('extra')});await until(()=>f.counts().requested===1);assert.equal(f.counts().sent,0);
    f.deny();assert.deepEqual(await pending,{ok:false,error:'identity_authorization_denied'});assert.equal(f.counts().sent,0);
  }finally{await f.ctx.fiber.dispose();}
});
test('a pending timeout returns an automatic-dialog reference without granting or sending',async()=>{
  const f=await fixture(20);try{
    const result=await f.execute('anp_call',{operationRef:f.op('write'),body:{message:'not sent'}});
    assert.deepEqual(result,{ok:false,error:'identity_authorization_required',authorization:{requestId:'exact-access',presentation:'dialog',status:'pending'}});
    assert.equal(f.counts().sent,0);assert.equal(f.status(),'pending');
  }finally{await f.ctx.fiber.dispose();}
});
test('cancellation and unload cancel a pending request and cannot send after a late approval',async()=>{
  for(const unload of [false,true]){
    const f=await fixture();const controller=new AbortController();
    try{const pending=f.execute('anp_call',{operationRef:f.op('write'),body:{}},controller.signal);await until(()=>f.counts().requested===1);
      if(unload)await f.ctx.fiber.dispose();else controller.abort();
      assert.deepEqual(await pending,{ok:false,error:'unavailable'});assert.equal(f.status(),'cancelled');f.approve();assert.equal(f.counts().sent,0);
    }finally{await f.ctx.fiber.dispose();}
  }
});
test('a permanent grant cannot authorize a domain write through the once-only path',async()=>{
  const f=await fixture();try{
    const pending=f.execute('anp_call',{operationRef:f.op('write'),body:{}});await until(()=>f.counts().requested===1);f.approve('permanent');
    assert.deepEqual(await pending,{ok:false,error:'identity_operation_not_permitted'});assert.equal(f.counts().sent,0);
  }finally{await f.ctx.fiber.dispose();}
});

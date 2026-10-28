import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const base=process.env.SMOKE_URL||'http://127.0.0.1:8098';if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Smoke test is restricted to a local synthetic demo.');
const login=await fs.readFile('.local-login.txt','utf8'),password=login.match(/^Password: (.+)$/m)?.[1];let cookie,csrf;
async function call(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();return {r,data};}
let x=await call('/health');assert.equal(x.data.demoMode,true);assert.equal(x.data.writesEnabled,false);assert.equal(x.data.version,'0.1.0-preview.2');assert.equal((await call('/api/state')).r.status,401);
x=await call('/api/login',{username:'admin',password});assert.equal(x.r.status,200);cookie=x.r.headers.get('set-cookie').split(';')[0];csrf=x.data.csrf;
x=await call('/api/creatives?account=900000000000001');assert.equal(x.data.source,'synthetic_demo');assert.equal(x.data.cards.length,1);
x=await call('/api/creative-performance?account=900000000000001&since=2026-10-01&until=2026-10-01&ads=900000000000004');assert.equal(x.data.rows[0].purchases,2);
assert.equal((await call('/api/creatives?account=900000000000099')).r.status,404);
const path='/api/learning?account=900000000000001&ads=900000000000004';x=await call(path);assert.ok(x.data.records.some(r=>r.recordKey==='synthetic-case-v1'));
const record={accountId:'900000000000001',campaignId:'900000000000002',adsetId:'900000000000003',adId:'900000000000004',recordKey:'synthetic-smoke-v1',recordDate:'2026-10-02',kind:'followup',title:'Synthetic write/readback test',source:'Local demo smoke test',content:{facts:['Synthetic only'],hypotheses:[],suggestions:[],approvals:[],executions:[],verification:['No platform action']}};
let first=await call('/api/learning',record),second=await call('/api/learning',record);assert.equal(first.r.status,200);assert.equal(first.data.record.hash,second.data.record.hash);assert.equal((await call('/api/learning',{...record,title:'Conflicting replacement'})).r.status,409);
x=await call(path);assert.equal(x.data.records.filter(r=>r.recordKey===record.recordKey).length,1);assert.equal(x.data.records.find(r=>r.recordKey===record.recordKey).storage.database,'verified');assert.notEqual(x.data.records.find(r=>r.recordKey===record.recordKey).storage.nas,'verified');
assert.equal((await call('/api/daily-review/status?account=900000000000001')).data.schedule.enabled,false);
console.log(JSON.stringify({demo:true,unauthenticatedBlocked:true,accountScope:true,syntheticMetrics:true,appendReadback:true,idempotence:true,conflictRejected:true,nasNotFalselyVerified:true,scheduleDisabledByDefault:true,platformWrites:false}));

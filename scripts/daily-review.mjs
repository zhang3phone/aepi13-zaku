import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import {reconcileFailures,reconcileReady} from '../lib/daily-review-state.mjs';
import {LearningStore} from '../lib/learning-store.mjs';
import {POLICY,REVIEW_SCHEMA,isoDay,validateConfig,ReadOnlyGraph,collect,buildRecord,redactEvidence,failureRecord,digest} from '../lib/daily-review.mjs';
if(process.env.DEMO_MODE!=='false')throw Error('daily_review_requires_explicit_live_mode');
const args=process.argv.slice(2);if(args.some(x=>!['--trial'].includes(x)))throw Error('unsupported_review_argument');
const slot=args.includes('--trial')?'trial':'daily';
const config=validateConfig(JSON.parse(await fs.readFile(process.env.REVIEW_CONFIG||'/run/daily-review.json','utf8')));
const outbox=process.env.REVIEW_OUTBOX||'/outbox',now=new Date(),date=isoDay(now,config.timezone);
const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:config.timezone,hour:'2-digit',hourCycle:'h23'}).format(now));
if(slot==='daily'&&hour<config.hour){console.log(JSON.stringify({status:'not_due',date,timezone:config.timezone}));process.exit(0);}
const dbUrl=new URL(process.env.DATABASE_URL||'invalid:');if(dbUrl.pathname!=='/meta_ads_workbench'||dbUrl.username!=='aepi13_zaku_app'||dbUrl.hostname.toLowerCase()!==(process.env.REVIEW_DB_HOST||'db').toLowerCase())throw Error('review_database_scope_invalid');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10000,query_timeout:120000});
const safeError=e=>/^(?:meta_api_\d+|meta_network_unavailable|meta_response_invalid|account_reporting_context_changed|live_ad_identity_mismatch|insights_[a-z_]+|meta_credentials_missing|known_learning_identity_required)$/.test(e?.message||'')?e.message:'review_collection_or_storage_failed';
async function immutableJson(t,value,label){
 const bytes=Buffer.from(JSON.stringify(redactEvidence(value),null,2)+'\n'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
 const rel=[t.accountId,t.adId,date,`${slot}-${label}-${sha}.json`].join('/'),file=path.join(outbox,rel);await fs.mkdir(path.dirname(file),{recursive:true});
 const tmp=path.join(outbox,'.partial-'+crypto.randomUUID());const h=await fs.open(tmp,'wx',0o640);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
 try{await fs.link(tmp,file);}catch(e){if(e.code!=='EEXIST')throw e;}finally{await fs.unlink(tmp);}
 if(!Buffer.from(await fs.readFile(file)).equals(bytes))throw Error('evidence_readback_failed');
 return {path:'originals/server-reviews/'+rel,sha256:sha};
}
async function run(t){
 let client,locked=false,attempt=0,store;
 const params=[t.accountId,t.adId,date,slot],where='account_id=$1 AND ad_id=$2 AND review_date=$3 AND slot=$4';
 try{
  client=await pool.connect();locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS ok',['aepi13_daily_review',t.accountId+':'+t.adId])).rows[0].ok;
  if(!locked)return {adId:t.adId,status:'already_running'};
  await client.query(REVIEW_SCHEMA);store=new LearningStore(client);
  const known=await store.list(t.accountId,[t.adId]);if(!known.length||known.some(r=>r.campaignId!==t.campaignId||r.adsetId!==t.adsetId))throw Error('known_learning_identity_required');
  await client.query('INSERT INTO mw_daily_review_runs(account_id,ad_id,review_date,slot) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',params);
  await reconcileFailures(client,store,t.accountId,t.adId);
  await reconcileReady(client,store,t.accountId,t.adId);
  let row=(await client.query('SELECT * FROM mw_daily_review_runs WHERE '+where,params)).rows[0];
  if(row.status==='recorded'){
   const record=(await store.list(t.accountId,[t.adId])).find(r=>r.hash===row.record_hash);if(!record)throw Error('saved_record_missing');
   return {adId:t.adId,date,slot,status:'already_recorded',recordHash:record.hash,database:record.storage.database,nas:record.storage.nas};
  }
  if(row.attempts>=4&&!row.payload)return {adId:t.adId,date,slot,status:'retry_limit',error:row.error_code};
  let payload=row.payload;
  if(!payload){
   attempt=row.attempts+1;
   await client.query('UPDATE mw_daily_review_runs SET status=\'collecting\',attempts=$5,updated_at=now() WHERE '+where,[...params,attempt]);
   await client.query('INSERT INTO mw_daily_review_attempts(account_id,ad_id,review_date,slot,attempt,status,payload) VALUES($1,$2,$3,$4,$5,\'collecting\',$6) ON CONFLICT DO NOTHING',[...params,attempt,{capturedAt:new Date().toISOString()}]);
   const reader=new ReadOnlyGraph(process.env.META_ACCESS_TOKEN),evidence=await collect(reader,t,config,new Date());
   const ref=await immutableJson(t,evidence,'evidence');
   const previous=(await client.query('SELECT evidence FROM mw_daily_review_runs WHERE account_id=$1 AND ad_id=$2 AND evidence IS NOT NULL AND NOT(review_date=$3 AND slot=$4) ORDER BY updated_at DESC LIMIT 1',params)).rows[0]?.evidence||null;
   const initial=known.find(r=>r.kind==='case'),prior=[...known].reverse().find(r=>r.content?.suggestions?.length&&(r.content?.metrics||['judgment','followup'].includes(r.kind)));
   payload=buildRecord(t,config,evidence,{slot,evidencePath:ref.path,evidenceSha:ref.sha256,previous,history:initial?.content?.history||[],priorSuggestion:prior});
   await immutableJson(t,{recordPayload:payload,evidence:ref},'ready');
   await client.query('UPDATE mw_daily_review_runs SET status=\'ready\',payload=$5,evidence=$6,error_code=NULL,updated_at=now() WHERE '+where,[...params,payload,redactEvidence(evidence)]);
   await client.query('UPDATE mw_daily_review_attempts SET status=\'collected\',payload=$6 WHERE '+where+' AND attempt=$5',[...params,attempt,{evidence:ref,capturedAt:evidence.capturedAt}]);
  }
  const saved=await store.append(payload,'服务器规则复盘（非AI模型）');
  const checked=(await store.list(t.accountId,[t.adId])).find(r=>r.hash===saved.hash);
  if(!checked||checked.recordKey!==payload.recordKey)throw Error('learning_readback_failed');
  await client.query('UPDATE mw_daily_review_runs SET status=\'recorded\',record_hash=$5,error_code=NULL,updated_at=now() WHERE '+where,[...params,saved.hash]);
  if(attempt)await client.query('UPDATE mw_daily_review_attempts SET status=\'recorded\' WHERE '+where+' AND attempt=$5',[...params,attempt]);

  return {adId:t.adId,date,slot,status:'recorded',recordHash:saved.hash,database:checked.storage.database,nas:checked.storage.nas};
 }catch(e){
  const code=safeError(e),capturedAt=new Date().toISOString();let errorPayload=failureRecord(t,date,slot,code,capturedAt);
  const evidence=await immutableJson(t,{recordPayload:errorPayload,errorCode:code,capturedAt},'failure').catch(()=>null);
  let failureHash=null;
  if(client&&store){
   try{
    const r=(await client.query('SELECT failure_payload FROM mw_daily_review_runs WHERE '+where,params)).rows[0];errorPayload=r?.failure_payload||errorPayload;
    await client.query('UPDATE mw_daily_review_runs SET status=CASE WHEN payload IS NULL THEN \'failed\' ELSE \'ready\' END,failure_payload=$5,error_code=$6,updated_at=now() WHERE '+where,[...params,errorPayload,code]);
    const known=await store.list(t.accountId,[t.adId]);
    if(known.length&&known.every(r=>r.campaignId===t.campaignId&&r.adsetId===t.adsetId)){
     const saved=await store.append(errorPayload,'服务器检查异常（规则程序）');failureHash=saved.hash;
     const check=(await store.list(t.accountId,[t.adId])).find(r=>r.hash===failureHash);if(!check)throw Error('failure_record_unverified');
     await client.query('UPDATE mw_daily_review_runs SET failure_hash=$5 WHERE '+where,[...params,failureHash]);
    }
    if(attempt)await client.query('UPDATE mw_daily_review_attempts SET status=\'failed\',payload=$6 WHERE '+where+' AND attempt=$5',[...params,attempt,{errorCode:code,capturedAt,evidence}]);
   }catch{failureHash=null;}
  }
  return {adId:t.adId,date,slot,status:'failed',error:code,database:failureHash?'failure_record_verified':'not_confirmed',failureRecordHash:failureHash,localEvidence:evidence};
 }finally{if(client){if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',['aepi13_daily_review',t.accountId+':'+t.adId]).catch(()=>{});client.release();}}
}
try{const results=[];for(const t of config.monitors)results.push(await run(t));console.log(JSON.stringify({engine:'rules',policy:POLICY,platformWrites:false,results}));if(results.some(r=>['failed','retry_limit'].includes(r.status)))process.exitCode=1;}finally{await pool.end();}

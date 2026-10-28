import test from 'node:test';import assert from 'node:assert/strict';import {reconcileFailures} from '../lib/daily-review-state.mjs';
test('fourth-attempt storage failure is reconciled on later day independently of collection cap',async()=>{
 const payload={recordKey:'server-daily-20261027-unavailable'},row={review_date:'2026-10-27',slot:'daily',attempts:4,failure_payload:payload,failure_hash:null};let available=false,record=null,appends=0;
 const client={query:async(q,args)=>{if(q.startsWith('SELECT'))return{rows:row.failure_hash?[]:[row]};row.failure_hash=args[4];return{rows:[]};}};
 const store={append:async p=>{if(!available)throw Error('storage unavailable');if(!record){appends++;record={hash:'verified-hash',recordKey:p.recordKey};}return record;},list:async()=>record?[record]:[]};
 await assert.rejects(()=>reconcileFailures(client,store,'900000000000001','900000000000004'));assert.equal(row.failure_hash,null);
 available=true;assert.equal(await reconcileFailures(client,store,'900000000000001','900000000000004'),1);assert.equal(row.failure_hash,'verified-hash');assert.equal(await reconcileFailures(client,store,'900000000000001','900000000000004'),0);assert.equal(appends,1);
});
test('append succeeded but readback failed cannot mark verified; retry reuses same record',async()=>{let verified=false,saved=null,calls=0;
 const row={review_date:'2026-10-27',slot:'daily',failure_payload:{recordKey:'fixed'}};const client={query:async(q,args)=>q.startsWith('SELECT')?{rows:verified?[]:[row]}:(verified=true,{rows:[]})};
 const store={append:async p=>saved??=(calls++,{hash:'same',recordKey:p.recordKey}),list:async()=>calls++===1?[]:[saved]};
 await assert.rejects(()=>reconcileFailures(client,store,'123456','123456'));assert.equal(verified,false);await reconcileFailures(client,store,'123456','123456');assert.equal(verified,true);
});
import {reconcileReady} from '../lib/daily-review-state.mjs';
test('ready payload from previous day survives crash before state ack without recollection',async()=>{let marked=false,record=null,appends=0;const old={review_date:'2026-10-26',slot:'daily',attempts:4,payload:{recordKey:'persisted'}};const client={query:async(q,args)=>{if(q.startsWith('SELECT'))return{rows:marked?[]:[old]};if(q.includes('mw_daily_review_runs'))marked=true;return{rows:[]};}};const store={append:async p=>record??=(appends++,{hash:'stable',recordKey:p.recordKey}),list:async()=>[record]};assert.equal(await reconcileReady(client,store,'123456','123456'),1);assert.equal(await reconcileReady(client,store,'123456','123456'),0);assert.equal(appends,1);});

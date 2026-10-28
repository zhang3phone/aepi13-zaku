// Storage reconciliation is independent of the capped platform collection retries.
export async function reconcileFailures(client,store,account,ad){
 const rows=(await client.query('SELECT review_date::text,slot,failure_payload FROM mw_daily_review_runs WHERE account_id=$1 AND ad_id=$2 AND failure_payload IS NOT NULL AND failure_hash IS NULL ORDER BY review_date LIMIT 30',[account,ad])).rows;
 for(const row of rows){
  const saved=await store.append(row.failure_payload,'服务器检查异常（规则程序）');
  const found=(await store.list(account,[ad])).find(r=>r.hash===saved.hash);
  if(!found||found.recordKey!==row.failure_payload.recordKey)throw Error('failure_record_readback_failed');
  await client.query('UPDATE mw_daily_review_runs SET failure_hash=$5 WHERE account_id=$1 AND ad_id=$2 AND review_date=$3 AND slot=$4',[account,ad,row.review_date,row.slot,saved.hash]);
 }
 return rows.length;
}
export async function reconcileReady(client,store,account,ad){
 const rows=(await client.query('SELECT review_date::text,slot,attempts,payload FROM mw_daily_review_runs WHERE account_id=$1 AND ad_id=$2 AND payload IS NOT NULL AND record_hash IS NULL ORDER BY review_date LIMIT 30',[account,ad])).rows;
 for(const row of rows){
  const saved=await store.append(row.payload,'服务器规则复盘（非AI模型）');
  const found=(await store.list(account,[ad])).find(r=>r.hash===saved.hash);
  if(!found||found.recordKey!==row.payload.recordKey)throw Error('learning_readback_failed');
  await client.query("UPDATE mw_daily_review_runs SET status='recorded',record_hash=$5,error_code=NULL,updated_at=now() WHERE account_id=$1 AND ad_id=$2 AND review_date=$3 AND slot=$4",[account,ad,row.review_date,row.slot,saved.hash]);
  await client.query("UPDATE mw_daily_review_attempts SET status='recorded' WHERE account_id=$1 AND ad_id=$2 AND review_date=$3 AND slot=$4 AND attempt=$5",[account,ad,row.review_date,row.slot,row.attempts]);
 }
 return rows.length;
}

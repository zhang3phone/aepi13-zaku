import {randomUUID} from 'node:crypto';
import {normalize} from './meta.mjs';
export const day=d=>d.toISOString().slice(0,10);
export function monthRanges(since,until){const out=[];let s=since;while(s<=until){const [y,m]=s.split('-').map(Number);const next=new Date(Date.UTC(y,m,1));const end=day(new Date(next.getTime()-86400000));out.push({since:s,until:end<until?end:until});s=day(next);}return out;}
export function googleRetention(today){const d=new Date(today+'T00:00:00Z');const old=new Date(d);old.setUTCFullYear(old.getUTCFullYear()-11);old.setUTCMonth(old.getUTCMonth()+1,1);const recent=new Date(d);recent.setUTCMonth(recent.getUTCMonth()-37);recent.setUTCDate(recent.getUTCDate()+1);return {monthlySince:day(old),dailySince:day(recent)};}
const core=['spend','impressions','reach','clicks','inline_link_clicks','actions','action_values','date_start','date_stop'];
const metaIds={account:['account_id','account_name','account_currency'],campaign:['campaign_id','campaign_name'],adset:['campaign_id','campaign_name','adset_id','adset_name'],ad:['campaign_id','campaign_name','adset_id','adset_name','ad_id','ad_name']};
const edges={campaigns:['id','name','status','effective_status','objective','created_time','updated_time','start_time','stop_time','daily_budget','lifetime_budget'],adsets:['id','name','campaign_id','status','effective_status','targeting','optimization_goal','billing_event','daily_budget','lifetime_budget','start_time','end_time','created_time','updated_time'],ads:['id','name','campaign_id','adset_id','status','effective_status','creative','created_time','updated_time'],adcreatives:['id','name','title','body','object_story_spec','asset_feed_spec','image_url','thumbnail_url','video_id','object_url'],adimages:['hash','name','url','width','height','created_time'],advideos:['id','title','description','created_time','length','picture'],customaudiences:['id','name','subtype','description'],customconversions:['id','name','custom_event_type','rule'],adspixels:['id','name','last_fired_time']};
const gMetrics=['metrics.cost_micros','metrics.impressions','metrics.clicks','metrics.conversions','metrics.conversions_value','metrics.all_conversions','metrics.all_conversions_value'];
const googleResources={customer:['customer.id'],campaign:['campaign.id','campaign.name','campaign.status','campaign.advertising_channel_type'],ad_group:['campaign.id','ad_group.id','ad_group.name','ad_group.status'],ad_group_ad:['campaign.id','ad_group.id','ad_group_ad.ad.id','ad_group_ad.status','ad_group_ad.ad.type','ad_group_ad.ad.final_urls'],keyword_view:['campaign.id','ad_group.id','ad_group_criterion.criterion_id','ad_group_criterion.keyword.text','ad_group_criterion.keyword.match_type'],search_term_view:['campaign.id','ad_group.id','search_term_view.search_term'],shopping_performance_view:['campaign.id','segments.product_item_id','segments.product_title'],asset_group:['campaign.id','asset_group.id','asset_group.name','asset_group.status']};
export class ArchiveWorker {
 constructor(store,archive,meta,google){Object.assign(this,{store,archive,meta,google});this.running=false;this.stopping=false;}
 async planMeta(today){const found=await this.meta.call('meta_list_ad_accounts');const accounts=found.accounts||[];await this.store.set('discovered_accounts',{capturedAt:new Date().toISOString(),accounts});for(const a of accounts){const id=String(a.account_id||a.id).replace(/^act_/,'');await this.archive.enqueue('meta',id,'inventory',{until:today});}await this.store.audit('archive_planned',{platform:'meta',accounts:accounts.length,scope:'all_accessible_accounts_maximum_available_history'});return accounts.length;}
 async planGoogle(today){const found=await this.google.discover();await this.store.set('google_accounts',{...found,capturedAt:new Date().toISOString()});for(const a of found.accounts)if(!a.manager)await this.archive.enqueue('google',a.id,'inventory',{until:today,account:a});await this.store.audit('archive_planned',{platform:'google',accounts:found.accounts.length,discoveryComplete:found.complete});return found;}
 async step(){if(this.running||this.stopping)return;this.running=true;let t;try{t=await this.archive.next();if(!t)return;if(t.platform==='meta')await this.metaTask(t);else await this.googleTask(t);}catch(e){if(t){
  if(e.code==='META_RETENTION'){
   await this.archive.update(t,'unavailable',t.cursor||null,e.message);
   if(e.earliestDate&&t.spec.since&&t.spec.since<e.earliestDate&&t.spec.until>=e.earliestDate)await this.archive.enqueue(t.platform,t.account_id,t.kind,{...t.spec,since:e.earliestDate,rebasedFrom:t.spec.since});
  }else if(e.code==='META_REDUCE_QUERY'&&(t.spec.pageLimit||500)>10){
   await this.archive.reschedule(t,{...t.spec,pageLimit:(t.spec.pageLimit||500)>100?100:(t.spec.pageLimit>25?25:10)});
  }else await this.archive.update(t,'failed',t.cursor||null,String(e.message).slice(0,450));
 }}finally{this.running=false;}}
 start(){this.timer=setInterval(()=>this.step().catch(()=>{}),1200);this.timer.unref();}
 async metaTask(t){const s=t.spec,id=t.account_id,obj='act_'+id;
  if(t.kind==='inventory'){
   const info=await this.meta.call('meta_get_account_details',{adAccountId:id});await this.archive.savePage(t,'000000',[info],{tool:'meta_get_account_details'});
   for(const [edge,fields] of Object.entries(edges))await this.archive.enqueue('meta',id,'entities_'+edge,{until:s.until,edge,fields});
   await this.archive.enqueue('meta',id,'maximum',{until:s.until,account:info});await this.archive.update(t,'complete');return;
  }
  if(t.kind==='maximum'){
   const r=await this.meta.call('meta_get_insights_raw',{objectId:obj,fields:[...metaIds.account,...core],level:'account',datePreset:'maximum',actionAttributionWindows:['7d_click','1d_view'],limit:500});
   const rows=r.data||[];await this.archive.savePage(t,'000000',rows,{datePreset:'maximum',source:'Meta API native account total'});
   if(r.paging?.next)throw new Error('最大历史账户汇总出现额外分页，需要人工核对日期边界');
   const since=rows[0]?.date_start||s.until,until=rows[0]?.date_stop||s.until;
   await this.store.set('meta_coverage:'+id,{requested:'maximum',reportedSince:rows[0]?.date_start||null,reportedUntil:rows[0]?.date_stop||null,observedAt:new Date().toISOString(),note:'maximum 表示当前 API 返回边界；不证明更早的已删除或过期数据不存在'});
   // Native totals remain native: never sum ad-level reach or multiply attribution windows.
   await this.archive.enqueue('meta',id,'campaign_snapshot',{since,until,account:s.account,totals:rows[0]||{}});
   if(rows.length)for(const range of monthRanges(since,until)){
    for(const level of ['account','campaign','adset','ad'])await this.archive.enqueue('meta',id,'daily_'+level,{...range,level,fields:[...metaIds.account,...metaIds[level],...core],timeIncrement:1,account:s.account});
    for(const breakdown of ['age,gender','country','publisher_platform,platform_position','device_platform'])await this.archive.enqueue('meta',id,'breakdown',{...range,level:'account',fields:[...metaIds.account,...core.filter(x=>x!=='reach')],timeIncrement:'monthly',breakdowns:breakdown.split(','),variant:breakdown});
   }
   await this.archive.update(t,'complete');return;
  }
  if(t.kind==='campaign_snapshot'){
   const rows=await this.metaPages(t,'meta_get_insights_raw',{objectId:obj,fields:[...metaIds.campaign,...core],level:'campaign',timeRange:{since:s.since,until:s.until},actionAttributionWindows:['7d_click','1d_view'],limit:500});
   if(rows===null)return;
   const totals=s.rebasedFrom?(await this.meta.call('meta_get_insights_raw',{objectId:obj,fields:[...metaIds.account,...core],level:'account',timeRange:{since:s.since,until:s.until},actionAttributionWindows:['7d_click','1d_view'],limit:500})).data?.[0]:s.totals;
   const info=s.account;const account={id,name:info.name||id,currency:info.currency||null,timezone:info.timezone_name||null,portfolio:info.business?.name||null,availability:rows.length?'api_delivery':'no_delivery_in_range',campaignsComplete:true,totals:normalize(totals||{}),campaigns:rows.map(r=>({...normalize(r),id:r.campaign_id,name:r.campaign_name,attribution:'7-day click, 1-day view'}))};
   // Maximum query must use the same attribution as campaign rows; see maximum request below.
   await this.store.saveSnapshot({id:randomUUID(),platform:'meta',source:'meta_api',ingestionOrigin:process.env.ARCHIVE_ORIGIN||'server',capturedAt:new Date().toISOString(),since:s.since,until:s.until,currency:account.currency,attribution:'7-day click, 1-day view',coverage:'maximum_available_api',notes:['API maximum 历史边界；原生账户总计与系列明细。'],accounts:[account]});await this.archive.update(t,'complete');return;
  }
  if(t.kind.startsWith('entities_')){await this.metaPages(t,'meta_list_edge_raw',{parentId:obj,edge:s.edge,fields:s.fields,limit:500,...(['campaigns','adsets','ads'].includes(s.edge)?{filtering:[{field:'effective_status',operator:'IN',value:['ACTIVE','PAUSED','DELETED','ARCHIVED','PENDING_REVIEW','DISAPPROVED','PREAPPROVED','PENDING_BILLING_INFO','IN_PROCESS','WITH_ISSUES','CAMPAIGN_PAUSED','ADSET_PAUSED']}]}:{})});return;}
  await this.metaPages(t,'meta_get_insights_raw',{objectId:obj,fields:[...new Set(s.fields)],level:s.level,timeRange:{since:s.since,until:s.until},timeIncrement:s.timeIncrement,breakdowns:s.breakdowns,actionAttributionWindows:['7d_click','1d_view'],limit:500});
 }
 async metaPages(t,tool,args){if(t.spec.pageLimit)args={...args,limit:t.spec.pageLimit};let after=t.cursor?.after;const key=String(t.cursor?.page||0).padStart(6,'0');const r=await this.meta.call(tool,{...args,...(after?{after}:{})});const container=r.data;const rows=Array.isArray(container)?container:container?.data;if(!Array.isArray(rows))throw new Error('Meta 分页没有数据数组，未标记完整');
  const paging=r.paging||container?.paging;await this.archive.savePage(t,key,rows,{tool,query:args});
  if(paging?.next){const next=paging.cursors?.after;if(!next||next===after)throw new Error('Meta 分页游标缺失或重复');t.cursor={after:next,page:(t.cursor?.page||0)+1};await this.archive.update(t,'pending',t.cursor);return null;}
  if(t.kind==='campaign_snapshot'){
   const all=[];let cursor='';while(true){const pages=await this.archive.page(t.id,cursor);if(!pages.length)break;all.push(...pages[0].payload.rows);cursor=pages[0].page_key;}return all;
  }
  await this.archive.update(t,'complete');return rows;
 }
 async googleTask(t){const s=t.spec,id=t.account_id,a=s.account;
  if(t.kind==='inventory'){
   await this.archive.savePage(t,'000000',[a],{source:'Google official MCP'});
   if(a.apiAvailable===false){await this.archive.update(t,'unavailable',null,'Google 账户已发现，但详情或报表 API 不可访问；请检查停用状态或权限。未重新启用账户。');return;}
   const limits=googleRetention(s.until);
   const historic=monthRanges(limits.monthlySince,s.until);
   for(const resource of Object.keys(googleResources)){
    // Keep old history at the maximum retained monthly granularity, recent history daily.
    for(let i=0;i<historic.length;i+=12){const group=historic.slice(i,i+12);await this.archive.enqueue('google',id,'monthly_'+resource,{since:group[0].since,until:group.at(-1).until,resource,grain:'month',account:a});}
    for(const range of monthRanges(limits.dailySince,s.until))await this.archive.enqueue('google',id,'daily_'+resource,{...range,resource,grain:'date',account:a});
   }
   for(const [resource,fields] of Object.entries({campaign:['campaign.id','campaign.name','campaign.status','campaign.advertising_channel_type','campaign_budget.amount_micros'],ad_group_ad:['ad_group_ad.ad.id','ad_group_ad.ad.type','ad_group_ad.ad.final_urls','ad_group_ad.status'],conversion_action:['conversion_action.id','conversion_action.name','conversion_action.category','conversion_action.status','conversion_action.type','conversion_action.primary_for_goal'],asset:['asset.id','asset.name','asset.type','asset.text_asset.text','asset.image_asset.full_size.url'],campaign_criterion:['campaign.id','campaign_criterion.criterion_id','campaign_criterion.negative','campaign_criterion.keyword.text'],ad_group_criterion:['ad_group.id','ad_group_criterion.criterion_id','ad_group_criterion.negative','ad_group_criterion.keyword.text']}))await this.archive.enqueue('google',id,'entities_'+resource,{until:s.until,resource,fields,account:a});
   await this.archive.update(t,'complete');return;
  }
  const fields=s.fields||[...googleResources[s.resource],...gMetrics,'segments.'+s.grain];
  const conditions=s.fields?[]:[`segments.${s.grain} BETWEEN '${s.grain==='month'?s.since.slice(0,7)+'-01':s.since}' AND '${s.grain==='month'?s.until.slice(0,7)+'-01':s.until}'`];
  const rows=await this.google.search(id,s.resource,fields,conditions,a.loginCustomerId);await this.archive.savePage(t,'000000',rows,{source:'Google official MCP SearchStream',resource:s.resource,fields,conditions,streamExhausted:true,grain:s.grain||'entity',currency:a.currency,timezone:a.timezone});await this.archive.update(t,'complete');
 }
}

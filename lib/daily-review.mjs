import crypto from 'node:crypto';
export const POLICY='server-rules-1';
export const isoDay=(now,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export const shiftDay=(day,n)=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const numeric=x=>x===null||x===undefined||!['number','string'].includes(typeof x)||(typeof x==='string'&&!x.trim())||!Number.isFinite(Number(x))||Number(x)<0?null:Number(x);
const ratio=(a,b,scale=1)=>a!==null&&b!==null&&b>0?a/b*scale:null;
const action=(items,type)=>{if(!Array.isArray(items))return null;const matches=items.filter(x=>x.action_type===type);return matches.length===1?numeric(matches[0].value):null;};
export function metrics(rows,{since,until,timezone,currency,capturedAt,adId,accountId}){
 if(!Array.isArray(rows)||rows.length>1)throw Error('insights_grain_invalid');
 const r=rows[0]||{};
 if(rows.length&&(String(r.ad_id)!==adId||String(r.account_id)!==accountId||r.date_start!==since||r.date_stop!==until))throw Error('insights_identity_or_period_mismatch');
 const spend=numeric(r.spend),clicks=numeric(r.inline_link_clicks),impressions=numeric(r.impressions),purchases=action(r.actions,'offsite_conversion.fb_pixel_purchase'),value=action(r.action_values,'offsite_conversion.fb_pixel_purchase');
 return {since,until,timezone,currency,attribution:'7天点击／1天浏览',basis:'广告级合计，按展示日期；含全部素材变体',capturedAt,note:rows.length?'未返回的事件保留缺失，不补零；平台归因可能延迟，未核对独立付款订单。':'平台未返回投放行，不等于零；不能据此认定没有购买。',spend,impressions,frequency:numeric(r.frequency),clicks,ctr:numeric(r.inline_link_click_ctr)??ratio(clicks,impressions,100),cpc:numeric(r.cost_per_inline_link_click)??ratio(spend,clicks),landingViews:action(r.actions,'landing_page_view'),addToCart:action(r.actions,'offsite_conversion.fb_pixel_add_to_cart'),checkouts:action(r.actions,'offsite_conversion.fb_pixel_initiate_checkout'),purchases,cpa:ratio(spend,purchases),purchaseValue:value,roas:ratio(value,spend)};
}
const value=(x,d=2)=>x===null||x===undefined?'未返回':Number(x).toFixed(d);
export function describe(m){return `${m.since}—${m.until}；${m.timezone}；${m.currency}；${m.attribution}；${m.basis}。花费${value(m.spend)}，展示${value(m.impressions,0)}，频次${value(m.frequency)}，链接点击${value(m.clicks,0)}，链接CTR ${value(m.ctr)}%，链接CPC ${value(m.cpc)}，落地页浏览${value(m.landingViews,0)}，加购${value(m.addToCart,0)}，结账${value(m.checkouts,0)}，网站购买${value(m.purchases,0)}，CPA ${value(m.cpa)}，购买价值${value(m.purchaseValue)}，ROAS ${value(m.roas)}。${m.note}`;}
export function validateConfig(c){
 if(!c||c.version!==1||c.mode!=='rules'||c.timezone!=='America/Los_Angeles'||c.currency!=='USD'||c.hour!==9||!Array.isArray(c.monitors)||!c.monitors.length)throw Error('review_configuration_invalid');
 for(const t of c.monitors){for(const k of ['accountId','campaignId','adsetId','adId'])if(!/^\d{5,30}$/.test(t[k]||''))throw Error('review_identity_invalid');for(const k of ['since','endExclusive'])if(!/^\d{4}-\d{2}-\d{2}$/.test(t[k]||'')||new Date(t[k]+'T00:00:00Z').toISOString().slice(0,10)!==t[k])throw Error('review_period_invalid');if(t.since>=t.endExclusive||!(Number.isFinite(t.plannedDailyBudget)&&t.plannedDailyBudget>0))throw Error('review_plan_invalid');}
 return c;
}
export function redactEvidence(v){
 if(Array.isArray(v))return v.map(redactEvidence);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!(/token|secret|password|authorization|cookie|paging|image_url|thumbnail_url|picture/i.test(k))).map(([k,x])=>[k,redactEvidence(x)]));
 if(typeof v==='string')return v.replace(/Bearer\s+\S+/gi,'[redacted]').replace(/(?:access_token|password|secret)=[^\s&]+/gi,'[redacted]');return v;
}
export class ReadOnlyGraph{
 constructor(token,transport=fetch){if(!token)throw Error('meta_credentials_missing');this.token=token;this.transport=transport;this.requests=[];}
 async get(path,params={}){
  if(!/^(?:act_)?\d+(?:\/(?:insights|ads))?$/.test(path))throw Error('meta_read_path_rejected');
  const url=new URL('https://graph.facebook.com/v26.0/'+path);for(const [k,v] of Object.entries(params)){if(/token|secret/i.test(k))throw Error('credential_parameter_rejected');url.searchParams.set(k,typeof v==='string'?v:JSON.stringify(v));}
  let response;try{response=await this.transport(url,{method:'GET',headers:{Authorization:'Bearer '+this.token},signal:AbortSignal.timeout(45000)});}catch{throw Error('meta_network_unavailable');}
  let data;try{data=await response.json();}catch{throw Error('meta_response_invalid');}
  if(!response.ok||data.error)throw Error('meta_api_'+String(data.error?.code||response.status).replace(/[^0-9]/g,''));
  return data;
 }
 async insights(t,range){
  let after=null,seen=new Set(),all=[],pages=0;
  do{
   const q={fields:'ad_id,account_id,spend,impressions,frequency,inline_link_clicks,inline_link_click_ctr,cost_per_inline_link_click,actions,action_values,date_start,date_stop',time_range:range,action_attribution_windows:['7d_click','1d_view'],action_report_time:'impression',time_increment:'all_days',limit:'100',...(after?{after}:{})};
   const data=await this.get(t.adId+'/insights',q);if(!Array.isArray(data.data))throw Error('insights_response_missing');all.push(...data.data);pages++;
   if(!data.paging?.next){after=null;break;}
   const next=data.paging?.cursors?.after;if(!next||seen.has(next)||pages>=20)throw Error('insights_pagination_incomplete');seen.add(next);after=next;
  }while(after);
  this.requests.push({path:t.adId+'/insights',range,pages,complete:true,attribution:['7d_click','1d_view'],reportTime:'impression'});return all;
 }
}
export async function collect(reader,t,c,now=new Date()){
 const capturedAt=now.toISOString(),today=isoDay(now,c.timezone),yesterday=shiftDay(today,-1);
 const account=await reader.get('act_'+t.accountId,{fields:'id,account_id,name,currency,timezone_name,account_status'});
 if(String(account.account_id)!==t.accountId||account.currency!==c.currency||account.timezone_name!==c.timezone)throw Error('account_reporting_context_changed');
 const campaign=await reader.get(t.campaignId,{fields:'id,name,status,effective_status,objective,daily_budget,lifetime_budget'});
 const adset=await reader.get(t.adsetId,{fields:'id,campaign_id,name,status,effective_status,start_time,end_time,daily_budget,lifetime_budget,optimization_goal,billing_event,promoted_object,attribution_spec'});
 const ad=await reader.get(t.adId,{fields:'id,account_id,campaign_id,adset_id,name,status,effective_status,creative{id,image_hash,video_id}'});
 if(String(campaign.id)!==t.campaignId||String(adset.id)!==t.adsetId||String(adset.campaign_id)!==t.campaignId||String(ad.id)!==t.adId||String(ad.account_id)!==t.accountId||String(ad.campaign_id)!==t.campaignId||String(ad.adset_id)!==t.adsetId)throw Error('live_ad_identity_mismatch');
 const ctx={timezone:c.timezone,currency:c.currency,capturedAt,adId:t.adId,accountId:t.accountId};
 const yr=await reader.insights(t,{since:yesterday,until:yesterday});
 const until=today<t.endExclusive?today:shiftDay(t.endExclusive,-1);
 const cr=t.since<=until?await reader.insights(t,{since:t.since,until}):[];
 const settings={campaignStatus:campaign.status||null,campaignEffectiveStatus:campaign.effective_status||null,adsetStatus:adset.status||null,adsetEffectiveStatus:adset.effective_status||null,adStatus:ad.status||null,effectiveStatus:ad.effective_status||null,creativeId:ad.creative?.id||null,imageHash:ad.creative?.image_hash||null,videoId:ad.creative?.video_id||null,campaignDailyBudget:numeric(campaign.daily_budget)===null?null:Number(campaign.daily_budget)/100,adsetDailyBudget:numeric(adset.daily_budget)===null?null:Number(adset.daily_budget)/100,start:adset.start_time||null,end:adset.end_time||null,optimizationGoal:adset.optimization_goal||null,promotedObject:redactEvidence(adset.promoted_object||null),attributionSpec:adset.attribution_spec||null};
 return {capturedAt,today,yesterday,account:redactEvidence(account),settings,yesterdayMetrics:metrics(yr,{...ctx,since:yesterday,until:yesterday}),cumulativeMetrics:t.since<=until?metrics(cr,{...ctx,since:t.since,until}):null,requests:reader.requests,raw:{yesterday:yr,cumulative:cr},policy:POLICY};
}
export function buildRecord(t,c,e,{slot='daily',evidencePath,evidenceSha,previous=null,history=[],priorSuggestion=null}={}){
 const s=e.settings,y=e.yesterdayMetrics,total=e.cumulativeMetrics,ended=e.today>=t.endExclusive,suggestions=[],facts=[],hypotheses=[];
 facts.push(`本条由服务器规则复盘生成（${POLICY}），不是AI模型生成；采集时间${e.capturedAt}。`);
 facts.push(`平台当前状态：广告${s.adStatus??'未返回'} / 生效${s.effectiveStatus??'未返回'}；广告组${s.adsetEffectiveStatus??'未返回'}；系列${s.campaignEffectiveStatus??'未返回'}。`);
 facts.push('昨日：'+describe(y));facts.push(total?'累计（含当日时未结算）：'+describe(total):'累计：尚未进入原测试日期窗口，未推测指标。');
 facts.push(`当前创意ID ${s.creativeId??'未返回'}，平台图片哈希${s.imageHash??'未返回'}，视频ID ${s.videoId??'未返回'}；不凭文件名认定历史素材。`);
 if(['DISAPPROVED','WITH_ISSUES'].includes(s.effectiveStatus)||['DISAPPROVED','WITH_ISSUES'].includes(s.adsetEffectiveStatus))suggestions.push('广告层级：当前有审核/投放问题。先在Meta核对具体拒因及账号通知，再制定修正版本；本程序不改素材或开关。');
 if(ended)suggestions.push('当前已超过原测试期：继续检查归因回传和实际订单，汇总原窗口结果；不重启、不延长、不加预算。');
 if(s.campaignDailyBudget!==null&&s.campaignDailyBudget!==t.plannedDailyBudget)suggestions.push(`系列日预算：当前${value(s.campaignDailyBudget)} USD，监控计划为${value(t.plannedDailyBudget)} USD。先核对是否有已批准变更，不自动调回或增加。`);
 if(y.spend!==null&&s.campaignDailyBudget!==null&&y.spend>s.campaignDailyBudget){facts.push(`昨日实际花费${value(y.spend)} USD高于当前日预算${value(s.campaignDailyBudget)} USD；日预算不是已核实的硬性日上限，不能据此认定平台违规。`);suggestions.push('预算核对：人工查看预算变更历史、当日浮动与累计消耗；测试期总额是规划，不当作已验证硬上限。');}
 if(!ended&&s.effectiveStatus!=='ACTIVE')suggestions.push('广告层级：当前生效状态不是ACTIVE。结合当前排期和审核通知人工核对是否按计划启动；不自动启用。');
 if(previous){const changed=Object.keys(s).filter(k=>JSON.stringify(s[k])!==JSON.stringify(previous.settings?.[k]));facts.push(changed.length?'与上次服务器观察相比有设置差异：'+changed.map(k=>`${k}：${JSON.stringify(previous.settings?.[k]??null)} → ${JSON.stringify(s[k])}`).join('；')+'。仅确认两次观测不同，不推定修改人、授权或具体时间。':'与上次服务器观察相比，已核对设置未发现变化；不能把指标变化称为本程序调整后的效果。');if(changed.includes('creativeId'))suggestions.push('素材版本：创意ID已变化，核对替换时间及素材原件，再分期比较；整条广告的指标不能分配成每张图片效果。');}
 if(priorSuggestion)facts.push(`回查先前建议记录：${priorSuggestion.recordDate} / ${priorSuggestion.hash}。本次只读核对当前设置及数据；人工批准、执行和效果因果仍需证据，未据此自动修改。`);
 if(y.purchases===null){hypotheses.push('昨日购买字段未返回，可能与无回报、权限或归因延迟有关；当前不能将其当作零购买。');suggestions.push('跟踪核对：先核对商店已付款订单、购买回传及去重，再判断是否需要改广告；不以缺失指标判定素材失败。');}
 if(y.clicks!==null&&y.clicks>0&&y.landingViews===0)suggestions.push('落地页跟踪：昨日有链接点击而明确回报的落地页浏览为0，先排查加载与回传延迟；不直接认定素材差。');
 if(!suggestions.length)suggestions.push('预算与素材：本次不建议据短期报表立即扩大。先维持已批准方案的观察，核对真实付款订单、事件去重与当前商品贡献利润，再另行提出可批准的单变量测试。');
 if(suggestions.length<3)suggestions.push('利润与样本：当前款利润未核实，平台归因购买不等于独立付款订单，ROAS不代表已盈利；历史CPA只作带日期对照。');
 hypotheses.push('指标随时间变化可能受样本、投放时间及回传延迟影响；没有对照和执行证据，不声称由某次调整导致。');
 return {...Object.fromEntries(['accountId','campaignId','adsetId','adId'].map(k=>[k,t[k]])),recordKey:`server-${slot}-${e.today.replaceAll('-','')}-${evidenceSha.slice(0,12)}`,recordDate:e.today,kind:'review',title:`${slot==='daily'?'每日检查':'服务器迁移试运行'}：规则复盘与未执行建议`,source:`服务器定时检查 / ${POLICY} / Meta Graph v26.0 / ${e.capturedAt}`,content:{summary:`昨日花费${value(y.spend)} USD，网站购买${value(y.purchases,0)}，CPA ${value(y.cpa)}，ROAS ${value(y.roas)}。规则建议未执行；缺失不补零。`,metrics:y,facts,hypotheses,suggestions:suggestions.slice(0,3),approvals:[],executions:['仅执行只读数据采集、指标计算和学习记录追加；没有调整预算、受众、素材、网站、排期或开关。'],verification:['已核对账户、系列、广告组及广告身份，固定7天点击/1天浏览与展示日期口径。','原始指标证据已保存在服务器；当前款利润、商店付款订单和购买事件去重尚未核实。','指标属于整条广告，含所有素材变体；本记录未附可确认的历史图片SHA，上方当前图片不能冒充过去素材。'],settings:[{level:'广告系列',field:'当前日预算',value:s.campaignDailyBudget===null?'未返回':value(s.campaignDailyBudget)+' USD',reason:'只读核对当前值，原始批准原因见初始案例，不冒充当时决策。',effect:'平均日预算，不是严格每日花费上限。',recheck:'与已批准方案、订单及利润核对后再提出具体变更。'},{level:'广告组',field:'当前排期',value:`${s.start??'未返回'} → ${s.end??'未返回'}`,reason:'保存本次平台观察；不据此重写历史设置。',effect:'影响实际投放时段，跨夏令时不强称168小时。',recheck:'启动、结束或发现已批准排期变动时核对。'},{level:'广告',field:'当前创意ID',value:s.creativeId??'未返回',reason:'区分每天所见的素材版本。',effect:'不能据此把广告整体数据当作单图因果效果。',recheck:'版本变化时核对素材及发生时间。'}],history:history.slice(0,2),assetNote:'仅保存本次可核实的创意身份；不自动沿用旧批准图冒充当前或历史投放图。',evidence:[`服务器证据：${evidencePath}`,`证据SHA-256：${evidenceSha}`,`规则版本：${POLICY}`],nextReview:'下一次服务器检查回看同口径数据、已批准人工变更及后续结果；没有执行证据时明确记为未执行，不自动调整广告。'}};
}
export const REVIEW_SCHEMA=`CREATE TABLE IF NOT EXISTS mw_daily_review_runs(account_id text NOT NULL,ad_id text NOT NULL,review_date date NOT NULL,slot text NOT NULL,status text NOT NULL DEFAULT 'new',attempts integer NOT NULL DEFAULT 0,payload jsonb,evidence jsonb,record_hash text,failure_payload jsonb,failure_hash text,error_code text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,ad_id,review_date,slot));CREATE TABLE IF NOT EXISTS mw_daily_review_attempts(account_id text NOT NULL,ad_id text NOT NULL,review_date date NOT NULL,slot text NOT NULL,attempt integer NOT NULL,status text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,ad_id,review_date,slot,attempt));`;
export function failureRecord(t,date,slot,code,capturedAt){return {...Object.fromEntries(['accountId','campaignId','adsetId','adId'].map(k=>[k,t[k]])),recordKey:`server-${slot}-${date.replaceAll('-','')}-unavailable`,recordDate:date,kind:'review',title:'服务器每日检查未完成：数据未读到，不按零处理',source:`服务器规则复盘 / ${POLICY} / ${capturedAt}`,content:{summary:'本次未能完成平台数据读取或记录保存，不提供推测的投放结论。',facts:[`监控对象广告${t.adId}；异常标识${code}；发生时间${capturedAt}。`,'未取得完整可核实的指标或关联；缺失不填零，当前配置与投放状态不作推测。'],hypotheses:[],suggestions:['人工检查工作台、服务器网络、Meta只读授权或数据库状态；未核实前不因本次缺失调整广告。'],approvals:[],executions:['只尝试读取与保存，未调整或发布任何平台广告。'],verification:['本次读取/保存未完成，不能称已同步或已验证。'],nextReview:'服务器会在后续计划重试；成功后追加独立补采记录，保留本条失败历史。'}};}
export async function dailyReviewStatus(pool,account){
 if(!/^\d{5,30}$/.test(account||''))throw Object.assign(Error('账户ID无效'),{status:400});
 const schedule=(await pool.query("SELECT payload FROM mw_storage_state WHERE id='daily_review_config'")).rows[0]?.payload||{enabled:false,mode:'rules',timezone:'America/Los_Angeles',hour:9,monitors:[]};
 const monitors=(schedule.monitors||[]).filter(m=>m.accountId===account);
 const runs=(await pool.query("SELECT r.ad_id,r.review_date::text,r.slot,r.status,r.attempts,r.error_code,r.record_hash,r.failure_hash,r.updated_at,n.verified_at AS nas_verified_at,f.verified_at AS failure_nas_verified_at FROM mw_daily_review_runs r LEFT JOIN mw_learning_nas n ON n.hash=r.record_hash LEFT JOIN mw_learning_nas f ON f.hash=r.failure_hash WHERE r.account_id=$1 ORDER BY r.review_date DESC,r.updated_at DESC LIMIT 30",[account])).rows;
 return {accountId:account,schedule:{...schedule,monitors},runs,platformWrites:false,analysisMode:'rules',serverToday:isoDay(new Date(),schedule.timezone),serverHour:Number(new Intl.DateTimeFormat('en-US',{timeZone:schedule.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()))};
}

// Comparable AD-level website purchase reporting; never allocate totals to images.
const numeric=value=>value===null||value===undefined||value===''||typeof value==='boolean'||!Number.isFinite(Number(value))?null:Number(value);
const websiteAction=(list)=>{
 if(!Array.isArray(list))return null;
 const action=list.find(x=>x.action_type==='offsite_conversion.fb_pixel_purchase');
 return action?numeric(action.value):0;
};
export function performanceRow(row){
 const spend=numeric(row.spend),clicks=numeric(row.inline_link_clicks),purchases=numeric(row.purchases)??websiteAction(row.actions),purchaseValue=numeric(row.purchase_value)??websiteAction(row.action_values);
 return {adId:String(row.ad_id),spend,clicks,purchases,purchaseValue,roas:spend!==null&&spend>0&&purchaseValue!==null?purchaseValue/spend:null};
}
export function performanceRange(since,until){
 const valid=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
 if(!valid(since)||!valid(until)||since>until)throw Object.assign(new Error('请选择有效的开始和结束日期'),{status:400});
 if((Date.parse(until)-Date.parse(since))/86400000>92)throw Object.assign(new Error('单次对照最多选择 93 天'),{status:400});return {since,until};
}
export function performanceIds(value){const ids=String(value||'').split(',');if(!ids.length||ids.length>100||ids.some(x=>!/^\d{5,30}$/.test(x))||new Set(ids).size!==ids.length)throw Object.assign(new Error('广告 ID 列表无效，单次最多 100 条'),{status:400});return ids.sort();}
export class CreativePerformance {
 constructor(meta){this.meta=meta;this.cache=new Map();this.busy=new Map();}
 async read(account,range,ids,force=false){
  const key=[account,range.since,range.until,ids.join(',')].join(':');const old=this.cache.get(key);if(!force&&old&&Date.now()-old.at<300000)return old.result;if(this.busy.has(key))return this.busy.get(key);
  const job=(async()=>{
   const info=await this.meta.call('meta_get_account_details',{adAccountId:account});
   if(!info.timezone_name||!info.currency)throw new Error('账户时区或币种未返回，未展示缺少口径的数据');
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:info.timezone_name,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   if(range.until>today)throw Object.assign(new Error('结束日期不能晚于广告账户所在时区的今天'),{status:400});
   const data=await this.meta.call('meta_get_insights',{adAccountId:account,level:'ad',metrics:['spend','inline_link_clicks','purchases','purchase_value'],adIds:ids,timeRange:range,timeIncrement:'all_days',attributionMode:'explicit',attributionWindows:['7d_click','1d_view'],actionReportTime:'impression',includeAccountTotals:false,limit:5000});
   if(!Array.isArray(data.data)||data.reporting_context?.pagination_exhausted!==true)throw new Error('表现数据分页尚未确认完整，未展示部分汇总');
   const rows=new Map();for(const row of data.data){const id=String(row.ad_id);if(!ids.includes(id)||rows.has(id))throw new Error('表现数据层级或广告关联异常，未展示推测汇总');rows.set(id,performanceRow(row));}
   const result={accountId:account,...range,currency:info.currency,timezone:info.timezone_name,attribution:'7 天点击 / 1 天浏览',actionReportTime:'impression',capturedAt:new Date().toISOString(),complete:true,rows:ids.map(adId=>rows.has(adId)?{...rows.get(adId),status:'reported'}:{adId,status:'no_row',spend:null,clicks:null,purchases:null,purchaseValue:null,roas:null}),notes:['广告级汇总，含此广告全部素材变体；不是单张图片的独立归因。','图片显示当前创意；历史期间如更换素材，不能把历史效果全部归给当前图片。','当天数据尚未结算，购买及金额可能延迟回传；无返回记录不等于零。']};
   if(this.cache.size>100)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,{at:Date.now(),result});return result;
  })().finally(()=>this.busy.delete(key));this.busy.set(key,job);return job;
 }
}

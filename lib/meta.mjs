import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {number} from './analysis.mjs';
export class Meta {
 constructor(){this.connecting=null;this.client=null;}
 async connect(){
  if(process.env.DEMO_MODE!=='false')throw Object.assign(new Error('演示模式不访问广告平台'),{status:409});
  if(!process.env.META_ACCESS_TOKEN)throw Object.assign(new Error('尚未配置 META_ACCESS_TOKEN，请在服务器私密环境文件配置 Meta API 授权'),{status:409});
  if(this.client)return this.client;
  if(!this.connecting)this.connecting=(async()=>{
   const client=new Client({name:'meta-ads-workbench',version:'0.1.0'});
   const env=Object.fromEntries(['PATH','HOME','TMPDIR','TMP','TEMP','META_ACCESS_TOKEN','META_API_VERSION','META_REQUEST_TIMEOUT_MS'].filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]));
   env.META_ENABLE_WRITES='0';env.LOG_LEVEL='error';
   const args=[fileURLToPath(new URL('../vendor/meta-ads-mcp-server/dist/cli.js',import.meta.url))];
   if(process.env.META_HTTPS_PROXY){
    const proxy=new URL(process.env.META_HTTPS_PROXY);
    if(!['http:','https:'].includes(proxy.protocol))throw new Error('META_HTTPS_PROXY 必须是正式 HTTP/HTTPS 代理地址');
    env.HTTPS_PROXY=proxy.href;env.HTTP_PROXY=proxy.href;env.NO_PROXY='localhost,127.0.0.1';args.unshift('--use-env-proxy');
   }
   const transport=new StdioClientTransport({command:process.execPath,args,env,stderr:'pipe'});
   transport.stderr?.on('data',()=>{}); // upstream errors may contain platform details: never log raw credentials
   await client.connect(transport);this.client=client;return client;
  })().catch(e=>{this.connecting=null;throw e;});
  return this.connecting;
 }
 async call(name,args={}){
  const c=await this.connect(); const result=await c.callTool({name,arguments:args},undefined,{timeout:120000});
  const raw=result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'{}';
  let data;try{data=JSON.parse(raw);}catch{data={message:raw};}
  if(result.isError||data.error){
   const detail=typeof data.error==='object'?JSON.stringify(data.error):String(data.error||data.message||'');
   if(data.isRateLimit||/too many calls|rate limit|request limit reached/i.test(detail))throw Object.assign(new Error('Meta 账户暂时触发调用频率限制，需等待后重试；已归档记录与分页游标已保留。'),{code:'META_RATE_LIMIT',status:429});
   if(/#3018/.test(detail)){
    const earliest=detail.match(/earliest start date available[^\d]*(\d{4}-\d{2}-\d{2})/i)?.[1];
    throw Object.assign(new Error('Meta 历史保留限制：'+(earliest?'当前最早可查询 '+earliest:'所请求日期已超出可查询范围')),{code:'META_RETENTION',earliestDate:earliest});
   }
   if(/reduce the amount of data|aborted due to timeout/i.test(detail))throw Object.assign(new Error('Meta 查询数据量过大或计算超时，需要减小分页'),{code:'META_REDUCE_QUERY'});
   if(/fetch failed|timed?\s*out|ENOTFOUND|ECONN/i.test(String(data.error||data.message||'')))throw Object.assign(new Error('当前运行主机无法连接 Meta API。请检查服务器出网、DNS 或正式代理配置；已有快照已保留。'),{status:502});
   throw new Error('Meta 接口未完成请求，请检查账户授权、权限及参数；未执行自动重试。');
  }
  return data;
 }
 async sync(accountId,range,known={}){
  const info=await this.call('meta_get_account_details',{adAccountId:accountId});
  const result=await this.call('meta_get_insights',{adAccountId:accountId,level:'campaign',metrics:['spend','impressions','reach','inline_link_clicks','purchases','purchase_value'],timeRange:range,attributionMode:'explicit',attributionWindows:['7d_click','1d_view'],actionReportTime:'impression',includeAccountTotals:true,limit:5000});
  if(!Array.isArray(result.data)||!Array.isArray(result.account_totals))throw new Error('接口返回不完整：缺少广告系列或账户原生总计，未保存快照');
  if(result.reporting_context?.pagination_exhausted!==true)throw new Error('分页未确认完整，未保存快照');
  const context=result.reporting_context;
  const warnings=[...(result.debug?.warnings||[]),...(result.notes||[])].map(x=>typeof x==='string'?x:JSON.stringify(x));
  const account={...known,id:String(accountId).replace(/^act_/,''),name:info.name||known.name||accountId,currency:info.currency||null,timezone:info.timezone_name||null,availability:result.data.length?'api_delivery':'no_delivery_in_range',campaignsComplete:true,totals:normalize(result.account_totals[0]||{}),campaigns:result.data.map(r=>({...normalize(r),id:r.campaign_id,name:r.campaign_name,attribution:'7-day click, 1-day view'}))};
  return {id:randomUUID(),source:'meta_api',capturedAt:new Date().toISOString(),...range,attribution:'7-day click, 1-day view',currency:account.currency,coverage:'api_campaigns_and_native_account_totals',reportingContext:context,notes:['Meta Marketing API；统一 7 天点击 / 1 天浏览归因。','购买口径为网站购买（Pixel Purchase），与历史后台汇总的 Purchases 可能不同，不能直接作增长比较。',...warnings],accounts:[account]};
 }
}
export function normalize(r){
 const action=(arr,type)=>{if(!Array.isArray(arr))return null;let a=arr.find(x=>x.action_type===type);return a?number(a.value):null;};
 return {spend:number(r.spend),impressions:number(r.impressions),reach:number(r.reach),linkClicks:number(r.inline_link_clicks),purchases:number(r.purchases)??action(r.actions,'offsite_conversion.fb_pixel_purchase'),purchaseValue:number(r.purchase_value)??action(r.action_values,'offsite_conversion.fb_pixel_purchase')};
}

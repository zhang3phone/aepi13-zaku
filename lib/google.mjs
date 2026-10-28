import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
export class GoogleAds {
 constructor(){this.client=null;this.connecting=null;this.metadata=new Map();}
 configured(){return !!process.env.GOOGLE_APPLICATION_CREDENTIALS;}
 async connect(){
  if(process.env.DEMO_MODE!=='false')throw Object.assign(new Error('演示模式不访问广告平台'),{status:409});
  if(!this.configured())throw Object.assign(new Error('Google API 尚未授权，请完成 Google Cloud OAuth 配置'),{status:409});
  if(this.client)return this.client;
  if(!this.connecting)this.connecting=(async()=>{
   const env=Object.fromEntries(['PATH','HOME','TMPDIR','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GOOGLE_PROJECT_ID','GOOGLE_ADS_DEVELOPER_TOKEN','GOOGLE_ADS_LOGIN_CUSTOMER_ID','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
   const transport=new StdioClientTransport({command:process.env.GOOGLE_ADS_MCP_COMMAND||'google-ads-mcp',args:[],env,stderr:'pipe'});transport.stderr?.on('data',()=>{});
   const c=new Client({name:'ads-workbench',version:'0.2.0'});await c.connect(transport);this.client=c;return c;
  })().catch(e=>{this.connecting=null;throw e;});
  return this.connecting;
 }
 async call(name,args={}){
  const c=await this.connect();const result=await c.callTool({name,arguments:args},undefined,{timeout:180000});
  if(result.isError){
   const detail=result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'';
   if(/not yet enabled|deactivated/i.test(detail))throw Object.assign(new Error('Google Ads 账户尚未启用或已停用，API 拒绝读取；未重新启用账户'),{status:409,code:'GOOGLE_ACCOUNT_DISABLED'});
   throw Object.assign(new Error('Google Ads 查询失败：请核对 API 访问级别、账户权限、查询字段与日期；未修改广告'),{status:502});
  }
  if(result.structuredContent){const v=result.structuredContent;return v.result??v;}
  const raw=result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'null';
  try{return JSON.parse(raw);}catch{throw new Error('Google MCP 返回格式无法识别');}
 }
 async search(customerId,resource,fields,conditions=[],loginCustomerId){
  const key=resource+':'+(loginCustomerId||'');let metadata=this.metadata.get(key);
  if(!metadata){metadata=await this.call('metadata_get_resource_metadata',{resource_name:resource,...(loginCustomerId?{login_customer_id:loginCustomerId}:{})});this.metadata.set(key,metadata);}
  // The official MCP requires live metadata validation before constructing GAQL.
  const allowed=new Set(metadata.selectable||[]);const missing=fields.filter(f=>!allowed.has(f));
  if(missing.length)throw new Error('Google API 当前不支持此数据集字段：'+missing.join(', '));
  const rows=await this.call('search_search',{customer_id:customerId,resource,fields,conditions,...(loginCustomerId?{login_customer_id:loginCustomerId}:{})});
  if(!Array.isArray(rows))throw new Error('Google 数据集返回格式无效，未标记完整');return rows;
 }
 async discover(){
  const direct=await this.call('customers_list_accessible_customers');if(!Array.isArray(direct))throw new Error('Google 账户列表格式无效');
  const accounts=new Map(),queue=direct.map(id=>({id:String(id)})),visited=new Set(),errors=[];
  while(queue.length){const {id,loginCustomerId}=queue.shift();if(visited.has(id))continue;visited.add(id);
   try{const info=await this.search(id,'customer',['customer.id','customer.descriptive_name','customer.currency_code','customer.time_zone','customer.manager','customer.status'],[],loginCustomerId);const r=info[0]||{};
    const a={id,name:r['customer.descriptive_name']||id,currency:r['customer.currency_code']||null,timezone:r['customer.time_zone']||null,manager:!!r['customer.manager'],status:r['customer.status'],loginCustomerId};accounts.set(id,a);
    if(a.manager){const children=await this.search(id,'customer_client',['customer_client.id','customer_client.descriptive_name','customer_client.manager','customer_client.level'],['customer_client.level <= 1'],loginCustomerId||id);for(const ch of children){const child=String(ch['customer_client.id']);if(child!==id)queue.push({id:child,loginCustomerId:loginCustomerId||id});}}
   }catch(e){
    const disabled=e.code==='GOOGLE_ACCOUNT_DISABLED';
    accounts.set(id,{id,name:id,manager:null,currency:null,timezone:null,status:disabled?'NOT_ENABLED_OR_DEACTIVATED':'INACCESSIBLE',apiAvailable:false,loginCustomerId});
    errors.push({id,status:disabled?'disabled':'inaccessible',message:disabled?e.message:'此账户的详情或下级账户读取失败，需要核对权限'});
   }
  }
  return {accounts:[...accounts.values()],errors,complete:errors.length===0,directCount:direct.length};
 }
}
export const GOOGLE_UPSTREAM={repo:'googleads/google-ads-mcp',commit:'9a78cbdceebae71a6bc8483bdec333695834ef9c',version:'0.0.5'};

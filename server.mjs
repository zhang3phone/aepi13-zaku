import http from 'node:http';
import {demoAccount,demoCards,demoPerformance} from './lib/demo.mjs';
import {REVIEW_SCHEMA,dailyReviewStatus} from './lib/daily-review.mjs';
import {LocalMedia} from './lib/local-media.mjs';
import {LearningStore,identity,archiveEnvelope} from './lib/learning-store.mjs';
import {CreativePerformance,performanceRange,performanceIds} from './lib/creative-performance.mjs';
import {CreativePreview,imageBytes} from './lib/creative-preview.mjs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from './lib/store.mjs';
import {Meta} from './lib/meta.mjs';
import {GoogleAds,GOOGLE_UPSTREAM} from './lib/google.mjs';
import {ArchiveStore} from './lib/archive-store.mjs';
import {ArchiveWorker} from './lib/archive-worker.mjs';
import {analyze,validateRange,number} from './lib/analysis.mjs';
const base=path.dirname(fileURLToPath(import.meta.url));
if(process.env.WORKBENCH_ENV_FILE)process.loadEnvFile(process.env.WORKBENCH_ENV_FILE);
const demo=process.env.DEMO_MODE!=='false';
if(process.env.WORKBENCH_ENABLE_WRITES==='true'||process.env.META_ENABLE_WRITES==='1')throw new Error('Public preview never enables platform writes');
const seed=demo?JSON.parse(await fs.readFile(path.join(base,'data/browser-snapshot.json'),'utf8')):{id:'empty-initial-v1',capturedAt:new Date().toISOString(),since:'2026-10-01',until:'2026-10-01',source:'empty',accounts:[]};
const store=new Store(process.env.DATABASE_URL);await store.init(seed);
const localMedia=new LocalMedia(store.pool);await localMedia.init();if(store.pool)await store.pool.query(REVIEW_SCHEMA);
const learning=new LearningStore(store.pool);await learning.init();
if(store.pool&&demo)for(const r of JSON.parse(await fs.readFile(path.join(base,'data/learning-seed.json'),'utf8')))await learning.append(r,'虚构教学示例生成器');
const meta=new Meta();const google=new GoogleAds();const archive=new ArchiveStore(store);await archive.init(!demo&&process.env.WORKBENCH_ARCHIVE_WORKER==='true');const worker=new ArchiveWorker(store,archive,meta,google);if(!demo&&process.env.WORKBENCH_ARCHIVE_WORKER==='true')worker.start();const sessions=new Map(), attempts=new Map();let syncBusy=false;
const passwordHash=process.env.WORKBENCH_PASSWORD_HASH,secret=process.env.SESSION_SECRET;
if(!passwordHash||!secret)throw new Error('WORKBENCH_PASSWORD_HASH and SESSION_SECRET are required');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:process.env.REPORT_TIMEZONE||'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const safeEqual=(a,b)=>{const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);};
const redact=e=>{let m=String(e?.message||'请求失败');for(const v of [process.env.META_ACCESS_TOKEN,process.env.DATABASE_URL])if(v)m=m.replaceAll(v,'[REDACTED]');return m.slice(0,400);};
function cookie(req){return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('mw_session='))?.slice(11);}
function session(req){const id=cookie(req),s=sessions.get(id);if(s&&s.exp>Date.now())return s;if(id)sessions.delete(id);return null;}
function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
async function body(req){let data='';for await(const c of req){data+=c;if(data.length>65536)throw Object.assign(new Error('请求过大'),{status:413});}try{return JSON.parse(data||'{}');}catch{throw Object.assign(new Error('JSON 格式无效'),{status:400});}}
function checkOrigin(req){if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`)throw Object.assign(new Error('来源校验失败'),{status:403});}
const id=x=>/^\d{5,30}$/.test(String(x));
const creativePreview=new CreativePreview(meta);const creativePerformance=new CreativePerformance(meta);

async function getAccount(snapshotId,accountId){const s=await store.snapshot(snapshotId);const a=s?.accounts.find(x=>x.id===accountId);if(!a)throw Object.assign(new Error('找不到该账户或快照'),{status:404});return {s,a};}
const server=http.createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
 try{
 const url=new URL(req.url,'http://localhost'),p=url.pathname;
 if(p==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(p==='/health'){json(res,200,{status:'ok',systemId:'AEPI13-Zaku',demoMode:demo,version:'0.1.0-preview.1',releaseDate:'2026-10-28',releaseTimezone:'America/Los_Angeles',storage:store.pool?'postgres':'memory',googleConfigured:google.configured(),metaConfigured:!!process.env.META_ACCESS_TOKEN,writesEnabled:process.env.WORKBENCH_ENABLE_WRITES==='true'});return;}
 if(p==='/api/login'&&req.method==='POST'){
  checkOrigin(req);const ip=req.socket.remoteAddress;const count=attempts.get(ip)||{n:0,until:Date.now()+600000};if(Date.now()>count.until){count.n=0;count.until=Date.now()+600000;}if(count.n>=10){json(res,429,{error:'登录尝试过多，请 10 分钟后重试'});return;}
  const b=await body(req);const [salt,hash]=passwordHash.split(':');const actual=crypto.scryptSync(String(b.password||'').slice(0,256),salt,64).toString('hex');
  if(b.username!=='admin'||!safeEqual(actual,hash)){count.n++;attempts.set(ip,count);json(res,401,{error:'用户名或密码错误'});return;}
  attempts.delete(ip);const token=crypto.randomBytes(32).toString('hex');const csrf=crypto.randomBytes(24).toString('hex');sessions.set(token,{csrf,exp:Date.now()+8*3600000});
  res.setHeader('Set-Cookie',`mw_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);await store.audit('login');json(res,200,{ok:true,csrf});return;
 }
 if(p.startsWith('/api/')){
  const s=session(req);if(!s){json(res,401,{error:'请先登录'});return;}
  if(!['GET','HEAD'].includes(req.method)){checkOrigin(req);if(!safeEqual(String(req.headers['x-csrf-token']||''),s.csrf)){json(res,403,{error:'页面会话已更新，请刷新后重试'});return;}}
  if(p==='/api/session'){json(res,200,{csrf:s.csrf,user:'admin'});return;}
  if(p==='/api/logout'&&req.method==='POST'){sessions.delete(cookie(req));res.setHeader('Set-Cookie','mw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');json(res,200,{ok:true});return;}
  if(p==='/api/state'){
   const snapshots=await store.snapshots(),settings=await store.settings();
   json(res,200,{systemId:'AEPI13-Zaku',demoMode:demo,version:'0.1.0-preview.1',releaseDate:'2026-10-28',releaseTimezone:'America/Los_Angeles',today:today(),metaConfigured:!!process.env.META_ACCESS_TOKEN,writesEnabled:process.env.WORKBENCH_ENABLE_WRITES==='true',storage:store.pool?'postgres':'memory',syncBusy,googleConfigured:google.configured(),googleUpstream:GOOGLE_UPSTREAM,settings,snapshots:snapshots.filter(s=>!s.platform||s.platform==='meta').map(s=>({...s,accounts:s.accounts.map(({campaigns,...a})=>({...a,campaignCount:campaigns.length}))})),upstream:{repo:'getmcpads-com/meta-ads-mcp-server',version:'2.0.0',commit:'1f2ebe6c93c2ff9c8ed4c22b4f9ff06a8f7aebd8'}});return;
  }
  if(p==='/api/daily-review/status'&&req.method==='GET'){json(res,200,await dailyReviewStatus(store.pool,url.searchParams.get('account')));return;}
  if(['/api/local-assets','/api/local-file','/api/storage'].includes(p)&&['GET','HEAD'].includes(req.method)){
   if(p==='/api/storage'){json(res,200,await localMedia.status());return;}
   const account=url.searchParams.get('account');const known=(await store.snapshots()).some(sn=>sn.accounts.some(a=>a.id===account))||((await store.settings()).discovered_accounts?.accounts||[]).some(a=>String(a.account_id||a.id).replace(/^act_/,'')===account);if(!known)throw Object.assign(new Error('账户尚未发现'),{status:404});
   if(p==='/api/local-assets'){json(res,200,await localMedia.list(account,url.searchParams.get('kind')||'all',url.searchParams.get('after')||''));return;}
   await localMedia.send(req,res,account,url.searchParams.get('id'),url.searchParams.get('variant')||'original');return;
  }
  if((p==='/api/creatives'||p==='/api/creative-image'||p==='/api/creative-performance')&&req.method==='GET'){
   const account=url.searchParams.get('account');if(!id(account))throw Object.assign(new Error('账户 ID 无效'),{status:400});
   const known=(await store.snapshots()).some(sn=>sn.accounts.some(a=>a.id===account))||((await store.settings()).discovered_accounts?.accounts||[]).some(a=>String(a.account_id||a.id).replace(/^act_/,'')===account);
   if(!known)throw Object.assign(new Error('账户尚未发现'),{status:404});
   if(demo&&account!==demoAccount)throw Object.assign(new Error('演示账户不存在'),{status:404});
   if(demo&&p==='/api/creatives'){json(res,200,demoCards());return;}
   if(demo&&p==='/api/creative-image')throw Object.assign(new Error('演示仅使用本地虚构图形'),{status:404});
   if(p==='/api/creative-performance'){const range=performanceRange(url.searchParams.get('since'),url.searchParams.get('until'));const ids=performanceIds(url.searchParams.get('ads'));json(res,200,demo?demoPerformance(account,range,ids):await creativePerformance.read(account,range,ids,url.searchParams.get('refresh')==='1'));return;}
   if(p==='/api/creatives'){const after=url.searchParams.get('after')||'';if(after.length>2000)throw Object.assign(new Error('分页参数无效'),{status:400});json(res,200,await localMedia.decorate(creativePreview.publicPage(await creativePreview.page(account,after,url.searchParams.get('refresh')==='1'))));return;}
   const ad=url.searchParams.get('ad'),rawIndex=url.searchParams.get('index')||'0';if(!id(ad)||!/^\d{1,2}$/.test(rawIndex))throw Object.assign(new Error('素材参数无效'),{status:400});
   const src=creativePreview.findImage(account,ad,Number(rawIndex));if(!src)throw Object.assign(new Error('请先刷新广告素材列表'),{status:404});
   const image=await imageBytes(src);res.writeHead(200,{'content-type':image.type,'content-length':image.bytes.length,'Cache-Control':'private, max-age=120'});res.end(image.bytes);return;
  }
  if(p.startsWith('/api/learning')){
   if(p==='/api/learning/pending'&&req.method==='GET'){json(res,200,{records:(await learning.pending()).map(archiveEnvelope)});return;}
   if(p==='/api/learning/nas-ack'&&req.method==='POST'){const b=await body(req),proof=crypto.createHmac('sha256',secret).update('learning-nas-v2|'+b.hash+'|'+b.fileHash+'|'+b.fileName).digest('hex');if(!safeEqual(proof,String(req.headers['x-learning-archive-proof']||'')))throw Object.assign(new Error('归档回执仅接受受控归档程序提交'),{status:403});json(res,200,await learning.ack(b.hash,b.fileHash,b.fileName));return;}
   const account=url.searchParams.get('account');
   if(p==='/api/learning'&&req.method==='GET'){json(res,200,{records:await learning.list(account,performanceIds(url.searchParams.get('ads')))});return;}
   if(p==='/api/learning/asset'&&req.method==='GET'){const localId=await localMedia.learning(account,url.searchParams.get('ad'),url.searchParams.get('sha'));if(localId){await localMedia.send(req,res,account,localId);return;}const a=await learning.asset(account,url.searchParams.get('ad'),url.searchParams.get('sha'));if(!a){json(res,404,{error:'历史素材尚未归档'});return;}res.writeHead(200,{'content-type':a.mime,'content-length':a.bytes.length});res.end(a.bytes);return;}
   if(p==='/api/learning'&&req.method==='POST'){
    const b=await body(req),who=identity(b),known=(await store.snapshots()).some(sn=>sn.accounts.some(a=>a.id===who.accountId))||((await store.settings()).discovered_accounts?.accounts||[]).some(a=>String(a.account_id||a.id).replace(/^act_/,'')===who.accountId);
    if(!known)throw Object.assign(new Error('账户尚未发现'),{status:404});
    const previous=await learning.list(who.accountId,[who.adId]);let matched=(demo&&who.accountId===demoAccount&&demoCards().cards.some(c=>c.id===who.adId&&c.campaignId===who.campaignId&&c.adsetId===who.adsetId))||previous.some(r=>r.campaignId===who.campaignId&&r.adsetId===who.adsetId);
    if(previous.length&&!matched)throw Object.assign(new Error('学习记录的系列或广告组关联不一致'),{status:409});
    if(!matched){const cards=[...creativePreview.pages.values()].filter(x=>x.accountId===who.accountId).flatMap(x=>x.cards);matched=cards.some(c=>c.id===who.adId&&c.campaignId===who.campaignId&&c.adsetId===who.adsetId);}
    if(!matched){const page=await creativePreview.page(who.accountId);matched=page.cards.some(c=>c.id===who.adId&&c.campaignId===who.campaignId&&c.adsetId===who.adsetId);}
    if(!matched)throw Object.assign(new Error('尚未核实广告关联，请先在素材页载入该广告'),{status:400});
    const record=await learning.append(b,b.kind==='judgment'||b.kind==='followup'?'用户补充':'工作台记录（作者以证据来源为准）');await store.audit('learning_record_saved',{accountId:who.accountId,adId:who.adId,recordHash:record.hash});json(res,200,{record});return;
   }
   json(res,405,{error:'学习记录只支持读取和追加，不支持覆盖或删除'});return;
  }
  if(p==='/api/account'){
   const {a,s}=await getAccount(url.searchParams.get('snapshot'),url.searchParams.get('account'));const settings=await store.settings();json(res,200,{snapshot:{...s,accounts:undefined},account:a,analysis:analyze(a,s,settings['target:'+a.id]||{})});return;
  }
  if(p==='/api/settings'&&req.method==='POST'){
   const b=await body(req);if(!id(b.accountId))throw Object.assign(new Error('账户 ID 无效'),{status:400});
   const target={};for(const k of ['targetCpa','targetRoas']){let v=number(b[k]);if(v!==null&&(v<=0||v>100000))throw Object.assign(new Error('目标值须大于 0'),{status:400});target[k]=v;}
   await store.set('target:'+b.accountId,target);await store.audit('target_updated',{accountId:b.accountId,...target});json(res,200,{ok:true});return;
  }
  if(p==='/api/discover'&&req.method==='POST'){
   const r=await meta.call('meta_list_ad_accounts');await store.set('discovered_accounts',{capturedAt:new Date().toISOString(),accounts:r.accounts});await store.audit('accounts_discovered',{count:r.accounts?.length});json(res,200,r);return;
  }
  if(p==='/api/sync'&&req.method==='POST'){
   if(syncBusy)throw Object.assign(new Error('已有同步任务执行中'),{status:409});const b=await body(req);if(!id(b.accountId))throw Object.assign(new Error('账户 ID 无效'),{status:400});
   const range=validateRange(b.since,b.until);if(range.until>today())throw Object.assign(new Error('结束日期不能晚于今天'),{status:400});
   const snaps=await store.snapshots();const known=snaps.flatMap(s=>s.accounts).find(a=>a.id===b.accountId)||{};
   syncBusy=true;try{const result=await meta.sync(b.accountId,range,known);await store.saveSnapshot(result);await store.audit('sync_completed',{accountId:b.accountId,snapshotId:result.id,...range});json(res,200,{ok:true,snapshotId:result.id});}finally{syncBusy=false;}return;
  }
  if(p==='/api/google/discover'&&req.method==='POST'){const result=await google.discover();await store.set('google_accounts',{...result,capturedAt:new Date().toISOString()});await store.audit('google_accounts_discovered',{count:result.accounts.length,complete:result.complete});json(res,200,result);return;}
  if(p==='/api/archive'&&req.method==='GET'){json(res,200,await archive.overview());return;}
  if(p==='/api/archive/start'&&req.method==='POST'){const b=await body(req);if(!['meta','google'].includes(b.platform))throw Object.assign(new Error('平台无效'),{status:400});const result=b.platform==='meta'?await worker.planMeta(today()):await worker.planGoogle(today());json(res,200,{ok:true,result});return;}
  if(p==='/api/archive/retry'&&req.method==='POST'){await archive.retry();await store.audit('archive_retry_requested');json(res,200,{ok:true});return;}
  if(p==='/api/archive/export'){const taskId=url.searchParams.get('task');if(!taskId||taskId.length>300)throw Object.assign(new Error('任务无效'),{status:400});res.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8','Content-Disposition':'attachment; filename="ads-archive.ndjson"'});let cursor='';while(!res.destroyed){const pages=await archive.page(taskId,cursor);if(!pages.length)break;for(const row of pages[0].payload.rows){if(!res.write(JSON.stringify(row)+'\n'))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});}cursor=pages[0].page_key;}res.end();return;}
  if(p==='/api/archive/page'){const taskId=url.searchParams.get('task');if(!taskId||taskId.length>300)throw Object.assign(new Error('任务无效'),{status:400});json(res,200,await archive.page(taskId,url.searchParams.get('after')||''));return;}
  if(p==='/api/report'){const month=url.searchParams.get('month')||today().slice(0,7);if(!/^\d{4}-\d{2}$/.test(month)||Number(month.slice(5))<1||Number(month.slice(5))>12)throw Object.assign(new Error('月份无效'),{status:400});json(res,200,await archive.report(month));return;}
  if(p==='/api/audit'){json(res,200,await store.audits());return;}
  if(p==='/api/plans'&&req.method==='GET'){json(res,200,await store.plans());return;}
  if(p==='/api/plans'&&req.method==='POST'){
   const b=await body(req);const {s:sn,a}=await getAccount(b.snapshotId,b.accountId);const campaign=a.campaigns.find(c=>c.name===b.campaignName);if(!campaign)throw Object.assign(new Error('找不到广告系列'),{status:400});
   if(!['review','retest','reduce','increase'].includes(b.action))throw Object.assign(new Error('调整类型无效'),{status:400});
   const note=String(b.note||'').slice(0,1500);const plan={id:crypto.randomUUID(),createdAt:new Date().toISOString(),status:'proposal',accountId:a.id,campaignId:campaign.id||null,campaignName:campaign.name,action:b.action,note,source:sn.source,snapshotId:sn.id,since:sn.since,until:sn.until,attribution:sn.attribution,executionEnabled:false,message:'这是待审阅优化方案，不会修改 Meta 广告。实际预算编辑须完成实时授权、当前配置核对和专项验收。'};
   await store.plan(plan);await store.audit('proposal_created',{planId:plan.id,accountId:a.id,campaign:campaign.name,action:b.action});json(res,200,plan);return;
  }
  if(p==='/api/export'){
   const {s:sn,a}=await getAccount(url.searchParams.get('snapshot'),url.searchParams.get('account'));res.setHeader('Content-Disposition',`attachment; filename="meta-ads-${a.id}-${sn.since}-${sn.until}.json"`);json(res,200,{snapshot:{...sn,accounts:[a]},exportedAt:new Date().toISOString()});return;
  }
  json(res,404,{error:'接口不存在'});return;
 }
 if(!['GET','HEAD'].includes(req.method)&&req.method!=='HEAD'){json(res,405,{error:'Method not allowed'});return;}
 const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/demo.svg':['demo.svg','image/svg+xml']};
 if(!files[p]){res.writeHead(404);res.end('Not found');return;}
 const [file,type]=files[p];res.writeHead(200,{'content-type':type});res.end(req.method==='HEAD'?'':await fs.readFile(path.join(base,'public',file)));
 }catch(e){if(res.headersSent){res.destroy();return;}json(res,e.status||500,{error:redact(e)});}
});
server.listen(Number(process.env.PORT||8098),process.env.HOST||'127.0.0.1',()=>console.log('AEPI13-Zaku 0.1.0-preview.1 listening on port '+(process.env.PORT||8098)));
process.on('SIGTERM',()=>{worker.stopping=true;clearInterval(worker.timer);server.close(()=>process.exit(0));});

import crypto from 'node:crypto';
export const digest=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:stable(x)).digest('hex');
export function archiveEnvelope(record){const bytes=Buffer.from(stable(record)+'\n');return {record,archiveBase64:bytes.toString('base64'),fileHash:digest(bytes)};}
export function stable(x){if(Array.isArray(x))return '['+x.map(stable).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';return JSON.stringify(x);}
const bad=m=>{throw Object.assign(new Error(m),{status:400});};
export function identity(x){for(const k of ['accountId','campaignId','adsetId','adId'])if(!/^\d{5,30}$/.test(x?.[k]||''))bad('账户、系列、组和广告 ID 必须完整');return Object.fromEntries(['accountId','campaignId','adsetId','adId'].map(k=>[k,x[k]]));}
export const categories=['facts','hypotheses','suggestions','approvals','executions','verification'];
export function validateRecord(b){
 const who=identity(b);if(!/^[a-zA-Z0-9_-]{1,100}$/.test(b.recordKey||''))bad('记录标识无效');
 if(!['case','review','judgment','followup','correction'].includes(b.kind))bad('记录类型无效');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(b.recordDate||'')||!Number.isFinite(Date.parse(b.recordDate+'T00:00:00Z'))||new Date(b.recordDate+'T00:00:00Z').toISOString().slice(0,10)!==b.recordDate)bad('记录日期无效');
 if(!b.content||typeof b.content!=='object'||Array.isArray(b.content))bad('内容格式无效');
 for(const k of ['source','title'])if(typeof b[k]!=='string'||!b[k].trim()||b[k].length>1000)bad('请填写标题和证据来源');
 if(b.supersedes!==undefined&&!/^[a-f0-9]{64}$/.test(b.supersedes))bad('纠错引用无效');
 const content=JSON.parse(JSON.stringify(b.content));if(Buffer.byteLength(JSON.stringify(content))>48000)bad('单条记录内容过长');
 for(const k of categories)if(!Array.isArray(content[k])||content[k].some(v=>typeof v!=='string'||v.length>4000))bad('事实、假设、建议、批准、执行和验证必须分别填写');
 const allowed=new Set([...categories,'summary','settings','settingsContext','assetSha','assetNote','history','metrics','nextReview','evidence']);if(Object.keys(content).some(k=>!allowed.has(k)))bad('包含未定义的学习字段');
 const text=(v,max=4000)=>typeof v==='string'&&v.length<=max;
 for(const k of ['summary','settingsContext','assetNote','nextReview'])if(content[k]!==undefined&&!text(content[k]))bad('教学文字格式无效');
 if(content.assetSha!==undefined&&!/^[a-f0-9]{64}$/.test(content.assetSha))bad('历史素材哈希无效');
 if(content.evidence!==undefined&&(!Array.isArray(content.evidence)||content.evidence.length>50||content.evidence.some(v=>!text(v))))bad('证据格式无效');
 for(const [key,fields] of [['settings',['level','field','value','reason','effect','recheck']],['history',['title','period','context','metrics','lesson','limit','source']]])if(content[key]!==undefined&&(!Array.isArray(content[key])||content[key].length>50||content[key].some(row=>!row||typeof row!=='object'||Object.keys(row).some(k=>!fields.includes(k))||fields.some(k=>!text(row[k])))))bad('设置或历史对照格式无效');
 if(content.metrics!==undefined){const m=content.metrics,nums=['spend','impressions','frequency','clicks','ctr','cpc','landingViews','addToCart','checkouts','purchases','cpa','purchaseValue','roas'],texts=['since','until','timezone','currency','attribution','basis','capturedAt','note'];if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!nums.includes(k)&&!texts.includes(k)))bad('指标字段无效');for(const k of nums)if(m[k]!==undefined&&m[k]!==null&&(typeof m[k]!=='number'||!Number.isFinite(m[k])||m[k]<0))bad('缺失指标须为空值，不接受推测数字');for(const k of texts)if(m[k]!==undefined&&!text(m[k]))bad('指标口径格式无效');for(const k of ['since','until','timezone','currency','attribution','basis','capturedAt'])if(!m[k])bad('历史指标必须保留日期时区币种归因和采集时间');}
 const scan=v=>{if(Array.isArray(v)){v.forEach(scan);return;}if(v&&typeof v==='object'){for(const [k,val] of Object.entries(v)){if(/password|cookie|access.?token|secret|authorization|数据库连接/i.test(k))bad('记录不得包含凭据字段');scan(val);}return;}if(typeof v==='string'&&/Bearer\s+\S+|postgres(?:ql)?:\/\/|(?:access_token|password|cookie|secret)\s*[=:]\s*\S+/i.test(v))bad('记录不得包含密钥或登录凭据');};scan({title:b.title,source:b.source,content});
 return {...who,recordKey:b.recordKey,kind:b.kind,recordDate:b.recordDate,title:b.title.trim(),source:b.source.trim(),...(b.supersedes?{supersedes:b.supersedes}:{}),content};
}
export class LearningStore{
 constructor(pool){this.pool=pool;}
 async init(){if(!this.pool)return;await this.pool.query(`CREATE TABLE IF NOT EXISTS mw_learning_records(account_id text NOT NULL,campaign_id text NOT NULL,adset_id text NOT NULL,ad_id text NOT NULL,record_key text NOT NULL,hash text NOT NULL UNIQUE,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,ad_id,record_key));CREATE TABLE IF NOT EXISTS mw_learning_nas(hash text PRIMARY KEY REFERENCES mw_learning_records(hash),relative_path text NOT NULL,verified_at timestamptz NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS mw_learning_assets(sha text NOT NULL,account_id text NOT NULL,ad_id text NOT NULL,mime text NOT NULL,bytes bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,ad_id,sha));`);}
 requireDB(){if(!this.pool)throw Object.assign(new Error('学习数据库不可用，未保存记录'),{status:503});}
 async append(b,author='用户补充'){
  this.requireDB();const input=validateRecord(b),hash=digest(input);
  if(input.supersedes){const p=(await this.pool.query('SELECT hash FROM mw_learning_records WHERE account_id=$1 AND ad_id=$2 AND hash=$3',[input.accountId,input.adId,input.supersedes])).rows;if(!p.length)bad('纠错引用必须属于同一广告');}
  const payload={...input,hash,author,createdAt:new Date().toISOString(),executionEnabled:false};
  await this.pool.query('INSERT INTO mw_learning_records(account_id,campaign_id,adset_id,ad_id,record_key,hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,ad_id,record_key) DO NOTHING',[input.accountId,input.campaignId,input.adsetId,input.adId,input.recordKey,hash,payload]);
  const r=(await this.pool.query('SELECT r.payload,n.verified_at,n.relative_path FROM mw_learning_records r LEFT JOIN mw_learning_nas n USING(hash) WHERE r.account_id=$1 AND r.ad_id=$2 AND r.record_key=$3',[input.accountId,input.adId,input.recordKey])).rows[0];
  if(!r||r.payload.hash!==hash)throw Object.assign(new Error('同一标识已有不同内容；请用新标识追加版本'),{status:409});
  return this.public(r);
 }
 public(r){return {...r.payload,storage:{database:'verified',nas:r.verified_at?'verified':'pending',nasVerifiedAt:r.verified_at||null,nasPath:r.relative_path||null}};}
 async list(account,ads){this.requireDB();if(!/^\d{5,30}$/.test(account)||!ads.length||ads.length>100||ads.some(a=>!/^\d{5,30}$/.test(a)))bad('查询广告 ID 无效');return (await this.pool.query('SELECT r.payload,n.verified_at,n.relative_path FROM mw_learning_records r LEFT JOIN mw_learning_nas n USING(hash) WHERE r.account_id=$1 AND r.ad_id=ANY($2::text[]) ORDER BY r.payload->>\'recordDate\',r.created_at,r.record_key',[account,ads])).rows.map(r=>this.public(r));}
 async pending(){this.requireDB();return (await this.pool.query('SELECT r.payload FROM mw_learning_records r LEFT JOIN mw_learning_nas n USING(hash) WHERE n.hash IS NULL ORDER BY r.created_at LIMIT 100')).rows.map(r=>r.payload);}
 async ack(hash,fileHash,fileName){this.requireDB();if(!/^[a-f0-9]{64}$/.test(hash)||! /^[a-f0-9]{64}$/.test(fileHash))bad('归档校验值无效');const r=(await this.pool.query('SELECT payload FROM mw_learning_records WHERE hash=$1',[hash])).rows[0]?.payload;if(!r)bad('记录不存在');if(digest(stable(r)+'\n')!==fileHash)bad('NAS 文件内容校验不匹配');const prefix=`${r.recordDate}-${r.recordKey}-${hash}-`;if(typeof fileName!=='string'||!fileName.startsWith(prefix)||! /^[a-f0-9]{24}\.json$/.test(fileName.slice(prefix.length)))bad('归档版本文件名无效');const rel=`meta/${r.accountId}/learning/records/${r.adId}/${fileName}`;await this.pool.query('INSERT INTO mw_learning_nas(hash,relative_path) VALUES($1,$2) ON CONFLICT(hash) DO NOTHING',[hash,rel]);const checked=(await this.pool.query('SELECT relative_path FROM mw_learning_nas WHERE hash=$1',[hash])).rows[0];if(checked?.relative_path!==rel)throw new Error('NAS回执数据库回读失败');return {hash,nas:'verified',relativePath:rel};}
 async asset(account,ad,sha){this.requireDB();if(!/^[a-f0-9]{64}$/.test(sha))bad('素材引用无效');const a=(await this.pool.query('SELECT mime,bytes FROM mw_learning_assets WHERE sha=$1 AND account_id=$2 AND ad_id=$3',[sha,account,ad])).rows[0];if(!a)return null;if(digest(a.bytes)!==sha)throw new Error('素材完整性校验失败');return a;}
}

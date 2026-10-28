// Read-only creative inspection. No platform mutations and no credentials in responses.
export const creativeFields=['id','name','campaign_id','adset_id','status','effective_status','creative'];
export function safeImage(value){try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.searchParams.has('access_token'))return null;if(!['fbcdn.net','facebook.com','fbsbx.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))return null;return u.href;}catch{return null;}}
export function creativeCard(ad){
 const c=ad.creative||{},story=c.object_story_spec||{},feed=c.asset_feed_spec||{},images=[];
 const add=(u,label)=>{u=safeImage(u);if(u&&!images.some(x=>x.url===u))images.push({url:u,label});};
 add(c.image_url,'主图');for(const i of feed.images||[])add(i.url,'素材变体');
 for(const part of [story.link_data,story.photo_data,story.video_data]){add(part?.picture,'图片');add(part?.image_url,'图片');for(const child of part?.child_attachments||[])add(child.picture,'轮播图片');}
 add(c.thumbnail_url,c.video_id?'视频封面':'预览图');
 const texts=[...(feed.bodies||[]).map(x=>x.text),story.link_data?.message,story.photo_data?.caption,story.video_data?.message,c.body].filter(Boolean);
 const titles=[...(feed.titles||[]).map(x=>x.text),story.link_data?.name,story.video_data?.title,c.title].filter(Boolean);
 const urls=[...(feed.link_urls||[]).map(x=>x.website_url),story.link_data?.link,c.object_url].filter(Boolean).filter(x=>{try{const u=new URL(x);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!u.searchParams.has('access_token');}catch{return false;}});
 return {id:String(ad.id),name:ad.name||ad.id,campaignId:ad.campaign_id||null,adsetId:ad.adset_id||null,status:ad.status||null,effectiveStatus:ad.effective_status||null,creativeId:c.id||null,imageHashes:[...new Set([c.image_hash,story.link_data?.image_hash,story.photo_data?.image_hash,...(feed.images||[]).map(i=>i.hash),...(story.link_data?.child_attachments||[]).map(i=>i.image_hash)].filter(Boolean))],videoIds:[...new Set([c.video_id,story.video_data?.video_id,...(feed.videos||[]).map(v=>v.video_id)].filter(Boolean).map(String))],videoId:c.video_id||story.video_data?.video_id||(feed.videos||[])[0]?.video_id||null,unresolvedImages:(feed.images||[]).filter(i=>i.hash&&!safeImage(i.url)).length,images:images.slice(0,30),texts:[...new Set(texts)],titles:[...new Set(titles)],destinations:[...new Set(urls)]};
}
export class CreativePreview {
 constructor(meta){this.meta=meta;this.pages=new Map();this.busy=new Map();this.inventories=new Map();}
 async inventory(account,force=false){
  const old=this.inventories.get(account);if(old&&!force&&Date.now()-old.at<300000)return old.map;
  const map=new Map();let after='';const seen=new Set();
  for(let page=0;page<40;page++){
   const r=await this.meta.call('meta_list_edge_raw',{parentId:'act_'+account,edge:'adcreatives',fields:['id','name','title','body','object_story_spec','asset_feed_spec','image_url','image_hash','thumbnail_url','video_id','object_url'],limit:25,...(after?{after}:{})});
   const rows=Array.isArray(r.data)?r.data:r.data?.data,paging=r.paging||r.data?.paging;if(!Array.isArray(rows))throw new Error('创意清单返回不完整');for(const row of rows)map.set(String(row.id),row);
   if(!paging?.next){this.inventories.set(account,{at:Date.now(),map});return map;}
   const next=paging.cursors?.after;if(!next||seen.has(next))throw new Error('创意清单分页游标无效');seen.add(next);after=next;
  }
  throw new Error('创意清单超过本次预览读取上限，未展示不完整关联');
 }
 async page(account,after='',force=false){
  const key=account+':'+after,cached=this.pages.get(key);if(cached&&!force&&Date.now()-cached.at<300000)return cached;
  if(this.busy.has(key))return this.busy.get(key);
  const task=(async()=>{const r=await this.meta.call('meta_list_edge_raw',{parentId:'act_'+account,edge:'ads',fields:creativeFields,limit:25,...(after?{after}:{})});const rows=Array.isArray(r.data)?r.data:r.data?.data,paging=r.paging||r.data?.paging;
   if(!Array.isArray(rows))throw new Error('广告素材返回不完整，未显示推测内容');
   const next=paging?.next?paging.cursors?.after:null;if(paging?.next&&(!next||next===after))throw new Error('广告分页游标无效，请稍后重试');
   const inventory=await this.inventory(account,force);const joined=rows.map(ad=>({...ad,creative:inventory.get(String(ad.creative?.id))||ad.creative}));
   const result={at:Date.now(),accountId:account,capturedAt:new Date().toISOString(),cards:joined.map(creativeCard),after:next||null,complete:!paging?.next,source:'meta_live_readonly'};
   if(this.pages.size>100)this.pages.delete(this.pages.keys().next().value);this.pages.set(key,result);return result;
  })().finally(()=>this.busy.delete(key));this.busy.set(key,task);return task;
 }
 findImage(account,ad,index){for(const [key,page] of this.pages)if(key.startsWith(account+':')&&Date.now()-page.at<900000){const card=page.cards.find(c=>c.id===ad);if(card?.images[index])return card.images[index].url;}return null;}
 publicPage(page){return {...page,at:undefined,cards:page.cards.map(c=>({...c,images:c.images.map((i,index)=>({label:i.label,url:'/api/creative-image?account='+page.accountId+'&ad='+c.id+'&index='+index}))}))};}
}
export async function imageBytes(source){
 let url=safeImage(source);if(!url)throw Object.assign(new Error('图片地址不可用'),{status:400});
 for(let redirects=0;redirects<=3;redirects++){
  const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
  if([301,302,303,307,308].includes(r.status)){url=safeImage(new URL(r.headers.get('location')||'',url).href);if(!url)throw new Error('素材重定向地址不受支持');continue;}
  if(!r.ok)throw Object.assign(new Error('平台图片暂时不可用，请刷新素材列表后重试'),{status:502});
  const type=r.headers.get('content-type')?.split(';')[0];if(!['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(type))throw new Error('素材不是支持的图片格式');
  const max=12*1024*1024;if(Number(r.headers.get('content-length'))>max)throw new Error('图片超过预览大小限制');let size=0;const chunks=[];
  for await(const chunk of r.body){size+=chunk.length;if(size>max)throw new Error('图片超过预览大小限制');chunks.push(chunk);}
  if(!size)throw new Error('素材图片为空');return {type,bytes:Buffer.concat(chunks)};
 }
 throw new Error('素材重定向次数过多');
}

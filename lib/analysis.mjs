export const number = x => x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x);
export const divide = (a,b) => number(a) !== null && number(b)>0 ? number(a)/number(b) : null;
export function metrics(row={}) {
 return {...row, cpa:divide(row.spend,row.purchases),roas:divide(row.purchaseValue,row.spend),ctr:divide(row.linkClicks,row.impressions)===null?null:divide(row.linkClicks,row.impressions)*100,cpc:divide(row.spend,row.linkClicks),cpm:divide(row.spend,row.impressions)===null?null:divide(row.spend,row.impressions)*1000,frequency:row.frequency??divide(row.impressions,row.reach)};
}
export function analyze(account,snapshot,target={}) {
 const rows=(account.campaigns||[]).map(metrics);
 const notes=[]; const cpa=number(target.targetCpa); const roas=number(target.targetRoas);
 if(snapshot.source!=='meta_api')notes.push({kind:'data',title:'先同步近期数据，再决定调整',detail:'当前是历史核查快照。没有近期趋势、当前状态与预算，无法推断今天应加预算或暂停。'});
 if(!account.campaignsComplete)notes.push({kind:'data',title:'明细尚未覆盖全部广告系列',detail:'账户总计来自后台原生汇总；当前可见明细不完整，不能相加替代账户总计。'});
 const windows=[...new Set(rows.map(r=>r.attribution).filter(Boolean))];
 if(windows.length>1||snapshot.attribution==='mixed')notes.push({kind:'measurement',title:'归因窗口需要统一',detail:'检测到不同点击 / 浏览归因窗口。列表可用于回顾，但不据此直接排名或调预算。'});
 if(!cpa&&!roas)notes.push({kind:'setup',title:'设置你的经营目标',detail:'填写目标 CPA 或目标 ROAS，建议才能按业务标准判断；未填写时不使用通用阈值冒充盈利线。'});
 for(const row of rows){
   if(!cpa&&!roas)continue;
   const enough=number(row.purchases)>=10;
   const bad=(cpa&&row.cpa>cpa*1.2)||(roas&&row.roas!==null&&row.roas<roas*0.8);
   const good=(!cpa||row.cpa<=cpa)&&(!roas||(row.roas!==null&&row.roas>=roas));
   if(bad&&number(row.spend)>0)notes.push({kind:'review',title:row.name,detail:`${enough?'复核投放效率':'样本不足，先观察'}：CPA ${row.cpa?.toFixed(2)??'缺失'}，ROAS ${row.roas?.toFixed(2)??'缺失'}。请结合近期窗口、毛利和当前投放状态判断。`,campaign:row.name});
   else if(good&&enough)notes.push({kind:'opportunity',title:row.name,detail:'历史指标达到你设置的目标，可列入近期复测候选。需要当前数据、素材趋势和统一归因后再决定扩量。',campaign:row.name});
 }
 return {summary:metrics(account.totals),campaigns:rows,notes,target};
}
export function validateRange(since,until){
 const valid=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
 if(!valid(since)||!valid(until)||since>until)throw Object.assign(new Error('日期范围无效'),{status:400});
 if((Date.parse(until)-Date.parse(since))/86400000>790)throw Object.assign(new Error('单次同步最多 790 天，请分段同步'),{status:400});
 return {since,until};
}

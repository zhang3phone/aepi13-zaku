import test from 'node:test';
import assert from 'node:assert/strict';
import {performanceRow,performanceRange,performanceIds,CreativePerformance} from '../lib/creative-performance.mjs';
test('ROAS uses website purchase value and spend, never fabricated on missing denominator',()=>{
 assert.equal(performanceRow({ad_id:'123456',spend:'4.84',inline_link_clicks:'18',purchases:'1',purchase_value:'229.98'}).roas,229.98/4.84);
 for(const spend of [null,'',0,'0'])assert.equal(performanceRow({ad_id:'123456',spend,purchase_value:'25'}).roas,null);
 const r=performanceRow({ad_id:'123456',spend:'10',actions:[{action_type:'purchase',value:'9'},{action_type:'offsite_conversion.fb_pixel_purchase',value:'2'}],action_values:[{action_type:'offsite_conversion.fb_pixel_purchase',value:'30'}]});assert.equal(r.purchases,2);assert.equal(r.roas,3);
 assert.equal(performanceRow({ad_id:'123456',spend:'10'}).purchases,null);
});
test('valid dates, bounded periods and exact ID lists are required',()=>{
 assert.deepEqual(performanceRange('2025-01-01','2025-01-31'),{since:'2025-01-01',until:'2025-01-31'});
 for(const dates of [['2025-02-30','2025-03-01'],['2025-04-01','2025-03-01'],['2025-01-01','2025-12-31']])assert.throws(()=>performanceRange(...dates));
 assert.deepEqual(performanceIds('654321,123456'),['123456','654321']);for(const ids of ['','123456,123456','bad,123456'])assert.throws(()=>performanceIds(ids));
});
const fixture=(data)=>{const calls=[];return {calls,async call(name,args){calls.push({name,args});if(name==='meta_get_account_details')return {currency:'USD',timezone_name:'America/Los_Angeles'};return data;}};};
test('a complete report joins only requested AD IDs and preserves absent rows as null',async()=>{
 const meta=fixture({data:[{ad_id:'123456',spend:'10',inline_link_clicks:'4',purchases:'0',purchase_value:'0'}],reporting_context:{pagination_exhausted:true}}),p=new CreativePerformance(meta),range={since:'2025-01-01',until:'2025-01-07'},ids=['123456','654321'];
 const r=await p.read('999999',range,ids);assert.equal(r.rows[0].roas,0);assert.equal(r.rows[1].status,'no_row');assert.equal(r.rows[1].spend,null);
 const query=meta.calls[1].args;assert.deepEqual(query.adIds,ids);assert.deepEqual(query.attributionWindows,['7d_click','1d_view']);assert.equal(query.actionReportTime,'impression');assert.equal(query.timeIncrement,'all_days');
 await p.read('999999',range,ids);assert.equal(meta.calls.length,2);await p.read('999999',range,ids,true);assert.equal(meta.calls.length,4);
});
test('incomplete, duplicate, or cross-ad data fails closed',async()=>{
 for(const data of [{data:[],reporting_context:{pagination_exhausted:false}},{data:[{ad_id:'654321'}],reporting_context:{pagination_exhausted:true}},{data:[{ad_id:'123456'},{ad_id:'123456'}],reporting_context:{pagination_exhausted:true}}])await assert.rejects(new CreativePerformance(fixture(data)).read('999999',{since:'2025-01-01',until:'2025-01-07'},['123456']));
});

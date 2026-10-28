import test from 'node:test';
import assert from 'node:assert/strict';
import {safeImage,creativeCard,CreativePreview} from '../lib/creative-preview.mjs';
test('only first party HTTPS images without credentials are permitted',()=>{
 for(const bad of ['http://scontent.fbcdn.net/a.jpg','https://fbcdn.net.evil.test/a','https://127.0.0.1/a','https://x:secret@fbcdn.net/a','https://fbcdn.net/a?access_token=secret','data:image/png;base64,AA'])assert.equal(safeImage(bad),null);
 assert.equal(safeImage('https://scontent.xx.fbcdn.net/a.jpg'),'https://scontent.xx.fbcdn.net/a.jpg');
});
test('one ad retains its own image, text and identity and marks missing previews',()=>{
 const a=creativeCard({id:'123456',name:'<script>',campaign_id:'987654',creative:{id:'345678',image_url:'https://scontent.fbcdn.net/red.jpg',body:'Brand',thumbnail_url:'https://evil.test/no.jpg',asset_feed_spec:{images:[{url:'https://scontent.fbcdn.net/red.jpg'},{url:'https://scontent.fbcdn.net/alt.jpg'}],bodies:[{text:'Brand'}]}}});
 assert.equal(a.images.length,2);assert.equal(a.campaignId,'987654');assert.deepEqual(a.texts,['Brand']);assert.equal(creativeCard({id:'654321'}).images.length,0);
});
test('read-only pages use continuation, cache and bind proxy URLs to account and ad',async()=>{
 const calls=[];const meta={async call(tool,args){calls.push({tool,args});if(args.edge==='adcreatives')return {data:[]};return args.after?{data:[{id:'456789',creative:{image_url:'https://scontent.fbcdn.net/b.jpg'}}]}:{data:[{id:'123456',creative:{image_url:'https://scontent.fbcdn.net/a.jpg'}}],paging:{next:'opaque',cursors:{after:'cursor1'}}};}};
 const p=new CreativePreview(meta),first=await p.page('999999');assert.equal(first.complete,false);assert.equal(first.after,'cursor1');
 assert.equal(p.publicPage(first).cards[0].images[0].url,'/api/creative-image?account=999999&ad=123456&index=0');assert.equal(p.findImage('888888','123456',0),null);
 await p.page('999999');assert.equal(calls.length,2);const last=await p.page('999999','cursor1');assert.equal(last.complete,true);assert.equal(calls[2].args.after,'cursor1');assert.equal(calls[0].tool,'meta_list_edge_raw');
});
test('broken pagination fails closed',async()=>{const p=new CreativePreview({call:async()=>({data:[],paging:{next:'present'}})});await assert.rejects(p.page('999999'),/分页游标/);});

test('plain Graph fields join creative by exact ID',async()=>{const p=new CreativePreview({call:async(_,a)=>{assert(a.fields.every(f=>!f.includes('{')));return a.edge==='ads'?{data:[{id:'123456',creative:{id:'444444'}},{id:'222222',creative:{id:'555555'}}]}:{data:[{id:'444444',image_url:'https://scontent.fbcdn.net/right.jpg',body:'Right'}]};}});const r=await p.page('999999');assert.equal(r.cards[0].texts[0],'Right');assert.equal(r.cards[1].images.length,0);});

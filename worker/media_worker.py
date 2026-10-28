"""Serial local Meta media downloader; scoped claims, leases and bounded storage."""
import os,pathlib,json,datetime,urllib.request,urllib.error,urllib.parse,subprocess,uuid,time,fcntl,tempfile
from common import *
def trusted(url):
 u=urllib.parse.urlparse(url);h=(u.hostname or '').lower()
 return u.scheme=='https' and not u.username and not u.password and 'access_token' not in urllib.parse.parse_qs(u.query) and any(h==d or h.endswith('.'+d) for d in ['fbcdn.net','fbsbx.com','facebook.com'])
class Redirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  if not trusted(newurl):raise RuntimeError('untrusted_media_redirect')
  return super().redirect_request(req,fp,code,msg,headers,newurl)
def graph(object_id,params):
 req=urllib.request.Request('https://graph.facebook.com/v26.0/'+object_id+'?'+urllib.parse.urlencode(params),headers={'Authorization':'Bearer '+os.environ['META_ACCESS_TOKEN']})
 try:
  with urllib.request.urlopen(req,timeout=45) as r:return json.load(r)
 except urllib.error.HTTPError as e:
  try:code=json.loads(e.read()).get('error',{}).get('code','unknown')
  except Exception:code='unknown'
  raise RuntimeError('meta_api_error_'+str(code)) from None
def download(url,temp):
 if not trusted(url):raise RuntimeError('untrusted_media_host')
 start=time.monotonic()
 with urllib.request.build_opener(Redirect()).open(urllib.request.Request(url,headers={'User-Agent':'AEPI13-Zaku-local/0.1.0-preview.1'}),timeout=60) as r,temp.open('xb') as f:
  declared=r.headers.get_content_type();size=0
  while chunk:=r.read(1024*1024):
   require_space();size+=len(chunk)
   if size>1024**3 or time.monotonic()-start>600:raise RuntimeError('media_download_limit')
   f.write(chunk)
  f.flush();os.fsync(f.fileno())
 if not size:raise RuntimeError('empty_media')
 actual=subprocess.check_output(['file','-b','--mime-type',str(temp)],text=True).strip()
 return size,declared,actual

def claim_guard(job):return 'id='+sql(job['id'])+" AND status='running' AND metadata->>'localClaimId'="+sql(job['metadata']['localClaimId'])+" AND (metadata->>'localLeaseUntil')::timestamptz>now()"
def process(job):
 kind=job['metadata'].get('mediaKind','image');ident=str(job['metadata'].get('hash' if kind=='image' else 'id',''));account=job['account_id']
 if kind not in ['image','video'] or not re.fullmatch('[A-Za-z0-9_-]+',ident) or not re.fullmatch('[0-9]+',account):raise RuntimeError('invalid_media_identity')
 folder=pathlib.Path(tempfile.mkdtemp(prefix='download-',dir=ROOT/'state'));temp=folder/'original';url=job['source_url']
 try:
  try:size,declared,mime=download(url,temp)
  except urllib.error.HTTPError as e:
   if temp.exists():temp.unlink()
   if e.code not in [400,401,403,404]:raise RuntimeError('media_http_'+str(e.code)) from None
   if kind=='video':url=graph(ident,{'fields':'source'}).get('source')
   else:
    images=graph('act_'+account+'/adimages',{'fields':'hash,url','hashes':json.dumps([ident])}).get('data',[]);url=next((x['url'] for x in images if x.get('hash')==ident),None)
   if not url:raise RuntimeError('media_source_unavailable')
   size,declared,mime=download(url,temp)
  if not mime.startswith(kind+'/') or declared not in ['application/octet-stream','binary/octet-stream'] and not declared.startswith(kind+'/'):raise RuntimeError('media_mime_mismatch')
  ext={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','video/mp4':'.mp4'}.get(mime)
  if not ext:raise RuntimeError('unsupported_media_mime')
  if kind=='video':
   if not any(s.get('codec_type')=='video' and s.get('width',0)>0 for s in probe(temp).get('streams',[])):raise RuntimeError('no_playable_video')
  if not query("UPDATE mw_media_jobs SET metadata=metadata||jsonb_build_object('localLeaseUntil',(now()+interval '30 minutes')::text) WHERE "+claim_guard(job)+' RETURNING id'):raise RuntimeError('claim_lost')
  digest=file_hash(temp);relative='originals/meta/'+account+'/local/'+digest[:2]+'/'+digest+ext;target=publish(temp,relative);poster=playback=None;preview_status='pending'
  try:poster,playback=derivatives(target,digest,mime);preview_status='ready'
  except Exception:preview_status='failed'
  payload={**job['metadata'],'runner':'server_local','mimeType':mime,'resolvedSourceUrl':url,'purpose':'original bytes preserved'}
  guard=claim_guard(job)
  query("BEGIN;SELECT id FROM mw_media_jobs WHERE "+guard+" FOR UPDATE;DO $guard$ BEGIN IF NOT EXISTS(SELECT 1 FROM mw_media_jobs WHERE "+guard+") THEN RAISE EXCEPTION 'claim_lost';END IF;END $guard$;INSERT INTO mw_assets(id,platform,account_id,dataset,nas_relative_path,source_url,captured_at,sha256,bytes,payload,storage_backend,local_relative_path,local_status,local_verified_at,mime_type,preview_relative_path,playback_relative_path,preview_status) VALUES("+','.join(sql(x) for x in [job['id'],'meta',account,'adimages' if kind=='image' else 'advideos','',job['source_url']])+",now(),"+sql(digest)+','+str(size)+','+sql(json.dumps(payload))+"::jsonb,'local',"+sql(relative)+",'verified',now(),"+sql(mime)+','+(sql(poster) if poster else 'NULL')+','+(sql(playback) if playback else 'NULL')+','+sql(preview_status)+") ON CONFLICT(id) DO UPDATE SET storage_backend=excluded.storage_backend,local_relative_path=excluded.local_relative_path,local_status=excluded.local_status,local_verified_at=excluded.local_verified_at,mime_type=excluded.mime_type,preview_relative_path=excluded.preview_relative_path,playback_relative_path=excluded.playback_relative_path,preview_status=excluded.preview_status WHERE mw_assets.sha256=excluded.sha256;DO $asset$ BEGIN IF NOT EXISTS(SELECT 1 FROM mw_assets WHERE id="+sql(job['id'])+" AND sha256="+sql(digest)+" AND local_status='verified' AND local_relative_path="+sql(relative)+") THEN RAISE EXCEPTION 'asset_conflict';END IF;END $asset$;UPDATE mw_media_jobs SET status='complete',bytes="+str(size)+",error=NULL,updated_at=now() WHERE "+guard+";COMMIT;")
  saved=rows('SELECT a.sha256,a.local_relative_path,j.status FROM mw_assets a JOIN mw_media_jobs j USING(id) WHERE a.id='+sql(job['id']))
  if not saved or saved[0]['status']!='complete' or saved[0]['sha256']!=digest or file_hash(safe_path(ROOT,saved[0]['local_relative_path']))!=digest:raise RuntimeError('database_file_readback_mismatch')
  log(event='media_completed',id=job['id'],bytes=size,sha256=digest,preview=preview_status)
 finally:
  if temp.exists():temp.unlink()
  if folder.exists():folder.rmdir()
def worker_state(status,reason=None):
 space=shutil.disk_usage(ROOT)
 query("INSERT INTO mw_storage_state(id,payload) VALUES('media_worker',"+sql(json.dumps({'status':status,'reason':reason,'freeBytes':space.free,'totalBytes':space.total,'stopBelowBytes':max(30*1024**3,space.total//5),'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}))+"::jsonb) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=now();")
def main():
 (ROOT/'state').mkdir(exist_ok=True);lock=(ROOT/'state'/'media-worker.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 query("UPDATE mw_media_jobs SET status='pending',error='local:expired_lease',updated_at=now() WHERE platform='meta' AND status='running' AND metadata ? 'localClaimId' AND (metadata->>'localLeaseUntil')::timestamptz<now();")
 while True:
  try:
   query("UPDATE mw_media_jobs SET status='pending',error='local:expired_lease',updated_at=now() WHERE platform='meta' AND status='running' AND metadata ? 'localClaimId' AND (metadata->>'localLeaseUntil')::timestamptz<now();");require_space();claim=uuid.uuid4().hex;jobs=json.loads(query("WITH picked AS (SELECT id FROM mw_media_jobs WHERE platform='meta' AND status='pending' ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1),changed AS (UPDATE mw_media_jobs j SET status='running',metadata=metadata||jsonb_build_object('localClaimId',"+sql(claim)+",'localLeaseUntil',(now()+interval '30 minutes')::text),updated_at=now() FROM picked p WHERE j.id=p.id RETURNING j.*) SELECT COALESCE(json_agg(changed),'[]') FROM changed"))
   if not jobs:
    worker_state('idle')
    if '--once' in sys.argv:return
    time.sleep(60);continue
   worker_state('downloading');job=jobs[0]
   try:process(job)
   except Exception as e:
    reason=str(e) if isinstance(e,RuntimeError) and re.fullmatch('[a-z0-9_]+',str(e)) else type(e).__name__;status='pending' if reason in ['disk_space_guard','meta_api_error_4','meta_api_error_17','meta_api_error_32','meta_api_error_613','meta_api_error_190'] else 'failed';query('UPDATE mw_media_jobs SET status='+sql(status)+',error='+sql('local:'+reason)+',updated_at=now() WHERE '+claim_guard(job));log(event='media_not_completed',id=job['id'],reason=reason);worker_state('waiting' if status=='pending' else 'job_failed',reason)
    if reason.startswith('meta_api_error_') or reason=='disk_space_guard':time.sleep(300)
   if '--once' in sys.argv:return
  except Exception as e:
   try:worker_state('waiting',str(e) if isinstance(e,RuntimeError) and re.fullmatch('[a-z0-9_]+',str(e)) else type(e).__name__)
   except Exception:pass
   log(event='worker_wait',reason=str(e) if isinstance(e,RuntimeError) and re.fullmatch('[a-z0-9_]+',str(e)) else type(e).__name__)
  time.sleep(5)
if __name__=='__main__':
 import sys
 main()

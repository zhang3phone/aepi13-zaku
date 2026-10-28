"""Server-side learning mirror and verified nightly PostgreSQL/media backups."""
import sys,time,fcntl,uuid,datetime,subprocess,urllib.parse,pathlib,os,json,hashlib
from zoneinfo import ZoneInfo
from common import *
import backup_bundle
STATE=pathlib.Path(os.environ.get('BACKUP_STATE','/state'));VERIFIED_OBJECTS={};VERIFIED_PACKAGES=set()
def state(status,reason=None):query("INSERT INTO mw_storage_state(id,payload) VALUES('backup_worker',"+sql(json.dumps({'status':status,'reason':reason,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}))+"::jsonb) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=now();")
def object_backup(path,digest):
 if digest in VERIFIED_OBJECTS:return VERIFIED_OBJECTS[digest]
 check_nas()
 existing=rows('SELECT nas_relative_path FROM mw_local_backup_objects WHERE sha256='+sql(digest))
 if existing:
  try:
   reference=existing[0]['nas_relative_path'];package=backup_bundle.parse_ref(reference)
   if package:
    rel,member=package
    if member!=digest:raise RuntimeError('bundle_identity_mismatch')
    if rel not in VERIFIED_PACKAGES:
     meta=rows('SELECT sha256,bytes FROM mw_local_backup_packages WHERE nas_relative_path='+sql(rel))
     target=safe_path(NAS,rel)
     if not meta or target.stat().st_size!=int(meta[0]['bytes']) or file_hash(target)!=meta[0]['sha256']:raise RuntimeError('backup_package_hash_mismatch')
     VERIFIED_PACKAGES.add(rel)
    VERIFIED_OBJECTS[digest]=reference;return reference
   target=safe_path(NAS,reference)
   if file_hash(target)==digest:VERIFIED_OBJECTS[digest]=existing[0]['nas_relative_path'];return existing[0]['nas_relative_path']
  except OSError:pass
 rel='AEPI13-Zaku/objects/'+digest[:2]+'/'+digest+'/'+uuid.uuid4().hex+'/original';dest=safe_path(NAS,rel);dest.parent.mkdir(parents=True,exist_ok=False)
 h=hashlib.sha256()
 with pathlib.Path(path).open('rb') as src,dest.open('xb') as out:
  while chunk:=src.read(1024*1024):out.write(chunk);h.update(chunk)
  out.flush();os.fsync(out.fileno())
 check_nas()
 if h.hexdigest()!=digest or file_hash(dest)!=digest:raise RuntimeError('backup_object_readback_failed')
 query('INSERT INTO mw_local_backup_objects(sha256,nas_relative_path,bytes) VALUES('+sql(digest)+','+sql(rel)+','+str(dest.stat().st_size)+') ON CONFLICT(sha256) DO UPDATE SET nas_relative_path=excluded.nas_relative_path,bytes=excluded.bytes,verified_at=now();')
 saved=rows('SELECT nas_relative_path FROM mw_local_backup_objects WHERE sha256='+sql(digest))[0]
 if saved['nas_relative_path']!=rel:raise RuntimeError('backup_index_readback_failed')
 VERIFIED_OBJECTS[digest]=rel;return rel

def mirror_learning():
 VERIFIED_OBJECTS.clear();VERIFIED_PACKAGES.clear();check_nas();pending=rows('SELECT r.payload FROM mw_learning_records r LEFT JOIN mw_learning_nas n USING(hash) WHERE n.hash IS NULL ORDER BY r.created_at LIMIT 100')
 for row in pending:
  r=row['payload'];asset=r['content'].get('assetSha')
  if asset:
   matches=rows("SELECT local_relative_path,sha256 FROM mw_assets WHERE account_id="+sql(r['accountId'])+' AND sha256='+sql(asset)+" AND local_status='verified' LIMIT 1")
   if not matches:raise RuntimeError('learning_image_not_local')
   a=matches[0];object_backup(safe_path(ROOT,a['local_relative_path']),a['sha256'])
  data=(json.dumps(r,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode();rel='AEPI13-Zaku/learning/'+r['accountId']+'/'+r['adId']+'/'+r['recordDate']+'-'+r['hash']+'-'+uuid.uuid4().hex+'.json';digest=nas_write(rel,data)
  if json.loads(safe_path(NAS,rel).read_bytes())!=r:raise RuntimeError('learning_semantic_readback_failed')
  query('INSERT INTO mw_learning_nas(hash,relative_path) VALUES('+sql(r['hash'])+','+sql(rel)+') ON CONFLICT(hash) DO NOTHING;')
  if not rows('SELECT hash FROM mw_learning_nas WHERE hash='+sql(r['hash'])):raise RuntimeError('learning_receipt_readback_failed')
  log(event='learning_nas_verified',recordHash=r['hash'],sha256=digest)

def full_backup(reason='scheduled'):
 VERIFIED_OBJECTS.clear();VERIFIED_PACKAGES.clear();check_nas()
 database_bytes=int(rows('SELECT pg_database_size(current_database()) AS bytes')[0]['bytes'])
 if shutil.disk_usage(STATE).free<max(512*1024**2,database_bytes*2):raise RuntimeError('backup_staging_space_guard')
 ident=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:12];local=STATE/ident;local.mkdir(exist_ok=False);dump=local/'database.dump';payload={'reason':reason,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'timezone':'America/Los_Angeles'}
 query('INSERT INTO mw_local_backups(id,status,payload) VALUES('+sql(ident)+",'running',"+sql(json.dumps(payload))+'::jsonb)')
 try:
  u=urllib.parse.urlparse(os.environ['DATABASE_URL']);env={**os.environ,'PGHOST':u.hostname,'PGPORT':str(u.port or 5432),'PGUSER':urllib.parse.unquote(u.username),'PGPASSWORD':urllib.parse.unquote(u.password or ''),'PGDATABASE':u.path[1:],'PGCONNECT_TIMEOUT':'10'}
  with dump.open('xb') as f:r=subprocess.run(['pg_dump','-Fc','--no-owner','--no-privileges'],env=env,stdout=f,stderr=subprocess.PIPE,timeout=900)
  if r.returncode or not dump.stat().st_size:raise RuntimeError('backup_dump_failed')
  if subprocess.run(['pg_restore','--list',str(dump)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:raise RuntimeError('backup_dump_structure_invalid')
  # Bundle only hashes not already archived. Original media files are never changed.
  paths=[]
  for a in rows("SELECT local_relative_path,preview_relative_path,playback_relative_path FROM mw_assets WHERE local_status='verified'"):
   for field in ['local_relative_path','preview_relative_path','playback_relative_path']:
    if a.get(field):paths.append(safe_path(ROOT,a[field]))
  for folder,dirs,names in os.walk(ROOT/'originals',followlinks=False):
   for name in names:
    source=pathlib.Path(folder)/name
    if not source.is_symlink():paths.append(source)
  prepared_package=backup_bundle.prepare(local,paths)
  if prepared_package:
   VERIFIED_PACKAGES.add(prepared_package)
   for item in rows('SELECT sha256,nas_relative_path FROM mw_local_backup_objects WHERE nas_relative_path LIKE '+sql('bundle://'+prepared_package+'#%')):VERIFIED_OBJECTS[item['sha256']]=item['nas_relative_path']
  copied=object_backup(dump,file_hash(dump));files=[]
  for row in rows("SELECT id,account_id,local_relative_path,sha256,bytes,mime_type,preview_relative_path,playback_relative_path FROM mw_assets WHERE local_status='verified' ORDER BY id"):
   file=safe_path(ROOT,row['local_relative_path'])
   if file_hash(file)!=row['sha256'] or file.stat().st_size!=int(row['bytes']):raise RuntimeError('backup_primary_asset_mismatch')
   derived=[]
   for field in ['preview_relative_path','playback_relative_path']:
    if row.get(field):
     source=safe_path(ROOT,row[field]);h=file_hash(source);derived.append({'relativePath':row[field],'sha256':h,'bytes':source.stat().st_size,'nasRelativePath':object_backup(source,h)})
   files.append({**row,'nasRelativePath':object_backup(file,row['sha256']),'derivedFiles':derived})
  # Preserve also unindexed imported evidence and original manifests, not only media.
  inventory=[]
  for folder,dirs,names in os.walk(ROOT/'originals',followlinks=False):
   for name in names:
    source=pathlib.Path(folder)/name
    if source.is_symlink():continue
    h=file_hash(source);inventory.append({'relativePath':str(source.relative_to(ROOT)),'sha256':h,'bytes':source.stat().st_size,'nasRelativePath':object_backup(source,h)})
  manifest={'manifestVersion':2,'packages':rows('SELECT nas_relative_path,sha256,bytes FROM mw_local_backup_packages ORDER BY nas_relative_path'),'systemId':'AEPI13-Zaku','backupId':ident,'database':{'nasRelativePath':copied,'sha256':file_hash(dump),'bytes':dump.stat().st_size},'assets':files,'originalFiles':inventory,'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
  rel='AEPI13-Zaku/backups/'+ident+'/manifest.json';manifest_hash=nas_write(rel,(json.dumps(manifest,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode())
  if json.loads(safe_path(NAS,rel).read_bytes())!=manifest:raise RuntimeError('backup_manifest_readback_failed')
  payload={**payload,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'manifest':rel,'manifestSha256':manifest_hash,'assetCount':len(files),'originalFileCount':len(inventory),'databaseSha256':manifest['database']['sha256'],'databaseBytes':dump.stat().st_size,'restoreVerified':False}
  query("UPDATE mw_local_backups SET status='verified',payload="+sql(json.dumps(payload))+"::jsonb WHERE id="+sql(ident))
  if rows('SELECT status FROM mw_local_backups WHERE id='+sql(ident))[0]['status']!='verified':raise RuntimeError('backup_receipt_readback_failed')
  log(event='full_backup_verified',id=ident,assets=len(files),files=len(inventory));return ident
 except Exception as e:
  payload['error']=str(e) if isinstance(e,RuntimeError) and re.fullmatch('[a-z0-9_]+',str(e)) else type(e).__name__;query("UPDATE mw_local_backups SET status='failed',payload="+sql(json.dumps(payload))+"::jsonb WHERE id="+sql(ident));raise

def main():
 STATE.mkdir(exist_ok=True);lock=(STATE/'backup-worker.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 while True:
  try:
   mirror_error=None
   try:mirror_learning()
   except Exception as e:mirror_error=type(e).__name__;log(event='learning_mirror_wait',reason=mirror_error)
   now=datetime.datetime.now(ZoneInfo('America/Los_Angeles'));today=now.date().isoformat();previous=rows("SELECT payload FROM mw_storage_state WHERE id='scheduled_backup_day'")
   if '--full' in sys.argv or now.hour>=3 and (not previous or previous[0]['payload'].get('date')!=today):
    full_backup('manual' if '--full' in sys.argv else 'scheduled')
    if '--full' not in sys.argv:query("INSERT INTO mw_storage_state(id,payload) VALUES('scheduled_backup_day',"+sql(json.dumps({'date':today}))+"::jsonb) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=now();")
   state('learning_mirror_pending' if mirror_error else 'healthy',mirror_error)
   if '--watch' not in sys.argv:return
  except Exception as e:
   reason=str(e) if isinstance(e,RuntimeError) and re.fullmatch('[a-z0-9_]+',str(e)) else type(e).__name__;log(event='backup_wait',reason=reason)
   try:state('failed',reason)
   except Exception:pass
   if '--watch' not in sys.argv:sys.exit(1)
  time.sleep(60)
if __name__=='__main__':main()

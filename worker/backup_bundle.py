"""Incremental immutable NAS bundles for small files; media primary is unchanged."""
import tarfile,hashlib,pathlib,json,os,uuid,shutil,re
from common import *
PREFIX='bundle://'
def parse_ref(ref):
 if not isinstance(ref,str) or not ref.startswith(PREFIX):return None
 parts=ref[len(PREFIX):].split('#')
 if len(parts)!=2 or not re.fullmatch('[a-f0-9]{64}',parts[1]):raise RuntimeError('invalid_bundle_reference')
 safe_path(NAS,parts[0]);return parts

def verify_members(path,expected):
 seen=set()
 with tarfile.open(path,'r:') as archive:
  for member in archive:
   if not member.isfile() or member.name not in expected or member.name in seen:raise RuntimeError('bundle_member_invalid')
   size=expected[member.name];stream=archive.extractfile(member);h=hashlib.sha256();count=0
   while chunk:=stream.read(1024*1024):h.update(chunk);count+=len(chunk)
   if member.size!=size or count!=size or h.hexdigest()!=member.name:raise RuntimeError('bundle_member_hash_mismatch')
   seen.add(member.name)
 if seen!=set(expected):raise RuntimeError('bundle_members_missing')

def prepare(local_dir,paths):
 query('CREATE TABLE IF NOT EXISTS mw_local_backup_packages(nas_relative_path text PRIMARY KEY,sha256 text NOT NULL,bytes bigint NOT NULL,verified_at timestamptz NOT NULL DEFAULT now());')
 existing={r['sha256'] for r in rows('SELECT sha256 FROM mw_local_backup_objects')};new={}
 for path in paths:
  path=pathlib.Path(path);digest=file_hash(path)
  if digest not in existing:new.setdefault(digest,path)
 if not new:return
 required=sum(p.stat().st_size for p in new.values())+512*1024**2
 if shutil.disk_usage(local_dir).free<required:raise RuntimeError('backup_bundle_staging_space_guard')
 bundle=pathlib.Path(local_dir)/'new-files.tar';expected={}
 with tarfile.open(bundle,'x:') as archive:
  for digest,path in sorted(new.items()):
   size=path.stat().st_size;info=tarfile.TarInfo(digest);info.size=size;info.mode=0o440;info.mtime=0
   with path.open('rb') as source:archive.addfile(info,source)
   expected[digest]=size
 with bundle.open('rb') as f:os.fsync(f.fileno())
 verify_members(bundle,expected);digest=file_hash(bundle)
 rel='AEPI13-Zaku/backups/'+pathlib.Path(local_dir).name+'/new-files-'+uuid.uuid4().hex+'.tar';check_nas();dest=safe_path(NAS,rel);dest.parent.mkdir(parents=True,exist_ok=True)
 with bundle.open('rb') as source,dest.open('xb') as out:
  while chunk:=source.read(1024*1024):out.write(chunk)
  out.flush();os.fsync(out.fileno())
 check_nas()
 if dest.stat().st_size!=bundle.stat().st_size or file_hash(dest)!=digest:raise RuntimeError('bundle_nas_readback_failed')
 statements=['BEGIN','INSERT INTO mw_local_backup_packages(nas_relative_path,sha256,bytes) VALUES('+sql(rel)+','+sql(digest)+','+str(bundle.stat().st_size)+')']
 for member,size in expected.items():statements.append('INSERT INTO mw_local_backup_objects(sha256,nas_relative_path,bytes) VALUES('+sql(member)+','+sql(PREFIX+rel+'#'+member)+','+str(size)+') ON CONFLICT(sha256) DO NOTHING')
 statements.append('COMMIT');query(';'.join(statements)+';')
 saved=rows('SELECT count(*) AS count FROM mw_local_backup_objects WHERE nas_relative_path LIKE '+sql(PREFIX+rel+'#%'))[0]['count']
 if int(saved)!=len(expected):raise RuntimeError('bundle_index_readback_failed')
 log(event='incremental_bundle_verified',files=len(expected),bytes=bundle.stat().st_size,sha256=digest)
 return rel

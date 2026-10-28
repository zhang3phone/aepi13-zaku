import pathlib,os,subprocess,urllib.parse,json,hashlib,uuid,re,shutil,datetime
ROOT=pathlib.Path(os.environ.get('MEDIA_ROOT','/data'));NAS=pathlib.Path(os.environ.get('NAS_ROOT','/nas'))
def sql(v):return "'"+str(v).replace("'","''")+"'"
def query(q):
 u=urllib.parse.urlparse(os.environ['DATABASE_URL']);env={**os.environ,'PGHOST':u.hostname,'PGPORT':str(u.port or 5432),'PGUSER':urllib.parse.unquote(u.username),'PGPASSWORD':urllib.parse.unquote(u.password or ''),'PGDATABASE':u.path[1:],'PGCONNECT_TIMEOUT':'10','PGOPTIONS':'-c statement_timeout=120000 -c lock_timeout=10000 -c timezone=UTC -c standard_conforming_strings=on'}
 r=subprocess.run(['psql','-X','-q','-At','-v','ON_ERROR_STOP=1'],input=q,env=env,capture_output=True,text=True,timeout=150)
 if r.returncode:raise RuntimeError('database_operation_failed')
 return r.stdout.strip()
def rows(q):return json.loads(query("SELECT COALESCE(json_agg(x),'[]') FROM ("+q.rstrip(';')+") x;"))
def file_hash(p):
 h=hashlib.sha256()
 with pathlib.Path(p).open('rb') as f:
  while b:=f.read(1024*1024):h.update(b)
 return h.hexdigest()
def safe_path(root,rel):
 if not isinstance(rel,str) or not rel or '\\' in rel or pathlib.PurePosixPath(rel).is_absolute() or '..' in pathlib.PurePosixPath(rel).parts:raise RuntimeError('invalid_local_path')
 p=(root/rel).resolve()
 if not p.is_relative_to(root.resolve()):raise RuntimeError('invalid_local_path')
 return p

def require_space(root=ROOT):
 s=shutil.disk_usage(root)
 if s.free<max(30*1024**3,s.total//5):raise RuntimeError('disk_space_guard')

def publish(source,relative):
 dest=safe_path(ROOT,relative);dest.parent.mkdir(parents=True,exist_ok=True);h=file_hash(source)
 if dest.exists():
  if file_hash(dest)!=h:raise RuntimeError('immutable_collision')
  return dest
 # Both locations are on the local primary filesystem. link is no-replace.
 os.chmod(source,0o640)
 try:os.link(source,dest)
 except FileExistsError:
  if file_hash(dest)!=h:raise RuntimeError('immutable_collision')
 if file_hash(dest)!=h:raise RuntimeError('local_readback_mismatch')
 return dest

def probe(path):
 r=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',str(path)],capture_output=True,text=True,timeout=60)
 if r.returncode:raise RuntimeError('ffprobe_failed')
 return json.loads(r.stdout)

def derivatives(path,digest,mime):
 folder=ROOT/'previews'/digest;folder.mkdir(parents=True,exist_ok=True);out=folder/'poster.jpg';stage=folder/('stage-'+uuid.uuid4().hex+'.jpg')
 if not out.exists():
  r=subprocess.run(['ffmpeg','-nostdin','-v','error','-i',str(path),'-vf','scale=640:640:force_original_aspect_ratio=decrease','-frames:v','1','-q:v','3',str(stage)],capture_output=True,timeout=120)
  if r.returncode or not stage.is_file() or not stage.stat().st_size:raise RuntimeError('poster_generation_failed')
  publish(stage,str(out.relative_to(ROOT)));stage.unlink()
 playback=None
 if mime.startswith('video/'):
  streams=probe(path).get('streams',[]);needs=any(s.get('codec_type')=='video' and s.get('codec_name')!='h264' or s.get('codec_type')=='audio' and s.get('codec_name') not in ['aac','mp3'] for s in streams)
  if needs:
   playable=folder/'playable.mp4'
   if not playable.exists():
    temp=folder/('stage-'+uuid.uuid4().hex+'.mp4');r=subprocess.run(['ffmpeg','-nostdin','-v','error','-i',str(path),'-c:v','libx264','-preset','fast','-crf','22','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',str(temp)],capture_output=True,timeout=600)
    if r.returncode:raise RuntimeError('playback_conversion_failed')
    probe(temp);publish(temp,str(playable.relative_to(ROOT)));temp.unlink()
   playback=str(playable.relative_to(ROOT))
 return str(out.relative_to(ROOT)),playback

def check_nas():
 if not NAS.is_dir() or not any(' - cifs ' in line and line.split()[4]==str(NAS) for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines()):raise RuntimeError('nas_not_mounted')
 sentinel=os.environ.get('NAS_SENTINEL');expected=os.environ.get('NAS_SENTINEL_SHA')
 if not sentinel or not expected or file_hash(safe_path(NAS,sentinel))!=expected:raise RuntimeError('nas_sentinel_failed')

def nas_write(relative,data):
 check_nas();dest=safe_path(NAS,relative);dest.parent.mkdir(parents=True,exist_ok=True)
 with dest.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
 check_nas();digest=hashlib.sha256(data).hexdigest()
 if file_hash(dest)!=digest:raise RuntimeError('nas_readback_mismatch')
 return digest

def log(**fields):print(json.dumps(fields,ensure_ascii=False),flush=True)

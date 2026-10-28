import fs from 'node:fs/promises';import crypto from 'node:crypto';
const file='.env.local';try{await fs.access(file);throw Error('Configuration already exists; refusing to overwrite.');}catch(e){if(e.code!=='ENOENT')throw e;}
const password=crypto.randomBytes(18).toString('base64url'),salt=crypto.randomBytes(16).toString('hex'),hash=crypto.scryptSync(password,salt,64).toString('hex'),db=crypto.randomBytes(24).toString('hex');
const env=`DEMO_MODE=true
HOST=0.0.0.0
PORT=8098
DATABASE_URL=postgresql://aepi13_zaku_app:${db}@db:5432/meta_ads_workbench
POSTGRES_PASSWORD=${db}
WORKBENCH_PASSWORD_HASH=${salt}:${hash}
SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}
WORKBENCH_ENABLE_WRITES=false
META_ENABLE_WRITES=0
WORKBENCH_ARCHIVE_WORKER=false
MEDIA_ROOT=/data
REVIEW_DB_HOST=db
REPORT_TIMEZONE=America/Los_Angeles
`;
await fs.writeFile(file,env,{flag:'wx',mode:0o600});await fs.writeFile('.local-login.txt',`Username: admin
Password: ${password}
Local-only generated credentials. Do not upload.
`,{flag:'wx',mode:0o600});console.log('Created .env.local and .local-login.txt (private, ignored). Open .local-login.txt locally to sign in.');

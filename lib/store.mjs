import pg from 'pg';
export class Store {
 constructor(url){this.pool=url?new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:6000}):null;this.memory={snapshots:[],settings:{},audit:[],plans:[]};}
 async init(seed){
  if(!this.pool){if(process.env.ALLOW_MEMORY_STORE!=='true')throw new Error('DATABASE_URL is required');this.memory.snapshots=[seed];return;}
  await this.pool.query(`CREATE TABLE IF NOT EXISTS mw_snapshots(id text PRIMARY KEY,captured_at timestamptz NOT NULL,payload jsonb NOT NULL); CREATE TABLE IF NOT EXISTS mw_settings(id text PRIMARY KEY,payload jsonb NOT NULL); CREATE TABLE IF NOT EXISTS mw_audit(id bigserial PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),event text NOT NULL,payload jsonb NOT NULL); CREATE TABLE IF NOT EXISTS mw_plans(id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),status text NOT NULL,payload jsonb NOT NULL);`);
  await this.pool.query('INSERT INTO mw_snapshots VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[seed.id,seed.capturedAt,seed]);
 }
 async snapshots(){if(!this.pool)return this.memory.snapshots;return (await this.pool.query('SELECT payload FROM mw_snapshots ORDER BY captured_at DESC LIMIT 100')).rows.map(r=>r.payload);}
 async snapshot(id){return (await this.snapshots()).find(s=>s.id===id);}
 async saveSnapshot(s){if(!this.pool){this.memory.snapshots.unshift(s);return;}await this.pool.query('INSERT INTO mw_snapshots VALUES($1,$2,$3)',[s.id,s.capturedAt,s]);}
 async settings(){if(!this.pool)return this.memory.settings;return (await this.pool.query('SELECT id,payload FROM mw_settings')).rows.reduce((a,r)=>({...a,[r.id]:r.payload}),{});}
 async set(key,value){if(!this.pool){this.memory.settings[key]=value;return;}await this.pool.query('INSERT INTO mw_settings VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=$2',[key,value]);}
 async audit(event,payload={}){if(!this.pool){this.memory.audit.unshift({event,payload,created_at:new Date().toISOString()});return;}await this.pool.query('INSERT INTO mw_audit(event,payload) VALUES($1,$2)',[event,payload]);}
 async audits(){if(!this.pool)return this.memory.audit.slice(0,100);return (await this.pool.query('SELECT event,payload,created_at FROM mw_audit ORDER BY id DESC LIMIT 100')).rows;}
 async plan(p){if(!this.pool){this.memory.plans.unshift(p);return;}await this.pool.query('INSERT INTO mw_plans(id,status,payload) VALUES($1,$2,$3)',[p.id,p.status,p]);}
 async plans(){if(!this.pool)return this.memory.plans;return (await this.pool.query('SELECT payload,status FROM mw_plans ORDER BY created_at DESC LIMIT 100')).rows.map(r=>({...r.payload,status:r.status}));}
 async claim(id){if(!this.pool){let p=this.memory.plans.find(p=>p.id===id&&p.status==='preview');if(p)p.status='executing';return p;}return (await this.pool.query("UPDATE mw_plans SET status='executing' WHERE id=$1 AND status='preview' RETURNING payload",[id])).rows[0]?.payload;}
 async finish(id,status){if(!this.pool){let p=this.memory.plans.find(p=>p.id===id);if(p)p.status=status;return;}await this.pool.query('UPDATE mw_plans SET status=$2 WHERE id=$1',[id,status]);}
}

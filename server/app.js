import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { todayKST, isDate, calculateStats } from '../shared/dates.js';
const scrypt = promisify(scryptCallback);
const sha = s => createHash('sha256').update(s).digest('hex');
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const publicUser = u => { const { password_hash, google_sub, ...rest } = u; return rest; };
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').filter(s => s.includes('=')).map(s => {const i=s.indexOf('='); return [s.slice(0,i).trim(), s.slice(i+1)];}));
export async function hashPassword(password) { const salt = randomBytes(16).toString('hex'); return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`; }
async function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  const value = await scrypt(password, salt || 'nonexistent-user-salt', 64);
  return !!hash && timingSafeEqual(value, Buffer.from(hash, 'hex'));
}
const credentials = z.object({ email: z.email().max(254).transform(v => v.toLowerCase()), password: z.string().min(10).max(128) });
const entrySchema = z.object({
  entry_date: z.string().refine(isDate, '올바른 날짜를 선택해 주세요.').refine(d => d <= todayKST() && d >= '2000-01-01', '미래 날짜는 기록할 수 없습니다.'),
  character_count: z.number().int().min(1).max(1000000),
  memo: z.string().max(2000).default(''),
  link: z.string().max(2048).refine(s => { if (!s) return true; try { return ['https:', 'http:'].includes(new URL(s).protocol); } catch { return false; } }, 'http 또는 https 링크를 입력해 주세요.').default('')
});
export function createApp(db, options = {}) {
  const app = express();
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const origin = options.origin || process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  if (production && !origin.startsWith('https://')) throw new Error('Production requires HTTPS APP_ORIGIN');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: production ? { directives: { 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'], 'connect-src': ["'self'"], 'font-src': ["'self'"], 'upgrade-insecure-requests': [] } } : false, strictTransportSecurity: production ? undefined : false }));
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', rateLimit({ windowMs: 60000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '요청이 많습니다. 잠시 후 다시 시도해 주세요.' } }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && (req.headers.origin !== origin || !req.is('application/json'))) return res.status(403).json({error:'허용되지 않은 요청입니다.'});
    next();
  });
  function issueSession(res, id) {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), id, Date.now() + 7*86400000);
    res.cookie('writeon_session', token, { httpOnly: true, secure: production, sameSite: 'lax', maxAge: 7*86400000, path: '/' });
  }
  function auth(req, res, next) {
    const token = cookies(req).writeon_session;
    const user = token && db.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').get(sha(token), Date.now());
    if (!user) return res.status(401).json({error:'로그인이 필요합니다.'});
    req.user = user; next();
  }
  function admin(req, res, next) { if (req.user.role !== 'admin') return res.status(403).json({error:'관리자만 접근할 수 있습니다.'}); next(); }
  const settings = () => db.prepare('SELECT * FROM site_settings WHERE id=1').get();
  const entries = id => db.prepare('SELECT * FROM writing_entries WHERE user_id=? ORDER BY entry_date DESC').all(id);
  const streams = new Set();
  app.locals.closeStreams = () => { for (const client of streams) client.res.end(); };
  const publish = (userId = null) => {
    for (const client of streams) if (!userId || client.userId === userId) client.res.write('event: changed\ndata: {}\n\n');
  };
  app.get('/api/events', auth, (req, res) => {
    res.set({'Content-Type':'text/event-stream', 'Connection':'keep-alive', 'X-Accel-Buffering':'no'});
    res.flushHeaders(); res.write(': connected\n\n');
    const client={userId:req.user.id,res}; streams.add(client);
    const tokenHash=sha(cookies(req).writeon_session);
    const heartbeat=setInterval(()=>{
      if(!db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash,Date.now())) return res.end();
      res.write(': heartbeat\n\n');
    },25000);
    req.on('close',()=>{clearInterval(heartbeat);streams.delete(client);});
  });
  const audit = (actor, action, target, detail='') => db.prepare('INSERT INTO audit_log(actor_id,action,target_id,detail) VALUES(?,?,?,?)').run(actor, action, target, detail);
  const authLimit = rateLimit({ windowMs: 15*60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: {error:'로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.'} });
  app.get('/api/config', (req,res) => res.json({settings:settings(), backend:'sqlite', googleEnabled:!!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), timezone:'Asia/Seoul'}));
  app.get('/api/health', (req,res) => { db.prepare('SELECT 1').get(); res.json({ok:true}); });
  app.post('/api/auth/register', authLimit, async (req,res) => {
    const data = credentials.extend({name:z.string().trim().min(1).max(40)}).parse(req.body);
    // Never accept role or identity from the client. The first admin is provisioned offline.
    const id = randomUUID(), hash = await hashPassword(data.password);
    try { db.prepare('INSERT INTO users(id,email,name,password_hash,challenge_start) VALUES(?,?,?,?,?)').run(id,data.email,data.name,hash,todayKST()); }
    catch(e) { if (e.code?.startsWith('ERR_SQLITE') && db.prepare('SELECT id FROM users WHERE email=?').get(data.email)) return res.status(409).json({error:'가입할 수 없는 이메일입니다. 로그인을 시도해 주세요.'}); throw e; }
    issueSession(res,id); res.status(201).json({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id))});
  });
  app.post('/api/auth/login', authLimit, async (req,res) => {
    const data = credentials.parse(req.body);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(data.email);
    if (!await verifyPassword(data.password,user?.password_hash)) return res.status(401).json({error:'이메일 또는 비밀번호를 확인해 주세요.'});
    issueSession(res,user.id); res.json({user:publicUser(user)});
  });
  app.post('/api/auth/logout', (req,res) => {
    const token = cookies(req).writeon_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
    res.clearCookie('writeon_session',{path:'/',secure:production,httpOnly:true,sameSite:'lax'}); res.json({ok:true});
  });
  // Google Authorization Code + PKCE + nonce. Same-email accounts are deliberately NOT auto-linked.
  app.get('/api/auth/google', authLimit, (req,res) => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(503).json({error:'Google 로그인 설정이 필요합니다.'});
    const state=randomBytes(32).toString('base64url'), verifier=randomBytes(32).toString('base64url'), nonce=randomBytes(32).toString('base64url');
    res.cookie('writeon_oauth',`${state}.${verifier}.${nonce}`,{httpOnly:true,secure:production,sameSite:'lax',maxAge:600000,path:'/api/auth/google/callback'});
    const params=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:`${origin}/api/auth/google/callback`,response_type:'code',scope:'openid email profile',state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });
  app.get('/api/auth/google/callback', authLimit, async (req,res) => {
    const [state,verifier,nonce]=(cookies(req).writeon_oauth || '').split('.');
    res.clearCookie('writeon_oauth',{path:'/api/auth/google/callback'});
    if (!state || state!==req.query.state || typeof req.query.code!=='string') return res.redirect('/?authError=google');
    try {
      const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:req.query.code,client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,redirect_uri:`${origin}/api/auth/google/callback`,grant_type:'authorization_code',code_verifier:verifier})});
      if (!response.ok) throw new Error('OAuth exchange failed');
      const token=await response.json();
      const {payload}=await jwtVerify(token.id_token,googleKeys,{issuer:['https://accounts.google.com','accounts.google.com'],audience:process.env.GOOGLE_CLIENT_ID});
      if(payload.nonce!==nonce || payload.email_verified!==true || typeof payload.email!=='string' || !payload.sub) throw new Error('Invalid Google identity');
      let user=db.prepare('SELECT * FROM users WHERE google_sub=?').get(payload.sub);
      if(!user) {
        if(db.prepare('SELECT id FROM users WHERE email=?').get(payload.email)) return res.redirect('/?authError=existing');
        const id=randomUUID(); db.prepare('INSERT INTO users(id,email,name,google_sub,challenge_start) VALUES(?,?,?,?,?)').run(id,payload.email.toLowerCase(),String(payload.name || payload.email.split('@')[0]).slice(0,40),payload.sub,todayKST());
        user=db.prepare('SELECT * FROM users WHERE id=?').get(id);
      }
      issueSession(res,user.id); res.redirect('/');
    } catch { res.redirect('/?authError=google'); }
  });
  app.get('/api/me',auth,(req,res) => res.json({user:publicUser(req.user)}));
  app.get('/api/dashboard',auth,(req,res) => {
    const records=entries(req.user.id);
    res.json({user:publicUser(req.user),entries:records,stats:calculateStats(records,req.user),settings:settings(),today:todayKST()});
  });
  app.put('/api/profile',auth,(req,res) => {
    const data=z.object({name:z.string().trim().min(1).max(40),daily_goal:z.number().int().min(1).max(1000000)}).parse(req.body);
    db.prepare('UPDATE users SET name=?,daily_goal=? WHERE id=?').run(data.name,data.daily_goal,req.user.id); publish(req.user.id); res.json({ok:true});
  });
  app.put('/api/entries',auth,(req,res) => {
    const data=entrySchema.parse(req.body);
    db.prepare(`INSERT INTO writing_entries(user_id,entry_date,character_count,memo,link) VALUES(?,?,?,?,?) ON CONFLICT(user_id,entry_date) DO UPDATE SET character_count=excluded.character_count,memo=excluded.memo,link=excluded.link,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(req.user.id,data.entry_date,data.character_count,data.memo,data.link);
    publish(req.user.id);
    res.json({ok:true,entry:db.prepare('SELECT * FROM writing_entries WHERE user_id=? AND entry_date=?').get(req.user.id,data.entry_date)});
  });
  app.delete('/api/entries/:date',auth,(req,res) => {
    const date=z.string().refine(isDate).parse(req.params.date);
    db.prepare('DELETE FROM writing_entries WHERE user_id=? AND entry_date=?').run(req.user.id,date); publish(req.user.id); res.json({ok:true});
  });
  app.get('/api/admin/members',auth,admin,(req,res) => {
    const date=z.string().refine(isDate).parse(req.query.date || todayKST());
    const members=db.prepare(`SELECT u.id,u.email,u.name,u.role,u.created_at,COUNT(e.entry_date) AS total_days,COALESCE(SUM(e.character_count),0) AS total_characters,COALESCE(MAX(CASE WHEN e.entry_date=? THEN e.character_count END),0) AS day_characters FROM users u LEFT JOIN writing_entries e ON e.user_id=u.id GROUP BY u.id ORDER BY u.created_at DESC`).all(date);
    res.json({members});
  });
  app.get('/api/admin/members/:id/entries',auth,admin,(req,res) => res.json({entries:entries(req.params.id)}));
  app.patch('/api/admin/members/:id/role',auth,admin,(req,res) => {
    const {role}=z.object({role:z.enum(['member','admin'])}).parse(req.body);
    if(req.params.id===req.user.id) return res.status(409).json({error:'자신의 권한은 변경할 수 없습니다.'});
    db.exec('BEGIN IMMEDIATE');
    try {
      const target=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
      if(!target) { db.exec('ROLLBACK'); return res.status(404).json({error:'회원을 찾을 수 없습니다.'}); }
      db.prepare('UPDATE users SET role=? WHERE id=?').run(role,target.id);
      audit(req.user.id,'role.change',target.id,`${target.role} → ${role}`); db.exec('COMMIT'); publish(target.id); res.json({ok:true});
    } catch(e) { db.exec('ROLLBACK'); throw e; }
  });
  app.put('/api/admin/settings',auth,admin,(req,res) => {
    const data=z.object({header:z.string().trim().min(1).max(120),announcement:z.string().max(500),challenge_guide:z.string().min(1).max(2000),accent:z.enum(['green','blue','violet'])}).parse(req.body);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE site_settings SET header=?,announcement=?,challenge_guide=?,accent=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`).run(data.header,data.announcement,data.challenge_guide,data.accent);
      audit(req.user.id,'settings.update','1'); db.exec('COMMIT'); publish(); res.json({settings:settings()});
    } catch(e) { db.exec('ROLLBACK'); throw e; }
  });
  app.use('/api', (req,res) => res.status(404).json({error:'존재하지 않는 API입니다.'}));
  app.use((error,req,res,next) => {
    if(error instanceof z.ZodError) return res.status(400).json({error:'입력 내용을 확인해 주세요.',issues:error.issues.map(i=>({path:i.path,message:i.message}))});
    if(error.type==='entity.too.large') return res.status(413).json({error:'입력 크기가 너무 큽니다.'});
    if(error instanceof SyntaxError && 'body' in error) return res.status(400).json({error:'잘못된 JSON 요청입니다.'});
    console.error('Request failed:',error.code || error.name); res.status(500).json({error:'서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'});
  });
  return app;
}

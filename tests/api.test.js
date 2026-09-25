import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { todayKST, addDays } from '../shared/dates.js';

test('database-backed API: authentication, ownership, dates, RBAC, persistence',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'writeon-')),path=join(dir,'test.sqlite');
  let db=openDatabase(path),server=createApp(db).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  let base=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,{method='GET',body,cookie='',origin='http://localhost:3000'}={})=>{
    const response=await fetch(base+path,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  let a,b,aid,bid;
  try {
    await t.test('anonymous access blocked and cross-origin mutations denied',async()=>{
      assert.equal((await call('/api/dashboard')).status,401);
      assert.equal((await call('/api/admin/members')).status,401);
      assert.equal((await call('/api/auth/register',{method:'POST',origin:'https://evil.example',body:{}})).status,403);
    });
    await t.test('register always member; password hash never returned',async()=>{
      const result=await call('/api/auth/register',{method:'POST',body:{email:'a@example.com',password:'very-safe-pass-1',name:'작가 A',role:'admin'}});
      assert.equal(result.status,201);assert.equal(result.data.user.role,'member');assert.ok(!('password_hash' in result.data.user));a=result.cookie;aid=result.data.user.id;
      const second=await call('/api/auth/register',{method:'POST',body:{email:'b@example.com',password:'very-safe-pass-2',name:'작가 B'}});b=second.cookie;bid=second.data.user.id;
      assert.notEqual(db.prepare('SELECT password_hash FROM users WHERE id=?').get(aid).password_hash,'very-safe-pass-1');
    });
    await t.test('invalid password and duplicate email rejected',async()=>{
      assert.equal((await call('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'wrong-pass-123'}})).status,401);
      assert.equal((await call('/api/auth/register',{method:'POST',body:{email:'A@example.com',password:'very-safe-pass-1',name:'duplicate'}})).status,409);
    });
    const today=todayKST(),yesterday=addDays(today,-1);
    await t.test('same-day upsert not duplicate; owner derived from session',async()=>{
      for(const count of [500,1200])assert.equal((await call('/api/entries',{method:'PUT',cookie:a,body:{user_id:bid,entry_date:today,character_count:count,memo:'테스트 글',link:'https://example.com'}})).status,200);
      const d=(await call('/api/dashboard',{cookie:a})).data;assert.equal(d.entries.length,1);assert.equal(d.entries[0].character_count,1200);assert.equal(d.stats.totalDays,1);
      assert.equal((await call('/api/dashboard',{cookie:b})).data.entries.length,0);
    });
    await t.test('validation rejects zero, fractional, future, impossible date, unsafe links',async()=>{
      for(const body of [{character_count:0},{character_count:1.2},{entry_date:addDays(today,1)},{entry_date:'2026-02-30'},{link:'javascript:alert(1)'},{memo:'a'.repeat(2001)}]){
        assert.equal((await call('/api/entries',{method:'PUT',cookie:a,body:{entry_date:today,character_count:20,...body}})).status,400);
      }
    });
    await t.test('streak derived from stored dates and own delete restriction',async()=>{
      await call('/api/entries',{method:'PUT',cookie:a,body:{entry_date:yesterday,character_count:600}});
      assert.equal((await call('/api/dashboard',{cookie:a})).data.stats.streak,2);
      await call(`/api/entries/${today}`,{method:'DELETE',body:{},cookie:b});
      assert.equal((await call('/api/dashboard',{cookie:a})).data.entries.length,2);
    });
    await t.test('member cannot read others, grant roles, or edit settings',async()=>{
      assert.equal((await call('/api/admin/members',{cookie:a})).status,403);
      assert.equal((await call(`/api/admin/members/${bid}/entries`,{cookie:a})).status,403);
      assert.equal((await call(`/api/admin/members/${bid}/role`,{method:'PATCH',cookie:a,body:{role:'admin'}})).status,403);
      assert.equal((await call('/api/admin/settings',{method:'PUT',cookie:a,body:{}})).status,403);
    });
    await t.test('offline provisioned admin may manage users and settings',async()=>{
      db.prepare("UPDATE users SET role='admin' WHERE id=?").run(aid);
      const list=await call(`/api/admin/members?date=${today}`,{cookie:a});assert.equal(list.status,200);assert.equal(list.data.members.length,2);assert.equal(list.data.members.find(m=>m.id===aid).day_characters,1200);
      assert.equal((await call(`/api/admin/members/${bid}/role`,{method:'PATCH',cookie:a,body:{role:'admin'}})).status,200);
      assert.equal((await call('/api/admin/members',{cookie:b})).status,200);
      assert.equal((await call(`/api/admin/members/${aid}/role`,{method:'PATCH',cookie:a,body:{role:'member'}})).status,409);
      assert.equal((await call('/api/admin/settings',{method:'PUT',cookie:a,body:{header:'새 헤더',announcement:'공지',challenge_guide:'도전 안내',accent:'blue'}})).status,200);
      assert.equal((await call('/api/config')).data.settings.header,'새 헤더');
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n>=2);
      await call(`/api/admin/members/${bid}/role`,{method:'PATCH',cookie:a,body:{role:'member'}});
      assert.equal((await call('/api/admin/members',{cookie:b})).status,403);
    });
    await t.test('SSE announces committed writes to the authenticated user',async()=>{
      const controller=new AbortController();
      const stream=await fetch(base+'/api/events',{headers:{Cookie:a},signal:controller.signal});
      assert.equal(stream.status,200);
      const reader=stream.body.getReader();
      await reader.read();
      await call('/api/entries',{method:'PUT',cookie:a,body:{entry_date:today,character_count:1200}});
      const result=await reader.read();
      assert.match(new TextDecoder().decode(result.value),/event: changed/);
      await reader.cancel(); controller.abort();
    });
    await t.test('database and sessions survive server/database restart',async()=>{
      await new Promise(r=>server.close(r));db.close();db=openDatabase(path);server=createApp(db).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
      const d=await call('/api/dashboard',{cookie:a});assert.equal(d.status,200);assert.equal(d.data.entries.length,2);assert.equal(d.data.stats.totalCharacters,1800);assert.equal(d.data.settings.header,'새 헤더');
    });
    await t.test('delete recomputes stats and logout revokes session',async()=>{
      await call(`/api/entries/${today}`,{method:'DELETE',cookie:a,body:{}});const d=(await call('/api/dashboard',{cookie:a})).data;assert.equal(d.stats.totalDays,1);assert.equal(d.stats.streak,1);assert.equal(d.stats.totalCharacters,600);
      assert.equal((await call('/api/auth/logout',{method:'POST',cookie:a,body:{}})).status,200);assert.equal((await call('/api/dashboard',{cookie:a})).status,401);
    });
  }finally{await new Promise(r=>server.close(r));db.close();rmSync(dir,{recursive:true,force:true});}
});

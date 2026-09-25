import { openDatabase } from '../server/db.js';
const email=process.argv[2]?.trim().toLowerCase();
if(!email){console.error('Usage: pnpm admin registered-user@example.com');process.exit(1);}
const db=openDatabase();
const user=db.prepare('SELECT id,role FROM users WHERE email=?').get(email);
if(!user){console.error('먼저 앱에서 해당 이메일로 가입해야 합니다.');db.close();process.exit(1);}
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
  db.prepare('INSERT INTO audit_log(actor_id,action,target_id,detail) VALUES(?,?,?,?)').run('offline-operator','role.bootstrap',user.id,`${user.role} → admin`);
  db.exec('COMMIT');console.log('관리자 권한을 부여했습니다. 앱을 새로고침하세요.');
} catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}

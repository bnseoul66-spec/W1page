import { backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase } from '../server/db.js';
const target=resolve(process.argv[2] || `./backups/writeon-${new Date().toISOString().replaceAll(':','-')}.sqlite`);
mkdirSync(dirname(target),{recursive:true,mode:0o700});
const db=openDatabase();
try{await backup(db,target);console.log(`일관된 데이터베이스 백업 생성: ${target}`);}finally{db.close();}

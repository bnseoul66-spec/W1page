import express from 'express';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const db = openDatabase();
const app = createApp(db,{production});
if (production) {
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (req,res) => res.sendFile(resolve('dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server:{middlewareMode:true}, appType:'spa' });
  app.use(vite.middlewares);
}
const server=app.listen(Number(process.env.PORT || 3000),'0.0.0.0',() => console.log(`WriteOn listening on port ${process.env.PORT || 3000} (${production?'production':'development'}; SQLite storage)`));
function shutdown() {
  app.locals.closeStreams();
  server.close(()=>{db.close();process.exit(0);});
  setTimeout(()=>server.closeAllConnections(),5000).unref();
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);

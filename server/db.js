import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 기존 index.js 및 앱 코드와 호환되는 openDatabase 객체 정의
export function openDatabase() {
  return {
    exec: async (sql) => {
      return await pool.query(sql);
    },
    get: async (sql, params = []) => {
      // SQLite ? 파라미터를 PostgreSQL $1, $2 로 변환
      let i = 1;
      const pgSql = sql.replace(/\?/g, () => `$${i++}`);
      const res = await pool.query(pgSql, params);
      return res.rows[0];
    },
    all: async (sql, params = []) => {
      let i = 1;
      const pgSql = sql.replace(/\?/g, () => `$${i++}`);
      const res = await pool.query(pgSql, params);
      return res.rows;
    },
    run: async (sql, params = []) => {
      let i = 1;
      const pgSql = sql.replace(/\?/g, () => `$${i++}`);
      const res = await pool.query(pgSql, params);
      return { lastID: res.rows[0]?.id, changes: res.rowCount };
    }
  };
}

export default pool;

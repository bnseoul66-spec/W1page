import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export function openDatabase() {
  return {
    exec: async (sql) => {
      return await pool.query(sql);
    },
    get: async (sql, params = []) => {
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
      let pgSql = sql.replace(/\?/g, () => `$${i++}`);

      // SQLite 전용 구문(INSERT OR IGNORE)을 PostgreSQL 구문으로 자동 변환
      if (pgSql.toUpperCase().includes('INSERT OR IGNORE')) {
        pgSql = pgSql.replace(/INSERT OR IGNORE/i, 'INSERT');
        pgSql += ' ON CONFLICT DO NOTHING';
      }

      // INSERT 실행 시 SQLite의 lastID 반환을 모방하기 위해 RETURNING id 자동 추가
      if (pgSql.toUpperCase().trim().startsWith('INSERT') && !pgSql.toUpperCase().includes('RETURNING')) {
         pgSql += ' RETURNING id';
      }

      const res = await pool.query(pgSql, params);
      return {
        lastID: res.rows && res.rows.length > 0 ? res.rows[0].id : undefined,
        changes: res.rowCount
      };
    }
  };
}

export default pool;

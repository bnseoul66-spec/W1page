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

      if (pgSql.toUpperCase().includes('INSERT OR IGNORE')) {
        pgSql = pgSql.replace(/INSERT OR IGNORE/i, 'INSERT');
        pgSql += ' ON CONFLICT DO NOTHING';
      }

      if (pgSql.toUpperCase().trim().startsWith('INSERT') && !pgSql.toUpperCase().includes('RETURNING')) {
        pgSql += ' RETURNING id';
      }

      const res = await pool.query(pgSql, params);
      return {
        lastID: res.rows && res.rows.length > 0 ? res.rows[0].id : undefined,
        changes: res.rowCount
      };
    },
    close: async () => {
      return await pool.end();
    }
  };
}

export default pool;

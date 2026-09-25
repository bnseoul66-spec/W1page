const { Pool } = require('pg');

// Render에 입력한 DATABASE_URL로 Supabase PostgreSQL에 연결
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};

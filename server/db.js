import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL 환경변수가 설정되어 있지 않습니다.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool 오류:', err);
});

const transactionStorage = new AsyncLocalStorage();
let closed = false;
let closePromise;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function bindPlaceholders(sql, params) {
  const isNamed = isPlainObject(params);
  const positional = Array.isArray(params)
    ? params
    : params === undefined || isNamed
      ? []
      : [params];

  const values = [];
  const namedIndexes = new Map();

  let positionalIndex = 0;
  let output = '';
  let i = 0;
  let quote = null;
  let dollarQuote = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      output += ch;
      i += 1;
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      output += ch;
      i += 1;
      if (ch === '*' && next === '/') {
        output += '/';
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, i)) {
        output += dollarQuote;
        i += dollarQuote.length;
        dollarQuote = null;
      } else {
        output += ch;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (quote === '`') {
        if (ch === '`' && next === '`') {
          output += '"';
          i += 2;
        } else if (ch === '`') {
          output += '"';
          i += 1;
          quote = null;
        } else {
          output += ch;
          i += 1;
        }
        continue;
      }

      output += ch;
      i += 1;

      if (ch === '\\' && i < sql.length) {
        output += sql[i];
        i += 1;
      } else if (ch === quote) {
        if (sql[i] === quote) {
          output += sql[i];
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      output += '--';
      i += 2;
      inLineComment = true;
      continue;
    }

    if (ch === '/' && next === '*') {
      output += '/*';
      i += 2;
      inBlockComment = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      output += ch;
      i += 1;
      continue;
    }

    if (ch === '`') {
      quote = '`';
      output += '"';
      i += 1;
      continue;
    }

    if (ch === '$') {
      const match = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarQuote = match[0];
        output += dollarQuote;
        i += dollarQuote.length;
        continue;
      }
    }

    if (ch === '?') {
      if (isNamed) {
        throw new Error(
          'SQL에 ? 바인딩이 있지만 명명 파라미터 객체가 전달됐습니다. 배열 파라미터를 사용하세요.'
        );
      }

      values.push(positional[positionalIndex]);
      positionalIndex += 1;
      output += `$${values.length}`;
      i += 1;
      continue;
    }

    const isNamedPrefix = ch === ':' || ch === '@' || ch === '$';
    const isCastColon = ch === ':' && (next === ':' || sql[i - 1] === ':');

    if (isNamed && isNamedPrefix && !isCastColon) {
      const match = sql.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (match) {
        const name = match[0];
        const candidates = [name, `${ch}${name}`];
        const key = candidates.find((candidate) =>
          Object.prototype.hasOwnProperty.call(params, candidate)
        );

        if (key === undefined) {
          throw new Error(`명명 파라미터 "${ch}${name}"의 값이 없습니다.`);
        }

        if (!namedIndexes.has(name)) {
          values.push(params[key]);
          namedIndexes.set(name, values.length);
        }

        output += `$${namedIndexes.get(name)}`;
        i += name.length + 1;
        continue;
      }
    }

    output += ch;
    i += 1;
  }

  return { text: output, values };
}

function stripLeadingComments(sql) {
  return sql.replace(
    /^\s*(?:(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/,
    ''
  );
}

function addClause(sql, clause, beforeReturning = false) {
  const trimmed = sql.trim();
  const hasSemicolon = /;\s*$/.test(trimmed);
  let body = trimmed.replace(/;\s*$/, '').trimEnd();

  if (beforeReturning) {
    const returningIndex = body.search(/\bRETURNING\b/i);

    if (returningIndex !== -1) {
      body =
        body.slice(0, returningIndex).trimEnd() +
        ' ' +
        clause +
        ' ' +
        body.slice(returningIndex).trimStart();
    } else {
      body += ` ${clause}`;
    }
  } else {
    body += ` ${clause}`;
  }

  return body + (hasSemicolon ? ';' : '');
}

function compileSql(originalSql, params, { forRun = false } = {}) {
  let sql = String(originalSql);
  const leadingSql = stripLeadingComments(sql).trimStart();

  if (/^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK)\b/i.test(leadingSql)) {
    throw new Error(
      '풀 연결을 사용하는 직접 트랜잭션 문은 안전하지 않습니다. db.transaction(async () => ...)를 사용하세요.'
    );
  }

  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(sql)) {
    throw new Error(
      'INSERT OR REPLACE는 자동 변환할 수 없습니다. PostgreSQL의 ON CONFLICT (...) DO UPDATE 구문으로 변경하세요.'
    );
  }

  const isIgnoreInsert = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');

  sql = sql.replace(
    /\bdatetime\s*\(\s*(['"])now\1\s*\)/gi,
    'CURRENT_TIMESTAMP'
  );

  const isInsert = /^INSERT\b/i.test(stripLeadingComments(sql).trimStart());

  if (isIgnoreInsert && !/\bON\s+CONFLICT\b/i.test(sql)) {
    sql = addClause(sql, 'ON CONFLICT DO NOTHING', true);
  }

  if (forRun && isInsert && !/\bRETURNING\b/i.test(sql)) {
    sql = addClause(sql, 'RETURNING *');
  }

  return {
    ...bindPlaceholders(sql, params),
    isInsert,
  };
}

function queryPostgres(text, values) {
  if (closed) {
    return Promise.reject(new Error('데이터베이스 연결이 이미 닫혔습니다.'));
  }

  const client = transactionStorage.getStore();
  const executor = client || pool;

  return values && values.length > 0
    ? executor.query(text, values)
    : executor.query(text);
}

function parseArgs(args) {
  const rest = [...args];
  let callback;

  if (typeof rest[rest.length - 1] === 'function') {
    callback = rest.pop();
  }

  let params;
  if (rest.length === 0) {
    params = [];
  } else if (rest.length === 1 && Array.isArray(rest[0])) {
    params = rest[0];
  } else if (rest.length === 1 && isPlainObject(rest[0])) {
    params = rest[0];
  } else {
    params = rest;
  }

  return { params, callback };
}

const db = {};

db.get = function (sql, ...args) {
  const { params, callback } = parseArgs(args);

  const promise = Promise.resolve()
    .then(() => compileSql(sql, params))
    .then(({ text, values }) => queryPostgres(text, values))
    .then((result) => result.rows[0]);

  if (!callback) return promise;

  promise.then(
    (row) => callback.call(undefined, null, row),
    (err) => callback.call(undefined, err, undefined)
  );

  return db;
};

db.all = function (sql, ...args) {
  const { params, callback } = parseArgs(args);

  const promise = Promise.resolve()
    .then(() => compileSql(sql, params))
    .then(({ text, values }) => queryPostgres(text, values))
    .then((result) => result.rows);

  if (!callback) return promise;

  promise.then(
    (rows) => callback.call(undefined, null, rows),
    (err) => callback.call(undefined, err, undefined)
  );

  return db;
};

db.run = function (sql, ...args) {
  const { params, callback } = parseArgs(args);

  const promise = Promise.resolve()
    .then(() => compileSql(sql, params, { forRun: true }))
    .then(({ text, values, isInsert }) => queryPostgres(text, values).then((result) => {
      const insertedRow = isInsert ? result.rows[0] : undefined;

      return {
        lastID: insertedRow ? (insertedRow.id ?? insertedRow.ID) : undefined,
        changes: result.rowCount ?? 0,
      };
    }));

  if (!callback) return promise;

  promise.then(
    ({ lastID, changes }) =>
      callback.call({ lastID, changes }, null),
    (err) =>
      callback.call({ lastID: undefined, changes: 0 }, err)
  );

  return db;
};

db.exec = function (sql, callback) {
  const promise = Promise.resolve().then(() => {
    let script = String(sql);

    script = script.replace(/(^|;)\s*PRAGMA\b[^;]*(?=;|$)/gim, '$1');

    if (/\bINSERT\s+OR\s+(?:IGNORE|REPLACE)\b/i.test(script)) {
      throw new Error(
        'db.exec()의 INSERT OR IGNORE/REPLACE는 자동 변환하지 않습니다. db.run()을 사용하거나 SQL을 PostgreSQL 문법으로 변경하세요.'
      );
    }

    script = script.replace(
      /\bdatetime\s*\(\s*(['"])now\1\s*\)/gi,
      'CURRENT_TIMESTAMP'
    );

    if (!script.trim()) return undefined;

    return queryPostgres(script, []);
  });

  if (typeof callback !== 'function') return promise;

  promise.then(
    () => callback.call(undefined, null),
    (err) => callback.call(undefined, err)
  );

  return db;
};

db.close = function (callback) {
  if (!closePromise) {
    closed = true;
    closePromise = pool.end();
  }

  if (typeof callback !== 'function') return closePromise;

  closePromise.then(
    () => callback.call(undefined, null),
    (err) => callback.call(undefined, err)
  );

  return db;
};

db.transaction = async function (fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('db.transaction()에는 함수를 전달해야 합니다.');
  }

  if (transactionStorage.getStore()) {
    throw new Error('중첩 트랜잭션은 지원하지 않습니다.');
  }

  if (closed) {
    throw new Error('데이터베이스 연결이 이미 닫혔습니다.');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await transactionStorage.run(client, () => fn(db));

    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('트랜잭션 롤백 오류:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
};

export function openDatabase() {
  return db;
}

export default pool;

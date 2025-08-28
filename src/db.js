import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DEFAULT_DIR = path.join(process.cwd(), 'out');
const DB_PATH = process.env.DB_PATH || path.join(DEFAULT_DIR, 'transfers.db');

export function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      blockNumber INTEGER NOT NULL,
      blockHash TEXT NOT NULL,
      eventIndex INTEGER NOT NULL,
      "from" TEXT NOT NULL,
      fromLabel TEXT,
      "to" TEXT NOT NULL,
      toLabel TEXT,
      tokenSymbol TEXT,
      tokenDecimals INTEGER,
      amountUnits TEXT,
      amountTokens REAL,
      UNIQUE(blockHash, eventIndex)
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_time ON transfers(time);
    CREATE INDEX IF NOT EXISTS idx_transfers_amount ON transfers(amountTokens);
    CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers("from");
    CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers("to");
  `);
  return db;
}

export function insertTransfers(db, rows) {
  if (!rows || rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transfers (
      time, blockNumber, blockHash, eventIndex, "from", fromLabel, "to", toLabel,
      tokenSymbol, tokenDecimals, amountUnits, amountTokens
    ) VALUES (@time, @blockNumber, @blockHash, @eventIndex, @from, @fromLabel, @to, @toLabel, @tokenSymbol, @tokenDecimals, @amountUnits, @amountTokens)
  `);
  const trx = db.transaction((batch) => {
    for (const r of batch) stmt.run(r);
  });
  trx(rows);
  return rows.length;
}

export function clearTransfers(db) {
  db.exec('DELETE FROM transfers;');
}

export function queryTransfers(db, { limit = 50, offset = 0, minAmount = 0, addressQ = '', sinceMinutes = 0, symbol = '' } = {}) {
  const where = [];
  const params = {};
  if (minAmount > 0) { where.push('amountTokens >= @minAmount'); params.minAmount = minAmount; }
  if (addressQ) { where.push('(lower(`from`) LIKE @q OR lower(`to`) LIKE @q OR lower(`fromLabel`) LIKE @q OR lower(`toLabel`) LIKE @q)'); params.q = `%${addressQ.toLowerCase()}%`; }
  if (sinceMinutes > 0) { where.push('time >= @sinceIso'); params.sinceIso = new Date(Date.now() - sinceMinutes*60*1000).toISOString(); }
  if (symbol) { where.push('tokenSymbol = @sym'); params.sym = symbol; }
  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const rows = db.prepare(`
    SELECT * FROM transfers
    ${whereSql}
    ORDER BY time DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });
  const count = db.prepare(`SELECT COUNT(1) as c FROM transfers ${whereSql}`).get(params).c;
  return { rows, count };
}



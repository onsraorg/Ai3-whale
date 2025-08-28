import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb, queryTransfers, clearTransfers } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', 'out');
const WHITELIST_FILE = process.env.WHITELIST_FILE || path.join(process.cwd(), 'whitelist.json');
// 已移除 CSV 读取，全部从 SQLite 查询
const PORT = Number(process.env.PORT || 8787);

const app = express();
const startedAt = new Date().toISOString();

// 清空数据库（重启时）
try {
  const db = openDb();
  clearTransfers(db);
  db.close();
  console.log('数据库 transfers 表已清空');
} catch (e) {
  console.warn('清空数据库失败：', e?.message || e);
}

// 简单 CSV 读取：仅解析最后 N 行，避免加载过大文件
// CSV 相关已删除

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/transfers', (req, res) => {
  try {
    const limit = Math.min(500, Number(req.query.limit || 100));
    const page = Math.max(1, Number(req.query.page || 1));
    const offset = (page - 1) * limit;
    const minAmount = Number(req.query.minAmount || 0);
    const addressQ = String(req.query.addressQ || '');
    const sinceMinutes = Number(req.query.sinceMinutes || 0);
    const symbol = String(req.query.symbol || '');

    const db = openDb();
    const { rows, count } = queryTransfers(db, { limit, offset, minAmount, addressQ, sinceMinutes, symbol });
    db.close();
    return res.json({ ok: true, count, page, pageSize: limit, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 返回服务启动时间
app.get('/api/meta', (req, res) => {
  res.json({ ok: true, startedAt });
});

// 返回白名单地址映射（地址=>标签）
app.get('/api/whitelist', (req, res) => {
  try {
    if (!fs.existsSync(WHITELIST_FILE)) {
      return res.json({ ok: true, data: {} });
    }
    const raw = fs.readFileSync(WHITELIST_FILE, 'utf8');
    const data = JSON.parse(raw);
    // 规范化为字符串键值
    const norm = {};
    for (const [k, v] of Object.entries(data)) norm[String(k)] = String(v);
    return res.json({ ok: true, data: norm });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});



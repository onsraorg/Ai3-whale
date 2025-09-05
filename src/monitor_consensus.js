import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { openDb, insertTransfers } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WS_ENDPOINT = process.env.AUTO_WS || process.env.WS_ENDPOINT;
if (!WS_ENDPOINT) {
  console.error('请在环境变量中设置 AUTO_WS 或 WS_ENDPOINT（Substrate 节点 WebSocket）');
  process.exit(1);
}

// 支持两种阈值配置：
// 1) THRESHOLD_TOKENS（整币数量） -> 将依据链 decimals 转换为基础单位
// 2) THRESHOLD_UNITS（链基础单位）
const THRESHOLD_TOKENS_ENV = process.env.THRESHOLD_TOKENS;
const THRESHOLD_UNITS_ENV = process.env.THRESHOLD_UNITS;
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', 'out');
const WHITELIST_FILE = process.env.WHITELIST_FILE || path.join(process.cwd(), 'whitelist.json');

fs.mkdirSync(OUT_DIR, { recursive: true });

function loadWhitelist() {
  try {
    const raw = fs.readFileSync(WHITELIST_FILE, 'utf8');
    const data = JSON.parse(raw);
    const norm = {};
    for (const [addr, name] of Object.entries(data)) {
      norm[String(addr)] = String(name);
    }
    return norm;
  } catch {
    return {};
  }
}

const whitelist = loadWhitelist();

// 仅使用 SQLite 存储，不再写 CSV

function label(addr) {
  return whitelist[addr] || '';
}

function formatUnits(valueBigInt, decimals) {
  const negative = valueBigInt < 0n;
  const value = negative ? -valueBigInt : valueBigInt;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  const result = fractionStr.length ? `${whole.toString()}.${fractionStr}` : whole.toString();
  return negative ? `-${result}` : result;
}

async function main() {
  console.log('WS:', WS_ENDPOINT);

  const provider = new WsProvider(WS_ENDPOINT);
  const api = await ApiPromise.create({ provider });

  const chain = await api.rpc.system.chain();
  const props = await api.rpc.system.properties();
  console.log(`连接到链: ${chain.toString()} properties: ${props.toString()}`);

  // 读取链 decimals
  const decimals = (api.registry.chainDecimals && api.registry.chainDecimals[0]) || 12;
  const tokenSymbol = (api.registry.chainTokens && api.registry.chainTokens[0]) || ((props && props.tokenSymbol && props.tokenSymbol[0]) || 'UNIT');
  console.log('链 decimals =', decimals);

  let thresholdUnits;
  if (THRESHOLD_TOKENS_ENV) {
    const tokens = BigInt(THRESHOLD_TOKENS_ENV);
    const pow = BigInt(10) ** BigInt(decimals);
    thresholdUnits = tokens * pow;
    console.log(`阈值(代币数量) = ${tokens.toString()} -> 阈值(基础单位) = ${thresholdUnits.toString()}`);
  } else if (THRESHOLD_UNITS_ENV) {
    thresholdUnits = BigInt(THRESHOLD_UNITS_ENV);
    console.log(`阈值(基础单位) = ${thresholdUnits.toString()}`);
  } else {
    // 默认按 10,000 枚代币计算
    const tokens = BigInt(10000);
    const pow = BigInt(10) ** BigInt(decimals);
    thresholdUnits = tokens * pow;
    console.log(`未设置阈值，默认 10000 代币 -> 阈值(基础单位) = ${thresholdUnits.toString()}`);
  }

  await api.rpc.chain.subscribeNewHeads(async (header) => {
    try {
      const blockNumber = header.number.toNumber();
      const blockHash = header.hash.toHex();
      console.log(`收到新区块 #${blockNumber} (${blockHash.slice(0,10)}...)，开始检查事件…`);

      const [events, ts] = await Promise.all([
        api.query.system.events.at(blockHash),
        api.query.timestamp.now.at(blockHash).catch(() => null)
      ]);
      const timeIso = ts ? new Date(ts.toNumber()).toISOString() : new Date().toISOString();

      const rows = [];
      events.forEach((record, idx) => {
        const { event } = record;
        if (api.events.balances.Transfer.is(event)) {
          const [from, to, amount] = event.data;
          try {
            const amt = BigInt(amount.toString());
            const fromAddr = from.toString();
            const toAddr = to.toString();
            
            // 检查是否涉及白名单地址（转入或转出）
            const isFromWhitelist = whitelist[fromAddr];
            const isToWhitelist = whitelist[toAddr];
            
            // 如果涉及白名单地址，记录所有转账（无论金额大小）
            if (isFromWhitelist || isToWhitelist) {
              const amountTokens = formatUnits(amt, decimals);
              rows.push({
                time: timeIso,
                blockNumber,
                blockHash,
                eventIndex: idx,
                from: fromAddr,
                fromLabel: label(fromAddr),
                to: toAddr,
                toLabel: label(toAddr),
                tokenSymbol,
                tokenDecimals: String(decimals),
                amountUnits: amt.toString(),
                amountTokens
              });
            }
          } catch {}
        }
      });

      if (rows.length > 0) {
        console.log(`记录 ${rows.length} 条白名单转账 (block ${blockNumber})，示例金额: ${rows[0].amountTokens} ${rows[0].tokenSymbol}`);
        try {
          const db = openDb();
          insertTransfers(db, rows);
          db.close();
        } catch (e) {
          console.error('写入 SQLite 失败:', e?.message || e);
        }
      } else {
        console.log(`区块 ${blockNumber} 无白名单相关转账`);
      }
    } catch (e) {
      console.error('处理新区块失败:', e?.message || e);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});



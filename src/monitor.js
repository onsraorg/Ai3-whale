import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createObjectCsvWriter } from 'csv-writer';
import { ethers } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration via ENV
const RPC_URL = process.env.AUTO_EVM_RPC || process.env.RPC_URL;
if (!RPC_URL) {
  console.error('请在环境变量中设置 AUTO_EVM_RPC 或 RPC_URL');
  process.exit(1);
}

// Threshold in whole tokens, default 10_000
const THRESHOLD_TOKENS = Number(process.env.THRESHOLD_TOKENS || '10000');
// From which block to start; if absent, start from latest - 1000
const START_BLOCK_ENV = process.env.START_BLOCK ? Number(process.env.START_BLOCK) : undefined;
// Comma separated token contract addresses to restrict (optional). If empty, scan all ERC20 transfers.
const TOKEN_ADDRESSES = (process.env.TOKEN_ADDRESSES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
// Output folder
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', 'out');
// State file for last processed block
const STATE_FILE = path.join(OUT_DIR, 'state.json');
// Whitelist file
const WHITELIST_FILE = process.env.WHITELIST_FILE || path.join(process.cwd(), 'whitelist.json');

// Ensure output dir
fs.mkdirSync(OUT_DIR, { recursive: true });

// Load or init state
function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { lastProcessedBlock: 0 };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Load whitelist mapping { addressLower: name }
function loadWhitelist() {
  try {
    const raw = fs.readFileSync(WHITELIST_FILE, 'utf8');
    const data = JSON.parse(raw);
    const norm = {};
    for (const [addr, name] of Object.entries(data)) {
      norm[String(addr).toLowerCase()] = String(name);
    }
    return norm;
  } catch {
    return {};
  }
}

const whitelist = loadWhitelist();

// CSV writer
const csvWriter = createObjectCsvWriter({
  path: path.join(OUT_DIR, 'large-transfers.csv'),
  header: [
    { id: 'time', title: 'time' },
    { id: 'blockNumber', title: 'blockNumber' },
    { id: 'txHash', title: 'txHash' },
    { id: 'logIndex', title: 'logIndex' },
    { id: 'token', title: 'token' },
    { id: 'tokenSymbol', title: 'tokenSymbol' },
    { id: 'tokenDecimals', title: 'tokenDecimals' },
    { id: 'from', title: 'from' },
    { id: 'fromLabel', title: 'fromLabel' },
    { id: 'to', title: 'to' },
    { id: 'toLabel', title: 'toLabel' },
    { id: 'amountTokens', title: 'amountTokens' },
    { id: 'amountRaw', title: 'amountRaw' }
  ],
  append: fs.existsSync(path.join(OUT_DIR, 'large-transfers.csv'))
});

// ERC20 Transfer(topic signature)
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Caches
const tokenDecimalsCache = new Map();
const tokenSymbolCache = new Map();

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

async function getTokenMeta(address) {
  const addr = address.toLowerCase();
  if (!tokenDecimalsCache.has(addr)) {
    const contract = new ethers.Contract(address, ERC20_ABI, provider);
    try {
      const [decimals, symbol] = await Promise.all([
        contract.decimals().catch(() => 18),
        contract.symbol().catch(() => 'UNKNOWN')
      ]);
      tokenDecimalsCache.set(addr, Number(decimals));
      tokenSymbolCache.set(addr, String(symbol));
    } catch (e) {
      tokenDecimalsCache.set(addr, 18);
      tokenSymbolCache.set(addr, 'UNKNOWN');
    }
  }
  return { decimals: tokenDecimalsCache.get(addr), symbol: tokenSymbolCache.get(addr) };
}

function formatAmount(raw, decimals) {
  try {
    return Number(ethers.formatUnits(raw, decimals));
  } catch {
    return 0;
  }
}

function label(addr) {
  if (!addr) return '';
  return whitelist[addr.toLowerCase()] || '';
}

async function determineStartBlock() {
  if (START_BLOCK_ENV && Number.isFinite(START_BLOCK_ENV)) return START_BLOCK_ENV;
  const latest = await provider.getBlockNumber();
  return Math.max(0, latest - 1000);
}

async function main() {
  console.log('RPC:', RPC_URL);
  console.log('阈值(代币):', THRESHOLD_TOKENS);
  if (TOKEN_ADDRESSES.length > 0) console.log('仅监控合约:', TOKEN_ADDRESSES.join(','));
  const state = readState();
  let fromBlock = state.lastProcessedBlock > 0 ? state.lastProcessedBlock + 1 : await determineStartBlock();

  // Polling loop using blocks to avoid missing events
  while (true) {
    try {
      const latest = await provider.getBlockNumber();
      if (fromBlock > latest) {
        await waitMs(4000);
        continue;
      }

      const toBlock = Math.min(fromBlock + 999, latest); // batch up to 1000 blocks

      const filter = {
        fromBlock,
        toBlock,
        topics: [TRANSFER_TOPIC]
      };
      if (TOKEN_ADDRESSES.length > 0) {
        filter.address = TOKEN_ADDRESSES;
      }

      const logs = await provider.getLogs(filter);

      if (logs.length > 0) {
        const rows = [];
        for (const log of logs) {
          try {
            const token = log.address;
            const { decimals, symbol } = await getTokenMeta(token);
            // Decode topics: indexed from, to; data: value
            const from = '0x' + log.topics[1].slice(26);
            const to = '0x' + log.topics[2].slice(26);
            const amountRaw = BigInt(log.data);
            const amountTokens = formatAmount(amountRaw, decimals);

            // 检查是否涉及白名单地址（转入或转出）
            const isFromWhitelist = whitelist[from.toLowerCase()];
            const isToWhitelist = whitelist[to.toLowerCase()];
            
            // 如果涉及白名单地址，记录所有转账（无论金额大小）
            if (isFromWhitelist || isToWhitelist) {
              const blk = await provider.getBlock(log.blockNumber);
              rows.push({
                time: new Date(Number(blk.timestamp) * 1000).toISOString(),
                blockNumber: log.blockNumber,
                txHash: log.transactionHash,
                logIndex: log.logIndex,
                token,
                tokenSymbol: symbol,
                tokenDecimals: decimals,
                from,
                fromLabel: label(from),
                to,
                toLabel: label(to),
                amountTokens,
                amountRaw: amountRaw.toString()
              });
            }
          } catch (e) {
            // Skip malformed log
          }
        }

        if (rows.length > 0) {
          await csvWriter.writeRecords(rows);
          console.log(`记录 ${rows.length} 条白名单转账 (blocks ${fromBlock}-${toBlock})`);
        }
      }

      fromBlock = toBlock + 1;
      writeState({ lastProcessedBlock: toBlock });
      await waitMs(1500);
    } catch (err) {
      console.error('轮询出错:', err?.message || err);
      await waitMs(5000);
    }
  }
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});



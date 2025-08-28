## Autonomys 大额转账监控（共识链版）

可视化监控共识链 `balances.Transfer` 大额转账事件：后端写入 SQLite，前端提供筛选/统计并显示白名单标签。

### 功能特性
- 订阅新区块，筛选超过阈值的转账事件
- 结果写入 SQLite（`out/transfers.db`），服务重启会清空并重新累计
- 前端展示最近记录，支持时间窗口、最小金额、地址模糊筛选
- 白名单标注与汇总：统计“交易所收款总额”（`whitelist.json`）
- 地址可点击直达 Subscan 账户页（新窗口打开）

### 快速开始
1) 安装依赖
```bash
npm install
```

2) 配置环境变量与白名单（根目录 `.env`）
```bash
# 必填：共识链 WebSocket
AUTO_WS=wss://YOUR_SUBSTRATE_WS

# 可选：按代币数量或基础单位设置阈值（二选一）
THRESHOLD_TOKENS=10000
# THRESHOLD_UNITS=10000000000000

# 输出与白名单
# OUT_DIR=./out
# WHITELIST_FILE=./whitelist.json
```

编辑 `whitelist.json`（地址=>标签）：
```json
{
  "sucXXXXXX...": "mexc",
  "sudXXXXXX...": "kucoin"
}
```

3) 运行
```bash
# 启动共识链监控
npm run start:consensus

# 启动后端 API + 前端（http://localhost:8787）
npm run start:server

# 或同时启动两者
npm run start:all
```

### 前端与 API
- 前端：`public/index.html`（静态页，定时调用 API 刷新）
- API：
  - `GET /api/transfers` 查询最近转账（支持 limit、minAmount、addressQ、sinceMinutes、symbol）
  - `GET /api/whitelist` 获取白名单映射
  - `GET /api/meta` 获取服务启动时间（用于提示数据起始点）

### 数据库存储
- 路径：`out/transfers.db`
- 表：`transfers`（列：time, blockNumber, blockHash, eventIndex, "from", "to", ...）
- 启动时清空表，以当前运行为时间起点

### 目录结构（关键文件）
```
src/
  db.js                # SQLite 打开/建表/查询
  monitor_consensus.js # 共识链监控与入库
  server.js            # API 与静态资源
public/
  index.html           # 前端展示
out/
  transfers.db         # 运行时生成（已被 .gitignore 忽略）
whitelist.json         # 白名单映射（地址=>标签）
```

### 提示
- 若不希望每次重启清空数据，可在 `server.js` 中移除清空逻辑或加环境变量开关。
- 生产部署建议使用 `pm2` 等进程管理器，并将 `OUT_DIR` 指向持久化存储。


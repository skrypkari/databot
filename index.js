const axios = require('axios');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const cron = require('node-cron');
const { Telegraf } = require('telegraf');

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SCAN_INTERVAL_MINUTES = Number(process.env.SCAN_INTERVAL_MINUTES || 5);

if (!BOT_TOKEN || !CHAT_ID) {
  throw new Error('Missing BOT_TOKEN or CHAT_ID in environment');
}

const bot = new Telegraf(BOT_TOKEN);
const db = new Database('snapshots.db');

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS snapshots (
    asset TEXT PRIMARY KEY,
    borrow_usdt REAL NOT NULL,
    repay_usdt REAL NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

db.exec(CREATE_TABLE_SQL);

const UPSERT_SQL = `
  INSERT INTO snapshots (asset, borrow_usdt, repay_usdt, updated_at)
  VALUES (@asset, @borrow_usdt, @repay_usdt, @updated_at)
  ON CONFLICT(asset) DO UPDATE SET
    borrow_usdt = excluded.borrow_usdt,
    repay_usdt = excluded.repay_usdt,
    updated_at = excluded.updated_at
`;

const selectAllStmt = db.prepare('SELECT asset, borrow_usdt, repay_usdt FROM snapshots');
const selectTopStmt = db.prepare(
  'SELECT asset, borrow_usdt, repay_usdt FROM snapshots ORDER BY borrow_usdt DESC LIMIT 10'
);
const upsertStmt = db.prepare(UPSERT_SQL);

const BINANCE_URL =
  'https://www.binance.com/bapi/margin/v1/public/margin/statistics/24h-borrow-and-repay';

const ALERTS = {
  borrowThreshold: 2_000_000,
  borrowDeltaThreshold: 1_500_000,
  ratioThreshold: 8
};

const formatUsdt = (value) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toFixed(2);
};

const formatRatio = (borrow, repay) => {
  if (!Number.isFinite(repay) || repay === 0) {
    return 'Inf';
  }
  return (borrow / repay).toFixed(1);
};

const buildTable = (rows) => {
  const headers = ['ASSET', 'BOR.D', 'REP.D', 'B/R'];
  const data = rows.map((row) => {
    const ratio = formatRatio(row.borrow_usdt, row.repay_usdt);
    return [
      row.asset,
      formatUsdt(row.borrow_usdt),
      formatUsdt(row.repay_usdt),
      ratio
    ];
  });

  const columns = headers.map((header, index) => {
    const width = Math.max(
      header.length,
      ...data.map((row) => row[index].length)
    );
    return { header, width };
  });

  const formatRow = (row) =>
    row
      .map((cell, index) => cell.padEnd(columns[index].width))
      .join('  ');

  const lines = [formatRow(headers), '-'.repeat(columns.reduce((sum, col) => sum + col.width, 0) + (columns.length - 1) * 2)];
  for (const row of data) {
    lines.push(formatRow(row));
  }
  return lines.join('\n');
};

const sendAlert = async (message) => {
  await bot.telegram.sendMessage(CHAT_ID, `\`\`\`text\n${message}\n\`\`\``);
};

const fetchSnapshot = async () => {
  const response = await axios.get(BINANCE_URL, { timeout: 15_000 });
  if (!response.data || !response.data.data) {
    throw new Error('Unexpected response from Binance');
  }
  return response.data.data;
};

const processSnapshot = async () => {
  const currentRows = await fetchSnapshot();
  const previousRows = selectAllStmt.all();
  const previousMap = new Map(
    previousRows.map((row) => [row.asset, row])
  );

  const alerts = [];
  const now = Date.now();

  for (const row of currentRows) {
    const asset = row.asset;
    const borrow = Number(row.totalBorrowInUsdt || 0);
    const repay = Number(row.totalRepayInUsdt || 0);
    const ratio = repay === 0 ? Infinity : borrow / repay;

    const previous = previousMap.get(asset);
    const prevBorrow = previous ? previous.borrow_usdt : 0;
    const deltaBorrow = borrow - prevBorrow;

    const reasons = [];
    if (borrow > ALERTS.borrowThreshold) {
      reasons.push(`BOR.D ${formatUsdt(borrow)} > ${formatUsdt(ALERTS.borrowThreshold)}`);
    }
    if (deltaBorrow > ALERTS.borrowDeltaThreshold) {
      reasons.push(`ΔBOR.D ${formatUsdt(deltaBorrow)} > ${formatUsdt(ALERTS.borrowDeltaThreshold)}`);
    }
    if (ratio > ALERTS.ratioThreshold) {
      reasons.push(`B/R ${ratio.toFixed(1)} > ${ALERTS.ratioThreshold}`);
    }

    if (reasons.length > 0) {
      alerts.push(
        `${asset} | BOR.D ${formatUsdt(borrow)} | REP.D ${formatUsdt(repay)} | B/R ${ratio === Infinity ? 'Inf' : ratio.toFixed(1)}\n` +
          reasons.map((reason) => `- ${reason}`).join('\n')
      );
    }

    upsertStmt.run({
      asset,
      borrow_usdt: borrow,
      repay_usdt: repay,
      updated_at: now
    });
  }

  if (alerts.length > 0) {
    const message = `ALERTS (${alerts.length})\n\n${alerts.join('\n\n')}`;
    await sendAlert(message);
  }
};

bot.command('stats', async (ctx) => {
  const rows = selectTopStmt.all();
  if (rows.length === 0) {
    return ctx.reply('```text\nNo data yet.\n```');
  }
  const table = buildTable(rows);
  return ctx.reply(`\`\`\`text\n${table}\n\`\`\``);
});

bot.launch();

const schedule = `*/${SCAN_INTERVAL_MINUTES} * * * *`;
cron.schedule(schedule, () => {
  processSnapshot().catch((error) => {
    console.error('Snapshot error:', error.message);
  });
});

processSnapshot().catch((error) => {
  console.error('Initial snapshot error:', error.message);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

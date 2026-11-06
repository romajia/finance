// Minimal no-dependency local server and read-only data adapter.
// Start with: node server.js
// The browser only talks to this local server; upstream CORS is not required.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const MARKET_SOURCE = 'https://pscnetsecrwd.moneydj.com/w/bcd/tBCDNavList.djbcd';
const DISTRIBUTION_SOURCE = 'https://wmfund.entrust.com.tw/w/wr/wr10.djhtm?a=ACPS63-A07049';
const cache = { market: null, dividends: null };
const scheduleState = {
  lastScheduledCheckAt: null,
  lastScheduledSyncAt: null,
  lastScheduledNavDate: null,
  lastScheduledStatus: 'waiting',
};

function taipeiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Northstar-ReadOnly-Demo/1.0', 'Accept': '*/*' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  return response.text();
}

async function marketData(url) {
  const html = await fetchText(url);
  const [datePart, navPart] = html.replace(/<!--.*?-->/gs, '').trim().split(/\s+/);
  if (!datePart || !navPart) throw new Error('Unexpected NAV response format');
  const dates = datePart.split(',');
  const navs = navPart.split(',');
  const history = dates.map((date, index) => ({
    date,
    nav: Number(navs[index]),
  })).filter(point => /^\d{8}$/.test(point.date) && Number.isFinite(point.nav) && point.nav > 0);
  if (history.length < 60) throw new Error('Upstream returned fewer than 60 NAV observations');
  return history;
}

async function distributionData() {
  const html = await fetchText(DISTRIBUTION_SOURCE);
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(cell => cell[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 5 || !/^\d{4}\/\d{2}\/\d{2}$/.test(cells[0])) return null;
    const amount = Number(cells[4]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return { recordDate: cells[0], exDate: cells[1], paymentDate: cells[2], amount };
  }).filter(Boolean);
  if (!rows.length) throw new Error('No distribution rows found');
  return rows.reverse().slice(-18);
}

async function loadMarket() {
  const endDate = taipeiDate();
  const start = new Date(`${endDate}T00:00:00+08:00`);
  start.setFullYear(start.getFullYear() - 1);
  const fromDate = taipeiDate(start);
  const params = new URLSearchParams({ a: 'ACPS63', b: '1', c: fromDate, d: endDate });
  const sourceUrl = `${MARKET_SOURCE}?${params}`;
  const history = await marketData(sourceUrl);
  cache.market = { fund: 'ACPS63', history, source: 'MoneyDJ', sourceUrl, updatedAt: new Date().toISOString() };
  return cache.market;
}

async function loadDividends() {
  const dividends = await distributionData();
  cache.dividends = {
    fund: 'A07049', dividends, source: '統一基金平台',
    sourceUrl: DISTRIBUTION_SOURCE, updatedAt: new Date().toISOString(),
  };
  return cache.dividends;
}

function addCivilDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function isWeekday(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday > 0 && weekday < 6;
}

function nextScheduledRun(now = new Date()) {
  let date = taipeiDate(now);
  let target = new Date(`${date}T18:00:00+08:00`);
  if (target <= now || !isWeekday(date)) {
    do { date = addCivilDays(date, 1); } while (!isWeekday(date));
    target = new Date(`${date}T18:00:00+08:00`);
  }
  return target;
}

async function scheduledSync(date, attempt = 0) {
  try {
    const market = await loadMarket();
    const today = date.replaceAll('-', '');
    const latestDate = market.history.at(-1)?.date;
    scheduleState.lastScheduledCheckAt = new Date().toISOString();
    scheduleState.lastScheduledNavDate = latestDate || null;
    if (latestDate !== today) {
      scheduleState.lastScheduledStatus = 'no-nav';
      console.log(`[18:00 sync] ${date}: no NAV dated today yet; retry ${attempt + 1}/12`);
      if (attempt < 11) setTimeout(() => scheduledSync(date, attempt + 1), 10 * 60 * 1000);
      return;
    }
    await loadDividends();
    scheduleState.lastScheduledSyncAt = scheduleState.lastScheduledCheckAt;
    scheduleState.lastScheduledStatus = 'updated';
    console.log(`[18:00 sync] updated NAV for ${date}`);
  } catch (error) {
    scheduleState.lastScheduledCheckAt = new Date().toISOString();
    scheduleState.lastScheduledStatus = 'error';
    console.error(`[18:00 sync] ${date}: ${error.message}`);
    if (attempt < 11) setTimeout(() => scheduledSync(date, attempt + 1), 10 * 60 * 1000);
  }
}

function scheduleNextBusinessDay() {
  const target = nextScheduledRun();
  const delay = Math.max(1000, target.getTime() - Date.now());
  console.log(`[scheduler] next check: ${new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'short',
  }).format(target)} (Asia/Taipei)`);
  setTimeout(() => {
    const date = taipeiDate();
    if (isWeekday(date)) scheduledSync(date);
    scheduleNextBusinessDay();
  }, delay);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (requestUrl.pathname === '/api/status') {
    send(res, 200, {
      schedule: '18:00 Asia/Taipei on weekdays; sync only when the NAV source has today\'s record',
      nextScheduledAt: nextScheduledRun().toISOString(),
      ...scheduleState,
      lastSourceUpdateAt: cache.market?.updatedAt || null,
    });
    return;
  }
  if (requestUrl.pathname === '/api/market') {
    const fund = requestUrl.searchParams.get('fund') || 'ACPS63';
    if (fund !== 'ACPS63') return send(res, 400, { error: 'Live history is currently available for ACPS63 only.' });
    try {
      const data = requestUrl.searchParams.get('cached') === '1' && cache.market ? cache.market : await loadMarket();
      send(res, 200, data);
    } catch (error) {
      send(res, 502, { error: 'NAV sync failed', detail: error.message });
    }
    return;
  }
  if (requestUrl.pathname === '/api/dividends') {
    const fund = requestUrl.searchParams.get('fund') || 'A07049';
    if (fund !== 'A07049') return send(res, 400, { error: 'Distribution history is currently available for A07049 only.' });
    try {
      const data = requestUrl.searchParams.get('cached') === '1' && cache.dividends ? cache.dividends : await loadDividends();
      send(res, 200, data);
    } catch (error) {
      send(res, 502, { error: 'Distribution sync failed', detail: error.message });
    }
    return;
  }
  if (requestUrl.pathname === '/api/health') {
    send(res, 200, { ok: true, service: 'northstar-readonly-demo' });
    return;
  }

  const requestedPath = requestUrl.pathname === '/' ? '/index.html' : decodeURIComponent(requestUrl.pathname);
  const filePath = path.resolve(ROOT, `.${requestedPath}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) && filePath !== path.join(ROOT, 'index.html')) {
    return send(res, 403, { error: 'Forbidden' });
  }
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  fs.readFile(filePath, (error, contents) => {
    if (error) return send(res, 404, { error: 'Not found' });
    send(res, 200, contents, contentTypes[path.extname(filePath)] || 'application/octet-stream');
  });
});

scheduleNextBusinessDay();
server.listen(PORT, HOST, () => {
  console.log(`Northstar dashboard: http://${HOST}:${PORT}`);
  console.log('Read-only market data routes: /api/market and /api/dividends');
});

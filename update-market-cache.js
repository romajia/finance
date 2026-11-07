'use strict';

// Refresh the public, static snapshot used by GitHub Pages.
// The NAV source normally publishes after 18:00 Asia/Taipei on business days.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT, 'northstar-market-cache.json');
const MARKET_SOURCE = 'https://pscnetsecrwd.moneydj.com/w/bcd/tBCDNavList.djbcd';
const DISTRIBUTION_SOURCE = 'https://wmfund.entrust.com.tw/w/wr/wr10.djhtm?a=ACPS63-A07049';

function taipeiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Northstar-Pages-Market-Snapshot/1.0', Accept: '*/*' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  return response.text();
}

async function fetchMarket() {
  const endDate = taipeiDate();
  const startDate = new Date(`${endDate}T00:00:00+08:00`);
  startDate.setFullYear(startDate.getFullYear() - 1);
  const params = new URLSearchParams({
    a: 'ACPS63', b: '1', c: taipeiDate(startDate), d: endDate,
  });
  const sourceUrl = `${MARKET_SOURCE}?${params}`;
  const body = (await fetchText(sourceUrl)).replace(/<!--.*?-->/gs, '').trim();
  const [datePart, navPart] = body.split(/\s+/);
  if (!datePart || !navPart) throw new Error('Unexpected NAV response format');
  const dates = datePart.split(',');
  const navs = navPart.split(',');
  const history = dates.map((date, index) => ({ date, nav: Number(navs[index]) }))
    .filter(point => /^\d{8}$/.test(point.date) && Number.isFinite(point.nav) && point.nav > 0);
  if (history.length < 60) throw new Error(`Only ${history.length} NAV observations received`);
  return { fund: 'ACPS63', history, source: 'MoneyDJ', sourceUrl };
}

async function fetchDistributions() {
  const html = await fetchText(DISTRIBUTION_SOURCE);
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(cell => cell[1].replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 5 || !/^\d{4}\/\d{2}\/\d{2}$/.test(cells[0])) return null;
    const amount = Number(cells[4]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return { recordDate: cells[0], exDate: cells[1], paymentDate: cells[2], amount };
  }).filter(Boolean).reverse().slice(-18);
  if (!rows.length) throw new Error('No distribution rows received');
  return { fund: 'A07049', dividends: rows, source: '統一基金平台', sourceUrl: DISTRIBUTION_SOURCE };
}

function readSnapshot() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (_) { return {}; }
}

async function main() {
  const [incomingMarket, incomingDividends] = await Promise.all([fetchMarket(), fetchDistributions()]);
  const previous = readSnapshot();
  const previousDate = previous.market?.history?.at(-1)?.date || '';
  const incomingDate = incomingMarket.history.at(-1).date;
  const previousNav = previous.market?.history?.at(-1)?.nav;
  const incomingNav = incomingMarket.history.at(-1).nav;
  const marketChanged = !previousDate || incomingDate > previousDate
    || (incomingDate === previousDate && incomingNav !== previousNav);
  const dividendsChanged = JSON.stringify(previous.dividends?.dividends || [])
    !== JSON.stringify(incomingDividends.dividends);

  if (!marketChanged && !dividendsChanged) {
    console.log(`No new snapshot: latest NAV is ${incomingDate} (${incomingNav}).`);
    return;
  }

  const updatedAt = new Date().toISOString();
  const next = {
    market: marketChanged
      ? { ...incomingMarket, updatedAt }
      : previous.market,
    dividends: dividendsChanged
      ? { ...incomingDividends, updatedAt }
      : previous.dividends,
  };
  fs.writeFileSync(CACHE_FILE, `${JSON.stringify(next)}\n`, 'utf8');
  console.log(`Snapshot refreshed: NAV ${next.market.history.at(-1).date} (${next.market.history.at(-1).nav}); ${next.market.history.length} daily observations.`);
  console.log(`Market changed: ${marketChanged}; distributions changed: ${dividendsChanged}.`);
}

main().catch(error => {
  console.error(`Market snapshot refresh failed: ${error.message}`);
  process.exitCode = 1;
});

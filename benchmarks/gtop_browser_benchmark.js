const { chromium } = require('playwright');
const fs = require('fs');

const MODE = process.env.MODE || 'CDN';
const RUNS = Number(process.env.RUNS || 5);
const SETTLE_MS = Number(process.env.SETTLE_MS || 4000);

const BASE = 'https://bioinfo.szbl.ac.cn';

/*
 * IMPORTANT:
 * Use the exact same fixed page set for CDN and ORIGIN.
 * Do not discover benchmark pages dynamically from the homepage, because
 * discovery itself is affected by the route being benchmarked and can make
 * the two groups incomparable.
 *
 * These pages represent the main GTOP browsing paths:
 * homepage, expression, QTL, download, and the integrated genome browser.
 */
const PAGES = [
  { name: 'Homepage', url: `${BASE}/GTOP/` },
  { name: 'Expression', url: `${BASE}/GTOP/expression/` },
  { name: 'QTL', url: `${BASE}/GTOP/qtl/list?qtl_type=eQTL` },
  { name: 'Download', url: `${BASE}/GTOP/download/` },
  {
    name: 'GenomeBrowser',
    url: `${BASE}/GTOP/tools/jbrowse/?config=data%2Fconfig.json&loc=chr1%3A196651754-196752476`
  }
];

const output = `gtop_browser_${MODE.toLowerCase()}.csv`;

const columns = [
  'mode','page','url','run','cache_state','status',
  'ttfb_ms','fcp_ms','lcp_ms','domcontentloaded_ms','load_ms',
  'requests','gtop_requests','network_bytes','gtop_network_bytes',
  'failed_requests','wall_time_ms','error'
];

fs.writeFileSync(output, columns.join(',') + '\n');

function esc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeRow(row) {
  fs.appendFileSync(
    output,
    columns.map(c => esc(row[c])).join(',') + '\n'
  );
}

async function measure(context, item, run, cacheState) {
  const page = await context.newPage();

  await page.addInitScript(() => {
    window.__GTOP_LCP = 0;

    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          window.__GTOP_LCP = Math.max(
            window.__GTOP_LCP || 0,
            entry.startTime || 0
          );
        }
      }).observe({
        type: 'largest-contentful-paint',
        buffered: true
      });
    } catch (_) {}
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  const urls = new Map();

  let requests = 0;
  let gtopRequests = 0;
  let networkBytes = 0;
  let gtopNetworkBytes = 0;
  let failedRequests = 0;

  cdp.on('Network.requestWillBeSent', e => {
    const url = e.request?.url || '';
    if (!/^https?:\/\//.test(url)) return;

    requests++;
    urls.set(e.requestId, url);

    if (url.startsWith(BASE)) {
      gtopRequests++;
    }
  });

  cdp.on('Network.loadingFinished', e => {
    const url = urls.get(e.requestId) || '';
    const bytes = Number(e.encodedDataLength || 0);

    networkBytes += bytes;

    if (url.startsWith(BASE)) {
      gtopNetworkBytes += bytes;
    }
  });

  cdp.on('Network.loadingFailed', e => {
    const url = urls.get(e.requestId) || '';
    if (/^https?:\/\//.test(url)) {
      failedRequests++;
    }
  });

  let status = 0;
  let error = '';
  const start = Date.now();

  try {
    const response = await page.goto(item.url, {
      waitUntil: 'load',
      timeout: 60000
    });

    status = response?.status() || 0;
    await page.waitForTimeout(SETTLE_MS);
  } catch (e) {
    error = String(e.message || e)
      .replace(/\s+/g, ' ')
      .slice(0, 500);
  }

  const wallTime = Date.now() - start;
  let metrics = {};

  try {
    metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];

      return {
        ttfb_ms: nav ? nav.responseStart - nav.requestStart : null,
        fcp_ms: fcp ? fcp.startTime : null,
        lcp_ms: window.__GTOP_LCP || null,
        domcontentloaded_ms: nav ? nav.domContentLoadedEventEnd : null,
        load_ms: nav ? nav.loadEventEnd : null
      };
    });
  } catch (_) {}

  writeRow({
    mode: MODE,
    page: item.name,
    url: item.url,
    run,
    cache_state: cacheState,
    status,
    ...metrics,
    requests,
    gtop_requests: gtopRequests,
    network_bytes: networkBytes,
    gtop_network_bytes: gtopNetworkBytes,
    failed_requests: failedRequests,
    wall_time_ms: wallTime,
    error
  });

  console.log(
    `${MODE} | ${item.name} | ${cacheState}` +
    ` | run=${run}` +
    ` | status=${status}` +
    ` | LCP=${metrics.lcp_ms?.toFixed?.(0) ?? 'NA'}ms` +
    ` | Load=${metrics.load_ms?.toFixed?.(0) ?? 'NA'}ms` +
    ` | GTOP=${(gtopNetworkBytes / 1024 / 1024).toFixed(2)}MB` +
    (error ? ` | ERROR=${error}` : '')
  );

  await cdp.detach();
  await page.close();
}

(async () => {
  console.log(`Benchmark mode: ${MODE}`);
  console.log(`Runs per page: ${RUNS}`);
  console.log('Fixed benchmark pages:');
  for (const p of PAGES) {
    console.log(`  ${p.name}: ${p.url}`);
  }

  const browser = await chromium.launch({ headless: true });

  for (const item of PAGES) {
    for (let run = 1; run <= RUNS; run++) {
      /*
       * A fresh context gives an empty browser cache for the cold load.
       * The warm load reuses the same context, so HTTP cache/cookies from
       * the cold load are available.
       */
      const context = await browser.newContext({
        viewport: {
          width: 1440,
          height: 1000
        }
      });

      await measure(context, item, run, 'cold');
      await measure(context, item, run, 'warm');

      await context.close();
    }
  }

  await browser.close();
  console.log(`Saved ${output}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});

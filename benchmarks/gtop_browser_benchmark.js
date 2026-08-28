const { chromium } = require('playwright');
const fs = require('fs');

const MODE = process.env.MODE || 'CDN';
const RUNS = Number(process.env.RUNS || 5);
const SETTLE_MS = Number(process.env.SETTLE_MS || 4000);

// 单个样本最多尝试次数。
// 第一次失败后自动补测，不需要重新跑整个 workflow。
const MAX_ATTEMPTS = Number(
  process.env.MAX_ATTEMPTS || 3
);

// 两次重试之间稍微等待，避免连续请求源站。
const RETRY_DELAY_MS = Number(
  process.env.RETRY_DELAY_MS || 1500
);

const BASE = 'https://bioinfo.szbl.ac.cn';


/*
 * IMPORTANT:
 *
 * CDN 和 ORIGIN 必须测试完全相同的固定页面。
 *
 * 不动态扫描首页发现页面，因为动态发现本身会受到
 * 当前访问路径影响，从而破坏 CDN / ORIGIN 的可比性。
 */
const PAGES = [
  {
    name: 'Homepage',
    url: `${BASE}/GTOP/`
  },
  {
    name: 'Expression',
    url: `${BASE}/GTOP/expression/`
  },
  {
    name: 'QTL',
    url: `${BASE}/GTOP/qtl/list?qtl_type=eQTL`
  },
  {
    name: 'Download',
    url: `${BASE}/GTOP/download/`
  },
  {
    name: 'GenomeBrowser',
    url:
      `${BASE}/GTOP/tools/jbrowse/` +
      `?config=data%2Fconfig.json` +
      `&loc=chr1%3A196651754-196752476`
  }
];


const output =
  `gtop_browser_${MODE.toLowerCase()}.csv`;


/*
 * attempt 是这次新增的字段。
 *
 * 例如：
 *
 * run = 4
 * attempt = 1  -> FCP/LCP 缺失
 * attempt = 2  -> 成功
 *
 * Python analyzer 会把第一个失败尝试排除，
 * 最终只使用成功的正式样本。
 */
const columns = [
  'mode',
  'page',
  'url',
  'run',
  'attempt',
  'cache_state',
  'status',

  'ttfb_ms',
  'fcp_ms',
  'lcp_ms',
  'domcontentloaded_ms',
  'load_ms',

  'requests',
  'gtop_requests',

  'network_bytes',
  'gtop_network_bytes',

  'failed_requests',
  'wall_time_ms',

  'error'
];


fs.writeFileSync(
  output,
  columns.join(',') + '\n'
);


function esc(v) {

  if (
    v === null ||
    v === undefined
  ) {
    return '';
  }

  const s = String(v);

  return /[,"\n]/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}


function writeRow(row) {

  fs.appendFileSync(
    output,

    columns
      .map(
        c => esc(row[c])
      )
      .join(',')

    + '\n'
  );
}


function sleep(ms) {

  return new Promise(
    resolve => setTimeout(
      resolve,
      ms
    )
  );
}


/*
 * 判断这一次测量是否能够作为正式 benchmark 样本。
 *
 * 必须同时满足：
 *
 * 1. HTTP status 200–399
 * 2. page.goto 没有报错
 * 3. FCP 有值
 * 4. LCP 有值
 */
function measurementIsValid(
  status,
  error,
  metrics
) {

  return (
    status >= 200
    &&
    status < 400
    &&
    !error
    &&
    Number.isFinite(
      metrics.fcp_ms
    )
    &&
    Number.isFinite(
      metrics.lcp_ms
    )
  );
}


/*
 * 测量一次页面访问。
 *
 * 每一次调用都会：
 *
 * 新建 page
 * ↓
 * 安装 LCP observer
 * ↓
 * 开启 Chromium 网络统计
 * ↓
 * page.goto()
 * ↓
 * 等待 SETTLE_MS
 * ↓
 * 读取性能指标
 * ↓
 * 写入 CSV
 *
 * 最后 return true / false，
 * 告诉外层是否需要自动重试。
 */
async function measure(
  context,
  item,
  run,
  cacheState,
  attempt
) {

  const page =
    await context.newPage();


  /*
   * LCP observer 必须在 navigation 之前安装。
   */
  await page.addInitScript(() => {

    window.__GTOP_LCP = 0;

    try {

      new PerformanceObserver(
        list => {

          for (
            const entry
            of list.getEntries()
          ) {

            window.__GTOP_LCP =
              Math.max(
                window.__GTOP_LCP || 0,
                entry.startTime || 0
              );
          }
        }
      ).observe({
        type:
          'largest-contentful-paint',
        buffered: true
      });

    } catch (_) {
      // 如果 Chromium 没有提供该指标，
      // 后面的完整性检查会判定本次失败。
    }

  });


  /*
   * Chromium DevTools Protocol
   *
   * 用来统计：
   *
   * 请求数量
   * GTOP 请求数量
   * 网络传输字节数
   * 请求失败数量
   */
  const cdp =
    await context.newCDPSession(
      page
    );

  await cdp.send(
    'Network.enable'
  );


  const urls =
    new Map();


  let requests = 0;
  let gtopRequests = 0;

  let networkBytes = 0;
  let gtopNetworkBytes = 0;

  let failedRequests = 0;


  cdp.on(
    'Network.requestWillBeSent',

    e => {

      const url =
        e.request?.url || '';

      if (
        !/^https?:\/\//.test(url)
      ) {
        return;
      }

      requests++;

      urls.set(
        e.requestId,
        url
      );

      if (
        url.startsWith(BASE)
      ) {
        gtopRequests++;
      }
    }
  );


  cdp.on(
    'Network.loadingFinished',

    e => {

      const url =
        urls.get(
          e.requestId
        ) || '';

      const bytes =
        Number(
          e.encodedDataLength || 0
        );


      networkBytes += bytes;


      if (
        url.startsWith(BASE)
      ) {

        gtopNetworkBytes +=
          bytes;
      }
    }
  );


  cdp.on(
    'Network.loadingFailed',

    e => {

      const url =
        urls.get(
          e.requestId
        ) || '';

      if (
        /^https?:\/\//.test(url)
      ) {

        failedRequests++;
      }
    }
  );


  let status = 0;
  let error = '';

  const start =
    Date.now();


  /*
   * 页面导航。
   *
   * 保留原 benchmark 条件：
   *
   * waitUntil = load
   * timeout = 60000 ms
   */
  try {

    const response =
      await page.goto(
        item.url,
        {
          waitUntil: 'load',
          timeout: 60000
        }
      );


    status =
      response?.status() || 0;


    /*
     * 页面 load 完成以后继续等待。
     *
     * 让：
     *
     * 异步资源
     * XHR
     * 字体
     * LCP
     *
     * 有时间稳定。
     */
    await page.waitForTimeout(
      SETTLE_MS
    );

  } catch (e) {

    error =
      String(
        e.message || e
      )
        .replace(
          /\s+/g,
          ' '
        )
        .slice(
          0,
          500
        );
  }


  const wallTime =
    Date.now() - start;


  /*
   * 读取页面性能指标。
   */
  let metrics = {
    ttfb_ms: null,
    fcp_ms: null,
    lcp_ms: null,
    domcontentloaded_ms: null,
    load_ms: null
  };


  try {

    metrics =
      await page.evaluate(() => {

        const nav =
          performance
            .getEntriesByType(
              'navigation'
            )[0];


        const fcp =
          performance
            .getEntriesByName(
              'first-contentful-paint'
            )[0];


        return {

          ttfb_ms:
            nav
              ? (
                  nav.responseStart
                  -
                  nav.requestStart
                )
              : null,


          fcp_ms:
            fcp
              ? fcp.startTime
              : null,


          lcp_ms:
            window.__GTOP_LCP
              || null,


          domcontentloaded_ms:
            nav
              ? nav
                  .domContentLoadedEventEnd
              : null,


          load_ms:
            nav
              ? nav.loadEventEnd
              : null
        };

      });

  } catch (_) {

    // 页面执行上下文异常时，
    // 保持指标为 null。
  }


  /*
   * 判断这一条数据能不能作为正式样本。
   */
  const ok =
    measurementIsValid(
      status,
      error,
      metrics
    );


  /*
   * 每一次 attempt 都写入 CSV。
   *
   * 失败记录不会消失，
   * 后续仍然可以用于排查问题。
   *
   * Python analyzer 只会选择成功记录。
   */
  writeRow({

    mode: MODE,

    page:
      item.name,

    url:
      item.url,

    run,

    attempt,

    cache_state:
      cacheState,

    status,

    ...metrics,

    requests,

    gtop_requests:
      gtopRequests,

    network_bytes:
      networkBytes,

    gtop_network_bytes:
      gtopNetworkBytes,

    failed_requests:
      failedRequests,

    wall_time_ms:
      wallTime,

    error
  });


  /*
   * 控制台输出。
   */
  console.log(

    `${MODE}`

    + ` | ${item.name}`

    + ` | ${cacheState}`

    + ` | run=${run}`

    + ` | attempt=${attempt}`

    + ` | status=${status}`

    + ` | FCP=${
        metrics.fcp_ms
          ?.toFixed?.(0)
        ?? 'NA'
      }ms`

    + ` | LCP=${
        metrics.lcp_ms
          ?.toFixed?.(0)
        ?? 'NA'
      }ms`

    + ` | Load=${
        metrics.load_ms
          ?.toFixed?.(0)
        ?? 'NA'
      }ms`

    + ` | GTOP=${
        (
          gtopNetworkBytes
          / 1024
          / 1024
        ).toFixed(2)
      }MB`

    + ` | valid=${
        ok ? 'YES' : 'NO'
      }`

    + (
        error
          ? ` | ERROR=${error}`
          : ''
      )
  );


  /*
   * 如果 HTTP 成功，
   * 但是 FCP/LCP 缺失，
   * 明确打印原因。
   */
  if (
    status >= 200
    &&
    status < 400
    &&
    !error
    &&
    !ok
  ) {

    console.log(

      `MISSING METRIC`

      + ` | ${MODE}`

      + ` | ${item.name}`

      + ` | ${cacheState}`

      + ` | run=${run}`

      + ` | attempt=${attempt}`

      + ` | FCP=${
          metrics.fcp_ms
            ?? 'NA'
        }`

      + ` | LCP=${
          metrics.lcp_ms
            ?? 'NA'
        }`
    );
  }


  try {

    await cdp.detach();

  } catch (_) {}


  try {

    await page.close();

  } catch (_) {}


  /*
   * true：
   * 正式样本成功。
   *
   * false：
   * 外层自动重试。
   */
  return ok;
}


/*
 * ============================================================
 * 主 benchmark
 * ============================================================
 */

(async () => {

  console.log(
    `Benchmark mode: ${MODE}`
  );

  console.log(
    `Runs per page: ${RUNS}`
  );

  console.log(
    `Max attempts per measurement: ${MAX_ATTEMPTS}`
  );

  console.log(
    `Settle time: ${SETTLE_MS} ms`
  );


  console.log(
    'Fixed benchmark pages:'
  );


  for (
    const p
    of PAGES
  ) {

    console.log(
      `  ${p.name}: ${p.url}`
    );
  }


  const browser =
    await chromium.launch({
      headless: true
    });


  /*
   * 每一个页面需要 RUNS 个正式样本。
   */
  for (
    const item
    of PAGES
  ) {

    for (
      let run = 1;
      run <= RUNS;
      run++
    ) {


      /*
       * ======================================================
       * COLD
       * ======================================================
       *
       * cold 必须使用全新的 browser context。
       *
       * 如果 attempt 失败，
       * 必须关闭整个 context 后重新创建。
       *
       * 否则第二次访问已经有浏览器缓存，
       * 就不能再称为 cold。
       */
      let context = null;

      let coldOk = false;


      for (
        let attempt = 1;
        attempt <= MAX_ATTEMPTS;
        attempt++
      ) {


        /*
         * 清理上一次失败的 context。
         */
        if (context) {

          try {

            await context.close();

          } catch (_) {}
        }


        /*
         * 每次 cold attempt
         * 都使用全新的 context。
         */
        context =
          await browser.newContext({

            viewport: {

              width:
                1440,

              height:
                1000
            }
          });


        console.log(
          '\n'
          + `START`
          + ` | ${MODE}`
          + ` | ${item.name}`
          + ` | cold`
          + ` | run=${run}`
          + ` | attempt=${attempt}`
        );


        coldOk =
          await measure(
            context,
            item,
            run,
            'cold',
            attempt
          );


        if (coldOk) {

          console.log(
            `SUCCESS`
            + ` | ${item.name}`
            + ` | cold`
            + ` | run=${run}`
            + ` | attempt=${attempt}`
          );

          break;
        }


        /*
         * 如果还有重试机会，
         * 稍等后再尝试。
         */
        if (
          attempt
          < MAX_ATTEMPTS
        ) {

          console.log(
            `RETRY`
            + ` | ${item.name}`
            + ` | cold`
            + ` | run=${run}`
            + ` | next attempt=${
                attempt + 1
              }`
          );


          await sleep(
            RETRY_DELAY_MS
          );
        }
      }


      /*
       * Cold 连续 MAX_ATTEMPTS 次失败。
       *
       * 这个 run 没有正式 cold 样本。
       *
       * 不继续做 warm，
       * 因为 warm 必须建立在一个成功 cold
       * 的同一 browser context 上。
       */
      if (!coldOk) {

        console.log(
          '\n'
          + `FAILED AFTER ${MAX_ATTEMPTS} ATTEMPTS`
          + ` | ${MODE}`
          + ` | ${item.name}`
          + ` | cold`
          + ` | run=${run}`
        );


        if (context) {

          try {

            await context.close();

          } catch (_) {}
        }


        /*
         * 继续下一个正式 run。
         *
         * 最后的 Python analyzer
         * 会发现这一组缺少正式样本，
         * 并正确让 benchmark 失败。
         */
        continue;
      }


      /*
       * ======================================================
       * WARM
       * ======================================================
       *
       * warm 必须继续使用刚刚成功 cold 的
       * 同一个 browser context。
       *
       * 这样：
       *
       * HTTP cache
       * cookies
       * 浏览器本地缓存
       *
       * 都会保留。
       */
      let warmOk = false;


      for (
        let attempt = 1;
        attempt <= MAX_ATTEMPTS;
        attempt++
      ) {


        console.log(
          '\n'
          + `START`
          + ` | ${MODE}`
          + ` | ${item.name}`
          + ` | warm`
          + ` | run=${run}`
          + ` | attempt=${attempt}`
        );


        warmOk =
          await measure(
            context,
            item,
            run,
            'warm',
            attempt
          );


        if (warmOk) {

          console.log(
            `SUCCESS`
            + ` | ${item.name}`
            + ` | warm`
            + ` | run=${run}`
            + ` | attempt=${attempt}`
          );

          break;
        }


        if (
          attempt
          < MAX_ATTEMPTS
        ) {

          console.log(
            `RETRY`
            + ` | ${item.name}`
            + ` | warm`
            + ` | run=${run}`
            + ` | next attempt=${
                attempt + 1
              }`
          );


          await sleep(
            RETRY_DELAY_MS
          );
        }
      }


      if (!warmOk) {

        console.log(
          '\n'
          + `FAILED AFTER ${MAX_ATTEMPTS} ATTEMPTS`
          + ` | ${MODE}`
          + ` | ${item.name}`
          + ` | warm`
          + ` | run=${run}`
        );
      }


      /*
       * 当前 run 完成。
       *
       * 关闭 context，
       * 下一 run 从全新 cold cache 开始。
       */
      try {

        await context.close();

      } catch (_) {}
    }
  }


  await browser.close();


  console.log(
    '\n'
    + `Saved ${output}`
  );

})().catch(
  e => {

    console.error(e);

    process.exit(1);
  }
);

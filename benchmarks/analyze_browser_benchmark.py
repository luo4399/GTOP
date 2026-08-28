import os
import sys
import pandas as pd
import numpy as np

RUNS = int(os.environ.get("RUNS", "5"))

EXPECTED_PAGES = [
    "Homepage",
    "Expression",
    "QTL",
    "Download",
    "GenomeBrowser",
]

EXPECTED_STATES = ["cold", "warm"]
EXPECTED_MODES = ["CDN", "ORIGIN"]


# ============================================================
# 1. 读取原始 benchmark CSV
# ============================================================

cdn = pd.read_csv("gtop_browser_cdn.csv")
origin = pd.read_csv("gtop_browser_origin.csv")

df = pd.concat(
    [cdn, origin],
    ignore_index=True
)


# ============================================================
# 2. 检查必须存在的列
# ============================================================

required_columns = {
    "mode",
    "page",
    "run",
    "cache_state",
    "status",
    "error",
    "ttfb_ms",
    "fcp_ms",
    "lcp_ms",
    "domcontentloaded_ms",
    "load_ms",
    "gtop_network_bytes",
}

missing_columns = sorted(
    required_columns - set(df.columns)
)

if missing_columns:
    raise SystemExit(
        "Missing required CSV columns: "
        + ", ".join(missing_columns)
    )


# ============================================================
# 3. 强制转换数值列
#
# 某些失败记录可能把空值读成 NaN，
# 所以这里统一转换，无法转换的值变成 NaN。
# ============================================================

numeric_columns = [
    "run",
    "status",
    "ttfb_ms",
    "fcp_ms",
    "lcp_ms",
    "domcontentloaded_ms",
    "load_ms",
    "gtop_network_bytes",
]

for col in numeric_columns:
    df[col] = pd.to_numeric(
        df[col],
        errors="coerce"
    )


# ============================================================
# 4. 定义真正的有效 benchmark
#
# 必须同时满足：
#
# 1. HTTP status 为 200–399
# 2. page.goto 没有 error
# 3. FCP 有有效数值
# 4. LCP 有有效数值
#
# 以前只检查前两个条件，
# 所以会出现 HTTP 200 但 FCP/LCP = NaN，
# 却仍然被认为是成功 benchmark 的情况。
# ============================================================

http_valid_mask = (
    (df["status"] >= 200)
    & (df["status"] < 400)
    & (df["error"].fillna("") == "")
)

metric_valid_mask = (
    np.isfinite(df["fcp_ms"])
    & np.isfinite(df["lcp_ms"])
)

valid_mask = (
    http_valid_mask
    & metric_valid_mask
)

valid = df[
    valid_mask
].copy()


# ============================================================
# 5. benchmark 完整性检查
#
# 每一个组合都必须有：
#
# Homepage / Expression / QTL / Download / GenomeBrowser
#
# × cold / warm
# × CDN / ORIGIN
# × RUNS 次
#
# 默认 RUNS = 5。
# ============================================================

problems = []

expected_run_ids = set(
    range(1, RUNS + 1)
)

for page in EXPECTED_PAGES:

    for state in EXPECTED_STATES:

        for mode in EXPECTED_MODES:

            x = valid[
                (valid["page"] == page)
                & (valid["cache_state"] == state)
                & (valid["mode"] == mode)
            ]

            # ------------------------------------------------
            # 检查有效记录总数
            # ------------------------------------------------

            if len(x) != RUNS:

                problems.append(
                    f"{page}/{state}/{mode}: "
                    f"expected {RUNS} valid runs, "
                    f"found {len(x)}"
                )

            # ------------------------------------------------
            # 检查 run 1..RUNS 是否全部存在
            # ------------------------------------------------

            actual_run_ids = set(
                x["run"]
                .dropna()
                .astype(int)
            )

            if actual_run_ids != expected_run_ids:

                missing_runs = sorted(
                    expected_run_ids
                    - actual_run_ids
                )

                unexpected_runs = sorted(
                    actual_run_ids
                    - expected_run_ids
                )

                details = []

                if missing_runs:

                    details.append(
                        "missing run IDs: "
                        + ", ".join(
                            map(
                                str,
                                missing_runs
                            )
                        )
                    )

                if unexpected_runs:

                    details.append(
                        "unexpected run IDs: "
                        + ", ".join(
                            map(
                                str,
                                unexpected_runs
                            )
                        )
                    )

                if details:

                    problems.append(
                        f"{page}/{state}/{mode}: "
                        + "; ".join(details)
                    )

            # ------------------------------------------------
            # 防止同一个 run 出现多个有效结果
            #
            # 如果以后 JS 加自动 retry，
            # 正常情况下失败尝试会被 valid_mask 排除，
            # 最终每个 run 仍然应该只有一个有效结果。
            # ------------------------------------------------

            duplicate_counts = (
                x["run"]
                .dropna()
                .astype(int)
                .value_counts()
            )

            duplicate_counts = (
                duplicate_counts[
                    duplicate_counts > 1
                ]
            )

            if len(
                duplicate_counts
            ):

                duplicate_text = ", ".join(
                    f"run {run_id} x{count}"
                    for run_id, count
                    in duplicate_counts.items()
                )

                problems.append(
                    f"{page}/{state}/{mode}: "
                    "duplicate valid measurements: "
                    + duplicate_text
                )


# ============================================================
# 6. 检查是否出现意外页面名称
# ============================================================

unexpected_pages = sorted(
    set(
        valid["page"]
        .dropna()
    )
    - set(EXPECTED_PAGES)
)

if unexpected_pages:

    problems.append(
        "Unexpected page names: "
        + ", ".join(
            unexpected_pages
        )
    )


# ============================================================
# 7. benchmark 不完整时打印详细原因
# ============================================================

if problems:

    print(
        "\n===== BENCHMARK INCOMPLETE =====\n"
    )

    # 去掉重复错误信息
    seen = set()

    for p in problems:

        if p not in seen:

            print(
                "ERROR:",
                p
            )

            seen.add(p)

    # --------------------------------------------------------
    # HTTP 请求成功，但是 FCP/LCP 没有成功采集
    # --------------------------------------------------------

    missing_metrics = df[
        http_valid_mask
        & ~metric_valid_mask
    ].copy()

    if len(
        missing_metrics
    ):

        print(
            "\n===== MISSING FCP/LCP =====\n"
        )

        print(
            missing_metrics[
                [
                    "mode",
                    "page",
                    "run",
                    "cache_state",
                    "status",
                    "fcp_ms",
                    "lcp_ms",
                ]
            ].to_string(
                index=False
            )
        )

    # --------------------------------------------------------
    # 真正的 HTTP / page.goto 失败
    # --------------------------------------------------------

    failed_requests = df[
        ~http_valid_mask
    ].copy()

    if len(
        failed_requests
    ):

        print(
            "\n===== FAILED REQUESTS =====\n"
        )

        print(
            failed_requests[
                [
                    "mode",
                    "page",
                    "run",
                    "cache_state",
                    "status",
                    "error",
                ]
            ].to_string(
                index=False
            )
        )

    # --------------------------------------------------------
    # 只要数据不完整就停止分析
    # --------------------------------------------------------

    sys.exit(2)


# ============================================================
# 8. 正式统计指标
# ============================================================

metrics = [
    "ttfb_ms",
    "fcp_ms",
    "lcp_ms",
    "domcontentloaded_ms",
    "load_ms",
    "gtop_network_bytes",
]


# ============================================================
# 9. CDN vs ORIGIN 页面级比较
# ============================================================

rows = []

for page in EXPECTED_PAGES:

    for state in EXPECTED_STATES:

        x = valid[
            (valid["page"] == page)
            & (
                valid[
                    "cache_state"
                ]
                == state
            )
        ]

        c = x[
            x["mode"]
            == "CDN"
        ]

        o = x[
            x["mode"]
            == "ORIGIN"
        ]

        row = {
            "page": page,
            "cache_state": state,
            "cdn_n": len(c),
            "origin_n": len(o),
        }

        for m in metrics:

            cv = (
                c[m]
                .dropna()
                .median()
            )

            ov = (
                o[m]
                .dropna()
                .median()
            )

            row[
                f"cdn_{m}"
            ] = cv

            row[
                f"origin_{m}"
            ] = ov

            # -----------------------------------------------
            # 改善百分比
            #
            # (Origin - CDN) / Origin × 100
            # -----------------------------------------------

            if (
                pd.notna(cv)
                and pd.notna(ov)
                and ov > 0
            ):

                row[
                    f"{m}_reduction_pct"
                ] = (
                    (ov - cv)
                    / ov
                    * 100
                )

                # -------------------------------------------
                # 加速倍数
                #
                # Origin / CDN
                # -------------------------------------------

                row[
                    f"{m}_speedup_x"
                ] = (
                    ov / cv
                    if cv > 0
                    else np.nan
                )

        rows.append(
            row
        )


comparison = pd.DataFrame(
    rows
)

comparison.to_csv(
    "gtop_browser_comparison.csv",
    index=False
)


# ============================================================
# 10. 输出完整统计 summary
#
# 每组输出：
#
# count
# mean
# median
# std
# ============================================================

summary = (
    valid
    .groupby(
        [
            "page",
            "cache_state",
            "mode",
        ]
    )[metrics]
    .agg(
        [
            "count",
            "mean",
            "median",
            "std",
        ]
    )
)

summary.to_csv(
    "gtop_browser_summary.csv"
)


# ============================================================
# 11. 控制台显示页面级结果
# ============================================================

pd.set_option(
    "display.max_columns",
    None
)

pd.set_option(
    "display.width",
    260
)

show = [
    "page",
    "cache_state",

    "origin_fcp_ms",
    "cdn_fcp_ms",
    "fcp_ms_reduction_pct",

    "origin_lcp_ms",
    "cdn_lcp_ms",
    "lcp_ms_reduction_pct",

    "origin_domcontentloaded_ms",
    "cdn_domcontentloaded_ms",
    "domcontentloaded_ms_reduction_pct",

    "origin_load_ms",
    "cdn_load_ms",
    "load_ms_reduction_pct",

    "origin_gtop_network_bytes",
    "cdn_gtop_network_bytes",
    "gtop_network_bytes_reduction_pct",
]

show = [
    x
    for x in show
    if x in comparison.columns
]


print(
    "\n===== PAGE LEVEL RESULTS =====\n"
)

print(
    comparison[
        show
    ]
    .round(2)
    .to_string(
        index=False
    )
)


# ============================================================
# 12. 完整性报告
# ============================================================

print(
    "\n===== COMPLETENESS =====\n"
)

counts = (
    valid
    .groupby(
        [
            "page",
            "cache_state",
            "mode",
        ]
    )
    .size()
    .rename(
        "valid_runs"
    )
    .reset_index()
)

print(
    counts.to_string(
        index=False
    )
)


# ============================================================
# 13. 无效记录报告
#
# 正常完成的 benchmark 理论上这里应该是 None。
# ============================================================

print(
    "\n===== FAILURES =====\n"
)

invalid = df[
    ~valid_mask
].copy()

if len(
    invalid
):

    print(
        invalid[
            [
                "mode",
                "page",
                "run",
                "cache_state",
                "status",
                "fcp_ms",
                "lcp_ms",
                "error",
            ]
        ].to_string(
            index=False
        )
    )

else:

    print(
        "None"
    )


# ============================================================
# 14. 完成
# ============================================================

print(
    "\n===== BENCHMARK COMPLETE =====\n"
)

print(
    "Saved: gtop_browser_comparison.csv"
)

print(
    "Saved: gtop_browser_summary.csv"
)

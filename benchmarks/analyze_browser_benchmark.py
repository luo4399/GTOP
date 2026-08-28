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

cdn = pd.read_csv("gtop_browser_cdn.csv")
origin = pd.read_csv("gtop_browser_origin.csv")

df = pd.concat([cdn, origin], ignore_index=True)

required_columns = {
    "mode", "page", "run", "cache_state", "status", "error",
    "ttfb_ms", "fcp_ms", "lcp_ms", "domcontentloaded_ms",
    "load_ms", "gtop_network_bytes",
}
missing_columns = sorted(required_columns - set(df.columns))
if missing_columns:
    raise SystemExit(
        "Missing required CSV columns: " + ", ".join(missing_columns)
    )

valid_mask = (
    (df["status"] >= 200)
    & (df["status"] < 400)
    & (df["error"].fillna("") == "")
)
valid = df[valid_mask].copy()

# Fail loudly when CDN and ORIGIN are not directly comparable.
# The old analyzer silently skipped missing page/mode combinations, which
# allowed an incomplete benchmark to look successful.
problems = []

KEY_METRICS = ["fcp_ms", "lcp_ms"]

for page in EXPECTED_PAGES:
    for state in EXPECTED_STATES:
        for mode in EXPECTED_MODES:
            x = valid[
                (valid["page"] == page)
                & (valid["cache_state"] == state)
                & (valid["mode"] == mode)
            ]

            # 先检查是否真的有 5 次成功页面请求
            if len(x) != RUNS:
                problems.append(
                    f"{page}/{state}/{mode}: "
                    f"expected {RUNS} valid runs, found {len(x)}"
                )

            # 再检查每一次是否真的采集到了 FCP / LCP
            for metric in KEY_METRICS:
                values = pd.to_numeric(
                    x[metric],
                    errors="coerce"
                )

                n_valid = np.isfinite(
                    values.to_numpy()
                ).sum()

                if n_valid != RUNS:
                    problems.append(
                        f"{page}/{state}/{mode}/{metric}: "
                        f"expected {RUNS} valid values, found {n_valid}"
                    )


unexpected_pages = sorted(set(valid["page"]) - set(EXPECTED_PAGES))
if unexpected_pages:
    problems.append(
        "Unexpected page names: " + ", ".join(unexpected_pages)
    )

if problems:
    print("\n===== BENCHMARK INCOMPLETE =====\n")

    for p in problems:
        print("ERROR:", p)

    # 找出 HTTP 请求成功，但 FCP/LCP 没有成功采集的运行
    metric_values = valid[["fcp_ms", "lcp_ms"]].apply(
        pd.to_numeric,
        errors="coerce"
    )

    missing_metrics = valid[
        ~np.isfinite(metric_values).all(axis=1)
    ]

    if len(missing_metrics):
        print("\n===== MISSING FCP/LCP =====\n")

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
            ].to_string(index=False)
        )

    fail = df[~valid_mask]

    if len(fail):
        print("\n===== FAILED REQUESTS =====\n")

        print(
            fail[
                [
                    "mode",
                    "page",
                    "run",
                    "cache_state",
                    "status",
                    "error",
                ]
            ].to_string(index=False)
        )

    sys.exit(2)


metrics = [
    "ttfb_ms",
    "fcp_ms",
    "lcp_ms",
    "domcontentloaded_ms",
    "load_ms",
    "gtop_network_bytes",
]

rows = []

for page in EXPECTED_PAGES:
    for state in EXPECTED_STATES:
        x = valid[
            (valid["page"] == page)
            & (valid["cache_state"] == state)
        ]

        c = x[x["mode"] == "CDN"]
        o = x[x["mode"] == "ORIGIN"]

        row = {
            "page": page,
            "cache_state": state,
            "cdn_n": len(c),
            "origin_n": len(o),
        }

        for m in metrics:
            cv = c[m].dropna().median()
            ov = o[m].dropna().median()

            row[f"cdn_{m}"] = cv
            row[f"origin_{m}"] = ov

            if pd.notna(cv) and pd.notna(ov) and ov > 0:
                row[f"{m}_reduction_pct"] = (ov - cv) / ov * 100
                row[f"{m}_speedup_x"] = (
                    ov / cv if cv > 0 else np.nan
                )

        rows.append(row)

comparison = pd.DataFrame(rows)
comparison.to_csv("gtop_browser_comparison.csv", index=False)

summary = (
    valid
    .groupby(["page", "cache_state", "mode"])[metrics]
    .agg(["count", "mean", "median", "std"])
)
summary.to_csv("gtop_browser_summary.csv")

pd.set_option("display.max_columns", None)
pd.set_option("display.width", 260)

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

show = [x for x in show if x in comparison.columns]

print("\n===== PAGE LEVEL RESULTS =====\n")
print(comparison[show].round(2).to_string(index=False))

print("\n===== COMPLETENESS =====\n")
counts = (
    valid.groupby(["page", "cache_state", "mode"])
    .size()
    .rename("valid_runs")
    .reset_index()
)
print(counts.to_string(index=False))

fail = df[~valid_mask]
print("\n===== FAILURES =====\n")
if len(fail):
    print(
        fail[
            [
                "mode", "page", "run", "cache_state",
                "status", "error"
            ]
        ].to_string(index=False)
    )
else:
    print("None")

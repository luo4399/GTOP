import pandas as pd
import numpy as np

cdn = pd.read_csv("gtop_browser_cdn.csv")
origin = pd.read_csv("gtop_browser_origin.csv")

df = pd.concat(
    [cdn, origin],
    ignore_index=True
)

valid = df[
    (df["status"] >= 200)
    & (df["status"] < 400)
    & (df["error"].fillna("") == "")
].copy()

metrics = [
    "ttfb_ms",
    "fcp_ms",
    "lcp_ms",
    "domcontentloaded_ms",
    "load_ms",
    "gtop_network_bytes"
]

rows = []

for page in valid["page"].unique():
    for state in ["cold", "warm"]:

        x = valid[
            (valid["page"] == page)
            & (valid["cache_state"] == state)
        ]

        c = x[x["mode"] == "CDN"]
        o = x[x["mode"] == "ORIGIN"]

        if c.empty or o.empty:
            continue

        row = {
            "page": page,
            "cache_state": state,
            "cdn_n": len(c),
            "origin_n": len(o)
        }

        for m in metrics:
            cv = c[m].dropna().median()
            ov = o[m].dropna().median()

            row[f"cdn_{m}"] = cv
            row[f"origin_{m}"] = ov

            if pd.notna(cv) and pd.notna(ov) and ov > 0:
                row[f"{m}_reduction_pct"] = (
                    (ov - cv) / ov * 100
                )

                row[f"{m}_speedup_x"] = (
                    ov / cv if cv > 0 else np.nan
                )

        rows.append(row)

comparison = pd.DataFrame(rows)

comparison.to_csv(
    "gtop_browser_comparison.csv",
    index=False
)

summary = (
    valid
    .groupby(
        ["page", "cache_state", "mode"]
    )[metrics]
    .agg(
        ["count", "mean", "median", "std"]
    )
)

summary.to_csv(
    "gtop_browser_summary.csv"
)

pd.set_option(
    "display.max_columns",
    None
)

pd.set_option(
    "display.width",
    240
)

show = [
    "page",
    "cache_state",
    "origin_lcp_ms",
    "cdn_lcp_ms",
    "lcp_ms_reduction_pct",
    "origin_load_ms",
    "cdn_load_ms",
    "load_ms_reduction_pct",
    "origin_gtop_network_bytes",
    "cdn_gtop_network_bytes",
    "gtop_network_bytes_reduction_pct"
]

show = [
    x for x in show
    if x in comparison.columns
]

print("\n===== PAGE LEVEL RESULTS =====\n")

print(
    comparison[show]
    .round(2)
    .to_string(index=False)
)

fail = df[
    ~(
        (df["status"] >= 200)
        & (df["status"] < 400)
        & (df["error"].fillna("") == "")
    )
]

print("\n===== FAILURES =====\n")

if len(fail):
    print(
        fail[
            [
                "mode",
                "page",
                "run",
                "cache_state",
                "status",
                "error"
            ]
        ].to_string(index=False)
    )
else:
    print("None")

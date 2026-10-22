# Lightning Pilot Finding 159: Measured Operator Review

Scope: the existing private six-seat Action pilot only. No activation, funding, roster change, engine replacement or public rollout. The maintained review door records `reviewed`; it does not clear or delete the finding.

Finding 159 is TIMING_CORRELATION for players 194e5206-bd4d-4ea5-ba2d-142c8bf8a258 and 4a686160-2102-4cba-b3e5-cfa3b1856602, detected 2026-10-20 18:48 UTC. The original 26 windows hold 26 paired-hand timing observations; independent recomputation of the stored additive moments reproduces r=0.7107378033. The next 116 windows through 2026-10-21 14:23 UTC hold 120 paired observations with r=0.1570266613. Combined, the 146 observations give r=0.3201299847. This supports recording that the finding was investigated; it does not prove innocence or justify weakening the detector.

## Reproducible Timing Evidence

Read `public.lightning_integrity_engine_window` for the Action cluster and this pair with `window_to > 2026-10-19T18:48:00Z`. Split at `window_to <= 2026-10-20T18:48:00Z`. Sum numbers.corr_n, corr_sx, corr_sy, corr_sxx, corr_syy and corr_sxy. Pearson is `(n*sxy-sx*sy) / sqrt((n*sxx-sx*sx)*(n*syy-sy*sy))`.

| Period     | n   | sx                   | sy                   | sxx                  | syy                   | sxy                  |
| ---------- | --- | -------------------- | -------------------- | -------------------- | --------------------- | -------------------- |
| Finding    | 26  | 86.624333333333334   | 90.3083166666666664  | 404.08973205555556   | 618.695202052499983   | 434.273235891666691  |
| Subsequent | 120 | 387.0180000000000008 | 327.3791952380952345 | 1698.325035643333336 | 1256.1502859695464715 | 1119.321916093571426 |

The pinned review permits exactly finding 159, its pair, cluster, source, pattern and measured evidence, read on the two-second interval around its persisted detection. Any changed field or player refuses the write.

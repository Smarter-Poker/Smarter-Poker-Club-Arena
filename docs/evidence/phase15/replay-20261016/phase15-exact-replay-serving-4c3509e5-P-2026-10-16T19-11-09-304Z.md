# P15-A exact historical replay evidence (2026-10-16T19:11:09.304Z)

- Command: `node scripts/phase15-exact-replay.mjs /home/replay/j/batches/P-4c3509e5.ndjson --since 2026-10-16T18:52:00Z --until 2026-10-16T19:02:00Z --limit 100000 --concurrency 18 --store-snapshot /home/replay/j/stores/phase6c-store-chart-store-2c8a2d9f448e.json --store-snapshot /home/replay/j/stores/phase6c-store-solver-store-postflop-dff78313b437.json --node /opt/node/node-v22.23.2-linux-x64/bin/node --esbuild-binary /home/replay/w/hb-phase15-replaysrc/server/node_modules/@esbuild/linux-x64/bin/esbuild --label serving-4c3509e5-P --out /home/replay/j/evidence --full-verdicts /home/replay/j/verdicts/P-4c3509e5.json --note Predeclared window docs/evidence/phase15/replay-declaration-4c3509e5-20261016.md and its addendum; batch P; child Node v22.23.2 linux-x64 in an x86_64 QEMU guest on the Mac`
- Running source: `4c3509e53d6465f2d13d286dd440e55ea501886b`
- Child runtime: `{"node":"v22.23.2","v8":"12.4.254.21-node.56","arch":"x64"}`
- Batch rule: newest 100000 decision records at or after 2026-10-16T18:52:00Z and before 2026-10-16T19:02:00Z, one fresh process each
- Copy: 10 decision records, 10 execution records, 0 plan receipts (sha256 `5e5f082b38b665e2a8c2ce2c19bec50c4d441f176f6095aa54450f3d703ab3ca`)
- Window: 2026-10-16T18:52:05.597Z to 2026-10-16T18:53:28.058Z
- Replayed: 10 in 10 fresh processes, 0 child failures
- replayVerified: 8
- Outbound connection attempts refused in the children: 0

## Recorded Sources

| Value                                      | Count |
| ------------------------------------------ | ----- |
| `4c3509e53d6465f2d13d286dd440e55ea501886b` | 10    |

## Outcomes

| Value               | Count |
| ------------------- | ----- |
| `replayed_exact`    | 8     |
| `replayed_mismatch` | 2     |

## Recorded Runtime By Outcome

| Value                            | Count |
| -------------------------------- | ----- |
| `v22.23.2/x64 replayed_exact`    | 8     |
| `v22.23.2/x64 replayed_mismatch` | 2     |

## First Differences

| Value                                                             | Count |
| ----------------------------------------------------------------- | ----- |
| `replayed_mismatch decision.omahaVariantPolicy.equity.analysisMs` | 2     |

## Acceptance Join

| Value                            | Count |
| -------------------------------- | ----- |
| `joined:intended:selected_equal` | 10    |

## Durable Accepted-Effect Receipts

| Value                          | Count |
| ------------------------------ | ----- |
| `replayed_exact no_effects`    | 8     |
| `replayed_mismatch no_effects` | 2     |

## Outcomes By Format, Variant And Street

| Cell                | Outcomes            |
| ------------------- | ------------------- |
| `cash/flh/preflop`  | replayed_exact 2    |
| `cash/plo4/preflop` | replayed_exact 2    |
| `cash/plo5/preflop` | replayed_exact 2    |
| `cash/plo6/preflop` | replayed_exact 1    |
| `cash/plo6/river`   | replayed_mismatch 1 |
| `cash/plo8/preflop` | replayed_exact 1    |
| `cash/plo8/river`   | replayed_mismatch 1 |

## Notes

- Predeclared window docs/evidence/phase15/replay-declaration-4c3509e5-20261016.md and its addendum; batch P; child Node v22.23.2 linux-x64 in an x86_64 QEMU guest on the Mac

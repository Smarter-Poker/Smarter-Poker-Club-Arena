# tests/chip-and-diamond-figures-never-sum.law.test.ts

`fn_project_hand_side_effects_after_post_commit_20260908` gates projections 1,
2 and 3 on `v_diamond` so Diamond hands stay out of club-member state, legacy
`player_stats` and positional profit - but projection 4, which writes
`ca_hand_player_idx` and `ca_hand_player_stat`, has no gate, and
`ca_hand_player_stat` carries no club or asset column at all. Every read over
it (`ca_player_stats_overview_v2`, `ca_player_stats_pulse`,
`ca_player_ev_curve`, `ca_player_hand_grid`, `ca_player_class_hands`,
`ca_player_nemesis`, `ca_player_rake_stats`) takes only `p_user`, so the first
Diamond hand ever played will add its `profit`, `won_amt`, `net` and
`rake_paid` to the player's chip totals with nothing able to separate them
again. The repair has two halves - a migration giving the fact table an asset
dimension, and a client that asks for a scope - and only the client half can
ship in a pull request, so this law pins the halves to each other: every stats
read carries a scope, a scope the database cannot separate is refused rather
than answered with the unscoped figure relabelled, and `STATS_RPCS_ARE_SCOPED`
is false exactly while the newest definition of the projection leaves
`ca_hand_player_stat` ungated. Land the migration without the client and it
goes red; flip the client without the migration and it goes red. The remaining
SQL is in `docs/runbooks/diamond-stats-asset-dimension-2026-09-20.md`.

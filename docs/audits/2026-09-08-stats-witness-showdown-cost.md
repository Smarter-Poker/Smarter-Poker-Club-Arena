# Showdown Witness Query Cost

The scheduled ca-stats-witness-audit-15m run timed out after 120.46 seconds at
20:24 UTC. Subsequent runs took 101.87 seconds at 20:39 and 97.62 seconds at
20:54. Hand settlement completion delays increased in the same window. This
correlation identifies a load contributor, not proof that it causes every gap.

The showdown check called the full SECURITY DEFINER ca_hand_player_facts_range
reader. That boundary reconstructs betting and money statistics even when the
caller selects only showdown. The replacement computes just the same fold and
non-folder facts for the same bounded hand window. Raw ID counting, canonical
UUID fold matching, duplicate seat semantics and invalid-ID filtering match the
original. All other audit blocks are byte-identical. The seven-day EV check,
financial readers, audit schedule, grace period and logging are unchanged.

## Validation and application

82 actual PostgreSQL cases compare both result multisets using EXCEPT ALL,
including every six-player fold subset and malformed/duplicate/case edge cases.
Independent heads-up expectations, the complete new audit function, persisted
result and execution grants also pass. The existing full PostgreSQL atomicity
suite passes with this probe integrated (54.03 seconds). No production wager,
seat, purchase or ledger test mutation was used.

The baseline fixture is the exact pre-change production SQL reader (prosrc MD5
ab6c6b31846ee88ae91dc9b2525d8fc2). The audit function was checked unchanged just
before application: c5dfd6daca0059571850ee42655a8bbb. The function-only migration
was applied through Supabase around 20:59 UTC and verified as
d1ee7bee735eef0e644b285d03648d9e. Anonymous and authenticated execute remain
false; service_role execute is true. No engine restart is needed for this SQL.

The next ordinary scheduled audit and fresh hand-gap samples must establish
live runtime improvement. No claim that all tail delays or the iPad connection
incident are resolved follows from these tests.

## First production result and publication

PR #3866 passed CI 34278254136 and merged at 21:06:13 UTC as
aee6fd2e4489304cc62ccdc90fa0880a1db0f322. Public and origin build-info both
served that SHA, built 21:08:33 UTC by Hetzner publication 34278658565.
The 21:09 scheduled audit succeeded at 21:10:35.560, taking 95.27 seconds.
This is not a substantial verified runtime improvement over the preceding
97.62-second run. The narrowed check removes unnecessary reconstruction, but
the overall audit latency remains unresolved. The seven-day EV candidate plan
still estimates 389,962 all-in index entries and 42,733 filtered candidates;
the old code comment describing about 400 hands no longer describes this load.
No extra production audit invocation or heavy EXPLAIN ANALYZE was used.

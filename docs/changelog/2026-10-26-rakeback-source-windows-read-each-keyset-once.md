# Rakeback source windows read each keyset once

The weekly close's original incomplete-source check performed an indexed source and batch lookup for each attribution. The planner estimated two matches in a production window containing 16,870 club sources; one original incomplete check exceeded its 18-second diagnostic limit, and the original coordinator committed only one two-hour window after roughly 135 seconds, including its other guards.

The maintained `fn_rakeback_split_counts` now joins its original bounded source and batch keysets once. Materialized full joins preserve every matching pair and missing row; the final count excludes only unmatched right rows through the original attribution primary key. Every whole-week match, NULL comparison, duplicate multiplicity, evidence check and drift check remains unchanged. This adds no payer, balance write, schedule, index or qualification shortcut.

The exact original and changed functions passed 22 fault/boundary cases under generic and custom plans in PostgreSQL 17, with original metadata preserved. The exact reserved installer also passed rollback, replay, changed-ACL and freeze refusals. A read-only production query returned all three original durable counts unchanged in 17.160 seconds, with two full hash joins, one scan per keyset and no temporary spill. That observation is a single window, not a uniform latency guarantee. The small warm native fixture is slower after the change; it proves parity and the join shape, not production speed.

Source qualification and a read-only query do not mean that the migration is installed or that rakeback has reached wallets. Those states remain recorded separately in the incident checkpoint.

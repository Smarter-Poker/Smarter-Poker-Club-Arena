# Horse upgrade cutover recovery

The horse-memory/strategy release d936ef6c failed its 75-second container replacement bound and recovered sealed74c1ff91. The memory migration committed successfully and is not replayed.

The image warm-up covered only an unpublished bridge container, while the actual engine publishes a port. Warm the published-port path before requesting maintenance, using only an ephemeral loopback port, no engine environment, no engine labels, and a replaced command that immediately exits. Keep all original cutover, proof and rollback budgets. Add timestamped phase-only receipts around the actual stop, metadata, rename and launch operations so a refusal names the last reached phase without disclosing arguments or secrets.

The warm-up coverage gap is reproduced by the maintained command fixture and repaired. The previous provider log does not establish which Docker subphase consumed the deadline, so the port path is a possible timing cause, not a claimed proven root cause. Actual protected publication, successful sealed cutover and fleet behavior evidence remain required; this source change alone is not a successful recovery.

There are1000 registered horses and8 shared decision workers. Worker health does not prove1000 individual decisions. Live acceptance must distinguish fleet routing, active-horse decision evidence, durable per-game profiles, inactive horses and unknown/missing reads. No per-horse enable flag or name-specific strategy is introduced.

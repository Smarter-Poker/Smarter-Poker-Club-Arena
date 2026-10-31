# River one-pair calls are computed where the rows are (2026-10-31)

## What was wrong

The Hold'em live measure (#8810) computed "how often does a horse that
called a river bet holding exactly one pair win, by the size class of the
bet it faced" by pulling a day of `horse_hand_reviews` through PostgREST -
12,207 NLH rows with their full action JSON, ~60 MB - to produce three
numbers. Taking the measurement needed the service key on the machine that
ran it, and exported hand data to get an aggregate.

## The fix

`public.fn_horse_river_one_pair_calls(p_since, p_limit)` (migration
`20261031024652`): the same arithmetic as `HoldemLiveMeasure.riverOnePairCalls`,
line for line, run where the rows are. STABLE, SECURITY DEFINER with a
pinned search_path, EXECUTE for `service_role` only (the table is
service-only), bounded to 14 days and 20,000 newest NLH rows, no horse flag,
never writes. One function in one transaction; it locks no hot table at
install time and reads under the `played_at` index at call time.

`scripts/dev/test-horse-river-one-pair-calls.sh` is the parity oracle: a
throwaway PostgreSQL, the migration, and the fixture hands
`server/scripts/river-one-pair-fixture.ts` writes (three size classes, blind
defence, dead ante, live ante, hero bet then raised, short all-in call, two
pair, set, board flush, board straight, wheel, fold, card strings, short
board, Omaha). The TypeScript side writes its own expected answer and the SQL
answer must match cell for cell; privileges, bounds and volatility are
asserted too. It runs in accounting shard 2 (the job with server
dependencies and PostgreSQL 17); when run as root it re-enters as `postgres`.
The oracle found one disagreement before it ever ran in CI: the SQL draft
counted a hand that ended before the river as unreadable where the
TypeScript reader counts it as read-and-not-a-river-call; the SQL now says
what the TypeScript says.

The CLI (`server/scripts/holdem-live-measure.ts report`) asks the function
first and names it in the report; it falls back to fetching rows only when
the function is ABSENT (404 / PGRST202) - any other refusal is an error, not
a guess. `riverOnePairFromRpc` adopts the function's answer only inside its
contract.

Pinned by `tests/river-one-pair-calls-are-computed-where-the-rows-are.law.test.ts`.
The ci.yml step changed the workflow's byte identity, so the six
qualification manifests and the runner-recovery fingerprint were rebound with
a source-only audit entry (`riverOnePairParitySourceAudit20261031`).

## Baseline the function reproduces (EED, 02:35 UTC, same arithmetic run as a pg_temp function)

| size class faced | calls | won | won % |
|---|---|---|---|
| small | 106 | 35 | 33.0% |
| medium | 301 | 53 | 17.6% |
| large / raised | 618 | 83 | 13.4% |

# A bust of a zero stack recorded after attestation is the same registration (2026-09-25)

The second retained 8825 manager, 615783bf (Afternoon Free Buy), refuses
every legacy checkpoint release at the same line:

```
F06_RETIRED_CANONICAL_CHANGED: registrations
PL/pgSQL function smarter_private.f06_retired_origin_transfer(uuid,uuid,jsonb,jsonb)
```

#5218's changelog read the cause from rows and recorded it for Dan's
decision rather than routing around it; #5225 made the receipt name the key.
Dan has now said the comparison is to be changed. This is that change, and
only that change.

## What differs, exactly

`smarter_private.f06_retired_origin_transfer` (20260919024642) is the guard
`fn_f06_prepare_mixed_manager_custody` runs for a retired original manager.
Before the successor may take custody it requires the live canonical snapshot
(`f06_mixed_custody_snapshot`, whose `registrations` are
`to_jsonb(public.tournament_players)` rows) to equal, whole row for whole row
sorted by text, the `canonical_proof` the original owner attested when it
stopped. That attestation is immutable.

Read-only comparison of the stored and live rows for 615783bf on 2026-09-25
13:00Z: 195 rows attested, 195 rows live, exactly one row differs,
registration `e18a7d98-7f05-4304-aa56-583abf8614af` (user `62ec986d`, seat 3
at table `9f30d335`):

| field                  | attested (immutable) | live                               |
| ---------------------- | -------------------- | ---------------------------------- |
| `status`               | `playing`            | `eliminated`                       |
| `position`             | `null`               | `12`                               |
| `eliminated_at`        | `null`               | `2026-09-18T22:12:05.712905+00:00` |
| `elimination_sequence` | `null`               | `151476`                           |
| `chips`                | `0`                  | `0`                                |
| `chip_count`           | `0`                  | `0`                                |
| `prize`                | `0.00`               | `0.00`                             |
| every other field      | identical            | identical                          |

The Noon manager, 5a387a75, has zero differences. The stack was already zero
when the origin was attested; the engine recorded the bust of that zero stack
afterwards. No chip, no prize and no seat moved. It is the same registration,
and the guard was refusing it for the four fields that only say so.

## What the migration changes

`supabase/migrations/20260925130323_a_bust_of_a_zero_stack_recorded_after_attestation_is_the_sam.sql`
replaces the transfer guard with the byte-exact 20260919024642 text
(body md5 `62d8d93f836f4edb633900f7da4ddc85`, definition md5
`c59a8710299a46b798facb7b5298ce2d`, extracted programmatically) with ONE
block replaced: the whole-row comparison inside the eight-key loop becomes,
for `registrations` only,

```sql
 IF key='registrations' THEN
 IF (SELECT count(*) FROM jsonb_array_elements(canonical->key)) IS DISTINCT FROM (SELECT count(*) FROM jsonb_array_elements(prior.canonical_proof->key))
 OR (SELECT jsonb_agg(z.n ORDER BY z.n::text) FROM (SELECT x FROM jsonb_array_elements(prior.canonical_proof->key) x EXCEPT ALL SELECT x FROM jsonb_array_elements(canonical->key) x) s(x)
 CROSS JOIN LATERAL (SELECT CASE WHEN s.x->>'status'='playing' AND jsonb_typeof(s.x->'chips')='number' AND (s.x->>'chips')::numeric=0
 AND jsonb_typeof(s.x->'chip_count')='number' AND (s.x->>'chip_count')::numeric=0
 THEN s.x-ARRAY['status','position','eliminated_at','elimination_sequence'] ELSE s.x END) z(n)) IS DISTINCT FROM
 (SELECT jsonb_agg(z.n ORDER BY z.n::text) FROM (SELECT x FROM jsonb_array_elements(canonical->key) x EXCEPT ALL SELECT x FROM jsonb_array_elements(prior.canonical_proof->key) x) l(x)
 CROSS JOIN LATERAL (SELECT CASE WHEN l.x->>'status'='eliminated' AND jsonb_typeof(l.x->'chips')='number' AND (l.x->>'chips')::numeric=0
 AND jsonb_typeof(l.x->'chip_count')='number' AND (l.x->>'chip_count')::numeric=0
 AND jsonb_typeof(l.x->'position')='number' AND (l.x->>'position')::numeric>0 AND (l.x->>'position')::numeric=trunc((l.x->>'position')::numeric)
 AND jsonb_typeof(l.x->'eliminated_at')='string'
 THEN l.x-ARRAY['status','position','eliminated_at','elimination_sequence'] ELSE l.x END) z(n)) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;
 ELSIF (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(canonical->key) x) IS DISTINCT FROM
 (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(prior.canonical_proof->key) x) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;
```

In words: the two arrays must have the same length; the rows identical on
both sides are removed (`EXCEPT ALL`, so a duplicate counts); every remaining
attested row must be `playing` with `chips=0` and `chip_count=0`; every
remaining live row must be `eliminated` with `chips=0`, `chip_count=0`, a
positive integer `position` and a non-null `eliminated_at`; and with
`status`, `position`, `eliminated_at` and `elimination_sequence` removed the
two remainders must be equal multisets. The seven other keys (`operations`,
`members`, `attempts`, `move_receipts`, `seats`, `hand_dispatch`,
`move_dispatch`) keep the strict sorted whole-row comparison verbatim, in the
`ELSIF`. The `F06_RETIRED_TERMINAL_RECEIPT_REQUIRED` check compares stored
against stored and is not touched. Nothing else in the function moves.

Post-image: body md5 `ce9c8da18aa4b596b62cc436fd22348d`, definition md5
`61bd389d3c261ee6422a9e2336c58e89`. The pre-image DO refuses unless the
installed body and definition are exactly the pre-image digests, the definer
identity is postgres / SECURITY DEFINER / VOLATILE / `{postgres=X/postgres}` /
`search_path=pg_catalog, public, smarter_private`, the strict block is present
exactly once and the relaxed block is absent. The post-image DO reads the new
digests and identity back from the catalog and proves that only the block
moved: `replace(prosrc, relaxed, strict)` must reproduce
`62d8d93f836f4edb633900f7da4ddc85` exactly. One statement of DDL, one
transaction, `lock_timeout 3s`, `statement_timeout 15s`.

## Why it is money-safe

A row is relaxed only when both sides carry `chips=0` and `chip_count=0`, so
no stack is involved; `prize`, the bounty fields, `table_id`, `user_id`,
`seat_number` and every other column are still compared byte for byte; a
live stack that busts after attestation (`chips>0`) does not qualify on
either side and refuses; a row added, removed or swapped changes the
remainder and refuses; a live bust without a positive integer `position` or
without an `eliminated_at` is not an engine-recorded bust and refuses; the
reverse transition (attested `eliminated`, live `playing`) refuses; a
zero-stack row whose `position` changed while still `playing` refuses. The
custody, the abort receipt and the terminal receipt are compared as before.

## What was proved

The native PostgreSQL 17 shared-hand lane
(`scripts/ci/test-f06-shared-hand-lane.py`) installs the migration on its
historical clone after 20260924225647 in
`scripts/ci/probes/f06-shared-hand-lane/historical_bank_qualification.py`
(`historical-registration-bust-install`, `-identity` pins the new digests)
and, through the prepare RPC on the 1402 fixture, whose attested
registrations hold exactly one playing zero-stack row:

- `historical-registration-bust-red-before`: with the 20260919024642 text
  reinstalled inside the probe, the bust refuses
  `F06_RETIRED_CANONICAL_CHANGED: registrations`.
- `historical-registration-bust-admitted`: with the migration, the same bust
  (status eliminated, position 12, eliminated_at, elimination_sequence;
  chips, chip_count, prize and seat unchanged) is admitted; the unchanged
  roster is admitted too.
- `historical-registration-refuses-{live-stack,chips,chip-count,prize,seat,
no-position,zero-position,no-eliminated-at,still-playing,added,removed,
swapped}`: each refuses `F06_RETIRED_CANONICAL_CHANGED: registrations`.
- `historical-registration-bust-refuses-changed-seat`: with the admitted
  bust in place, one chip on one live seat refuses
  `F06_RETIRED_CANONICAL_CHANGED: seats` (the other keys stay strict).
- `historical-registration-bust-refuses-late-changed-operation`: a changed
  original operation is refused before the transfer guard is reached
  (`F06_MIXED_RESERVATION_CHANGED`); `retired-origin-late-changed-move` still
  refuses `F06_RETIRED_CANONICAL_CHANGED` on the disposition path.

The native `tournament_players` gains the production outcome columns
(`chip_count`, `prize`, `position`, `eliminated_at`, `elimination_sequence`)
before attestation so attested and live rows carry the same keys. The lane
was run once with the old catalogue (every case green, the publisher-fixture
equality the only failure), the 29-function `MIXED_CUSTODY_CONTRACT` in
`server/scripts/engine-release-database-proof.py` and
`tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json` were
regenerated from the qualified catalogue, and the rerun reports
`passed: true`, `publisherCatalogEquality: true`. Install the migration
before the release's contract check: the publisher carrying the new
catalogue refuses a database still holding the old digest, and vice versa.

`scripts/ci/probes/f06-retired-origin-authority.sql` is NOT edited: it is the
source `scripts/ci/build-f06-retired-origin.py` composes 20260919024642 from,
and `retired_origin_qualification.py` refuses if that composition drifts; the
relaxed text lives in the new migration, which the lane installs on top of the
composed one exactly as production will.

Also run green: `tests/legacyEngineCheckpointAdmission.test.ts`,
`tests/engine-release-seal.law.test.ts`, `tests/legacyEngineCheckpointGuard.test.ts`,
`tests/unit/fixtureNativeCi.test.ts`, `check-new-migration-version-collisions`,
`check-money-trigger-declared`, `check-no-new-band-aids`,
`check-lease-lock-strength`, `check-definer-authorization`,
`check-unqualified-writes`, `check-stranded-writers`, `verify-source-bindings`.

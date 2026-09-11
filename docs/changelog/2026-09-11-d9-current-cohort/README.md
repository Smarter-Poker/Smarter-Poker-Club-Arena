# D9 current cohort and execution prerequisites

Read-only production queries on September 11 find **40** old REGISTERING events,
all scheduled September 8 between 12:49:30 and 14:51:04 UTC. They hold 2,164.60 in
advertised prize pools. The old count of 79 is historical; 17 additional rows
created September 8 are scheduled for later dates and are excluded. A search of
every older REGISTERING start date, including NULL starts, finds only these 40.
All 134 captured entrants are currently marked as horses.

| Current class | Events | Advertised pools | Required next step |
| --- | ---: | ---: | --- |
| Unpaid with an evidenced final survivor | 28 | 1,551.60 | Prove legacy finish compatibility and each native settlement batch |
| Unpaid with two positive players and no valid finish | 11 | 460.00 | Rehearse exact entry refunds and terminal cancellation |
| Partly paid, requiring compatible adjudication | 1 | 153.00 | Preserve 99.88 already paid and resolve historical finish evidence |

These are classifications, not completed settlement rehearsals. Batches must
contain at most ten events and follow the shared 20260911110000 migration. Pool
figures are not promised refund amounts; exact entry receipts, fee/reserve paths
and the native refund authority determine refunds.

Every one of the 82 already-eliminated player rows has a NULL historical
`elimination_sequence`. Current `fn_settle_tournament_places` refuses these rows
before ranking. The stamping trigger assigns sequences only on insertion or a
first eliminated transition and refuses direct changes; replaying elimination
does not fill the missing value. No status toggle or sequence write was made.
A private accepted-settlement witness helper and compatible ordinary finish
integration are separate implementation work, with native proof still required.

One of the 28 finish cases, `9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8`, records
survivor `345e5562-05ac-4c1f-9154-64bf8339806b` with 300 roster chips while
accepted hand 8217132 wrote 900. Both other players have accepted zero-stack
witnesses. This mismatch remains in the receipt as a prerequisite; the event is
not dropped, its chips are not overwritten and no winner is chosen from cache.

## The paid event

`f370585d-40ea-4085-bb8f-c7e8c74f3fb4` has 34 players and four settled places
2-5 totaling **99.88**, with 53.12 prize and 17.00 fee escrow remaining. Its
current version 3 five-place ladder already matches every paid row; no contract
restoration is indicated. Four exact wallet credit identities, 38 ledger and
wallet rows, 34 entry entitlements and 34 rake records are captured.

The roster has 32 eliminated players and two marked playing. One playing row,
`9ee591b7-2360-4ea8-ad3b-942ef829fbda`, is zero: its last accepted hand was
8209603 at 14:27:42.207662 UTC, beginning at 8,242 and writing zero. The other,
`ae0bc48d-f98c-4b25-a9fa-e3522f986173`, is recorded at 430,255, matching hand
8215917 at 14:44:23.416750 UTC. All 33 other entrants have accepted zero-stack
witnesses. These observations do not authorize rewriting the paid standings,
choosing a winner or refunding all entries. This event is an explicit unresolved
paid-history prerequisite before D12 activation.

## Reproduce the classification

```sh
python3 scripts/ci/classify-d9-current-cohort.py
```

The script verifies a sealed archive, reclassifies the captured facts locally,
and prints the receipt path. It makes no database or network calls. The input
manifest records each source checksum and the exact current membership
predicate. Full per-event classifications retain all 40 IDs and prerequisites;
they do not collapse ambiguous cases out of the workload.

No production SQL, source mutation, wake, payout, refund or proposal was made.
Refresh membership and source pins before preparing each actual batch. Native
batch rehearsal and compatible financial authority remain required.

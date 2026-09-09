# 2026-09-09 — Forty-nine bounties that could never be paid

## The state, read not assumed

`fn_claim_bounty_legacy_candidate` refuses any bounty claim for a hand before
the tournament's PKO settlement watermark — `pko_order_already_advanced` —
because a progressive bounty's halves must settle in hand order. The guard is
right. But a hand number never changes, so a claim that arrives late is refused
**for ever**.

The elimination sweep was handing busts over in the wrong order (it sorted by
chips, and every busted candidate holds zero, so the order was whatever Postgres
returned). #3920 fixed that. It stops new strandings; it cannot release the ones
already behind.

| tournament                            | stranded | window | eliminated | obligations | last hand |
| ------------------------------------- | -------- | ------ | ---------- | ----------- | --------- |
| `1776979f` Late Night PKO (PLO4)      | 12       | 19     | 7          | **7**       | 22:46     |
| `32994c65` DSS Tuesday $16.50 NLH     | 15       | 21     | 6          | **6**       | 01:14     |
| `a50be0b4` Union PKO Afternoon (PLO4) | 22       | 33     | 11         | **11**      | 19:00     |

All three RUNNING and dead — between two and eight and a half hours of no hands.
Together they held 61 players still `playing`, of whom 49 held zero chips: the
stranded ones, blocking the field count so the events could neither progress nor
end.

## Why this was safe, which is the whole argument

- In every window this re-exposes, bounty obligations **equal** the
  already-eliminated candidates — 7/7, 6/6, 11/11. Each of those is settled and
  its candidate already reads `eliminated`, which the claim RPC skips.
- Every one of the 49 pending candidates has **zero** obligations. Their bounties
  had never been paid to anybody. There was nothing to duplicate — settling them
  pays a _first_ time.

So the hazard the watermark exists to prevent is provably absent here. The
migration asserts that invariant itself and **aborts rather than commits** if it
does not hold at apply time, and asserts afterwards that no candidate is left
behind a watermark.

Proved first in a transaction that aborted itself (CLAUDE.md 11.5 rule 1):

```
PROBE OK rows=3 invariant_violations=0
  | 1776979f mark=8364652 stranded=0
  | 32994c65 mark=8403336 stranded=0
  | a50be0b4 mark=8222597 stranded=0
```

## Who gets what

Each of the 49 is a player who busted and was never recorded as out. Their
knocker receives the bounty share the platform's own claim path computes,
through that path, once. Nobody is charged, nobody is reversed, and no player
already paid is touched — their candidates read `eliminated` and are skipped.

## Not a band-aid

CLAUDE.md 10.12: this builds no back-pay job, no sweep, no compensating write.
It corrects **one cursor value per tournament** so the platform's own live
elimination path can do the work it was always supposed to do, and the root fix
that stops it recurring (#3920, busts processed in hand order) is already
shipped. Nothing here runs twice and nothing here runs again.

## Measured after applying

Within five minutes: stranded candidates **49 → 2** (and those two are fresh
churn behind the newly-advanced mark, which is the guard working normally), and
**two bounty obligations created** — the first payments these knockouts have ever
produced.

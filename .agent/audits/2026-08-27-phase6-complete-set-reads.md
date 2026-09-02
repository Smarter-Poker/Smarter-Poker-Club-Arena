# Phase-6 — the complete-set pass: "all of them" now means all of them

Date: 2026-08-27 · Agent: cowork-mobile · Scope: **Club Arena only**

Closes the item phase 5 left open. Dan: "there should never be a cap on the
amount of players in the club, union or anywhere else."

## One helper, tested, instead of eight hand-rolled loops

`src/utils/fetchAllRows.ts` pages a Supabase query until the server returns a
short page. It takes a query FACTORY, because a Supabase builder is single-use
(awaiting it sends it), so paging must rebuild the query per page.

It **rejects on the first failed page** rather than returning a partial set: a
caller asking for "all of them" cannot tell a short answer from a complete one,
and quietly handing back half a roster is the failure this exists to prevent.
Its `maxPages` is an anti-runaway assert that throws, not a data cap.

8 specs, including the off-by-one that silently drops the last page when the
row count is an exact multiple of the page size.

## What was TRUNCATING PRODUCTION, measured

| read                           | cap | reality that day                                                                                 |
| ------------------------------ | --- | ------------------------------------------------------------------------------------------------ |
| **ClubDetailPage member list** | 500 | **SHARK CLUB 590 members, Club JAQK 584** — 90 and 84 members missing from their own club's list |

That one was already ORDERED by `created_at`, which the previous note treated
as the fix. Ordering made the missing members _predictable_, not _present_ —
and predictable meant it was always the NEWEST joiners who were invisible: the
members most likely to be searched for.

Latent, fixed anyway:

| read                        | cap  | what truncation would do                                           |
| --------------------------- | ---- | ------------------------------------------------------------------ |
| StatsExport roster          | 5000 | a roster export an owner trusts, silently short                    |
| AgentAssignmentPanel        | 2000 | a member absent from the roster reads as "does not exist"          |
| AgentPromoPanel             | 1000 | a player who can never be sent a promo                             |
| `admin.ts` union clubs      | 100  | **an AUTHORIZATION path** — a union admin of club #101 gets DENIED |
| TournamentResults myEntries | 5000 | a player's own tournament history, oldest lost                     |

All now page, ordered, because paging an unordered query can serve a row twice
or skip it.

## The one I deliberately did NOT "fix"

`StatsExport.fetchOwnHands` scopes through a club's tables with `.limit(200)`.
The busiest club holds **36,403 tables**, so that scope really is a fraction —
and the instinct is to page it away.

**That would break the export.** Every table id rides in the query string of
the FOLLOWING request; the file's own comment records the measurement (~1000
uuids ≈ 37 KB URL, servers answer **414**). Paging to 36,403 ids guarantees a
failed request. Fetching the club's 1.56M hands into a browser tab to build a
CSV is its own denial of service.

So the cap stays and the **silence** is what got fixed: the limit is a named
constant explaining the protocol constraint, the code records when the scope
actually clipped, and the user is told —

> "Scoped To This Club's 200 Most Recent Tables. Older Hands Are Not In This File."

— instead of a bare "Exported N rows" that reads as complete. The real answer
is a server-side export that never puts ids in a URL; that is a feature, not a
cap removal, and it is recorded as the follow-up.

## Guards

`tests/unit/CompleteSetReadsDoNotTruncate.test.ts` (13 specs) pins each
complete-set read as paged AND ordered, and separately pins that the hand
export keeps its scope limit and admits to it — so a future agent cannot
"helpfully" page it into a 414. **Mutation-tested**: reinstating the 500 cap on
the member list turns it red.

## Verified

client `tsc` clean · **7,422/7,422** · server `tsc` clean · **1,967/1,967**

## Deliberately left alone

Genuine UI paging — search dropdowns at `.limit(10)`, a 4-seat table preview,
the online-friends pill. Deleting a limit is not automatically an improvement.

## Follow-ups recorded, not done

- A server-side hand export (removes the 414 constraint entirely).
- `union_clubs`: 6,590,684 reads on a 2-row table — hot-path re-query.
- The 4 real reconciler criticals and 166 stranded `chip_escrow_holds` —
  financial decisions.

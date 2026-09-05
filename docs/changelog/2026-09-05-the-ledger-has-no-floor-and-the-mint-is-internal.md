# The diamond ledger has no floor, a send leaves a record, and the Mint is internal

2026-09-05. Club Arena. Branch `agent/cw-wallet/fix/realism-polish`.

Three things Dan asked for after reading the wallet audit, in his words:
"1, GO AHEAD AND DO THIS. 2, THEY SHOULD NEVER SEE OF HAVE ACCESS TO THE MINT,
THATS INTERNAL SYSTEMS. 3, GO AHEAD AND BUILD THIS."

---

## 1. The Receive pane had a floor under it and did not say so

`loadIncoming` read `.limit(25)` and stopped. No continuation, no count, no
line admitting the cut - a player with a longer ledger saw their newest 25
credits and had no route to the rest, and no way to tell a complete ledger from
a truncated one.

Measured on production before touching it:

|                                 |             |
| ------------------------------- | ----------- |
| players holding diamond credits | 645         |
| players past the old 25 cap     | 6           |
| longest ledger                  | 390 credits |

So it was not hypothetical. One player could reach 25 of their 390.

**Fixed** with real pagination - `.range()`, a Load More, a "that is every
diamond you have received" line when the ledger ends, and the count.

### The tiebreaker is the part that matters

`.range()` only partitions a set under a TOTAL order. Ordering by `created_at`
alone leaves rows sharing a timestamp in no defined order, so Postgres may
resolve them differently per window: one row is served twice and another is
skipped, silently.

Measured on that same longest ledger:

|                                                       |                                   |
| ----------------------------------------------------- | --------------------------------- |
| rows sharing a timestamp with another                 | 41                                |
| largest tie group                                     | **29 - larger than a whole page** |
| pages that group spans                                | 2                                 |
| rows sitting on a page seam inside an ambiguous group | 2                                 |

`id` is a uuid in a unique index, so `.order('created_at').order('id')` makes
the sequence total. Walking all 16 pages of that ledger with the client's exact
ordering returns 390 rows, 390 of them distinct: nothing served twice, nothing
missed.

Another agent hit this same class the same day on `/friends` - `friendships`
paged by `created_at` with a 214-row tie group, rendering 1,274 of 1,309
friends, a different 35 vanishing per load - and wrote
`a-complete-read-is-ordered-by-something-unique.law.test.ts` for it. Rather
than write a second law saying the same thing, the diamond ledger was **added
to theirs**. One rule, one place.

That law had two holes, both closed here:

- it matched `/\.range\(from, to\)/` literally, so every paged query computing
  its window inline (`.range(from, from + N - 1)`) was exempt by accident;
- widened, it then matched `.range()` inside COMMENTS - including the comments
  in FriendsPage that document this very fix - and reported a violation in the
  sentence recording the repair. It blanks comments first now, preserving byte
  offsets so the lookback window still lands correctly.

Both directions verified: removing the `.order('id')` from the hook turns the
law red; restoring it turns it green.

## 2. A completed send left no trace the player could go back to

A transfer succeeded, the toast expired, and then: Receive filters to credits
(`amount > 0`), and the Ledger tab reads the CHIP tables (`wallet_transactions`,
`chip_ledger`). **A sent diamond appeared on no surface in the wallet at all.**

**Fixed** with a "Diamonds You Have Sent" panel in the Send pane, refreshed the
moment a transfer completes - so the send confirms itself without a reload.

It is read by KIND rather than by `amount < 0`, because `diamond_gift_refund`
is POSITIVE and belongs to the send story: it is what the transfer route writes
when the recipient's credit fails after the sender has already been charged
(`pages/api/store/diamond-transfer.js` line 651). A sign filter would have
hidden the one row a sender most needs to see. The kinds were read out of the
route, not guessed.

The sign is rendered from the row rather than from the pane, so a refund in
that list is not drawn as another outgoing.

## 3. The Mint is internal, and now it is law

I had reported "the Mint is invisible to players" as a GAP and offered to show
per-row diamond provenance. Dan's answer was the sentence at the top. **The
proposal was mine and it was wrong**, and the next agent auditing this page will
reach for the same idea for the same reason: the register knows the origin, the
ledger row does not show it, and that looks like something missing.

Audited on all three layers before writing anything:

| layer      | state                                                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database   | RLS on `ca_mint_ledger` / `ca_mint_policy` gates SELECT on `profiles.role IN ('admin','god','superadmin')`. Impersonating a real non-admin: a PLAYER sees 0 mint rows and 0 policy rows; an ADMIN sees 3,157 - so it restricts rather than merely blocking |
| Club Arena | zero reads of any diamond-Mint identifier anywhere in `src/`                                                                                                                                                                                               |
| World Hub  | only `/horses`, a staff page, which refuses a non-operator and signs them out                                                                                                                                                                              |

The three existing mint laws pin CHIP-mint function grants only
(`mint_club_chips`, `fn_mint_club_chips`) - a real gap for diamond-Mint player
visibility. `tests/the-mint-is-internal.law.test.ts` closes it: no file under
`src/` may name the register or its readers, the wallet reads only the player's
own `diamond_transactions` journal, and the migration's admin-only policy and
`anon` revoke stay in place. Verified in both directions - planting
`ca_mint_ledger` in the wallet turns it red.

The law deliberately pins the five identifiers rather than the word "mint": a
club owner minting CHIPS into a treasury is a player-visible flow and stays
that way.

## Housekeeping in the same merge

- The Receive and Send panes became two directions of one query, so the paging
  moved into `src/hooks/useDiamondLedger.ts`. The pins that read it moved with
  it rather than being dropped (house rule 8).
- A refresh MERGES rather than resets. These panes refresh themselves on
  `BALANCE_UPDATED`; re-reading as a reset would have collapsed a player who had
  paged to 100 rows back to 25 the instant a diamond landed - a worse defect
  than the cap being removed.
- A failed LATER page keeps the pages already read, and offers Retry. Only the
  first read has nothing to preserve.
- `global-css-does-not-leak-across-pages` ratcheted 164 -> 162: main set 164
  while the wallet's two leak fixes were still on this branch.

## Files

    src/hooks/useDiamondLedger.ts                                   new
    src/pages/PlayerWalletPage.tsx                                  Receive paged, Send records itself
    src/pages/PlayerWalletPage.css                                  .vault-btn--wide, .is-outgoing
    tests/the-mint-is-internal.law.test.ts                          new law
    docs/laws.d/the-mint-is-internal.md                             registry entry
    tests/a-complete-read-is-ordered-by-something-unique.law.test.ts widened + comment-blind
    tests/wallet-casino-realism.test.ts                             pins moved and extended
    tests/global-css-does-not-leak-across-pages.law.test.ts          ratchet 164 -> 162

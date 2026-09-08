# LAWS.md — the single registry of binding laws

Created 2026-09-01 after the hamburger-menu revert war (#2321 -> #2401 ->
#2429 -> #2432): two law tests demanding OPPOSITE artwork coexisted in
different worktrees, and every agent that read one re-reverted the other's
work. Two laws fighting is not a stricter repo, it is a coin flip decided by
whichever test the next agent notices first.

## The rules of this registry

1. **Every `*.law.test.*` file must be listed here.** Enforced by
   `tests/law-registry.law.test.ts` — an unregistered law test fails CI with
   instructions to add it below, in the same commit that writes it.
2. **Laws are read from `origin/main`, never from your local tree.** Worktrees
   go stale by hundreds of commits; a stale tree carrying a retired law is how
   the revert war sustained itself. Before enforcing any law, confirm it still
   exists on current `origin/main`.
3. **Never resolve a conflict between two laws by writing a third.** If you
   find two entries (or two tests) demanding opposite things, STOP and ask
   Dan. Record his answer here and delete the loser in the same PR.
4. **Retiring a law** requires deleting BOTH the test file and its row here in
   the same PR, with the reason in the PR body. A row without a file (or a
   file without a row) fails CI.

## Resolved conflicts — do not reopen

- **Where union promo to a club lands (resolved 2026-09-05, Dan):** in the
  club's **PROMO WALLET** (`clubs.promo_balance`), not the Club Bank. The
  2026-09-03 promo model (`promo-is-disbursed-by-the-owner.law.test.ts`) had it
  land in `chip_treasury` "never a promo_balance" and refused a union club its
  own promo wallet. On 2026-09-05 Dan sent promo from the Midway Union to two
  clubs, opened each club's Promo Wallet, found 0.00, and reported the chips
  missing. Put to him as a choice between the two rules he chose the club
  Promo Wallet. So: `fn_union_promo_send(destination => 'club')` and
  `fn_promo_disburse(target => 'club')` both credit `clubs.promo_balance`; a
  club inside a union spends its own promo wallet through
  `fn_club_promo_wallet_send` (into a player wallet as cash, or an agent promo
  float); "promo chips are treated exactly like regular chips" holds at the
  point they reach a PLAYER. Every promo wallet carries a ledger
  (`fn_promo_wallet_ledger`). The union modal routes a club send by the wallet
  that is open: `union-promo-goes-to-the-promo-wallet.law.test.ts`.
- **The rake treasury has no club route (ruled 2026-09-05, chip standard under
  CLAUDE.md 10.9, handed back by Dan):** the union rake wallet is held IN TRUST
  for the member clubs and leaves ONLY through the weekly union close
  (`20260820b_rake_only_to_treasury`,
  `20260903161443_the_weekly_union_close_pays_from_the_rake_treasury_and_only_from_it`;
  `fn_union_move_rake_to_chips_atomic` retired). A manual rake-to-club send
  would spend money that belongs to the clubs on a basis nobody attributed, so
  it is not built: the union modal refuses it with a sentence and points at the
  Union Bank (`clubSendRoute`, `union-promo-goes-to-the-promo-wallet.law.test.ts`).
  Do not add a route.
- **A satellite seat is ordinary money in the target's escrow (ruled
  2026-09-05, chip standard under CLAUDE.md 10.9, handed back by Dan; Phase
  5.3):** the seat's value moves from the satellite's own pool into the
  target's escrow on the `tourney:<satellite>:seat:<user>:pool_transfer` leg.
  A qualifier who unregisters is refunded it in cash like any entry; a
  cancelled target refunds every qualifier in cash like every other entrant
  (`20260905200041_a_cancelled_target_refunds_the_satellite_seat_it_holds`);
  a winner who already holds the target seat, bought with their own chips or
  won in a different satellite, is paid the seat's value in cash
  (`20260905195011_a_cash_entrant_who_wins_a_seat_is_paid_the_seat_in_cash`).
  There is no ticket and no separate ticket liability: the escrow already
  holds it.
- **Hamburger menu artwork (resolved 2026-09-01, PR #2432):** the hamburger
  STAYS on every drawer trigger. "Em bars" in Dan's 2026-08-20 instruction
  means EM DASHES (U+2014) in player-facing copy — a punctuation rule, not an
  artwork rule. The law is `approvedHamburgerGearGuard.law.test.ts`. The
  retired counter-law (`noThreeBarArtwork.law.test.ts`) must not come back.
- **Unpaid hands (resolved 2026-09-01, Dan, PR #2554):** Dan's rule is
  "MUCKED HANDS SHOULDN'T BE RECORDED AND TRACKED, ONLY HANDS WHERE THE HERO
  PUTS CHIPS IN POT." Applied to `ca_hand_facts`, which stored `hole_cards` on
  every dealt hand including hands folded for free (640 of 2,265 rows, 28%).
  **The exact holding is gone** and is stripped at the database by
  `trg_ca_hand_facts_strip_unpaid_holding`. **The 169-bucket `hand_class` label
  STAYS, and Dan chose this explicitly when the question was put to him.**
  Do not "finish the job" by stripping it too: it is not decoration, it is the
  DENOMINATOR of two things. `fn_nit_check` judges NIT Game eviction on
  `avg(vpip)` across every row a player has, and `ca_player_hand_grid`'s default
  view is `hands_vpip / hands` per class. Remove the label and the chart reads
  100% everywhere while nit eviction quietly stops evicting - a rule that fails
  OPEN, which nobody notices. The law is
  `noCardsForHandsNobodyPaidInto.law.test.ts`.
- **Horses are players (2026-08-27):** no `is_horse` exclusion anywhere except
  identification and the horse's input device. See CLAUDE.md 10.5.
- **A VIP-gated, per-user squeeze does not break Animation Law 10.6 (resolved
  2026-09-05, Dan):** 10.6 forbids "a toggle that disables an animation
  outright". The VIP all-in squeeze (`user_table_settings.all_in_squeeze`,
  the perk that lets an all-in VIP drag or touch a run-out card open) is a
  DIFFERENT PROFILE for one viewer, not the absence of one: with it off, or
  for a non-VIP, or for every other seat at the table, the card still lands,
  still animates its full ordinary reveal for its full duration, and still
  makes its sound. That is the same mechanism `resolveCardAnimationProfile`
  already uses for spectator, background and mobile, and 10.6 has never
  objected to those. What 10.6 WOULD forbid is a setting under which the card
  appears with no animation at all, and no such setting exists (`off` is
  still never a user choice). Pinned by `tests/unit/vipAllInSqueeze.test.ts`
  ("Animation Law 10.6 is intact"). Do not read the perk toggle as a 10.6
  violation and remove it; do not read 10.6 as a reason to give the squeeze
  to seats Dan excluded.

- **The header portrait's frame is a 0.5px black hairline and the baked
  ornament is masked (ruled 2026-09-07, Dan, fourth time):** the approved
  artwork bakes a silver ring with a blue glow around the profile slot. That
  ring is never shown. `.profileBtn` paints an opaque `#000` disc over the
  whole ornament at every width - centred on it, covering the glow (r 52 on
  the 1648x168 plane) and clear of the rails (r 62) - and the photo's only
  frame is `border: 0.5px solid rgba(0, 0, 0, 0.94)` on `.profileAvatarSlot`,
  declared once. Dan, 2026-09-07, with a screenshot of the ring: "the profile
  pic is supposed to be a .5 pixel black frame that 'appears invisible'
  instead of this thick broken frame that exists now. once you fix it back, i
  need you to harden it, and make it regression proof." Earlier, the same:
  2026-08-31 (#2183, #2305, #2366 - ring removed, thin black edge, 0.5px),
  2026-09-03 ("INSTEAD OF HAVING THE .50 PIXEL BLACK INVISIBLE CIRCLE
  FRAME"), 2026-09-05 ("NOT IN ITS FRAME"). The loser: the 2026-09-01
  "aperture" treatment (#2515) that removed the disc below 901px, seated the
  photo inside the ring and wrote tests calling the disc "a shape drawn over
  approved artwork" - which is why the 09-03 and 09-05 fixes restored only
  the hairline and left the ring. "NO BOXES OVER HEADER ICONS" is about focus
  rings on icons; the disc is its one deliberate exception. Pinned by
  arithmetic in `the-header-portrait-frame-is-a-hairline.law.test.ts` and by
  rendered pixels in `tests/e2e/header-portrait-frame.spec.ts`. The World Hub
  and Club Commander headers carry the identical rule
  (`GLOBAL_HEADER_PROFILE_FRAME_LAW.md` in the World Hub repo). Do not show
  the ring; do not read "fix the profile image" as "show the ring".

- **The next hand deals two seconds after completion (ruled 2026-09-07,
  Dan):** "LOTS OF HANDS ARE NOT STARTING THE NEXT HAND 2 SECONDS AFTER THE
  HAND IS COMPLETED ... SOME UP TO 10 SECONDS+." "Completed" keeps its
  2026-08-21 meaning (winning hand shown, pot pushed with its total, cards
  mucked - the end of `handCompletionHoldMs`); from there to the next deal is
  `HAND_COMPLETION.NEXT_HAND_REST_MS`, 2000ms, and it is the whole gap. The
  2026-09-05 ruling that the hand rests 1.75s for the Rabbit Hunt button is
  not reversed but absorbed: the button's window IS the rest
  (`RABBIT_HUNT_WINDOW_MS` is the same number), and a purchase "displays and
  moves on" - it never touches the schedule. The loser is the shape in which
  the engine slept the board clear and the window and only then went to wait
  for settlement, reload the roster, sweep the leavers and allocate a hand
  number, each a PostgREST round trip at 250-700ms from the engine box:
  measured p50 11.2s / p90 20.6s between hands on 2026-09-07. All of that now
  runs under the rest. The five-second rebuy pause (2026-08-24) is untouched
  and remains its own beat. Pinned by
  `the-next-hand-deals-two-seconds-after-completion.law.test.ts`; measured by
  `/health.nextHandGap`.

## Registry

**The registry is the directory `docs/laws.d/` - one file per law.** This
table used to live here, and every law appended to its last line, so any two
law-bearing pull requests conflicted with each other on this file. Measured
on 2026-09-04: one PR went merge-dirty FOUR times in an afternoon on nothing
but this table. That is the same failure `MIGRATION-CHANGELOG.md` had
(CLAUDE.md 10.9), fixed the same way: two files written independently cannot
conflict.

Each file is `docs/laws.d/<slug>.md` and reads:

    # tests/<the-law-test-file>.law.test.ts

    <one line: what it guards>

`tests/law-registry.law.test.ts` enforces both directions: a law test with
no file here fails CI with the exact file to create; a file here whose test
no longer exists is a ghost and fails CI too. Rules 1-4 above are unchanged;
"its row here" now means "its file in `docs/laws.d/`".

To read the whole registry as one table:

    node scripts/laws-registry.mjs

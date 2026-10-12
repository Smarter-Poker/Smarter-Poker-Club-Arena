# A buy-in draws from the wallet that can pay, and no unfunded seat is held

Dan, 2026-10-12 (items 4 and 5 of that day's list):

> 4, Club arena - can't buy into tournaments or cash games even with chips in account.
> 5, A player should not be able to "hold a seat" if they don't have sufficient chips. That
> should be checked before the seat is "reserved". And there is not point to have a pop up with
> "This seat is reserved click to take it." That's already assumed and doesn't need a pop up.

## What happened, read from rows

Dan plays as **kingfish**, the owner of Club JAQK, SHARK CLUB, Midway Union and Deep Stack
Society. On 2026-10-11 at 21:48 UTC the Join Game door held him a chair at NLH 2/5 Classic
Feeder (a Midway Union game; `table_waitlist` row `c4970393`, expired unused). The buy-in
sheet showed BALANCE 4.50 against a 200 minimum. The Evening Mystery Bounty (PLO5) Sign Up
card showed 0 Chips against a 15 entry. His SHARK CLUB wallet held about 2,650 at the time.

The 484.2K figure on both screenshots is the Diamond Spins button: diamonds, not chips.

1. **A union game charges one member club,** the club the player came in through when it is a
   member club, otherwise their oldest membership. For kingfish that was Club JAQK (4.50 then).
   Nothing asked whether that wallet could pay, so every union buy-in and entry was refused
   while another of his clubs in the same union could cover it many times over.
2. **The Sign Up card asked by the tournament's club,** which for a union event is the union's
   house club (Midway Union, 0.00). The entry is charged to a member club, so the card showed a
   wallet that is never charged.
3. **The join door held the chair first,** for sixty seconds, and only the buy-in asked about
   money afterwards. The waitlist offer did the same.
4. **The "Seat Held, Tap To Take It" card and the "A Seat Just Opened For You" toast** sat on top
   of the buy-in sheet that the same hold had just opened.

## What changed

Migration `20261012131301_a_buyin_draws_from_the_wallet_that_can_pay_and_no_unfunded_s`:

- **Cash buy-in** (`atomic_table_buyin`): when the default wallet cannot cover the amount, the
  player's union member club that can (richest, ties to the oldest membership) is passed to the
  gate as the preferred club. `fn_seat_club_for_user` already honours a preferred member club,
  so the debit, the seat stamp and the cash-out all name it. Nothing changes when the default
  can pay, at a standalone club table, at a Diamond table, or for a player already seated in the
  union (one club at a time).
- **Buy-in sheet** (`fn_player_spendable_balance`): reads the wallet the buy-in will spend, by
  the same rule at the table's minimum.
- **Tournament entry** (`fn_register_for_tournament`, `fn_register_horse_for_tournament`): when
  the default member club cannot cover the entry, the door declares the club that can for this
  transaction only (`app.ca_entry_paying_club`, keyed on tournament and player).
  `fn_tournament_club_for_user` honours it, so the debit, the wallet log and the roster stamp
  agree. The person's door and the horse's door use the identical rule (CLAUDE.md 10.5).
- **An entry's later money** (`fn_tournament_club_for_user`): once on the roster, rebuys,
  re-entries, add-ons and prizes resolve to the club stamped on the entry. Refunds already used
  the club the charge left (`tournament_refund_entitlements.refund_wallet_club_id`).
- **Sign Up card**: the client now reads the balance by tournament
  (`WalletService.readPlayerBalance({ tournamentId })` -> `p_tournament_id`).
- **Holds** (`fn_cash_game_join`, `fn_offer_open_seat`): no chair is held for a player none of
  whose spendable wallets covers the table's minimum (rejoin floor included). The join door
  refuses with `INSUFFICIENT_CHIPS:<need>` before writing anything, and the lobby says "Not
  Enough Chips. You Need At Least 200 Chips To Join This Game." The waitlist offer passes such a
  player over for that seat and keeps their place, as it already did for a capped player.
- **No hold popup**: the waitlist banner shows a place in line only, and the listener raises no
  toast for a held seat. The buy-in sheet still counts the hold down in its own pill, and a
  player waiting elsewhere is told by the "Seat Open" notification `fn_offer_open_seat` writes
  (bell and push).

## Proof

Every function was copied from production and proven byte-identical (md5 of
`pg_get_functiondef`) before it was edited; the migration refuses to install over anything else.

Before applying, a rolled-back probe ran the new functions as temporary copies against live rows:

| Case                                                    | Result                          |
| ------------------------------------------------------- | ------------------------------- |
| kingfish, 2/5 Feeder, came in through Club JAQK (24.50) | charged and shown SHARK CLUB    |
| kingfish buy-in sheet                                   | 2,653.74 (SHARK CLUB)           |
| kingfish Sign Up, 100 Chip Spin PLO6                    | 2,653.74 (SHARK CLUB)           |
| danbek4545 (Club JAQK 10,000 covers it)                 | unchanged                       |
| Smarter.Poker Official (no wallet holds 200)            | join refused, no hold           |
| Declared club for kingfish, resolved for danbek4545     | not steered (Club JAQK)         |
| A club the caller names                                 | still wins over the declaration |

Law: `tests/a-buyin-draws-from-the-wallet-that-can-pay.law.test.ts`. The banner tests
(`tests/unit/seatHoldCountdown.test.ts`, `tests/unit/globalWaitlistSdkTransport.test.tsx`) now
pin that no held-seat card or toast appears; they pinned the card's internal clock (Dan
2026-09-23) until this ruling replaced it.

## Resumption checkpoint, 2026-10-12

Owner: Codex chat 01a13098-81c7-7b23-85a3-b91f942922d2, explicitly taking over the prior Claude assignment. Private checkout: /Volumes/SmarterWork/agent-work/poker-features-resume-01a13098/repo; local branch codex/poker-features-resume-01a13098; existing delivery PR #6763, remote fix/buyin-seat, inherited head 3aff164de1e61120e47b0c2fd9ce8f6d1d8fc776. No matching local original worktree; source recovered from the existing remote PR. PR auto-merge disabled for direct owning-agent protected integration. No engine source changes or new engine dependency; client/database delivery.

Fresh canonical policies read through agent-policy.mjs at 2026-10-12T14:51:23.101Z: version 2.9, manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b; OWNER-POLICY b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; OPERATING-LAW a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; HARDENING d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; REFERENCE-INDEX adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555. Canonical MAC-STORAGE, repository AGENTS/CLAUDE/AGENT-PLAYBOOK/PUBLISHING/deploy-paths and this checkpoint read. Both SSD volumes mounted as separate disks, 43GiB work and 215GiB archive free at startup. Locked root dependencies installed in this task's private SSD directory/cache.

Inherited CI 38262870576 failures diagnosed from exact job logs:

- Client shard 3: overload law treats the existing fn_register_for_tournament(uuid) compatibility wrapper followed by its required two-argument implementation as a signature replacement. Live readback confirms the two-argument boolean has NO default; wrapper delegates with false, ACL postgres only; implementation ACL postgres/service_role only. Preserve installed migration, both callable signatures and access. Add the documented deliberate pair plus assertions that its latest two-argument definition requires the boolean and the single-argument door lacks it; ambiguous defaults remain prohibited.
- CSS Beat financial-decisions: old browser scenario still demanded the removed held-seat card. Replace it with a real queue event, mobile fit and 44px dismiss hit-area checks, then the offer event removing the card with no popup or navigation. Keep subsequent queue/dismiss functionality proved through the mounted consumer.

Read-only migration-history confirmation: version 20261012131301 installed in PokerIQ-Production kuklfnapbkmacvwxktbh. No replay or new DDL. Registration implementation md5 88dc44b7cb63b2bd845f89d672335b97; compatibility md5 52ae0199d26af5deeaa5d865ef178c39. Prior rolled-back probe evidence remains inherited, not re-labelled as newly executed. New local verification, protected checks, merge, static publication, both endpoints and affected live behavior are pending at this checkpoint entry.

Local resumption verification: inherited overload law reproduced failing (1 failure/5); repaired focused suite passes 30/30 across five files. `npx tsc --noEmit` passed; Prettier of the three changed executable files passed; title-case, painted-text, UI text, diff whitespace and canonical policy comparison passed; policy scenarios 18/18 passed. Real mobile browser financial-decision suite passed 3/3 after installing the configured iPhone WebKit browser in the task SSD directory. Initial browser launch was unavailable (WebKit missing), not an application failure; Node 26 browser download stalled, task-owned downloader processes stopped, maintained Node 24 installation succeeded. No check bypass or config change.

Phase 1 recovery: CA #6743 c76fa16970c1c579d5e34c23ecafef2a33bafa2e (owner player-wallet selection), #6744 1c2c5cebd9 (scroll-direction filters), #6745 11b06ffaccd236bb7838b90e1285c0c495955159 (Lifetime VIP rabbit label) merged; both public client identities 514f1116886208d0f36eaee61db7a434351f3d74, publisher 38259327997 terminal success. World Hub #2317 13ae002444b15eba747c7eadbc29d9ead6c7959d merged; live health b5645a336cf6c0ee367c1b13087a5313f66ccb7f, deployment dpl_5iSV8ms9LtdQAGE75r1sQsd5fqhg. Browser visibly confirms Poker Arena is first top-row card and centered starting carousel card, and first Quick Navigation link. Live Odds Calculator: AA versus KK completes 10,000 runouts with equities 82.9/17.1 in observed simulation; card picks reject reuse; actual document clientWidth/scrollWidth equal at 375,393,1280. No production financial action used.

Second hosted recovery: CI 38267307247 passes the repaired overload shard and the real browser suite, but client shard 4 found the no-ticket registration test still requiring `{ clubId }` instead of `{ clubId, tournamentId }`. Local reproduction confirms the failure. A directly connected historical tournament UX source contract pins the same old read and also fails locally (74 other cases pass). Both are updated to the intended tournament-aware read; the fallback for a caller without a tournament remains asserted. Ticket selection, fail-closed selector errors, exact ticket identity, registration and balance-update assertions are preserved. The three direct tournament suites now pass 83/83. A wider import-connected run before repair reports only the known ticket assertion failing among 7,640 tests; the exact repaired rerun is recorded in the active operating checkpoint under /Volumes/SmarterArchives/agent-evidence/poker-features-resume-01a13098/INHERITED-CHECKPOINT.md. No application behavior or installed SQL changed in this recovery.

# Diamond Phase 11, line 1: request forgery and unauthorized access

**Verdict: line 1 is done.** We tried every way we could find to make the
Diamond Arena do something it should not. That meant forged assets, clubs,
tables, events and users; membership through chip doors; management as a
player, a chip-club agent or a signed-out staff member; and replayed requests.
Production refuses every one of those attempts by name. The attack found three
holes that needed no owner decision. All three are closed in production and
proven closed.

Programme line: Phase 11 of 12, "Test cross-asset request forgery and
unauthorized membership/management access."

## What was found and fixed

1. **Staff doors trusted a signed-out token.** This project issues seven-day
   access tokens, and the database checks only a token's signature and expiry.
   So a staff member's token keeps working at the database after they sign out,
   unless the door asks whether the session still exists
   (`fn_caller_session_is_live()`). Five Phase 10 staff doors asked. Fourteen
   did not: opening a table, the three table-feature switches, creating a
   tournament, proposing, approving, rejecting and settling a Diamond
   correction, and the incident desk (board, trail, review, resolve-family).
   The staff books did not ask either.
   - Migration `20260930131500_every_diamond_staff_door_needs_a_live_session`
     (Phase 11 line 7, the stale-client agent, applied 12:08 UTC) closed ten of
     them.
   - Migration `20260930120000_a_forged_request_is_refused` (this line, applied
     12:14 UTC) closed the last four: tournament creation, the staff books, the
     incident board and the incident trail.

   All nineteen staff doors now refuse a signed-out token, a token with no
   session id and an expired session, by name.

2. **The Diamond Arena could host club games.** `fn_wheel_host` resolved the
   arena's club id like any chip club. So the club-games doors (wheel, plinko,
   crash, crossing, mines, Diamond Spins, promo funding, owner terms) accepted
   the arena as a host whose games pay chips and whose entries go to the host
   owner. The baseline run shows a staff member configuring a plinko game
   hosted by the Diamond Arena. The arena has players only and the client never
   offers these games there. `fn_wheel_host` now finds no host for a Diamond
   club (`20260930120000`).
3. **Any club owner could operate any host's club games.**
   `fn_wheel_can_operate` admitted `fn_ca_caller_is_management()`, which is true
   for every club owner, every union owner and every incident recipient, not
   only platform staff. The baseline run shows a non-staff incident recipient
   reading another host's P&L and player list. The doors' own refusal says
   "Only The Host Owner Or An Admin". Operating or reading another host is now
   platform staff only (`20260930120000`). Today every member of that wider set
   is platform staff, so nobody who operates a game lost anything.

`20260930120000`, file md5 `abf22f0dcc77cca0436d0a10810f3f76`:

- **Rehearsal:** the fixture below ran after the migration, in one rolled-back
  production transaction: `REHEARSAL OK [mode fixed]: 243 probes, every one as
expected, in 6284 ms`.
- **Apply:** `apply.sh` printed `APPLIED AND RECORDED 20260930120000`; the
  recorded statements equal the file.
- **Proof in production:** all three `@live-proof` expressions are true.

Every edit is an asserted substitution against a pinned live md5. The first fix
rehearsal refused itself when the stale-client migration moved ten of its pins
mid-morning; the change was rebuilt on the new live text and rehearsed again.
PR: see "Shipped" below.

## How it was tested (re-runnable)

| Evidence                                                              | Where                                                                                                      | Command                                                                                                                    | Result                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Rolled-back production rehearsal: 243 probes, single session          | `docs/evidence/diamond-phase-11/request-forgery-rehearsal.sql` (md5 `07681c9c8526d89e8837a7b14710b530`)    | `rehearse.sh /dev/null docs/evidence/diamond-phase-11/request-forgery-rehearsal.sql <you>`                                 | after apply, 12:14 UTC: `REHEARSAL OK [mode fixed]: 243 probes, every one as expected, in 2974 ms` |
| The same fixture before either fix (`forgery.mode` set to `baseline`) | same file                                                                                                  | as above                                                                                                                   | 12:04 UTC: 240 probes; the three holes answered as holes (tables below); nothing moved             |
| CI SQL acceptance, isolated PostgreSQL 17                             | `tests/sql/poker-diamond-forged-arena-acceptance.sql`, loaded by `tests/sql/run-diamond-cash-admission.py` | `python3 scripts/ci/run-diamond-sql-acceptance.py --only run-diamond-cash-admission.py` (on the Mac: `LC_ALL=en_US.UTF-8`) | PASS; runs in CI on every pull request                                                             |
| Engine handler unit tests                                             | `server/src/handlers/aForgedRequestActsOnlyForItsToken.test.ts`                                            | `cd server && npx vitest run src/handlers/aForgedRequestActsOnlyForItsToken.test.ts`                                       | 39 passed                                                                                          |
| Law on the migration text                                             | `tests/a-forged-request-is-refused.law.test.ts`                                                            | `npx vitest run tests/a-forged-request-is-refused.law.test.ts`                                                             | 6 passed                                                                                           |

**How the rehearsal probes.** Every probe runs in a subtransaction that always
ends in an error, so whatever the door did (a row lock, a receipt row, an
advisory lock) is undone the moment the probe ends. The door's answer is carried
out in the error text. The caller takes the real PostgREST role (`anon`,
`authenticated` or `service_role`), so grants and row-level security are the
ones production enforces.

**Test identities.** All identities are synthetic hydra.bot accounts:

- a player and a second player (not horses), given a session in the
  transaction only;
- a staff member (not a horse), made admin in the transaction only;
- a chip-club super agent (a synthetic horse), used only where the door refuses
  before it reads a row.

No real account signs in and no real balance moves.

**Safety.** Staff probes pass deliberately invalid input, so even a door that
wrongly admits a caller refuses one step later and writes nothing. The one
door that takes the global settlement lane (tournament cancellation) is only
ever called with a null id or by a caller refused before the lane. Every run
used `lock_timeout 2s`, took under 7 seconds, and ended with the Diamond
identity (register against supply), four wallets and eight row counts exactly
where they started.

## Results, production after the fix (12:14 UTC)

### 1. Management: every Diamond staff door, every identity a forger has

The live-staff column is the control: it passes both checks and is refused by
the invalid input one step later. The last column is a signed-out staff token
before either fix. Wherever it shows the control's answer, the token got
through: that is fourteen doors.

| Door                         | no account         | player                          | chip super agent                | staff, live (control)                            | signed out                       | no session id                    | expired                          | Signed out, before either fix (12:04 UTC)        |
| ---------------------------- | ------------------ | ------------------------------- | ------------------------------- | ------------------------------------------------ | -------------------------------- | -------------------------------- | -------------------------------- | ------------------------------------------------ |
| approve a Diamond correction | `no EXECUTE grant` | `platform_staff_only`           | `platform_staff_only`           | `not_found`                                      | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `not_found`                                      |
| cancel a tournament          | `no EXECUTE grant` | `diamond_tournament_staff_only` | `diamond_tournament_staff_only` | `Tournament id is required`                      | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required`                 |
| close a cash table           | `no EXECUTE grant` | `diamond_table_staff_only`      | `diamond_table_staff_only`      | `diamond_table_not_found`                        | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required`                 |
| create a seat-first board    | `no EXECUTE grant` | `diamond_tournament_staff_only` | `diamond_tournament_staff_only` | `diamond_tournament_requires_a_configuration`    | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required`                 |
| create a tournament          | `no EXECUTE grant` | `diamond_tournament_staff_only` | `diamond_tournament_staff_only` | `diamond_tournament_requires_a_configuration`    | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_tournament_requires_a_configuration`    |
| edit a cash table            | `no EXECUTE grant` | `diamond_table_staff_only`      | `diamond_table_staff_only`      | `diamond_table_not_found`                        | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required`                 |
| open a cash table            | `no EXECUTE grant` | `diamond_table_staff_only`      | `diamond_table_staff_only`      | `diamond_table_requires_whole_positive_stakes`   | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_table_requires_whole_positive_stakes`   |
| propose a Diamond correction | `no EXECUTE grant` | `platform_staff_only`           | `platform_staff_only`           | `not_a_diamond_target`                           | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `not_a_diamond_target`                           |
| read an incident trail       | `no EXECUTE grant` | `staff_required`                | `staff_required`                | `incident_not_found`                             | `authentication_required`        | `authentication_required`        | `authentication_required`        | `incident_not_found`                             |
| read the incident board      | `no EXECUTE grant` | `staff_required`                | `staff_required`                | `invalid_status`                                 | `authentication_required`        | `authentication_required`        | `authentication_required`        | `invalid_status`                                 |
| read the staff books         | `no EXECUTE grant` | `platform_staff_only`           | `platform_staff_only`           | `unknown_view`                                   | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `unknown_view`                                   |
| reject a Diamond correction  | `no EXECUTE grant` | `platform_staff_only`           | `platform_staff_only`           | `not_found`                                      | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `not_found`                                      |
| remove a registered player   | `no EXECUTE grant` | `diamond_tournament_staff_only` | `diamond_tournament_staff_only` | `tournament and player ids are required`         | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required`                 |
| resolve an incident family   | `no EXECUTE grant` | `staff_required`                | `staff_required`                | `family_required`                                | `authentication_required`        | `authentication_required`        | `authentication_required`        | `family_required`                                |
| review an incident           | `no EXECUTE grant` | `staff_required`                | `staff_required`                | `unknown_action`                                 | `authentication_required`        | `authentication_required`        | `authentication_required`        | `unknown_action`                                 |
| settle a Diamond correction  | `no EXECUTE grant` | `platform_staff_only`           | `platform_staff_only`           | `not_found`                                      | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `not_found`                                      |
| switch bomb pots             | `no EXECUTE grant` | `diamond_table_staff_only`      | `diamond_table_staff_only`      | `diamond_bomb_pot_requires_an_explicit_flag`     | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_bomb_pot_requires_an_explicit_flag`     |
| switch run it twice          | `no EXECUTE grant` | `diamond_table_staff_only`      | `diamond_table_staff_only`      | `diamond_run_it_twice_requires_an_explicit_flag` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_run_it_twice_requires_an_explicit_flag` |
| switch straddles             | `no EXECUTE grant` | `diamond_table_staff_only`      | `diamond_table_staff_only`      | `diamond_straddle_requires_explicit_flags`       | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_staff_session_required` | `diamond_straddle_requires_explicit_flags`       |

### 2. Cross-asset money: Diamond doors given chip words, chip doors given Diamond ids, and doors called for someone else

With both arena switches closed, a Diamond buy-in is refused by the switch
first. The arena check behind it (a chip club named against a Diamond table
answers `diamond_purchase_arena_mismatch`) is proved in CI by
`poker-diamond-forged-arena-acceptance.sql`, together with the cases in the
Replay section below.

| Attempt                                                                                                              | As                            | Answer (production, after)                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| buy-in: a chip club named against a Diamond table (the closed switch refuses first; the arena check is proved in CI) | player                        | `diamond_cash_not_open`                                                                 |
| buy-in: for another player                                                                                           | player                        | `Cannot buy in for another user`                                                        |
| buy-in: from a signed-out token                                                                                      | player, signed out            | `SESSION_REVOKED: this session is signed out - sign in again`                           |
| buy-in: a fraction of a cent                                                                                         | player                        | `Chips Move In Hundredths At Most`                                                      |
| the chip rebuy door at a Diamond table                                                                               | player                        | `Player not seated at this table (cannot rebuy a vacated seat)`                         |
| the chip rebuy door for another player                                                                               | player                        | `Cannot rebuy for another player`                                                       |
| the chip cash-out door at a Diamond table, from a browser                                                            | player                        | `no EXECUTE grant`                                                                      |
| leave-and-refund at a Diamond table where the caller has no seat                                                     | player                        | `{"ok": false, "reason": "table_not_found"}`                                            |
| chips minted into the Diamond Arena by a player                                                                      | player                        | `Only The Club Owner Or An Admin May Mint Chips`                                        |
| chips minted into the Diamond Arena by staff                                                                         | staff (live)                  | `Only The Club Owner Or An Admin May Mint Chips`                                        |
| any chip treasury on the Diamond Arena, by any door (the service role writes it)                                     | service role                  | `new row for relation "clubs" violates check constraint "poker_arena_diamond_identity"` |
| a promo balance on the Diamond Arena, by any door                                                                    | service role                  | `new row for relation "clubs" violates check constraint "poker_arena_diamond_identity"` |
| a Diamond table rewritten by a definer door acting for a player                                                      | player, inside a definer door | `Diamond Games Require Platform Operations`                                             |
| a Diamond table rewritten straight through the API                                                                   | player                        | `rows=0`                                                                                |
| a chip table id at a Diamond staff door                                                                              | staff (live)                  | `diamond_table_not_found`                                                               |
| a chip tournament is not a Diamond tournament to any Diamond event door                                              | service role                  | `false`                                                                                 |
| a Diamond satellite whose target is a chip tournament                                                                | staff (live)                  | `diamond_satellite_target_must_be_a_diamond_tournament`                                 |
| a tournament rebuy bought for another player                                                                         | player                        | `process_tournament_rebuy: caller may only transact for themselves`                     |
| a transfer to somebody who is not a friend                                                                           | player                        | `accepted_friend_required`                                                              |
| a transfer to oneself                                                                                                | player                        | `invalid_transfer_request`                                                              |
| a negative transfer                                                                                                  | player                        | `invalid_transfer_request`                                                              |
| a transfer from a signed-out token                                                                                   | player, signed out            | `authentication_required`                                                               |
| an engine-only Diamond money door, from a browser: fn_poker_diamond_top_up                                           | player                        | `no EXECUTE grant`                                                                      |
| an engine-only Diamond money door, from a browser: fn_poker_diamond_buyin                                            | player                        | `no EXECUTE grant`                                                                      |
| an engine-only Diamond money door, from a browser: fn_poker_diamond_cashout                                          | player                        | `no EXECUTE grant`                                                                      |
| an engine-only Diamond money door, from a browser: fn_poker_diamond_settle_cash_hand                                 | player                        | `no EXECUTE grant`                                                                      |
| an engine-only Diamond money door, from a browser: fn_poker_diamond_reserve                                          | player                        | `no EXECUTE grant`                                                                      |
| an engine-only Diamond money door, from a browser: fn_poker_diamond_release                                          | player                        | `no EXECUTE grant`                                                                      |
| an engine-only Diamond money door, from a browser: fn_poker_diamond_tournament_charge                                | player                        | `no EXECUTE grant`                                                                      |
| an engine-only Diamond money door, from a browser: fn_poker_diamond_tournament_pay                                   | player                        | `no EXECUTE grant`                                                                      |

### 3. Membership: join, approve, invite, and the hierarchy Phase 2 forbids

| Attempt                                                                        | As               | Answer (production, after)                                                              |
| ------------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------- |
| the chip join door, pointed at the Diamond Arena                               | player           | `Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy`                   |
| the atomic join door, pointed at the Diamond Arena                             | player           | `Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy`                   |
| the join preview, pointed at the Diamond Arena (the public card, nothing more) | player           | `the public card (found: true), nothing else`                                           |
| an invite code redeemed into the Diamond Arena                                 | player           | `Invalid referral code.`                                                                |
| an invite code redeemed for somebody else                                      | player           | `You can only redeem an invite for yourself.`                                           |
| a join request approved in the Diamond Arena by a player                       | player           | `Not authorized to review join requests for this club`                                  |
| a join request approved in the Diamond Arena by a chip-club super agent        | chip super agent | `Not authorized to review join requests for this club`                                  |
| a join request cancelled in the Diamond Arena                                  | player           | `false`                                                                                 |
| a membership row written straight through the API (the automatic shape)        | player           | `Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy`                   |
| an owner membership written straight through the API                           | player           | `Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy`                   |
| a membership row written by any door (the service role writes it)              | service role     | `Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy`                   |
| the Diamond Arena put in a union                                               | service role     | `Diamond Arena Cannot Join A Union`                                                     |
| the Diamond Arena row given a union                                            | service role     | `new row for relation "clubs" violates check constraint "poker_arena_diamond_identity"` |
| an agent in the Diamond Arena                                                  | service role     | `Diamond Arena Has No Agents Or Commissions`                                            |
| a player assigned to an agent in the Diamond Arena                             | service role     | `Diamond Arena Has No Agents Or Commissions`                                            |

### 4. Member data without entitlement

Out of scope and recorded as known: which profile fields are public. Any
signed-in account can read another account's Diamond balance and legal name
through the API. That is Dan's open decision from Phase 10, line 2, and it is
not probed here.

| Attempt                                                    | As               | Answer (production, after)         |
| ---------------------------------------------------------- | ---------------- | ---------------------------------- |
| the Diamond roster without an account                      | no account       | `no EXECUTE grant`                 |
| the Diamond counts without an account                      | no account       | `no EXECUTE grant`                 |
| another player's wallet summary                            | player           | `wallet_summary_is_own_only`       |
| another player's arena reconciliation                      | player           | `arena_reconciliation_is_own_only` |
| another player's Diamond flow                              | player           | `diamond_flow_is_own_only`         |
| another player's lifetime totals                           | player           | `lifetime_totals_is_own_only`      |
| another player's Diamond cash-out receipt                  | player           | `<null>`                           |
| every chip-club roster row but one's own                   | player           | `0`                                |
| a chip club's roster read by a super agent of another club | chip super agent | `0`                                |
| the agent list                                             | player           | `0`                                |

### 5. Club games: the arena as a host, and another host's games in non-staff hands

| Attempt                                                                      | As           | Answer (production, after)                             | Before (12:04 UTC)                                     |
| ---------------------------------------------------------------------------- | ------------ | ------------------------------------------------------ | ------------------------------------------------------ |
| the Diamond Arena resolved as a club-games host                              | player       | `<null>`                                               | `002c2d27-9584-4e52-835a-bb2be148fc81`                 |
| the club-games entry read for the Diamond Arena                              | player       | `That Club Could Not Be Found`                         | `ok: true (answered)`                                  |
| a club game configured in the Diamond Arena by a player                      | player       | `That Club Could Not Be Found`                         | `Only The Host Owner Or An Admin May Change This Game` |
| a club game configured in the Diamond Arena by staff                         | staff (live) | `That Club Could Not Be Found`                         | `ok: true (answered)`                                  |
| owner terms accepted for the Diamond Arena by staff                          | staff (live) | `That Club Could Not Be Found`                         | `The Wallet Owner Must Accept This Agreement`          |
| another host's game P&L read by a player                                     | player       | `Only The Host's Owners And Admins Read This`          | `Only The Host's Owners And Admins Read This`          |
| another host's game P&L read by an incident recipient who is not staff       | player       | `Only The Host's Owners And Admins Read This`          | `ok: true (answered)`                                  |
| another host's player list read by an incident recipient who is not staff    | player       | `Only The Host's Owners And Admins Read This`          | `ok: true (answered)`                                  |
| another host's game P&L read by staff (control)                              | staff (live) | `ok: true (answered)`                                  | `ok: true (answered)`                                  |
| another host's game limits changed by an incident recipient who is not staff | player       | `Only The Host Owner Or An Admin May Change This Game` | not asked (the door would have locked a live host row) |
| another host's promo wallet funded by an incident recipient who is not staff | player       | `Only The Host's Owners And Admins Move This Money`    | not asked (the door would have locked a live host row) |

### 6. Engine-only doors: no browser role can execute a Diamond money core

Each row checks that neither `anon` nor `authenticated` holds `EXECUTE` on
every overload.

| Attempt                                                                          | As      | Answer (production, after) |
| -------------------------------------------------------------------------------- | ------- | -------------------------- |
| no browser role executes fn_poker_diamond_buyin                                  | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_cashout                                | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_top_up                                 | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_settle_cash_hand                       | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_reserve                                | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_release                                | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_charge                      | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_pay                         | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_refund                      | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_drain                       | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_seat_transfer               | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_unregister                  | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_cancel                      | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_custody_add                 | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_close_custody               | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_open_shadow                 | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_tournament_settle_fee                  | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_spin_draw                              | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_create_spin                            | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_staff_audit                            | catalog | ok - 1 overload(s)         |
| no browser role executes fn_poker_diamond_audit_tournament_created               | catalog | ok - 1 overload(s)         |
| no browser role executes add_diamonds_to_balance                                 | catalog | ok - 1 overload(s)         |
| no browser role executes deduct_diamonds                                         | catalog | ok - 1 overload(s)         |
| no browser role executes award_diamonds                                          | catalog | ok - 1 overload(s)         |
| no browser role executes award_diamonds_v2                                       | catalog | ok - 1 overload(s)         |
| no browser role executes fn_ca_diamond_incident                                  | catalog | ok - 1 overload(s)         |
| no browser role executes fn_ca_register_diamond_journal_row                      | catalog | ok - 1 overload(s)         |
| no browser role executes purchase_vip_with_diamonds_atomic_v3                    | catalog | ok - 1 overload(s)         |
| no browser role executes purchase_merch_with_diamonds_atomic_v2                  | catalog | ok - 1 overload(s)         |
| no browser role executes fn_purchase_club_shop_item_diamonds_v2                  | catalog | ok - 1 overload(s)         |
| no browser role executes refund_diamond_merch_order_atomic_v2                    | catalog | ok - 1 overload(s)         |
| no browser role executes settle_diamond_card_purchase_atomic                     | catalog | ok - 1 overload(s)         |
| no browser role executes fn_diamond_purchase_refund                              | catalog | ok - 1 overload(s)         |
| no browser role executes fn_diamond_purchase_dispute                             | catalog | ok - 1 overload(s)         |
| no browser role executes atomic_table_buyin_before_maintenance_announcement_gate | catalog | ok - 1 overload(s)         |
| no browser role executes atomic_table_rebuy_before_maintenance_announcement_gate | catalog | ok - 1 overload(s)         |
| no browser role executes fn_ca_settle_hand_stacks_absolute                       | catalog | ok - 1 overload(s)         |
| no browser role executes fn_ca_commit_hand_settlement                            | catalog | ok - 1 overload(s)         |
| no browser role executes fn_wheel_can_operate                                    | catalog | ok - 1 overload(s)         |
| no SECURITY DEFINER function named for Diamonds is executable without an account | catalog | ok - none                  |

### 7. Nothing moved

| Attempt                                                                                                                   | As      | Answer (production, after)                             |
| ------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------ |
| the Diamond identity (register vs supply) is where it started                                                             | catalog | ok - 0.00 -> 0.00                                      |
| no identity's wallet moved                                                                                                | catalog | ok - 6867 -> 6867                                      |
| no Diamond membership, table, event, custody, correction, incident event, arena club game or purchase receipt was written | catalog | ok - (1,17,0,0,81,0,0,50484) / (1,17,0,0,81,0,0,50484) |
| both Diamond switches are still closed                                                                                    | catalog | ok                                                     |

## The engine (server/src/handlers)

- **The WebSocket.** It accepts only `PONG`, `SUBSCRIBE`, `UNSUBSCRIBE` and
  `RESYNC` (`EngineWebSocketServer`). Action ingress is REST only, so there is
  no socket message to forge.
- **Tokens.** Every REST door authenticates with GoTrue (`http/auth.ts`, a
  signed token only, cached 60 s), so a signed-out token stops working at the
  engine within a minute.
- **The money doors.** Actions, time bank, top-up, cash-out and leave were
  already proved to act for the token alone, and to read the table's arena off
  the table the engine loaded (`server/src/http/aForgedArenaRequestIsRefused.test.ts`,
  2026-09-19).
- **The remaining twelve state-changing doors.** The new test carries that
  proof to them: straddle, run it twice, show hand, discard, sit out, reject
  rebuy, post big blind, pre-action, away, heartbeat, insurance and rabbit hunt.
  For each one it asserts three things:
  1. a body carrying another player's id, a club, an asset, a role, an amount
     and a seat reaches the engine as the token's user and the door's own
     fields, and nothing forged;
  2. without a token the door answers 401 before it reads a body or finds a
     table;
  3. a table this engine does not hold reaches no table.
- **Table administration.** Pause, resume and kick with no token answer 401 and
  read no table, role or engine. A player, a club role and a chip owner at a
  Diamond table are refused by `adminDiamondStaff.test.ts`. A kick's authority
  comes from authorization, never the body (`adminKickOccupancy.test.ts`).

## Replay

- **Buy-in keys (CI, new).** A settled buy-in key is bound to the whole request
  it first carried: who, which table, which seat, how much, which club. It is
  refused as `IDEMPOTENCY_KEY_REUSED` in these cases:
  - another player sends it word for word;
  - its owner re-sends it for a bigger buy-in;
  - its owner re-sends it for another seat.

  Naming its owner as the buyer is refused as `Cannot buy in for another user`.
  Sent again exactly, it answers from its receipt and buys nothing twice
  (`a replayed purchase key moves nothing for anyone`). The chip rebuy door
  binds its key the same way (`fn_claim_entry_purchase_receipt`).

- **Transfers.** The transfer door looks a request id up under its own sender
  only, so another user's id is just a new request of the caller's and never
  returns someone else's transfer. A settled id re-sent with a different
  recipient, amount or message is refused as `idempotency_payload_mismatch`
  (`send_wallet_diamond_transfer`; CI `run-diamond-wallet-transfer.py`).
- **Top-ups.** Keyed per request (`fn_poker_diamond_top_up`, engine-only, CI
  `run-diamond-top-up.py`).

## Known, and not fixed here

- **Public profile fields.** Which ones are public is Dan's open decision
  (Phase 10, line 2). Out of scope for this line.
- **The arena's owner.** The Diamond Arena's club row names a real platform
  account (role `god`) as `owner_id`. Chip doors that trust a club's owner
  therefore treat that one account as the arena's owner. Every money
  consequence we probed is still refused, by the arena identity constraint
  (`poker_arena_diamond_identity`: no union, no chip treasury, pool, promo or
  insurance balance) and by the step-0 chip-money and hierarchy triggers.
  Whether the arena row should name the system account instead is Dan's
  decision.
- **Chip estate, observed only.**
  - The chip mint door (`fn_mint_chips_from_diamonds`) looks up a replay key
    in its club before it checks who is asking, so another user's key in the
    same club answers "replayed". Nothing moves, the key is a random UUID, and
    it cannot touch the Diamond Arena (refused above).
  - `fn_ca_caller_is_management()` itself still admits every club owner to
    the payout-freeze and manual-adjustment doors that call it directly. Those
    are chip-standard controls, and who counts as management there is Dan's
    call.
- **The engine's sign-out window.** The engine's 60-second token cache means a
  signed-out token works at the engine for up to a minute. This is a documented
  trade-off (`server/src/http/auth.ts`) and belongs to Phase 11 line 7.

## Shipped

- Branch `agent/claude-diamond-phase-11/test/a-forged-request-is-refused`,
  migration `20260930120000`, applied and recorded. PR: filled in on merge.
- Migration `20260930131500` (the ten staff doors) is Phase 11 line 7's, shipped
  on its own branch.

# The Diamond Arena belongs to the system

**Verdict: done.** The Diamond Arena's club row now names the system account
as owner. Every door that trusts a club's owner now refuses the former owner at
the arena. All nineteen Diamond staff doors still admit him as staff, and a
Diamond hand now opens to platform staff through the staff door. The arena
cannot be handed back to a person. This was proved in production before and
after, in rolled-back rehearsals, and the migration is applied and recorded.

**Decided by Claude on Dan's delegation of 2026-09-30.** Dan: "these are all
for you to decide not me ... FIX AND FINISH ALL OF THESE". This is Ruling 22 in
[`docs/DIAMOND-RULINGS.md`](../../DIAMOND-RULINGS.md).

## What was wrong

Phase 11 line 1 ([request forgery and access](./request-forgery-and-access.md),
"The arena's owner") found it. The Diamond Arena's club row
(`002c2d27-9584-4e52-835a-bb2be148fc81`) named a real platform account as
`owner_id`: `daniel@smarter.poker`, role `god` (`2d1cd6c3-...`). That is the
"god mode admin account" of CLAUDE.md 10.10, which Dan and the estate's scripts
sign in as. It is not Dan's personal account, but it is an account a person
signs in as. So every door that trusts a club's owner treated whoever signed in
as it as the arena's owner. The baseline rehearsal below shows what that
account could do at the arena:

- edit the arena's club row through the API;
- read the arena's audit rows;
- run the club integrity report;
- reach the chip bomb-pot door for a Diamond table, outside the Diamond door's
  rules;
- count as a club owner for World Hub's Commander check.

It was also the only account that could open a Diamond hand's hole cards
(Phase 10 evidence: "for a Diamond hand that is the arena's owner account").
The money consequences were already refused by the arena identity constraint
and the step-0 triggers. The authority itself was not.

## The decision, and what "the system" is

Phase 2 established one system Diamond identity: the arena's club row itself
(`poker_arena_one_diamond_identity`, `poker_arena_diamond_identity`). A club
row cannot own itself, because `clubs.owner_id` references `profiles`. So the
arena is owned by the estate's one non-person account: `system@smarter.poker`,
`00000000-0000-0000-0000-000000000001`, "a system actor for service-side
writes" (migration `20260901013451`). It has:

- no password;
- no sign-in identity;
- no session or refresh token;
- never signed in.

The migration asserts all of these before it names the account, and the
rehearsal checks them again. Nobody signs in as the arena's owner, so no door
that trusts a club's owner admits a person to the arena. Platform staff (Dan
included) run the arena through the staff doors. Those doors ask for the
platform role and a live session. They never ask for ownership.

## What changed: migration `20260930235500_the_arena_belongs_to_the_system`

1. **The owner-wallet trigger skips a Diamond club.**
   `fn_club_owner_has_a_player_wallet` is the deferred constraint trigger that
   gives a club's new owner an `owner` membership row. The arena's membership
   is automatic and holds no wallet, and its guard refuses any other row. So
   this trigger refused every change of the arena's owner at commit. The
   baseline rehearsal shows it: handing the arena to any account answered
   `Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy`. The
   trigger now returns for a club that does not play in chips. Chip clubs run
   the text they ran before.
2. **The arena's `owner_id` becomes the system account.** The step is
   idempotent. It refuses if the arena is owned by anyone other than the former
   owner or the system. The former owner's automatic participation row stays as
   it is, a player's, like every account's.
3. **A Diamond hand opens to platform staff.** `fn_ca_operator_read_hand` opened
   a hand's hole cards to the club's owner or a club admin. The arena has no
   club admin, so without this edit nobody could open a Diamond hand once the
   system owns the arena. A Diamond hand now opens to platform staff with a live
   session, as every Diamond staff door admits, and the audit row records
   `platform_admin`. A chip hand opens exactly as before.
4. **The arena guard keeps it that way.** `fn_poker_guard_arena_structure`, a
   watched guard whose redefinition is declared, refuses a Diamond club whose
   owner is anyone but the system account: `The Diamond Arena Belongs To The
System`. Neither `transfer_club_ownership` nor a platform write can hand the
   arena back to a person.

Every edit is an asserted substitution against a pinned live md5, with the
reverse substitution proved:

| Function                                   | Pinned md5                         |
| ------------------------------------------ | ---------------------------------- |
| `fn_club_owner_has_a_player_wallet`        | `84222e6fb692c99fa27c843584ac9fc0` |
| `fn_ca_operator_read_hand`                 | `5730804b7bd990a728b93cf602480273` |
| `fn_poker_guard_arena_structure` (watched) | `d3ecf93c4ac0aced79031b4ce00df59b` |

The migration adds no table, column, function or grant. No Diamond moves and no
switch opens.

- **File md5:** `ecd4f0aafe09cab7a83d0def17c45b23`.
- **Rehearsal of that exact file:**
  `REHEARSAL OK [mode fixed]: 43 probes, every one as expected, in 1006 ms`.
- **Apply:** `apply.sh` printed `APPLIED AND RECORDED 20260930235500`, with the
  recorded statements equal to the file.
- **Proof in production:** all four `@live-proof` expressions are true, and the
  arena's owner is `00000000-0000-0000-0000-000000000001`.

## How it was tested (re-runnable)

| Evidence                                                | Command                                                                                                    | Result                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Rolled-back production rehearsal, before (no migration) | `rehearse.sh /dev/null docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system-rehearsal.sql <you>` | 2026-09-30 23:45 UTC: `REHEARSAL OK [mode baseline]: 43 probes, every one as expected, in 5374 ms` |
| The same fixture with the migration first               | `rehearse.sh supabase/migrations/20260930235500_the_arena_belongs_to_the_system.sql <fixture> <you>`       | 23:46 UTC: `REHEARSAL OK [mode fixed]: 43 probes, every one as expected, in 1006 ms`               |
| The same fixture after apply                            | `rehearse.sh /dev/null <fixture> <you>`                                                                    | 23:48 UTC: `REHEARSAL OK [mode fixed]: 43 probes, every one as expected, in 483 ms`                |
| Law on the migration text                               | `npx vitest run tests/the-arena-belongs-to-the-system.law.test.ts`                                         | 9 passed                                                                                           |
| Who reads the arena's owner (read-only inventory)       | `python3 docs/evidence/diamond-phase-11/arena-owner-readers.py --linked-dir <clone linked to production>`  | the lists below                                                                                    |

The fixture file's md5 is `7d84dfaf923ce6618ee8709b1fe1110c`. It reads its
mode from production: `baseline` when the former owner owns the arena and
`fixed` when the system does. Each probe runs in a subtransaction that always
ends in an error, as the caller's real PostgREST role. The former owner and a
synthetic player (a `hydra.bot` account, not a horse) are given a session inside
the transaction only. Staff doors get deliberately invalid input. Every run
used `lock_timeout 2s`. At the end of every run the Diamond identity (register
against supply), three wallets and the arena's membership, table and audit
counts were exactly where they started.

### The matrix: the former owner (`daniel@smarter.poker`, role god) at the arena

Sections 1 to 3 of the fixture: owner doors, staff doors, and the arena
changing hands.

| Probe                                                                                       | As                                    | Before (baseline)                                                     | After (with the migration)                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| club control (the hand, rules and report doors' test)                                       | former owner                          | `true`                                                                | `false`                                          |
| club staff (fn_club_is_staff)                                                               | former owner                          | `true`                                                                | `false`                                          |
| club staff (fn_ca_is_club_staff)                                                            | former owner                          | `true`                                                                | `false`                                          |
| club role (fn_club_role)                                                                    | former owner                          | `owner`                                                               | `player`                                         |
| the role an audit row records (fn_ca_club_actor_role)                                       | former owner                          | `owner`                                                               | `player`                                         |
| manage the club treasury (fn_actor_can_manage_club_treasury)                                | former owner                          | `true`                                                                | `false`                                          |
| the club integrity report (detect_suspicious_plays)                                         | former owner                          | `0`                                                                   | `not authorized for this club`                   |
| the arena's audit rows, read through the API                                                | former owner                          | `3`                                                                   | `0`                                              |
| the arena's club row, edited through the API (a write that changes nothing)                 | former owner                          | `rows=1`                                                              | `rows=0`                                         |
| a Diamond table's bomb pot, through the chip door (invalid mode)                            | former owner                          | `bad_trigger_mode`                                                    | `not_authorized`                                 |
| Commander access through owning a club (World Hub's check)                                  | former owner                          | `true`                                                                | `false`                                          |
| the owner the doors now see is the system account                                           | server                                | `<none>`                                                              | `owner`                                          |
| approve a Diamond correction                                                                | former owner                          | `not_found`                                                           | `not_found`                                      |
| cancel a tournament                                                                         | former owner                          | `Tournament id is required`                                           | `Tournament id is required`                      |
| close a cash table                                                                          | former owner                          | `diamond_table_not_found`                                             | `diamond_table_not_found`                        |
| create a seat-first board                                                                   | former owner                          | `diamond_tournament_requires_a_configuration`                         | `diamond_tournament_requires_a_configuration`    |
| create a tournament                                                                         | former owner                          | `diamond_tournament_requires_a_configuration`                         | `diamond_tournament_requires_a_configuration`    |
| edit a cash table                                                                           | former owner                          | `diamond_table_not_found`                                             | `diamond_table_not_found`                        |
| open a cash table                                                                           | former owner                          | `diamond_table_requires_whole_positive_stakes`                        | `diamond_table_requires_whole_positive_stakes`   |
| propose a Diamond correction                                                                | former owner                          | `not_a_diamond_target`                                                | `not_a_diamond_target`                           |
| read an incident trail                                                                      | former owner                          | `incident_not_found`                                                  | `incident_not_found`                             |
| read the incident board                                                                     | former owner                          | `invalid_status`                                                      | `invalid_status`                                 |
| read the staff books                                                                        | former owner                          | `unknown_view`                                                        | `unknown_view`                                   |
| reject a Diamond correction                                                                 | former owner                          | `not_found`                                                           | `not_found`                                      |
| remove a registered player                                                                  | former owner                          | `tournament and player ids are required`                              | `tournament and player ids are required`         |
| resolve an incident family                                                                  | former owner                          | `family_required`                                                     | `family_required`                                |
| review an incident                                                                          | former owner                          | `unknown_action`                                                      | `unknown_action`                                 |
| settle a Diamond correction                                                                 | former owner                          | `not_found`                                                           | `not_found`                                      |
| switch bomb pots                                                                            | former owner                          | `diamond_bomb_pot_requires_an_explicit_flag`                          | `diamond_bomb_pot_requires_an_explicit_flag`     |
| switch run it twice                                                                         | former owner                          | `diamond_run_it_twice_requires_an_explicit_flag`                      | `diamond_run_it_twice_requires_an_explicit_flag` |
| switch straddles                                                                            | former owner                          | `diamond_straddle_requires_explicit_flags`                            | `diamond_straddle_requires_explicit_flags`       |
| review a club's integrity (fn_ca_can_review_integrity)                                      | former owner                          | `true`                                                                | `true`                                           |
| see which players are horses (fn_can_see_horse_flag)                                        | former owner                          | `true`                                                                | `true`                                           |
| open a Diamond hand (no such hand: admitted, then not found)                                | former owner                          | `no hand numbered -1`                                                 | `no hand numbered -1`                            |
| open a Diamond hand with a token that has no session                                        | former owner, token without a session | `no hand numbered -1`                                                 | `diamond_staff_session_required`                 |
| open a Diamond hand as a player                                                             | player                                | `only a club owner or admin may open a hand`                          | `only platform staff may open a Diamond hand`    |
| open a chip club's hand (unchanged: club control only)                                      | former owner                          | `only a club owner or admin may open a hand`                          | `only a club owner or admin may open a hand`     |
| the arena handed to another account, by the server                                          | server                                | `Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy` | `The Diamond Arena Belongs To The System`        |
| the system account cannot sign in: no password, provider, session or token, never signed in | catalog                               | `true`                                                                | `true`                                           |

The nineteen staff doors answer the same before and after. Each one is refused
by its deliberately invalid input, one step after the staff and live-session
checks, which means it let the former owner in as staff.

## Who reads the arena's owner, and what changes for each

`arena-owner-readers.py` produced these lists, read-only, on 2026-10-01 after
the apply. It removes comments and string literals before it matches, and it
found no reader that only builds SQL in a string.

### Database functions: 104 read `clubs.owner_id`

**They admit the caller as the owner (52).** After the change, none of them
admits the former owner at the arena, and nobody can sign in as the system
account.

`ca_can_view_club`, `ca_can_view_club_finances`, `calculate_agent_settlement`,
`calculate_agent_spread`, `detect_suspicious_plays`,
`fn_actor_can_manage_club_treasury`, `fn_admin_update_agent`,
`fn_agent_attach_player`, `fn_ca_can_manage_agents`,
`fn_ca_can_review_integrity`, `fn_ca_incident_dashboard`,
`fn_caller_can_moderate_user`, `fn_close_settlement_period`,
`fn_club_bomb_pot_report`, `fn_club_money_panel`,
`fn_club_opening_checklist_complete`, `fn_community_overview`,
`fn_community_search`, `fn_complete_club_opening_setup`, `fn_create_agent`,
`fn_diamond_spin_statements`, `fn_emit_management_content_event`,
`fn_get_leaderboard_reward_setup`, `fn_get_leaderboard_settlement_status`,
`fn_join_club`, `fn_launch_table_from_template`,
`fn_leaderboard_reward_contexts`, `fn_list_my_post_targets`,
`fn_mint_chips_from_diamonds`, `fn_mint_club_chips_zd3core`,
`fn_my_wallet_ledger`, `fn_promo_disburse`, `fn_promo_vault_can_manage`,
`fn_promo_vault_visible`, `fn_publish_leaderboard_reward_program`,
`fn_request_manual_bomb_pot`, `fn_retire_settled_club`,
`fn_review_credit_request`, `fn_search_players`, `fn_set_club_rules`,
`fn_settle_club_rakeback_batch`, `fn_union_clawback_from_club`,
`fn_union_clawback_promo_from_club`, `fn_union_dispute_invoice`,
`fn_union_distribute_promo`, `fn_union_eco_adjustment`,
`fn_union_issue_credit_note`, `fn_union_reconciliation_report`,
`fn_union_send_chips_to_club`, `fn_update_table_bomb_settings`,
`generate_period_settlements`, `recompute_club_levels`.

Most of them could not act on the arena anyway. It has no chip treasury, pool,
promo or insurance balance, no union, no agents, no credit, no settlement
period, no leaderboard programme and no club-games host (Phase 2, and
`fn_wheel_host` since Phase 11 line 1). A few did act on the arena for the
former owner, and now they refuse him:

- the integrity report (`detect_suspicious_plays`, probed);
- the bomb-pot report (`fn_club_bomb_pot_report`, not probed: it writes a
  catch-up before it answers);
- the two chip bomb-pot doors (`fn_update_table_bomb_settings`, probed, and
  `fn_request_manual_bomb_pot`, same check);
- the club rules (`fn_set_club_rules`, same check);
- retiring the club (`fn_retire_settled_club`, same check).

None of these is a Diamond staff door, and the client offers none of them in
the arena. Bomb pots at a Diamond table belong to the staff door
`fn_poker_diamond_set_table_bomb_pot`. Two readers already admit platform staff
and still admit him: `fn_ca_can_review_integrity` and `fn_can_see_horse_flag`,
both probed.

**They ask whether a given user is the owner (27).** For the arena, the answer
is now the system account, never the former owner.

`atomic_table_buyin_before_maintenance_announcement_gate`,
`cleanup_reserved_certification_account`, `fn_audit_actor_role`,
`fn_ca_ban_club_player`, `fn_ca_certification_identity_retired`,
`fn_ca_club_actor_role`, `fn_ca_is_club_control`, `fn_ca_is_club_staff`,
`fn_can_create_games`, `fn_can_manage_club_message`, `fn_can_message_in_club`,
`fn_close_account`, `fn_club_bank_role`, `fn_club_is_staff`, `fn_club_role`,
`fn_credit_reduction_lock_current_manager_v1`, `fn_is_any_union_overseer`,
`fn_sweep_test_account`, `fn_sweep_test_account_after_audit_archive`,
`fn_union_overseer_of_record`, `fn_wheel_can_operate`,
`get_commander_access_details`, `get_unified_user_profile`,
`has_commander_access`, `is_club_admin`, `mint_club_chips`,
`transfer_club_ownership`.

The ones that change something visible:

- **The role answers** (`fn_club_role`, `fn_ca_club_actor_role`,
  `fn_ca_is_club_control`, `fn_ca_is_club_staff`, `fn_club_is_staff`) now say
  `player` for the former owner and `owner` for the system account (probed).
- **`transfer_club_ownership`** meets the new guard. **The two test-account
  sweepers** now find the system account "owns a club" and will never sweep it.
  Its address was never a test pattern either.
- **`fn_close_account`** no longer counts the arena against the former owner's
  account.
- **Commander access** (`has_commander_access`, `get_commander_access_details`;
  World Hub `pages/api/check-access.js`, the World Hub Commander carousel entry
  and the Poker Near Me "Host A Home Game" button). Owning a club is one of the
  four ways in, and the former owner had no other: no subscription, no venue
  staff row, no home group. So `daniel@smarter.poker` no longer counts as having
  Commander access (probed). "Host A Home Game" now sends it to the Commander
  sign-up page instead of home-game creation. This is not a Diamond or platform
  staff power, and it is reported to Dan below.

**They use the owner as a value (25).** For the arena, the value is now the
system account.

`fn_accounting_correction_prepare`, `fn_accounting_party_users`,
`fn_ca_commerce_activate_launch_cohort`, `fn_ca_commerce_scope_owner`,
`fn_cashier_cashout_transition`, `fn_club_opening_checklist_skip`,
`fn_club_opening_checklist_state`, `fn_club_retirement_impact`,
`fn_club_set_member_status`, `fn_create_club_atomic_membership_impl`,
`fn_deliver_accounting_invoice`, `fn_diamond_game_owner`,
`fn_emit_managed_command_event`, `fn_emit_management_access_event`,
`fn_ensure_social_page_for_club`, `fn_guard_credit_request_creation`,
`fn_join_club_membership_impl`, `fn_membership_approval_gate`,
`fn_notify_dispute`, `fn_notify_guarantee_bank_short`,
`fn_poker_guard_arena_structure` (the new guard), `fn_remove_settled_club_member`,
`fn_request_chips`, `fn_union_send_club_message`, `get_club_home`.

None of them reaches the arena in a way that matters:

- `get_club_home` returns access-only context for a Diamond club, without an
  owner.
- The commerce launch cohort skips platform clubs.
- The accounting party, invoice and dispute paths need chip accounting the
  arena does not have.
- The guarantee-bank notice is sent by the chip schedule services, and the
  arena has no schedule.
- `fn_diamond_game_owner` answers only for a club-games host.
- `fn_ensure_social_page_for_club` creates a page only when none exists.

The arena's page in the social feed already exists and still names
`daniel@smarter.poker` as its owner. That is a social-feed record, not the club
record, and no door reads it for club authority: club post targets come from
membership roles, and the former owner's role in the arena is `player`. It is
left as it is.

### Triggers on `clubs` that read the owner (7)

- **`fn_club_owner_has_a_player_wallet`** (deferred): changed. It skips a
  Diamond club.
- **`fn_poker_guard_arena_structure`**: changed. It is the new guard.
- **`fn_emit_club_union_access_event`**: on an owner change, it wrote one
  `management_access_changed` event to the former owner and one to the system
  account.
- **`fn_sync_mfa_required_on_club_owner`**: requires MFA of a new owner. The
  system account already had `mfa_required = true`, so nothing was written.
- **`fn_audit_club_entry_mutation`, `fn_record_new_club_opening_bank`,
  `fn_audit_club_delete`**: they act on a club's INSERT or DELETE. The arena is
  neither created nor deleted.

### Row-level-security policies: 32 read a club's owner, directly or through a helper

**Direct (19):**

`audit_trail` "club owners read own club rows", `bbj_daily_user`
read_own_bbj_daily_user, `ca_hand_flags` ca_hand_flags_select_staff,
`club_members` "Club staff can read club rosters", `club_opening_setup_funding`,
`club_opening_setups`, `club_shop_inventory` csi_select_own,
`club_wallet_transactions`, `club_wallets`, `clubs` "Owners can update clubs",
`credit_assignments`, `credit_requests`, `leaderboard_payout_batches`,
`leaderboard_payout_failures`, `session_history` session_history_select_own,
`tables` tables_select_scoped, `tournaments` tournaments_select_scoped,
`union_applications`, `union_clubs`.

**Through `is_club_admin`, `fn_club_is_staff`, `fn_club_bank_role`,
`ca_can_view_club_finances` or `fn_promo_vault_visible` (13):**

`ad_campaign`, `audit_trail` (admins), `cashout_requests`, `chip_escrow`,
`club_challenges`, `club_members` (join and update), `commission_rate_audit`,
`promo_vault_inventory`, `promo_vault_records`, `rake_rate_audit`,
`tournament_registration_approvals` (two policies). `is_club_admin` already
answered false at the arena: the two-argument form refuses a Diamond club
(Phase 2), and the arena has no admin row for the one-argument form to find.

At the arena, the former owner's reads through these policies are gone: its 3
audit rows (probed: 3, then 0), the arena seats' session history and the arena
roster beyond his own row. So is his write, the club row through the API
(probed: 1 row, then 0). Every signed-in account still reads the arena's tables
and tournaments through the Phase 2 policies
(`poker_arena_diamond_tables`, `poker_arena_diamond_tournaments`). The rest are
chip books the arena does not keep.

### Cron jobs: 5 reach an owner reader within four calls

- `union-law-selftest` and `union-integrity-sweep` read union owners and
  members. The arena cannot join a union.
- `union-weekly-rakeback-close` and `midway-close-once-20260929d` run the weekly
  accounting of union scopes. The arena has no union.
- `managed-game-schedules-minute` runs managed game commands through
  `fn_can_create_games`, which answers false for a Diamond club. There are no
  managed schedules at all.

### Client and engine: 26 files read a club's owner

- **Engine** (`server/src/handlers/admin.ts`): pause, resume and kick at a
  Diamond table ask for the caller's platform role only. That is unchanged, and
  `adminDiamondStaff.test.ts` proves it. `rake.ts` selects `owner_id` and never
  uses it.
- **Client:** the Diamond Arena renders its own shell (`ArenaAccessBoundary`),
  which mounts none of the chip owner surfaces. Those are the club bank row,
  notice editing, the opening checklist, finance, rules and settings. For the
  former owner, `ClubHomePage`'s `isOwner` and `TablePage`'s `isClubStaff` are
  now false at the arena. At a Diamond table that removes the chip manual bomb
  pot button, which the chip door now refuses. `PermissionService` checks the
  platform role before club ownership, so the former owner stays
  `PLATFORM_ADMIN`. The Diamond Staff Desk is behind `PlatformStaffGuard` and
  does not read ownership.
- **The other client files** (the cashier, credit, mint, union, club settings,
  rules, financials and dashboard pages) are chip-club surfaces the arena never
  mounts.

## What stays open

- **For Dan, not blocking:** `daniel@smarter.poker` loses Commander access,
  which came only from owning the arena (above). If that account should still
  open Club Commander, it needs its own way in: a venue staff row or a
  subscription.
- **Hardening the system account itself:** it has no password, no provider
  identity and no session, and it has never signed in. The one way into any
  password-less account is an email link to its address, `system@smarter.poker`,
  a Smarter.Poker mailbox. It was not banned in GoTrue, because this estate has
  never written `auth.users.banned_until` from SQL and this decision does not
  need it.

## Shipped

Branch `agent/claude-fix/the-arena-belongs-to-the-system`, migration
`20260930235500`, applied and recorded.

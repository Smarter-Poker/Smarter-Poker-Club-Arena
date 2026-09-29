# Channel And Scope Activation Matrix

This file serves two R2 requirements:

- The activation matrix at `CA-DIAMOND-COMMERCE-2026-09-22-R2.md` line 1679: "catalog visible, quote available, trial enrolled, paid checkout enabled for eligible consenting operators, renewal consumer running, and genuine live paid activity observed".
- The storefront and channel acceptance matrix at lines 1651-1657.

Short names (M1 to M4, RM, RR, RA, Engine, Page, Service) follow `c1-wiring-map.md`.

**Update, 2026-09-24 19:40 UTC.** M3 (`20260924102040`) and M4 (`20260924102056`) are installed and read back (14:15 and 14:16 UTC), so Step 1 is done, the heartbeat column exists, the launch cohort has its heartbeat guard, admission is in shadow at seven doors, and the union SKUs are withdrawn from sale. The client carrying the Commerce Desk and the owner page growth is published (`4c1aa6e0`). Three further migrations (M5 `20260924182605`, M6 `20260924183529`, M7 `20260924183657`) come with the operator-completion pull request; Step 1b covers them. The rest of this section is the original record.

**Source of the production state.** This document had no production access. Every production statement below comes from the repository record: `CHECKPOINT.md` and `docs/changelog/2026-09-24-club-and-union-diamond-commerce-fixes.md` ("Delivery record", readback at 2026-09-24 05:04 UTC). Nothing later was read. Anything that may have changed since is marked Unknown.

## 1. Global switches, as installed

All four switches live in the single row `ca_commerce_settings` (M1:62-74). The repository records no `settings_changed` event, so each switch is taken at its installed value. The last recorded readback (2026-09-24 05:04 UTC) found 0 purchases and 0 trials.

| Switch             | Column                       | Installed value                                                                                                       | Who changes it                                                           |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Catalog visible    | `catalog_visible`            | `true` (M1:64). Stored only until M5; from M5 it hides prices from owners and the quote refuses `catalog_not_visible` | Staff, via `fn_ca_commerce_settings_set` (M1:1974)                       |
| Checkout enabled   | `checkout_enabled`           | `true` (M1:65)                                                                                                        | Staff, via the same door                                                 |
| Admission enforced | `admission_enforced_from`    | `NULL`, which means shadow (M1:66)                                                                                    | Staff, via the same door. M4 refuses to install if it is set (M4:78-80). |
| Launch cohort      | `launch_cohort_activated_at` | `NULL`, which means not run (M1:67)                                                                                   | Staff, via `fn_ca_commerce_activate_launch_cohort`                       |
| Consumer heartbeat | `consumer_heartbeat_at`      | The column does not exist until M3 is installed (M3:158)                                                              | Stamped on every claim by the Engine (M3:714)                            |

## 2. Matrix: channel by scope by state

The states, as they appear in the column headings:

| Heading       | State                        |
| ------------- | ---------------------------- |
| Catalog       | catalog visible              |
| Quote         | quote available              |
| Checkout      | paid checkout enabled        |
| Trial         | trial enrolled               |
| Consumer      | renewal consumer running     |
| Admission     | admission shadow or enforced |
| Paid activity | live paid activity observed  |

### 2.1 Web: `https://smarter.poker/hub/club-arena/`

Client build `abea9a1af` is published at both build-info endpoints (fixes changelog).

| Scope                                                                                                                  | Catalog                                                                                                             | Quote                                         | Checkout                                                                                                                                                                                                                                                                   | Trial                                                                                                                                                           | Consumer                                                           | Admission                                                                                                                           | Paid activity                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Club (`/clubs/:clubId/diamond-costs`, operations item `diamond-costs` in `src/config/clubOperationsNavigation.ts:258`) | **Yes.** Six capacity tiers and the club insurance module are sellable. Report and asset SKUs show without a price. | **Yes**, for the owner.                       | **Yes**, for an owner whose scope is not in an active trial. The Page offers Pay only when `!trialActive` (Page:2164, HEAD). Inside a trial the server refuses with `trial_active_authorize_instead` (M2:562-564), and the owner may only authorize the first paid period. | **Self-serve: yes.** "Start Free Month" (Page:1829) calls the browser door (M1:725). Launch cohort: **not run.** Count at the last readback: 0. Later: Unknown. | **No.** The engine has not been released since 2026-09-21 (#5161). | **Neither shadow nor enforced.** M4 is not installed, so no door consults admission. The installed M1 read (M1:1860) has no caller. | None at the 05:04 UTC readback. Later: Unknown. |
| Union (`/unions/:unionId/diamond-costs`, union rail `src/config/arenaSectionNavigation.ts:182`)                        | **Yes.** Union back office (1,000 per covered club) and the union insurance module (capped at 1,000).               | **Yes**, for the owner.                       | **Yes**, same trial rule. Both union SKUs grant no enforced right today (`traceability-register.md` section 4, item 1).                                                                                                                                                    | As for a club.                                                                                                                                                  | **No.**                                                            | No union door exists (`union_tools` has no door, per the admission changelog).                                                      | None at the readback. Later: Unknown.           |
| Sponsored club (the union owner paying for a covered club)                                                             | Yes, through "Buy For A Covered Club" (Page:914).                                                                   | **Yes**, for the sponsor only (M1:1106-1110). | **Yes**, from the sponsor's own session within budget (M2:572-590). A club admin cannot spend the union budget from their own session (not built).                                                                                                                         | The club's own trial applies (M2:562-564).                                                                                                                      | **No.** Sponsored renewal also needs M3 (M3:760-776).              | As for a club.                                                                                                                      | None at the readback. Later: Unknown.           |

### 2.2 Native iOS and Android

The Capacitor shell is `capacitor.config.ts`, app id `poker.smarter.clubarena`. It updates by Capgo OTA from the same React tree, per its header comment.

| Scope                          | Catalog                                                                                                                                                    | Quote   | Checkout                         | Trial   | Consumer | Admission | Paid activity |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------- | ------- | -------- | --------- | ------------- |
| Club, union and sponsored club | **Unknown.** The page is in the same bundle. Whether the OTA channel carries `abea9a1af`, and whether any binary is published in a store, is not recorded. | Unknown | **Not accepted** (see section 3) | Unknown | No       | As web    | Unknown       |

## 3. Storefront and channel acceptance (R2 lines 1651-1657)

| Question                                                                     | Web                                                                        | iOS (StoreKit)                                                          | Android (Play Billing)                  | Evidence                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| How are diamonds acquired?                                                   | Existing Stripe Checkout packages, unchanged                               | Existing consumable `poker.smarter.clubarena.diamonds.<key>`, unchanged | Same product id rule, unchanged         | `src/lib/iapProducts.ts:1-30`. M1 to M4 add no acquisition product, provider or external link.         |
| Does commerce spend diamonds only?                                           | Yes: `deduct_diamonds` only (M2:618-622)                                   | Yes                                                                     | Yes                                     | M2:618-622                                                                                             |
| Is there a cash subscription or automatic top-up?                            | None                                                                       | None                                                                    | None                                    | No Stripe or IAP call in M1 to M4 or the Engine consumer                                               |
| Purchased currency does not expire when the service does (Apple 3.1.1)       | Yes                                                                        | Yes                                                                     | Yes                                     | RM `D63 an expired license refuses new discretionary operation and the purchased balance is untouched` |
| Restore or reinstall duplication (D62)                                       | Unchanged path                                                             | Unchanged path                                                          | Unchanged path                          | N/A: no change (`traceability-register.md` D62)                                                        |
| Provider or store approval to sell operator-service time for in-app currency | Not required to be recorded for Stripe web, but **not recorded**           | **Not recorded (Unknown)**                                              | **Not recorded (Unknown)**              | Nothing in the repository records an App Review or Play policy decision for this product               |
| Accepted to activate paid checkout?                                          | Checkout is **on** by default (M1:65). No acceptance decision is recorded. | **No:** blocked pending review evidence                                 | **No:** blocked pending review evidence | R2 line 1649: a missing approval blocks only the affected activation                                   |

The page makes no platform check before offering checkout. A native build that carries this page offers the same checkout as the web. If native checkout is to stay off until review, that needs a client change or a staff `checkout_enabled=false` switch. The switch is global and would also stop the web.

## 4. The remaining activations, in order, with exact preconditions

### Step 1: install M3, then M4

- **Preconditions.**
  - Protected merge of branch `feat/diamond-commerce-completion`.
  - The three runners pass on the production migration order: RM (155), RR (123), RA (all `GREEN`, `SAFETY` and `REGRESSION` records).
  - The install is one transaction outside the break window, :50 to :03 UTC (repository `CLAUDE.md` section 2, rule 8).
  - The M3 baseline pins match: nine function md5s (M3:69-83).
  - The M4 baseline pins match: `fn_ca_commerce_admission` md5 `9fc091db...` (M4:74) and `admission_enforced_from IS NULL` (M4:78).
- **Order.** M3 and M4 do not depend on each other. M3 **must** precede Step 2 (see below).
- **Readback.**
  - The function md5s and grants.
  - M3's post-conditions: three policies, the one-open-request index, the heartbeat stamp (M3:1622-1663).
  - M4's post-conditions: exactly seven doors call `fn_ca_commerce_admit` (the four owner doors plus `fn_join_club`, `fn_redeem_club_invite_code` and `fn_agent_attach_player`), and no commerce trigger sits in the gameplay path (M4:443-503).

### Step 1b: install M5, M6 and M7, in that order

- **Preconditions.** Protected merge of the operator-completion pull request; its runners pass (completion 17, metrics 52, earnings 9, recovery 36, and the base, refunds and admission runners unchanged); outside :50 to :03 UTC and outside a maintenance thaw.
- **M5 baseline pins.** `fn_ca_commerce_quote` md5 `2b5999d2...`, `fn_ca_commerce_catalog` md5 `196868d0...`, `fn_ca_commerce_activate_trial_impl` md5 `c1a16474...`.
- **Order.** M6 and M7 each check that M5 is installed.
- **Readback.** The function md5s against the qualified build, the `service_terms` policy v1, and the two new tables empty.
- **Effect on activation.** None of the switches change. From M5, `catalog_visible` is a real switch.

### Step 2: an engine release carrying the consumer

- **Blocking issue.** Engine releases fail at "Publish Through Hetzner" (#5161, release workstream).
- **What the release must carry.** `server/src/services/CommerceRenewalConsumer.ts` on `main` is the #5077 version: claim, execute, notices. The branch version adds step 3, `fn_ca_commerce_execute_approved_refunds` (Engine:188-208).
- **Precondition.** If the branch consumer ships before M3 is installed, step 3's RPC fails on every wake. The throw at Engine:193-195, or the RPC error at Engine:116, is caught at Engine:212, and `deliverNotices` (Engine:210) never runs. Renewals would still execute, but no notice would ever be delivered. **Install M3 first.**
- **Route.** `stage-engine-release.yml` then `auto-deploy-hetzner.yml`, in a certified maintenance window. Verify `https://engine.smarter.poker/health`.
- **What `/health` does not show.** `commerceRenewalConsumerStatus()` (Engine:147) is not exposed on `/health`: no caller outside the module was found. The `[CommerceRenewal]` log line prints only when a mandate or refund is claimed (Engine:180-184, Engine:203-207). A healthy but idle consumer therefore prints nothing.

### Step 3: observe the heartbeat

- **Read** (service or SQL route, read-only): `SELECT consumer_heartbeat_at, now() - consumer_heartbeat_at AS age FROM public.ca_commerce_settings WHERE id = 1;`
- **Pass condition.** `age < interval '10 minutes'`, which is the same test the cohort applies (M3:1094-1097). The Engine wakes every `COMMERCE_RENEWAL_POLL_MS`, default 60,000 ms (Engine:46), so a live consumer keeps the age under about 1 minute outside the maintenance freeze (Engine:167).
- **Before M3 no durable heartbeat exists.** There is no way to prove from the database that an idle consumer is running.

### Step 4: the launch cohort (owner decision 2, `CHECKPOINT.md:186-188`)

- **Call.** Staff call `fn_ca_commerce_activate_launch_cohort(p_effective_at)`.
- **Preconditions.**
  - M3 is installed. The installed M1 version (M1:741-771) has **no heartbeat guard** and would enrol owners whose reminders and renewals nobody delivers.
  - The Step 3 heartbeat is under 10 minutes old. Otherwise the call returns `consumer_not_running` (M3:1095-1097).
  - `p_effective_at` is not more than 1 hour in the past (M3:1088-1090).
- **Effect.**
  - Every club that has an owner and is not retired or `is_platform`, and every union that has an owner, is enrolled (M3:1100-1105).
  - Each operator gets one trial of 720 hours from `p_effective_at`.
  - An operator who already self-activated keeps their earlier end for every scope (M1:681-691).
  - Each enrolled owner gets a Title Case notice (M3:1114-1121).
- **What it does not cover.** Clubs created after the event are not enrolled. Their owners use "Start Free Month".
- **Proof.** RR `launch cohort: every eligible scope is enrolled, one trial per operator`, `launch cohort: retired and platform clubs are not enrolled`, `horses are players: a horse-owned club is enrolled and its owner is told like anyone else`.

### Step 5: admission enforcement

- **Call.** Staff call `fn_ca_commerce_settings_set(NULL, NULL, <enforce_from>, false)` (M1:1974-1991). The admission changelog calls this "a separate, recorded staff event".
- **Preconditions, all required:**
  1. **M4 is installed** (Step 1). Without it, setting the date changes only what `scope_status` displays: no door consults admission.
  2. **The cohort's trials have run their 30 days.** Set `<enforce_from>` no earlier than the cohort's `p_effective_at + 720 hours`. Enforcement is global, but any scope inside its trial is still answered `trial` (M4:185-186). Before that date, enforcement bites only on scopes with no trial: clubs created after the cohort whose owners never pressed "Start Free Month" (`no_effective_entitlement`, M4:187-188).
  3. **The direct-table-write bypasses listed in the admission changelog are closed first**:
     - Closed since 2026-09-24 by another workstream: production's `trg_club_members_status_guard` (`20260924045900`) refuses a browser change of `club_members.status` outside `fn_club_set_member_status`.
     - RLS `Users can join clubs` lets a player insert their own `club_members` row directly, which in a club that admits automatically is an approved member without `fn_join_club`.
     - RLS `tables_insert_owner_or_admin` (`supabase/migrations/20260906091511_phase_1_table_management_authority_recertified.sql:29-33`) lets a creator insert a `tables` row without calling `fn_cash_game_create`.
     - Both must move behind the doors. The changelog rules out a trigger (D21, D28).
  4. **Client copy for the refusal is shipped.** `TOURNAMENT_CREATE_ERRORS` and the schedule error map need `operating_access_required`, and `tests/unit/cashGamesVocabulary.test.ts` `LIVE_REFUSALS` needs the cash sentence (admission changelog, "Client copy"). Working-tree edits by another agent touch these files: client surface: see PR.
  5. **Shadow data has been reviewed**, using the would-deny query in `operational-metrics.md` section 7. That includes the open question of the union house club: "Games in a union's house club are checked against that club".
  6. **Union back office and union insurance have a door**, if they are to be enforced at all. None exists (admission changelog, "Open items").
- **Proof in isolation.** RA `s_enforced_refuses_without_side_effect`, `s_existing_obligations_untouched`, `s_last_seat_race`, `s_horse_counts`.

## 5. Observations the owner should know before any step

1. **Checkout and self-serve trials are live today while no consumer runs.**
   - An owner can press "Start Free Month" now. The day 21 and day 27 reminders (M1:707-716) will sit undelivered until Step 2.
   - When the consumer starts, `fn_ca_commerce_deliver_due_notices` delivers every overdue notice. Fixed in M3: a trial reminder is retitled at delivery with the days actually left, and one for a trial that already ended is suppressed on record (`trial_already_ended`), never sent.
   - A post-trial authorization due at the trial end waits for the consumer. If the consumer first claims it more than 24 hours late, it ends in `needs_attention` with no charge (M2:841-842), which is the intended safe result.
2. **Before M3, the launch cohort had no heartbeat guard** (M1:741-771). Resolved: M3 is installed.
3. **Before M4, the admission read leaked.** Resolved: M4 is installed. The installed `fn_ca_commerce_admission` answers any signed-in caller with any club's roster count and capacity (`CHECKPOINT.md:191-192`; tightened at M4:205-223).

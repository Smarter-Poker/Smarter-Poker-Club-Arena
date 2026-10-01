# Profile privacy: a profile shows strangers only what the table needs (2026-10-01)

Diamond Arena Phase 10, line 2 ("Verify public/private fields and opponent card privacy"), the private-fields half.
The card-privacy half was verified on 2026-09-29 ([lines 1, 2 and 6](../DIAMOND-PHASE-10-LINES-1-2-6-2026-09-29.md)).
Ruling 25 ([DIAMOND-RULINGS](../DIAMOND-RULINGS.md)), decided by Claude on Dan's delegation of 2026-09-30.

Production project `kuklfnapbkmacvwxktbh`. Database facts were read with `supabase db query --linked` (read-only
selects, `pg_stat_statements` since its reset at 2026-09-28 16:36 UTC). Behaviour was proven in rolled-back
rehearsals (`rehearse.sh`, fixture accounts only) before each apply (`apply.sh`). The rehearsal fixtures are in
[profile-privacy-2026-10-01/](profile-privacy-2026-10-01/).

## What was wrong (measured 2026-09-30, 23:20 UTC)

- `profiles` has one SELECT policy, `profiles_select` (`USING true`, to `authenticated`). `authenticated` holds no
  table SELECT; its reads are carried by column grants on 98 of the 120 columns, among them `diamonds`,
  `diamond_balance`, `diamond_multiplier`, `first_name`, `last_name`, `full_name`, `birth_year`, `city`, `state`,
  `country`, `last_seen`, `last_login`, `last_login_date`, `last_active`, `updated_at`, `referred_by` and
  `poker_near_me_preferences` (which holds `lastLocation`, `lastLocationCity`, `lastLocationState` and
  `manualLocation` for the players who set one). So any signed-in account could read all of them for every account.
- `anon` holds SELECT on `bio` and `player_tags` only and has no policy: a visitor reads no profile row.
- `updated_at` is last seen in disguise: `fn_update_presence` stamps it with `last_seen`, and 267 of 1,448 rows held
  the two within two seconds of each other.
- Two definer doors answered strangers with the same fields: `get_public_profile_by_username` (anon) returned any
  account's `full_name` and `diamonds`; `get_unified_user_profile` returned any account's `city` and `state`.

## The classification (every column of `public.profiles`)

Private = SELECT revoked from `authenticated` and `anon` by the revoke migration; readable by the owner through
`get_my_full_profile()` and by platform staff through `get_full_profiles_for_staff(uuid[])`. "Private (already)" were
not readable by `authenticated` before this work and are unchanged. Where a column is genuinely ambiguous it stays
public and the row says why.

| #   | Column                         | Class              | Why                                                                                                               |
| --- | ------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1   | `id`                           | public             |                                                                                                                   |
| 2   | `full_name`                    | **private**        | real identity                                                                                                     |
| 3   | `display_name`                 | public             |                                                                                                                   |
| 4   | `first_name`                   | **private**        | real identity                                                                                                     |
| 5   | `last_name`                    | **private**        | real identity                                                                                                     |
| 6   | `username`                     | public             |                                                                                                                   |
| 7   | `email`                        | private (already)  | contact                                                                                                           |
| 8   | `phone`                        | private (already)  | contact                                                                                                           |
| 9   | `bio`                          | public             |                                                                                                                   |
| 10  | `city`                         | **private**        | whereabouts                                                                                                       |
| 11  | `state`                        | **private**        | whereabouts                                                                                                       |
| 12  | `alias`                        | public             |                                                                                                                   |
| 13  | `avatar_url`                   | public             |                                                                                                                   |
| 14  | `role`                         | public             |                                                                                                                   |
| 15  | `status`                       | public             |                                                                                                                   |
| 16  | `is_vip`                       | public (ambiguous) | drives VIP styling others see                                                                                     |
| 17  | `is_horse`                     | private (already)  | house horses (revoked 2026-09-03)                                                                                 |
| 18  | `is_admin`                     | public             |                                                                                                                   |
| 19  | `is_online`                    | public (ambiguous) | presence; the player controls it (app_settings.showOnlineStatus); fresh presence is served by fn_profile_presence |
| 20  | `player_number`                | public             |                                                                                                                   |
| 21  | `diamonds`                     | **private**        | money: the Diamond balance                                                                                        |
| 22  | `diamond_balance`              | **private**        | money: the Diamond balance mirror                                                                                 |
| 23  | `diamond_multiplier`           | **private**        | money: the earning multiplier                                                                                     |
| 24  | `level`                        | public             |                                                                                                                   |
| 25  | `tier`                         | public             |                                                                                                                   |
| 26  | `skill_tier`                   | public             |                                                                                                                   |
| 27  | `login_streak`                 | public             |                                                                                                                   |
| 28  | `streak_days`                  | public             |                                                                                                                   |
| 29  | `settings`                     | public             |                                                                                                                   |
| 30  | `preferences`                  | public             |                                                                                                                   |
| 31  | `social_page_id`               | public             |                                                                                                                   |
| 32  | `favorite_venue`               | public (ambiguous) | where they like to play, which they chose to show                                                                 |
| 33  | `home_poker_club`              | public (ambiguous) | where they like to play, which they chose to show                                                                 |
| 34  | `referred_by`                  | **private**        | named by the ruling: who brought the person in                                                                    |
| 35  | `friends_count`                | public             |                                                                                                                   |
| 36  | `hendon_total_cashes`          | public (ambiguous) | public tournament record (The Hendon Mob)                                                                         |
| 37  | `hendon_total_earnings`        | public (ambiguous) | public tournament record (The Hendon Mob)                                                                         |
| 38  | `email_verified`               | public             |                                                                                                                   |
| 39  | `phone_verified`               | public             |                                                                                                                   |
| 40  | `onboarding_complete`          | public             |                                                                                                                   |
| 41  | `last_login`                   | **private**        | last seen (sign-in time)                                                                                          |
| 42  | `last_login_date`              | **private**        | last seen (sign-in day)                                                                                           |
| 43  | `last_seen`                    | **private**        | whereabouts in time: last seen                                                                                    |
| 44  | `created_at`                   | public (ambiguous) | member since                                                                                                      |
| 45  | `updated_at`                   | **private**        | last seen: fn_update_presence stamps it with last_seen (267 of 1,448 rows equal to the second)                    |
| 46  | `training_view_mode`           | public             |                                                                                                                   |
| 47  | `last_trivia_date`             | public (ambiguous) | a game statistic (trivia streak day)                                                                              |
| 48  | `trivia_streak`                | public             |                                                                                                                   |
| 49  | `trivia_high_score`            | public             |                                                                                                                   |
| 50  | `total_hands_played`           | public             |                                                                                                                   |
| 51  | `notification_token`           | private (already)  | device                                                                                                            |
| 52  | `referral_code`                | public (ambiguous) | made to be shared                                                                                                 |
| 53  | `horse_status`                 | private (already)  | house horses                                                                                                      |
| 54  | `horse_profile`                | private (already)  | house horses                                                                                                      |
| 55  | `sounds_enabled`               | public             |                                                                                                                   |
| 56  | `vibrations_enabled`           | public             |                                                                                                                   |
| 57  | `show_stack_bb`                | public             |                                                                                                                   |
| 58  | `birth_year`                   | **private**        | real identity: year of birth                                                                                      |
| 59  | `favorite_hand_type`           | public             |                                                                                                                   |
| 60  | `card_back_preference`         | public             |                                                                                                                   |
| 61  | `country`                      | **private**        | whereabouts                                                                                                       |
| 62  | `website`                      | public (ambiguous) | a link they chose to publish                                                                                      |
| 63  | `twitter`                      | public (ambiguous) | a link they chose to publish                                                                                      |
| 64  | `instagram`                    | public (ambiguous) | a link they chose to publish                                                                                      |
| 65  | `hendon_url`                   | public (ambiguous) | public tournament record link                                                                                     |
| 66  | `favorite_game`                | public             |                                                                                                                   |
| 67  | `favorite_hand`                | public             |                                                                                                                   |
| 68  | `home_casino`                  | public (ambiguous) | where they like to play, which they chose to show                                                                 |
| 69  | `cover_photo_url`              | public             |                                                                                                                   |
| 70  | `favorite_hand_plo`            | public             |                                                                                                                   |
| 71  | `app_settings`                 | public (ambiguous) | settings; no money, identity or location in it (keys measured)                                                    |
| 72  | `display_name_preference`      | public             |                                                                                                                   |
| 73  | `cover_photo_position`         | public             |                                                                                                                   |
| 74  | `tiktok`                       | public (ambiguous) | a link they chose to publish                                                                                      |
| 75  | `telegram`                     | public (ambiguous) | a handle they chose to publish                                                                                    |
| 76  | `birthday`                     | private (already)  | date of birth (revoked 2026-09-29)                                                                                |
| 77  | `hendon_biggest_cash`          | public (ambiguous) | public tournament record (The Hendon Mob)                                                                         |
| 78  | `use_real_name`                | public             |                                                                                                                   |
| 79  | `streak_count`                 | public             |                                                                                                                   |
| 80  | `access_tier`                  | public             |                                                                                                                   |
| 81  | `vip_tier`                     | public (ambiguous) | drives VIP styling others see                                                                                     |
| 82  | `vip_expires_at`               | public (ambiguous) | drives VIP styling others see                                                                                     |
| 83  | `last_active`                  | **private**        | last seen                                                                                                         |
| 84  | `poker_near_me_preferences`    | **private**        | whereabouts: holds lastLocation, lastLocationCity, lastLocationState, manualLocation                              |
| 85  | `can_review`                   | public             |                                                                                                                   |
| 86  | `deleted_reviews_count`        | public             |                                                                                                                   |
| 87  | `kyc_status`                   | private (already)  | identity check                                                                                                    |
| 88  | `kyc_provider`                 | private (already)  | identity check                                                                                                    |
| 89  | `kyc_inquiry_id`               | private (already)  | identity check                                                                                                    |
| 90  | `kyc_completed_at`             | private (already)  | identity check                                                                                                    |
| 91  | `kyc_rejection_reason`         | private (already)  | identity check                                                                                                    |
| 92  | `age_verified`                 | private (already)  | identity check                                                                                                    |
| 93  | `age_verified_at`              | private (already)  | identity check                                                                                                    |
| 94  | `jurisdiction_country`         | private (already)  | whereabouts                                                                                                       |
| 95  | `mfa_required`                 | private (already)  | account security                                                                                                  |
| 96  | `hub_preferences`              | public             |                                                                                                                   |
| 97  | `friend_preferences`           | public             |                                                                                                                   |
| 98  | `store_preferences`            | public             |                                                                                                                   |
| 99  | `messenger_preferences`        | public             |                                                                                                                   |
| 100 | `reels_preferences`            | public             |                                                                                                                   |
| 101 | `over_18_attested_at`          | private (already)  | identity check                                                                                                    |
| 102 | `jurisdiction_region`          | private (already)  | whereabouts                                                                                                       |
| 103 | `jurisdiction_acknowledged_at` | private (already)  | whereabouts                                                                                                       |
| 104 | `home_games_onboarded_at`      | public             |                                                                                                                   |
| 105 | `social_profile_completed`     | public             |                                                                                                                   |
| 106 | `is_farming_flagged`           | private (already)  | moderation                                                                                                        |
| 107 | `stripe_customer_id`           | private (already)  | money                                                                                                             |
| 108 | `club_arena_tos_accepted_at`   | public             |                                                                                                                   |
| 109 | `bankroll_preferences`         | public (ambiguous) | UI preferences only (autoSave, notifications), despite the name                                                   |
| 110 | `diamond_arena_preferences`    | public             |                                                                                                                   |
| 111 | `memory_games_preferences`     | public             |                                                                                                                   |
| 112 | `news_preferences`             | public             |                                                                                                                   |
| 113 | `video_library_preferences`    | public             |                                                                                                                   |
| 114 | `memory_elo`                   | public             |                                                                                                                   |
| 115 | `arena_avatar_url`             | public             |                                                                                                                   |
| 116 | `equipped_frame`               | public             |                                                                                                                   |
| 117 | `equipped_aura`                | public             |                                                                                                                   |
| 118 | `use_avatar_as_profile_pic`    | public             |                                                                                                                   |
| 119 | `status_text`                  | private (already)  | never granted (pre-existing)                                                                                      |
| 120 | `player_tags`                  | public             |                                                                                                                   |

## The doors (migration 1, live)

| Door                                                            | Signature                                                                               | Who                                               | Answers                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Owner (existing, pinned md5 `a464244a590dd2615cadc79c63a283ba`) | `get_my_full_profile() RETURNS SETOF profiles`                                          | the signed-in account                             | its own row; 42501 with no session; anon cannot call                                   |
| Staff (new)                                                     | `get_full_profiles_for_staff(p_user_ids uuid[]) RETURNS SETOF profiles`                 | `fn_is_platform_admin()` (admin, superadmin, god) | the rows asked for; anyone else 42501 by name; anon cannot call                        |
| Presence (new)                                                  | `fn_profile_presence(p_user_ids uuid[]) RETURNS TABLE(user_id uuid, is_online boolean)` | signed-in accounts                                | `is_online AND last_seen > now() - 5 minutes`; never the heartbeat; at most 1,000 rows |

Writes are unchanged: `authenticated` keeps UPDATE on the private columns (the owner edits their own row), and RLS,
`service_role` and INSERT are untouched.

## Every consumer, and how each moved

### The database (read 2026-09-30)

- **RLS policies that read `profiles`:** 28, on 23 tables. Every one reads `id`, `role` or `is_admin` (public). None
  reads a private column.
- **Views over `profiles`:** one, `horse_style_performance` (security invoker, no browser grant).
- **Realtime:** `profiles` is in no publication, so no browser receives row images of it.
- **Invoker functions a browser can reach** (directly, or as a trigger on a table a browser can write) that read
  `profiles` and name a private column - 15 found by a catalogue sweep:
  - moved by migration 1 (asserted substitution): `fn_get_stories` (it swallows errors, so the story bar would have
    gone empty without a word), `get_top_mission_completers`, `fn_notify_home_member_status`,
    `fn_notify_home_post_comment`, `fn_notify_home_post_created`, `fn_notify_home_post_like`, `fn_notify_home_rsvp`,
    `fn_welcome_new_approved_member`, `fn_notify_mention`;
  - read nothing private and stay: `fn_ca_diamond_transfer_names_its_counterparty` (reads `p.id`; "diamonds" is in
    its text), `fn_calculate_rakeback` (a stub; "updated_at" is in a comment), `fn_guard_profile_privileged_columns`
    and `fn_protect_profile_username_and_gate` (read `NEW`/`OLD`, which no grant governs), `fn_update_presence` (writes
    `last_seen`/`updated_at`, filters on `id`; UPDATE stays granted);
  - `fn_hg_caller_display_name` reads the real-name fields but is called only by five definers (`rpc_hg_*`,
    `fn_home_game_unseated_confirmed`), which run as their owner; no client calls it directly (searched in both
    repositories and the org's other repositories), so it stays.
- **Definer doors that answered strangers with private fields:** `get_public_profile_by_username` and
  `get_unified_user_profile`, closed by migration 1 (same signatures; the World Hub's `/u/[username]` page already
  falls back to the display name). Others that return a person's legal name or presence to other people (home-game
  rosters and notifications, messenger, union and club directories) are listed under Follow-ups: the revoke cannot
  reach a definer, and each serves a screen whose owner should look at it.
- **Edge functions:** two (`send-invite-email`, `send-push-notification`, which answers 410). Neither reads `profiles`.

### The Club Arena (this repository, `src/`)

186 `.from('profiles')` statements were read (`docs/evidence/profile-privacy-2026-10-01/scan-profile-consumers.py`).
Every read that named a private column moved:

| Read                                                                                                          | Was                                    | Now                                                                      |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| player names everywhere (`PLAYER_NAME_COLUMNS`, 115 uses, plus waitlist and union admin names)                | legal-name columns of other players    | public name columns only; arena handles                                  |
| own Diamond balance: wallet, chip mint, advertising, VIP page, time-bank store, Diamond service, profile page | `.from('profiles').select('diamonds')` | `ownProfile(id)` (owner door)                                            |
| own profile and account sync (`useUserStore.loadProfile`, `useProfileAccountSync`)                            | own row incl. legal name and balance   | owner door                                                               |
| own login streak day (`AchievementTriggerService.onLogin`), own data export (`SettingsPage`)                  | `last_login_date`, `last_login`        | owner door                                                               |
| `IdentityDNA.loadUserProfile`, `ProfileService.getPublicProfile`                                              | `updated_at`                           | dropped (nothing read it)                                                |
| friends list, online-friends pill, presence dot, player status                                                | `last_seen`                            | presence door; offline friends read "Offline"                            |
| agent dashboard online count, last active, at-risk and churn                                                  | players' `last_seen`                   | presence door; last hand played in that club (`player_stats.updated_at`) |
| agent score card retention                                                                                    | `.gte('last_seen', ...)`               | `player_stats.updated_at` in that club                                   |
| agent player search, invite search                                                                            | `email`, `last_active`                 | dropped (email was never granted, so both were refused whole)            |
| `ProfileService.getLeaderboard` (no caller)                                                                   | ranked other players by `diamonds`     | ranks hands                                                              |

The engine (`server/`) reads profiles with the service role and is unaffected. The native shell ships no OTA bundle
yet (`CAPGO_OTA_ENABLED` is unset), so no installed app carries old code.

### The World Hub

Moved by its own agent (privacy-wh), coordinated through `privacy-handshake.md`; its pull request and deploy are
recorded below when they land.

### Every other app on this project

All 25 repositories of the Smarter-Poker organisation were cloned at their default branch on 2026-10-01 and searched.
Seven talk to `kuklfnapbkmacvwxktbh`:

| Repository                                        | Reads private profile columns?                                        | Role                                                                            | Affected by the revoke                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| smarter-poker-commander                           | `full_name`, `first_name`, `last_name`, `city`, `state` in API routes | service role (`SUPABASE_SERVICE_ROLE_KEY`)                                      | no                                                                                                            |
| smarter-poker-workers                             | `full_name`, `city`, `state`                                          | service role                                                                    | no                                                                                                            |
| commander-shared                                  | `diamonds` in `premiumFeatureGate`                                    | browser, but nothing imports it (Commander's own copy no longer reads profiles) | no                                                                                                            |
| identity-dna-engine                               | `select('*')`                                                         | `*` is already refused for `authenticated` (22 ungranted columns)               | no change                                                                                                     |
| Smarter-Poker-Diamond-Arena                       | `diamond_balance`                                                     | browser                                                                         | not deployed: `diamond.smarter.poker` answers 404 DEPLOYMENT_NOT_FOUND, and no such statement ran in two days |
| Smarter-Poker-Memory-Games, AI-Content-GTO-Engine | no profile read of a private column                                   | -                                                                               | no                                                                                                            |

PepNationLab and the pepnationrx repositories use other Supabase projects.

### What production actually ran (pg_stat_statements, `authenticated`, since 2026-09-28 16:36 UTC)

53 statements touched `profiles`, 323,180 calls. 24 of them read a private column (221,788 calls); every one is a
Club Arena read moved above (the name lists, the own balance, the account sync, the presence and agent reads,
`IdentityDNA`) or a World Hub read (`readOwnProfile` in the diamond store and `useCurrentUser`, the header stats,
Poker Near Me). One more only writes one (the login-streak `UPDATE ... SET last_login_date`, which stays granted).
`anon` ran none.

## Rehearsals and applies

| Migration                                                                 | md5                                | Rehearsal                                                                                                                                                                                                                                                                                                | Apply                                                      |
| ------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `20260930234000_a_profiles_private_fields_have_an_owner_and_a_staff_door` | `765c08b217ec756f9b3ffb1f282026e4` | REHEARSAL OK: owner=own-row presence=fresh-online,stale-offline staff=refused(player,visitor) public-profile=no-name,no-balance staff=reads unified=owner-only-city story='openshove' revoke=stranger-refused,public-read,owner-door,owner-edit,upsert-refused,presence,readers-ok,staff-door in 2372 ms | APPLIED AND RECORDED 20260930234000 (2026-10-01 00:05 UTC) |

The first rehearsal simulates the revoke inside its own transaction, so the readers were proven against the revoke
before anything was revoked.

## Found on the way

- An upsert that names a private column is refused after the revoke even though UPDATE stays granted: `ON CONFLICT DO
UPDATE SET x = EXCLUDED.x` reads `x` (PostgreSQL 17, proven locally and in the rehearsal). Owners edit with
  `.update(...).eq('id', id)`.
- `GRANT`/`REVOKE` of column privileges takes no lock on the table (PostgreSQL 17, measured locally), so the revoke
  cannot queue behind or block live traffic.
- 288 human rows hold `is_online = true` with a heartbeat more than ten minutes old; the presence door is the only
  honest "online" answer.

## Follow-ups (not changed here)

- 31 human accounts (Dan's among them) have a display name that is exactly their legal name. The display name is
  public by ruling 25, so those names stay visible; this is Dan's to decide (leave them, or clear a display name that
  equals the legal name).
- Definer RPCs that still answer other people with a legal name, city or presence (home games, messenger, union and
  club directories): the column revoke cannot reach them; each serves a screen that needs its own review.

## Verdict

Pending the revoke (step 2) and its verification, recorded below when done.

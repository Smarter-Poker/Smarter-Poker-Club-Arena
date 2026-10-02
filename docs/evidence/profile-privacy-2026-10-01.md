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

Moved by its own agent (privacy-wh), coordinated through a handshake file: Smarter-Poker-World-Hub#2056, squash commit
`e2fc35c368d1955c33e4e82d6c63b9a5ce02528e`, merged 2026-10-01 00:14:47 UTC after every required check, live on Vercel
(`dpl_9q27GswMKEdaHveYuxM69ufcvx4w`) at 00:18:41 UTC; `/api/health` reported that commit at 00:18:53.

- 86 call sites changed. 41 reads of other people now name public columns only (post, comment, story and live-stream
  author embeds, people search, messenger, the in-app profile page through `SAFE_PROFILE_COLUMNS`, the signed-out
  `/u/[username]` page no longer showing a legal name). 45 reads of the signed-in user's own private fields (diamond
  store, wallet, header stats, trivia, settings, Poker Near Me) go through `get_my_full_profile()`
  (`src/lib/ownProfile.js`, `readOwnProfile`).
- The messenger's online dot now asks `fn_profile_presence`; before, it read a column that does not exist
  (`last_seen_at`) and always said offline.
- The staff door is not used: World Hub staff screens read through service-role API routes.
- All 439 client chunks of the live build were scanned: 75 `from("profiles")` chains, none naming a private column in a
  select, filter, upsert, embed or REST URL. Its law (`__tests__/a-profile-shows-strangers-only-what-the-table-needs.law.test.mjs`,
  CI check 8) fails if one does again.

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

| Migration                                                                 | md5                                | Rehearsal                                                                                                                                                                                                                                                                                                                                        | Apply                                                      |
| ------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `20260930234000_a_profiles_private_fields_have_an_owner_and_a_staff_door` | `765c08b217ec756f9b3ffb1f282026e4` | REHEARSAL OK: owner=own-row presence=fresh-online,stale-offline staff=refused(player,visitor) public-profile=no-name,no-balance staff=reads unified=owner-only-city story='openshove' revoke=stranger-refused,public-read,owner-door,owner-edit,upsert-refused,presence,readers-ok,staff-door in 2372 ms                                         | APPLIED AND RECORDED 20260930234000 (2026-10-01 00:05 UTC) |
| `20260930234500_a_profile_shows_strangers_only_what_the_table_needs`      | `142966e96cb6dcfd2940e0932d9bfd5a` | REHEARSAL OK: stranger=refused(17/17),owner-table=refused public=reads owner=door,edit presence,stories,missions,unified,live-streams=ok heartbeat,transfer-check,hg-name=arena-only(direct-refused) staff=reads,player-refused visitor=no-row,public-page-no-name in 2252 ms (final, 11:25 UTC, fixture md5 `a704632c0584cdd8e3f07f498ca8f732`) | APPLIED AND RECORDED 20260930234500 (2026-10-01 11:26 UTC) |

The first rehearsal simulates the revoke inside its own transaction, so the readers were proven against the revoke
before anything was revoked. The revoke itself was rehearsed three times: as a draft at 00:23 UTC, as this file at
00:30 UTC, and finally at 11:25 UTC, after the pins were re-read, with the fixture extended to the five invoker
functions below. The pins were read again just before the apply (`get_visible_live_streams()`
`01efdcda8c294e68635d9ceaa33eabce`, `get_my_full_profile()` `a464244a590dd2615cadc79c63a283ba`, both unchanged), and
apply.sh proved the recorded text equals the file (statements md5 `c8a5e8b0b6fcdaf3383445ab81371973`).

## Step 2: the revoke

### Only once every old read had stopped

The revoke waited for both apps to be live and for their old statements to stop arriving. `pg_stat_statements` was
read for every statement by `authenticated` or `anon` that names `profiles` and a private column, writes and the two
doors excluded ([old-reads.sql](profile-privacy-2026-10-01/old-reads.sql)):

| Read at (UTC) | What had happened                                                               | Calls since the read before |
| ------------- | ------------------------------------------------------------------------------- | --------------------------- |
| 00:24:35      | baseline: 24 such statements, all from the old Club Arena and World Hub bundles | -                           |
| 01:19:54      | World Hub live since 00:18; Club Arena #5679 merged 01:14, not yet published    | 2,602 (all Club Arena)      |
| 01:26:47      | Club Arena published (run 36800347285, `aa996a3185`, built 01:21:19)            | -                           |
| 01:29:13      |                                                                                 | 0                           |
| 11:23:20      |                                                                                 | 0 (nine hours fifty-four)   |

Every write a browser sends to `profiles` was read the same way: each needs SELECT only on `id`, `arena_avatar_url` and
`use_avatar_as_profile_pic` (eight statements, all public).

All 366 chunks of the live Club Arena build were scanned the same way as the World Hub's: 146 `.from("profiles")`
chains, none naming a private column in a read. Its only writes that name one are three `UPDATE ... WHERE id` (granted)
and the sign-up upsert in `AuthPage`, which was already refused before this work (`authenticated` holds no UPDATE on
`id` or `diamonds`) and is unchanged.

### The five invoker functions that name a private column

The World Hub's agent listed the database functions that read a private column as their caller. Each keeps working
after the revoke and tells a stranger nothing private; the final rehearsal proves each one (`rehearsal-revoke.sql`,
sections 3 and 3b):

| Function                                          | What it reads                                     | After the revoke                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_get_stories(uuid)`                            | was the author's `full_name`                      | moved by migration 1 to the display name; proven: the story bar names its author by display name, not legal name                                                                                                                                                                                                                                                                                                                                                       |
| `get_top_mission_completers(uuid,integer)`        | was the real-name fields, for the arena name      | moved by migration 1; reads no private column; proven to run as a stranger                                                                                                                                                                                                                                                                                                                                                                                             |
| `fn_update_presence(uuid,boolean)`                | writes `last_seen`, `updated_at`; filters on `id` | UPDATE stays granted; proven: the owner's heartbeat writes (read back through the owner door). The live caller is the service role                                                                                                                                                                                                                                                                                                                                     |
| `fn_ca_diamond_transfer_names_its_counterparty()` | the counterparty's `id`                           | a trigger on `diamond_transactions`, which no browser role may write, so it runs only under a definer or the service role; `id` is public anyway; proven                                                                                                                                                                                                                                                                                                               |
| `fn_hg_caller_display_name(uuid)`                 | the real-name fields, into `fn_arena_name`        | its five callers (`rpc_hg_list_roster`, `rpc_hg_claim_seat`, `rpc_hg_list_tables_and_reservations`, `rpc_hg_start_table`, `fn_home_game_unseated_confirmed`) are definers owned by `postgres`, so they keep working; run as that owner it answers the arena name (alias, username, or the display name unless it equals the legal name), never the legal name; called directly by a stranger it is refused. No client calls it directly (none in `pg_stat_statements`) |

The two definers the same agent named answer strangers without a private field: `get_public_profile_by_username`
returns NULL for `full_name` and `diamonds` (migration 1; the signed-out `/u/[username]` page shows the display name
and username), and `get_visible_live_streams` returns NULL for `broadcaster_full_name` (this migration; the World Hub
shows the broadcaster's username or display name).

### Verified after the apply (11:26:15 UTC)

- **The table.** The four `@live-proof` lines are true. `authenticated` reads 81 columns of `profiles` (98 before);
  `anon` reads 2 (`bio`, `player_tags`), as before; `service_role` is unchanged; UPDATE on the private columns stays.
- **Nothing a browser runs is failing on `profiles`.** `postgres_logs`, every `permission denied` and every SQLSTATE
  42501 from 11:26:15 to 11:40:46 UTC (24,899 log lines): seven `permission denied for table profiles`, all at 11:31 and
  all caused by the signed-out probe below (a visitor's read that was refused before the revoke too); none from a
  signed-in read. The other four were the engine's own (three `TOURNAMENT_MANAGER_FENCED` lease fences, one
  hand-statistics warning). Meanwhile signed-in reads of `profiles` kept succeeding: at 11:41 UTC
  `pg_stat_statements` held 71 such statements for `authenticated`, the owner door among them (7,823 calls).
- **Signed-out visitor, both apps, each page loaded once in a fresh headless browser**
  ([signed-out-visit.mjs](profile-privacy-2026-10-01/signed-out-visit.mjs), 11:28 and 11:31 UTC):

| Page                                           | Result                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Club Arena home `/hub/club-arena/`             | 200, the landing page; no failed request                                                                                                                      |
| Club Arena wallet, table, profile, leaderboard | 200, each sends a visitor to sign in (as before); no failed request                                                                                           |
| World Hub home `/` and `/hub`                  | 200; no failed request                                                                                                                                        |
| World Hub diamond store `/hub/diamond-store`   | 200; no failed request                                                                                                                                        |
| World Hub public profile `/u/openshove`        | 200: display name, username, level, member since; no legal name, no balance; `get_public_profile_by_username` answered                                        |
| World Hub in-app profile `/hub/user/openshove` | "User Not Found": the page reads `profiles` from the browser, and a visitor has never been able to (anon held `bio` and `player_tags` only, before and after) |
| World Hub live streams `/hub/lives`            | "No Lives Yet": the list embeds `profiles`, refused to a visitor for the same reason, before and after                                                        |

The last two are not caused by the revoke: it took nothing from `anon`, which had none of the seventeen (column grants
read 2026-09-30 23:19 UTC and again after the apply). Their refusals are the seven `permission denied for table
profiles` lines this probe caused at 11:31.

Lock and statement timeouts on engine tournament and hand calls (service role, none touching `profiles`) came in the
same bursts after the apply as in the hour before it (for example 21 lock timeouts and 5 deadlocks at 11:05, 43
statement timeouts at 11:14, 36 at 11:22); the apply held no lock any of them waits on and had committed at 11:26:15.

## What a stranger can and cannot read now

- **A signed-in stranger reading `profiles`** (the API, or any browser query) reads only the public columns: display
  name, username, alias, avatar, player number, level and tier, public statistics (hands, streaks, trivia, Hendon Mob
  record), bio and tags, VIP badge, the links they chose to publish, member since, and the raw `is_online` flag. They
  cannot read anyone's Diamond balance or multiplier, legal or real name, year of birth, city, state or country, last
  seen, last sign-in or last active time, who referred them, or their saved location; nor (as before) email, phone,
  birthday, identity checks, jurisdiction, payment ids or device tokens. Asking for any of those is refused whole.
- **The owner** reads all of their own row through `get_my_full_profile()`, and still edits it.
- **Platform staff** read whole rows through `get_full_profiles_for_staff(uuid[])`.
- **Who is online** is answered by `fn_profile_presence(uuid[])`: a yes or no by the five-minute rule, never the time.
- **A signed-out visitor** reads no profile row (as before). The public profile page shows display name, username,
  avatar, bio, level and member since.
- **Through the database functions a browser calls**, the story bar, mission leaderboard, notification texts, live
  stream list, public profile and unified profile no longer hand a stranger a legal name, balance or city.
- **Not reached by this work** (they run as their owner, or as the service role, so a column revoke cannot touch them;
  listed under follow-ups): home-game screens and agent tools fall back to a legal name for an account with no display
  name (nobody in a home game today), an agent's tree shows sub-agents' legal names, club staff see a member's last
  sign-in, and some World Hub server routes still hand out legal names. None of these is reachable in the Diamond
  Arena.

## Found on the way

- An upsert that names a private column is refused after the revoke even though UPDATE stays granted: `ON CONFLICT DO
UPDATE SET x = EXCLUDED.x` reads `x` (PostgreSQL 17, proven locally and in the rehearsal). Owners edit with
  `.update(...).eq('id', id)`.
- `GRANT`/`REVOKE` of column privileges takes no lock on the table (PostgreSQL 17, measured locally), so the revoke
  cannot queue behind or block live traffic.
- 288 human rows hold `is_online = true` with a heartbeat more than ten minutes old; the presence door is the only
  honest "online" answer.
- The World Hub's messenger said everyone was offline: it read `last_seen_at`, a column that does not exist (fixed in
  #2056 with the presence door).
- A signed-out visitor has never been able to read a profile row, so the World Hub's in-app profile page and live list
  show nothing to a visitor (before and after this work; the public `/u/[username]` page is the visitor's door).

## Follow-ups (not changed here)

The column revoke reaches every read that runs as `authenticated` or `anon`. It cannot reach a function that runs as
its owner or a server route that uses the service role. Read on 2026-10-01, 64 such functions a browser can call name a
private column of `profiles`; most use it only for the caller's own balance or pass the real-name fields to
`fn_arena_name`, which never returns them. The rest:

- **A legal name when there is no display name.** 146 human accounts have a legal name and no display name. These
  home-game functions fall back to the legal name in that case (`COALESCE(display_name, full_name, ...)`):
  `get_home_group_roster`, `get_home_game_seat_map`, `get_live_home_game_state`, `get_home_group_feed`,
  `get_home_group_member_engagement`, `get_host_dashboard`, `get_friends_home_activity`, `fn_home_list_seats`,
  `export_home_group_members_csv`, `list_home_ban_appeals_admin`, `list_home_ban_appeals_for_host`,
  `rsvp_to_home_game` (the host's name) and `get_home_group_public_detail` (reviewer names, to visitors too). Today
  none of the 21 home-game members lacks a display name and there are no reviews, so no legal name shows; one would for
  a member who has none. Agent tools: `ca_club_my_downline` returns each sub-agent's `full_name` to the agent above
  them; `calculate_agent_spread` and `generate_period_settlements` fall back to it after the display name and username.
  None of these is reachable inside the Diamond Arena (no agents, no home games). Under ruling 25 each should name
  people by `fn_arena_name`, the way the club screens already do.
- **Last sign-in to club staff.** `ca_club_member_detail` returns a member's last sign-in time
  (`coalesce(last_login, last_seen)`) to the club's staff (its `v_sensitive` branch); a Diamond player's detail is NULL
  (Phase 10 line 6). The other six that read `last_seen` (`ca_club_member_downline`, `ca_club_members_summary`,
  `fn_search_players`, `fn_community_overview`, `fn_diamond_arena_counts`, `fn_diamond_arena_roster`) use it only for
  the five-minute online rule, the presence door's, and never return the time.
- **World Hub server routes** (service role, from the World Hub agent's list): `pages/api/poker/leaderboards.js`,
  `poker/checkins/*`, `social/pages/*`, `social/interactions.js`, `live/gifts.js`, `live/schedule.js`,
  `social/live-session.js`, `notifications/feed.js`, `poker/reviews.js` and `public/home-games/[slug]/*` still hand
  out legal names.
- **31 human accounts (Dan's among them) have a display name that is exactly their legal name.** The display name is
  public by ruling 25, so those names stay visible. This is Dan's to decide: leave them, or clear a display name that
  equals the legal name.

## Verdict

Private fields hold. Through the table, a signed-in stranger now reads only the public columns of a profile and a
visitor reads none; the owner, staff and presence doors carry the rest; no read either app sends was refused after the
revoke, and both apps' signed-out pages load as before. With the card-privacy half verified on 2026-09-29, Phase 10
line 2 holds for the Diamond Arena. The server functions and routes above that still name people outside the arena are
follow-ups under the same ruling.

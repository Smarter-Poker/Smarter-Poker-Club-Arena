# The Lightning conversion notice arrives live (2026-10-24)

A player seated at a Lightning anchor table whose game converts is entered into the pool by `fn_cash_cluster_commit_lightning` without clicking Join Lightning. Their tab offers **View Game** once `fn_lightning_my_session` names their pool session. Nothing told the tab when that moment came.

- `src/lightning/useLightningAnchorHandoff.ts` first waited on a `postgres_changes` UPDATE of `public.cash_games`. That table is not in `supabase_realtime`, and it must not be (19.7M updates on 266 rows, `pg_stat_user_tables`), so the channel said SUBSCRIBED and never fired. The notice appeared only after a reload.
- #7943 replaced that with a 30-second re-read. That was a guess on a clock, not the event: up to 30 s late, a read every 30 s per seated Lightning tab, and still a polling repair loop.

The other candidate carriers were also wrong. `lightning_pool_session` is unpublished and has no player grant (1.4M updates on 4.3k rows). `cash_cluster_events` is published, but players cannot read it and it takes about 5M inserts.

## Root fix: the transaction that opens the room says so

Migration `20261025025154_a_lightning_pool_session_tells_its_player_the_moment_it_open.sql` patches **both** writers of `public.lightning_pool_session`, as read live:

- `fn_cash_cluster_commit_lightning`, the conversion: one `realtime.send` per pool session it opened in the new epoch, just before step 22.
- `fn_lightning_pool_enter`, the door every later entry goes through (`abort_pending_off`, the seat trigger, `pool_enter_seated`): one send after its `pool_player_joined` event.

Each send goes onto the **existing** owner-only Broadcast topic `profile-account:<player>`. That topic's receive policy is `players receive their own account change signal` (20260927001026), and `ProfileAccountSync` already holds it open once per signed-in tab. The event is the same `account_changed`. The payload is identity only: `{user_id, cluster_id, reason: 'lightning_room_opened', domains: []}`. So the fix adds no publication member, no policy, no grant, no table and no channel.

`realtime.send` writes inside the caller's transaction. A conversion that aborts sends nothing. A send failure is caught inside `realtime.send` and cannot roll the conversion back. No chip, seat, session or ledger row is touched, and the conversion's money, left-behind and stranded assertions still run after the new statement. There is no `is_horse` anywhere: every pool session is told (10.5).

The patch is guarded by the md5 pre-image of each live body (`pg_get_functiondef`, read 2026-10-25: `35cf4a34...` and `634a4efa...`). Each anchor must occur exactly once. The post-image md5 (`e1edf0a3...`, `9149913448...`) is asserted before and after `EXECUTE`. Owner, SECURITY DEFINER flag, search_path and ACL are read back unchanged. It is one transaction. `CREATE OR REPLACE FUNCTION` takes only AccessShare (measured on PG16), so it needs no install window.

## Client

- `ProfileAccountSync` relays `reason: 'lightning_room_opened'` for its own account as the bus event `LIGHTNING_ROOM_OPENED {userId, clusterId}`. On every rejoin of the carrier it emits `{userId}` with no Cluster, because a signal may have been missed while disconnected.
- `useLightningAnchorHandoff` reads the session once on mount. After that it reads only when that event names its Cluster or names none, and once more when a hidden tab that received a signal becomes visible. The interval, the visibility poll and the `LIGHTNING_LOBBY_REFRESH_MS` import are gone. Classic games are still never watched.

## Verified

- Live, read-only: both pre-images match, each anchor occurs once, and the post-image md5s are the ones the migration asserts.
- Native PG16 run of the migration's own DO block against a fixture that carries the live anchors:
  - The production md5s are refused against a different body, and a replay is refused.
  - Grants and SECURITY DEFINER are kept.
  - A three-player conversion writes three private `account_changed` messages, each on its own player's `profile-account:` topic.
  - A rolled-back conversion writes none.
  - A pool entry writes one.
  - A failing `realtime.messages` insert leaves the caller committed.
- Tests:
  - New: `tests/lightning/lightning-conversion-notice-arrives-live.test.tsx`. It fails 4 of 10 against the previous hook.
  - Updated: `tests/lightning/lightning-phase-6-review-fixes.test.tsx`, which now drives the notice by the signal instead of the clock, and `tests/unit/ProfileAccountSync.test.tsx`, which covers the relay and its account filter.

Not done here: the migration is not applied. It goes through the normal Apply Merged Migration path after merge. Until it is live, a seated player gets the notice on mount, on tab focus after a signal, or on a carrier rejoin.

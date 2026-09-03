# Daily Missions Phase 4 — Realtime State And Clock Isolation

## Player-facing result

- Mission progress, Reward Vault changes, streak-freeze inventory, and diamond
  balance changes now reconcile from one private per-player Realtime cursor.
- Cross-tab and cross-device progress no longer depends on a subscription to a
  table that was absent from the Realtime publication.
- Event bursts are coalesced into one silent dashboard receipt, so finishing a
  hand does not flash a loading state or fan out duplicate reads.
- A dropped Realtime channel is surfaced as reconnecting, recovered through the
  shared channel lifecycle, and reconciled once when the connection returns.
- Daily rollover is scheduled at the UTC boundary and background-tab resume is
  reconciled from wall time. There is no visible polling fallback.

## Performance result

- Countdown time no longer lives in `DailyChallengesPage` state.
- One shared wall-clock publisher wakes only the two countdown leaves. Mission
  cards, the command deck, Reward Vault, tabs, and celebration tree do not
  re-render once per second.
- The clock is deadline-derived from `Date.now()`, so browser throttling cannot
  accumulate countdown drift.

## Data contract

- `daily_challenge_dashboard_revisions` exposes only `user_id`, a monotonic
  revision, and timestamp under owner-only RLS.
- Triggers advance it for authoritative mission rows, streak state, and actual
  `profiles.diamonds` changes.
- The revision table is explicitly added to `supabase_realtime`; raw financial
  and profile records are not sent through the Daily Missions stream.

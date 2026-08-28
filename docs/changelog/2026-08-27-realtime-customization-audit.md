# 2026-08-27 — customization now repaints every live table

## Shipped

- Routed themes, table skins, button styles, backgrounds and card backs through one optimistic, partial-row writer. Rapid selections are persisted in tap order and a rejected save rolls every mounted table back without erasing a newer choice.
- Added account-scoped mutation identities so an older database echo cannot flash stale artwork, avatars or cosmetics over the player's newest choice, and one signed-in account cannot repaint another account's tabs.
- Replaced the global table-settings warm cache with per-account caches and account-scoped write queues. Logging out while a save is in flight can no longer leak or roll an old account's visual toggles into the next account.
- Added immediate avatar, frame and aura events for the header and every seated copy of the player. Durable profile updates now reconcile through one roster-scoped realtime channel per table instead of one unfiltered platform-wide profile feed per open table.
- Added cross-device realtime handlers for `user_theme_settings`, `user_table_settings` inserts and updates, and profile light/dark mode. Multi-table slots receive the same discrete updates and rollbacks as the source picker.
- Removed the last competing card-back and big-blind-display writers. Card backs use the canonical appearance path, and the hamburger's stack display switch uses the same ordered table-settings hook as the in-table panel.
- Aligned the first-row database defaults with the free client catalog so a new player's first partial customization is accepted by the entitlement trigger and does not swap unrelated artwork.
- Kept all preset themes visually distinct while ensuring every free preset bundles only a free felt.

## Database

- Added `public.user_theme_settings` to `supabase_realtime` with an idempotent migration and verification block.
- Changed `user_theme_settings` defaults to `default-dark`, `classic_green`, `classic-white`, `midnight` and `classic_red`.
- Both migrations were applied to production and the publication/default state was verified after application.

## Verification

- Added regression coverage for rapid taps, double failures, stale replication echoes, multi-table repainting, cross-account isolation, avatar write ordering, roster-scoped profile subscriptions, cross-device settings, light/dark mode and catalog/default contracts.
- Confirmed every selectable appearance category is wired to the live table surface, including persistent multi-table `TablePage` instances.

## Deliberately not changed

- The automatic MTT Final Table felt and broadcast background continue to override a player's table/background selection while the event state is active. The saved choice remains intact and resumes afterward.

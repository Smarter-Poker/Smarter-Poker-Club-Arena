# Table artwork keeps the newest account row

The routed mobile acceptance received the saved carbon-red row and then another account-row event; both mounted tables reverted to classic green while the database still held carbon red. The live consumer previously spread every echo into the rendered selection and cached row, bypassing both row ordering and ALL-versus-game precedence.

The owning hook now records the authenticated database timestamp and values separately from client optimistic cache timestamps. Older row versions and conflicting values at an equal version cannot repaint or overwrite the cache. Identical equal-version events still reach every mounted table. Accepted database rows resolve through the same cached bucket precedence as first paint. Pending mutations retain their immediate paint and rollback identities while observed committed versions retain their ordering fence.

The regression reproduces five failures against the original hook. The repaired hook passes 47 affected tests across persistence, first-paint cache, local live events, and database realtime. The isolated final source graph passes TypeScript with no emit. Protected integration, publication, and affected live verification remain required.

Real-time law: triggered by the existing account-scoped user_theme_settings postgres_changes event; no polling or snapshot diff.

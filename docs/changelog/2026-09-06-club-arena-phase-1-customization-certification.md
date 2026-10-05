# Club Arena Phase 1: Customization Is One Live, Owned System

2026-09-06. Phase 1 closes the gap between a design appearing in a picker and
that design being owned, saved, rendered on the real table, and delivered to
every open device through the authenticated engine channel.

## Product Surface

- Table Studio is a mobile-first, near-full-screen editor with coordinated
  Looks plus separate Tables, Scenes, Buttons, Cards, and Decks tabs. Selectable
  table art no longer lives in the gameplay hamburger settings.
- The catalog exposes ten coordinated Looks, thirteen selectable table skins,
  thirty portrait-first scenes (including ten recognizable Places and ten
  patterned Skins), twelve card backs, ten face decks, and ten dealer/action
  button treatments. White D remains the default.
- The existing 97-avatar library is the only avatar-art source. The Style tab
  adds ten real frame treatments and ten real aura treatments, plus None for
  each; no substitute avatar set is generated.
- Light and Dark modes repaint the editor immediately and persist at account
  scope. The automatic MTT Final Table presentation overlays the event table,
  seats, avatars, cards, and controls on the broadcast arena; it does not paint
  a second table into the background.

## Ownership And Checkout

- Permanent designs are priced from the server catalog, purchased through the
  idempotent feature RPC, journaled once, delivered to the exact entitlement
  ledger, auto-applied, and reconciled after ambiguous network responses.
- Production commerce certification enumerates the paid tiles deployed by the
  UI and requires exact equality with `feature_pricing` before buying every one.
- `avatar_unlocks` is a server-issued entitlement ledger. Browser roles can
  read only their own rows and cannot mint, alter, delete, or truncate grants;
  trusted service-role and security-definer purchase/reward writers remain.
- Avatar, frame, and aura copy consistently names every valid path: active VIP,
  club-shop purchase, or a separately issued reward. Expired monthly VIP flags
  do not grant premium cosmetics; lifetime membership remains durable.

## Live Delivery And Failure Semantics

- Theme, table, background, button, card-back, face-deck, interface-mode,
  collection, avatar, frame, and aura mutations repaint optimistically, persist
  with ordered mutation receipts, and recover without an older response
  overwriting a newer choice.
- Cross-device changes use named authenticated engine events. Seated avatar
  fanout is table-scoped and account-authenticated; browser profile WAL,
  snapshot diffs, and polling are not the live product path.
- Per-game theme buckets reconcile independently, so an event for one game type
  cannot suppress a newer snapshot for another.

## Database Changes

- `20260906093222_phase_one_customization_authority_closure`
- `20260906152652_ten_face_decks_are_owned_saved_and_live`
- `20260906153403_ten_avatar_frames_and_ten_avatar_auras`
- `20260906093432_short_formats_are_never_final_tables`

The first three are backward-compatible client prerequisites. The short-format
constraint is applied only after the compatible engine is proven live.

## Certification Checkpoint

- Scope: recover and finish the Phase 1 customization delivery only. This
  includes its client, existing named engine-event support, four migrations,
  required workflow wiring, protected merge, publication, and live proof.
- Acceptance: mobile-first layout; table and avatars remain primary; premium
  scenes frame the table; coherent Light/Dark modes; White D default; the
  existing 97-avatar library; immediate durable account-scoped changes;
  idempotent purchases; named realtime propagation; automatic MTT-only Final
  Table presentation; every required check and production proof is terminal.
- Exclusions: no Phase 2 work, no unrelated UI sweep, no new avatar library,
  no retired publisher, no scheduler/watchdog, and no destructive testing on
  active players or games.
- Operation owner: this Codex task, branch
  `agent/codex-phase1-20261005/fix/customization-phase1-certification-closure`,
  worktree
  `/Volumes/SmarterWork/agent-work/codex-club-arena-phase1-20261005/codex-phase1-20261005`.
- Recovered baseline: archived commit `d9c3002f0431663a4015223f86c1ac58b9509294`
  plus its six-file uncommitted regression patch. Current protected base at
  resumption: `1157cf081a3586e6007ce80813ce24c1988ae5a6`.
- Policy receipt refreshed after resumption at 2026-10-05T11:03:37Z: version 2.9, manifest
  `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
  Canonical and portable hashes matched. Required repository, publication,
  storage, deployment, hardening, and Club Arena Console references were read.
- Delivery classification: client + existing engine implementation + database
  migrations + workflow. Client publication has no hourly gate. Engine
  activation is required only if the recovered server changes remain necessary
  after current-main reconciliation.
- Previous evidence is retained only as historical input: 1,118 client files
  and 15,488 tests passed; 444 server files and 6,373 tests passed; all four
  migrations replayed twice in disposable PostgreSQL. Current-main integration
  invalidates source-dependent portions, so the exact final candidate receives
  only the affected required checks once.
- Remaining proof: semantic current-main reconciliation, focused and required
  exact-candidate checks, migration installation/readback where missing,
  protected PR/merge, publisher and any required engine release, both public
  build-info endpoints, production browser/commerce/realtime results, and
  affected live behavior.

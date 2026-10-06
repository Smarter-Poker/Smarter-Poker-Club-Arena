# Club Arena Phase 1: Customization Is One Live, Owned System

2026-09-06. Phase 1 closes the gap between a design appearing in a picker and
that design being owned, saved, rendered on the real table, and delivered to
every open device through its authenticated realtime path.

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
- Account appearance changes use owner-filtered Postgres Realtime plus named
  authenticated client signals. Seated avatar fanout is table-scoped and
  account-authenticated; polling is only a bounded repair path while the
  Studio is open, never the primary live path.
- Per-game theme buckets reconcile independently, so an event for one game type
  cannot suppress a newer snapshot for another.

## Database Changes

- `20261005111453_phase_one_customization_ownership_face_decks_and_avatar_styl`
- `20261005111523_short_formats_never_reach_final_table`

The first migration is the backward-compatible client and engine prerequisite:
it installs the durable Final Table receipt, public event projection, and
claim/read/ack RPCs without constraining legacy short-format rows. Install it
before releasing the compatible client and engine; it deliberately preserves
the write paths used by the currently served client. The second migration is
post-cutover cleanup only: it retires those legacy customization writes and
applies Final Table cleanup, default/NOT NULL, and the MTT-only constraint only
after the compatible client and engine are proven live.

## Certification Checkpoint

- Scope: recover and finish the Phase 1 customization delivery only. This
  includes its client, named engine-event support, two ordered migrations,
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
  `agent/codex-phase1-20261005/fix/production-customization-cert-contracts`,
  protected follow-up PR #6183,
  worktree
  `/Volumes/SmarterWork/agent-work/codex-club-arena-phase1-20261005/codex-phase1-20261005`.
- Recovered baseline: archived commit `d9c3002f0431663a4015223f86c1ac58b9509294`
  plus its six-file uncommitted regression patch. The candidate first
  integrated protected main `cef7530aea7b5ede5166f7b75d1bbda50c3c4cdc`.
  After the final visual correction, protected main advanced through
  `27174382f2ad44aedb775474af05a69175640354` to
  `e187377e21eb0f408d2287e8022821a1f83f58c1`; it is now integrated without a
  conflict or an overlapping Phase 1 path.
- Policy receipt refreshed after the latest resumption at 2026-10-05T20:08:25.178Z:
  version 2.9, manifest
  `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
  Canonical and portable hashes matched. Required repository, publication,
  storage, deployment, hardening, and Club Arena Console references were read.
- Delivery classification: client + engine implementation + database
  migrations + workflow. Client publication has no hourly gate. The Final
  Table transition change is an actual engine dependency, so the compatible
  client and engine must be live before legacy-write retirement and the
  short-format database constraint.
- Previous evidence is retained only as historical input: 1,118 client files
  and 15,488 tests passed; 444 server files and 6,373 tests passed; the earlier
  migration shape replayed twice in disposable PostgreSQL. The final two-step
  migration candidate then passed 102/102 assertions on PostgreSQL 17.11 with
  exact production-shaped eight-character heartbeats, NULL/foreign/stale and
  absent-seal refusal, service-role-only sealing, idempotent retry, replay, and
  post-cutover authority/constraint readback. Qualified migration SHA-256s are
  `79107c24c0da4af4ae6a203e7e8090b7da2d38cdd91b26b85fb8e535a36fa661`
  (`20261005111453`) and
  `01f55a655705900be5c31d9ab88f3efa29d5728107ce73f2802ab5e2aeed0d6f`
  (`20261005111523`). Current-main integration invalidates other
  source-dependent portions, so the exact final candidate receives only the
  affected required checks once.
- The prerequisite/post-cutover order is mechanically enforced: a protected
  schema promise names the new objects, the native PostgreSQL 17 harness is a
  blocking accounting shard input, both authenticated browser lanes publish
  exact certificate outputs, and only a terminal same-client/same-engine job
  may write the append-only cutover seal after both lanes finish. Forward
  supersession is a named non-verdict; NULL or off-lineage identity is refused.
- Prerequisite delivery is durable: PR #6152 exact head
  `43a84fb26c6c8cc7ee580de9b15ee6306200a917` passed core run `37315022620`
  and all ancillary gates, then protected-squash merged as
  `926e19c871d2fdd20177b895e6fa0c18aa8b2e30`. Apply run `37317569025`
  committed and recorded `20261005111453` as `APPLIED`. A separate read-only
  production readback proved one globally unique ledger row, one 90,236-byte
  statement, and exact SHA-256
  `79107c24c0da4af4ae6a203e7e8090b7da2d38cdd91b26b85fb8e535a36fa661`.
  The live function hashes, owners, grants, RLS, realtime publication, ten face
  decks, and ten-frame/ten-aura catalog contract match the qualified post-image.
- The final candidate integrates protected main
  `e187377e21eb0f408d2287e8022821a1f83f58c1` with the Phase 1 commits,
  preserving the MTT-only Final Table/realtime/face-deck work and every
  concurrent protected-main gameplay, navigation, Diamond, and horse-policy
  change. Protected/prerequisite paths are byte-identical to current main and
  `git diff --check` is clean. Client/server typechecks,
  production builds, 309 focused client tests, 33 focused engine tests, 16
  production browser journeys discovered by Playwright, policy classification,
  source bindings, and script syntax all pass.
- Hosted run `37322052713` proved every completed lane green except the Table
  Studio visual lane. Its ten mobile coordinated-look screenshots were 290 by
  474 instead of the approved 290 by 455 because the newly complete card-back,
  face-deck, and game caption wrapped onto a second line. The corrected caption
  keeps all facts in one accessible sentence, prints a compact one-line visual
  label, and leaves the 9:13 gameplay canvas unchanged.
- Follow-up head `de85adab2dbe89ade196f1d78f223d95c823667d` then reached
  hosted run `37329786178`. Its server, client, TypeScript, production-build,
  WebGL, source-contract, and Table Studio purchase/realtime/accessibility
  assertions passed. The remaining visual failure exposed a harness defect:
  Playwright's `iPhone 13` descriptor silently selected WebKit even though the
  project and workflow contract named Chromium. The project now overrides
  `browserName` after the descriptor spread, and a maintained law pins that
  ordering. The intentional face-deck cards and compact three-part caption
  made the old WebKit images stale; all thirty baselines were regenerated with
  actual Chromium at consistent 296-by-465 mobile and 595-by-918 tablet
  geometry. Independent review of every Standard, Final Table, and Light-mode
  image found no clipping, ellipsis, missing table/avatar/action content, or
  second-table artifact. Final Table remains the real table and seated avatars
  over the premium broadcast arena. The exact settled-source browser run
  passed 13/13, including purchase charge-once/auto-apply, two-tab realtime,
  accessibility/keyboard/zoom/forced-colors, and all thirty screenshots at
  the unchanged two-percent threshold.
- Exact pushed correction `541d6be52ed982bb5f983ac8420c932be5f8ac0e`
  repeated that proof on hosted Linux Chromium in run `37333729197`, job
  `111843933274`: shared CSS beats, the real purchase/realtime/accessibility
  gate, and all thirty Table Studio images passed with no retry or failure
  artifact. Its server shard exposed that the branch still carried an older
  protected-main horse test which did not name the already-supported
  `work_budget` outcome on a loaded host. Protected main `27174382f2` contains
  that exact correction and its connected Phase 12 implementation, so the
  branch integrated it rather than weakening or blindly rerunning the test.
- The same final-diff audit found that one account's unresolved collection RPC
  could block another account and that an old account lifecycle could update a
  new lifecycle's cache or sync status. The collection writer is now isolated
  per owner and lifecycle, failed mutations remain in exact tap order, stale
  hydration/retry/realtime work is rejected, and a monotonic per-owner revision
  floor replaces signature-based echo suppression. Newer realtime truth is
  retained while writes settle and drained afterward; invalid mutation, seed,
  read, and realtime receipts cannot claim success or poison the revision
  floor. The 40-test hook suite covers two accounts, logout, A to B to A
  lifecycle reuse, failure and retry ordering, canonical cache ownership,
  revision zero, malformed receipts, delayed echoes, and the exact final-write
  versus newer-remote-state race.
- Exact corrected-worktree checks passed: five directly affected Vitest files
  with 93 tests, client TypeScript, the four copy/title gates, Prettier, targeted
  ESLint with zero errors (one pre-existing Fast Refresh warning), 805 source
  pins across 17 binding files, canonical policy comparison, and
  `git diff --check`. The earlier local WebKit launch abort supplies no product
  verdict and is superseded by the intentional Chromium correction and clean
  13/13 settled-source Chromium run above. Hosted Linux Chromium remains the
  final cross-platform browser gate for the corrected commit.
- The production-certificate correction and this checkpoint are pushed in
  protected follow-up PR #6183. Remaining proof: complete its checks/merge,
  verify client publication and exact engine release,
  observe the terminal cutover seal, install/read back `20261005111523`, then
  run the fresh authenticated production commerce/realtime/gameplay certificate
  and verify cleanup plus affected live behavior.

## Final Browser-Certificate Correction — 2026-10-05

- Current owner policy was reread at `2026-10-05T23:13:03Z`: version 2.9,
  manifest `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
  The canonical and portable copies match. This correction is owned in
  `/Volumes/SmarterWork/agent-work/menu-cert-final` on branch
  `agent/codex-menu-cert-final-20261005`.
- Authenticated run `37381227013` proved the hamburger 35 of 35 and Leaderboard
  at 393px and 1440px with zero page, request, subresource, or console
  failures. It exposed two harness defects rather than product regressions:
  routed gameplay asked for visible copy instead of the button's accessible
  name, and the nine-surface Table Management phone audit retained a 30-second
  outer budget even though one cold route may take 45 seconds.
- The gameplay locator now uses `Open Table Studio`, the shipped accessible
  name. The phone audit derives its outer budget from all nine route allowances. The
  private appearance certificate also proves both receiving channels have
  acknowledged their owner-scoped joins before the durable profile write, so
  a pre-subscription race cannot masquerade as a lost broadcast.
- No application, database, engine, authorization, checkout, settlement, or
  realtime implementation changed. Local proof is 19 of 19 focused unit
  contracts, client TypeScript, targeted ESLint, Prettier, `git diff --check`,
  and 12 of 12 affected Playwright journeys discovered. Protected merge,
  publication, authenticated execution, and fixture cleanup remain required
  before this correction can close the production certificate.

## Tournament Continuity Recovery — 2026-10-06

- After the latest context resumption, the canonical policy reader was run
  and fully reread at `2026-10-06T03:31:52.431Z`, followed by the byte-identical
  portable reader at `2026-10-06T03:34:18.166Z`. Both emitted policy version
  2.9, manifest
  `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`,
  and owner/operating-law/hardening/reference hashes
  `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`,
  `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`,
  `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`,
  and `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`.
  The full repository, publication, deployment, storage, migration, visual,
  and existing-checkpoint references were reread from the owned external-SSD
  worktree. Protected main is now
  `d5070158b518ac60a45f52ce5c84b5bfcf2454d7`; PR #6247 is its protected
  cashier-certificate correction, while this document remains the only owned
  uncommitted path.
- After the next context resumption, the canonical reader was executed again
  and fully reread at `2026-10-06T02:45:19.962Z` on the owned external-SSD
  worktree. It emitted policy version 2.9 and the same manifest and four
  canonical hashes recorded below. Root `AGENTS.md`, `AGENT-PLAYBOOK.md`,
  `CLAUDE.md`, `PUBLISHING.md`, the deploy-path contract, storage guide,
  swarm-orchestration contract, and this complete checkpoint were reread
  before another write. The branch then fast-forwarded without conflict from
  `22efa99613ed2e8b97cd82c538ffbf5f57249491` through current protected main
  `c2b4fccb491390f2bbdceb2ce100a977898f09b5`; the only owned tracked change
  remains this certification record.
- Final-certification work resumed from protected-main descendant
  `02875455977ca36d9e832c14c299bcc7946a15f5` and integrated current protected
  main `22efa99613ed2e8b97cd82c538ffbf5f57249491`. The canonical policy reader
  emitted version 2.9 at `2026-10-06T01:27:09.275Z`, was reread after context
  compaction at `2026-10-06T01:59:21.201Z`, and the portable reader emitted
  the byte-identical manifest at `2026-10-06T01:28:17.374Z`.
  Manifest SHA-256 remains
  `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`;
  owner, operating-law, hardening, and reference-index SHA-256 values remain
  `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`,
  `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`,
  `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`,
  and `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`.
  Repository, publication, deployment, maintenance, migration, storage,
  visual, and checkpoint contracts were reread before another production
  operation. The owned closeout branch is
  `agent/codex-phase1-20261006/docs/final-certification` in the same external
  SSD worktree.
- Current owner policy was reread after resumption at
  `2026-10-06T00:55:06.875Z`: version 2.9, manifest
  `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
  Canonical hashes are `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`
  (owner), `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`
  (operating law), `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`
  (hardening), and
  `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`
  (reference index). Repository, publishing, maintenance, storage, migration,
  and checkpoint instructions remain the active contract.
- The fresh production MTT lane exposed a real 46.509-second causal-gameplay
  silence while its authenticated socket remained healthy. The table-move
  scheduler claimed every source boundary together, then serially resolved
  requests; one ambiguous result could therefore park unrelated tables for
  the full two-call-plus-receipt uncertainty envelope.
- The owned correction branch is
  `agent/codex-phase1-20261006/fix/final-continuity` in the existing Phase 1
  SSD worktree. It claims, resolves, and releases one ordered source group at
  a time. An unknown outcome retains only its exact source fence and immutable
  UUID/input, and no later source from the stale plan is claimed. Receipt,
  retry, refusal, whole-break custody, destination wake, and the strict
  45-second production certificate remain unchanged.
- Exact focused local proof passed 84 of 84 server tests across the move
  boundary, no-false-detector, and tournament-fix suites; the server TypeScript
  build, Prettier 3.8.1, canonical policy check, and `git diff --check` also
  passed. Protected merge, exact engine activation, a fresh two-lane
  authenticated production certificate, guarded forward database completion,
  finalizer readback, and post-install live proof remain required.
- Protected follow-up PR #6224 passed every active ruleset context at head
  `c557dfba36fb2a6ffbcdfd58784e0b36a935f4e7`; core run `37397249852`
  completed all four engine, four accounting, and four client shards. GitHub
  protected-squash merged it at `2026-10-06T01:21:03Z` as
  `2c3410bc25569c2249c933024ef7369b13a3af98`. Stage run `37398711599`
  succeeded and exact receiver `37399051451` owns that immutable engine
  component. The receiver completed successfully at `2026-10-06T01:57:49Z`:
  all four exact-engine shards, production-door proof, immutable publication,
  independent identity proof, append-only receipt attempt 935, and exact
  certificate dispatch passed. Post-thaw public health at
  `2026-10-06T02:01:39Z` reported exact SHA
  `2c3410bc25569c2249c933024ef7369b13a3af98`, instance/leader
  `1-7d4084e4`, maintenance idle, all 313 tables resumed, zero retained
  custody, manager quarantine, held events, stalled/dead-stalled tables, F06
  custody, lease conflicts, claim errors, or heartbeat errors. Current
  protected main `22efa99613ed2e8b97cd82c538ffbf5f57249491` contains the repair.
- A read-only regression audit of exact current tree
  `22efa99613ed2e8b97cd82c538ffbf5f57249491` re-traced the connected Phase 1
  source. It found the mobile-first Studio, ten Looks, thirteen tables, thirty
  scenes split into base/Places/Skins, twelve backs, ten face decks, ten button
  treatments with White D default, the existing exact 97-avatar catalog, ten
  frames and ten auras plus None, Light/Dark, the single real table and seated
  avatars over the MTT-only Final Table arena, owner-ordered optimistic and
  realtime persistence, and server-priced idempotent purchase/entitlement/
  auto-apply recovery all intact. It found no duplicate cosmetic picker in
  gameplay settings and no concrete regression or source blocker.
- Read-only production database state at `2026-10-06T01:31:27.612308Z`
  preserves the false-stamped original `20261005111523` with NULL statements,
  records the 9,658-byte bounded helper `20261005230204` at exact SHA-256
  `f90e9c44f7461640f280d654659f11f2ab8ae2643d4ddc612413e9d515913681`,
  and has no finalizer or MTT-only constraint yet. Cleanup is incomplete with
  no cursor, no receipts, and 307,146 invalid legacy rows. The last seal is
  stale at client/engine `c5be0012513f470bb3dd641e42bbfe893a08466e`,
  while the serving heartbeat remains `8f931f90`; therefore the guarded helper
  correctly remains untouched until the fresh exact two-lane seal exists.
- Client publisher run `37398933922` selected containing protected descendant
  `b6ae474fb086bdc7768dfb69efa10cf7dfa71bb7`, passed all four client shards,
  built, and published successfully. At `2026-10-06T01:34:56Z`, both
  `ca-static.smarter.poker/build-info.json` and the public
  `smarter.poker/hub/club-arena/build-info.json` independently reported that
  exact SHA, build time `2026-10-06T01:27:47Z`, and run `37398933922`.
  Original run `37398711651` was superseded before jobs rather than failed.
  Post-deploy run `37399799341` passed its publication and SEO gates; its two
  authenticated behavior lanes and durable Phase 1 seal remained pending at
  this checkpoint.
- Protected-main engine component
  `1be3343ffd77aecec734aa0d34d74aa3450f3dbe` contains the tournament
  continuity repair. Stage run `37405559514` selected exact receiver
  `37405648817`; all four engine shards, the 223-function production-door
  check, immutable image publication, and elected-instance identity proof
  passed. The receiver published digest
  `sha256:6d83ba9247f06b962a221afb760e6a411149b903d7fd4860e84cd2796dcca867`
  to instance and leader `1-9b02ebe5`, recorded append-only deployment attempt
  937, and dispatched post-deploy run `37406752873`. After thaw, exact public
  health returned HTTP 200; all 315 tables resumed through all eight waves.
  The next liveness sample reported 360 expected tables and 340 hands in its
  window with zero below-floor, killed, stalled, dead-stalled, quarantined,
  lease-conflicted, claim-error, or retained-custody tables.
- Protected-main client publisher `37406336033` built exact protected SHA
  `c2b4fccb491390f2bbdceb2ce100a977898f09b5`, passed all four client shards,
  sealed immutable build bytes, and completed origin transaction job
  `112086685112`. At `2026-10-06T03:04:32Z`, both
  `ca-static.smarter.poker/build-info.json` and
  `smarter.poker/hub/club-arena/build-info.json` independently served exact
  `c2b4fccb491390f2bbdceb2ce100a977898f09b5`, build time
  `2026-10-06T02:57:17Z`, and run `37406336033`. This descendant has no
  intervening Phase 1 client-source changes from the audited tree. Exact-client
  post-deploy run `37407226104` was then admitted; its authenticated browser,
  live-table, cleanup, and seal verdicts remain pending at this checkpoint.
- The `c2b4fccb` client certificate did not fail a player flow: production
  migration `20261006022835_a_chip_request_tells_its_approver` had correctly
  added the notification write to private authority
  `fn_request_chips_core_20261004`, while the release canary still pinned its
  pre-migration source hash. Read-only production evidence proved the exact
  migration ledger row, notification marker, owner, SECURITY DEFINER/search
  path, closed browser-role grants, and live `md5(prosrc)`
  `1dce6c06306523ba83060f1546611648`. The smallest source correction now
  requires that migration and derives/pins the notification-aware post-image;
  20 focused authority/canary tests and the ordinary protected pre-push gate
  passed. PR #6247 exact head `ba7ed9f26156c38630f8e29c75392e7c87ec7513`
  passed every required context and protected-squash merged at
  `2026-10-06T03:32:16Z` as
  `d5070158b518ac60a45f52ce5c84b5bfcf2454d7`. Its exact client publisher is
  run `37409445438`; publication, artifact-bound post-deploy behavior, seal,
  and fixture cleanup remain pending and are not represented as complete.
- Superseded run `37408341809` supplied useful but deliberately non-sealing
  live-table evidence: job `112091108331` bound exact served client
  `72935cda55c64d763ae7be6418aa7f72cf2a6fa3` to engine
  `1be3343ffd77aecec734aa0d34d74aa3450f3dbe`, passed all four runtime cases
  in 9.6 minutes with stable identity, then hard-deleted and independently
  proved absence of its own fixture at `2026-10-06T03:37:52Z`. Its client
  lane was cancelled by a newer publication, so seal job `112095731762`
  correctly skipped. That is cleanup and interoperability evidence, not the
  final same-artifact two-lane verdict.
- Fixture forensics found a second certificate-source defect before it could
  invalidate the final verdict: stale recovery selected reserved identities
  after 40 minutes, while the client and live-table fixture-owning jobs have
  hard ceilings of 65 and 76 minutes. A later lane could therefore delete an
  older still-running lane's account. The recovery boundary is now 90 minutes,
  retaining fourteen minutes beyond the longest owner, and a maintained test
  reads all three fixture-owning workflow ceilings so the mismatch cannot
  silently return. The exact focused account suite passes 48 of 48; Prettier
  and `git diff --check` also pass. Protected merge, publication, and a fresh
  post-fix certificate remain required.
- The race was then reproduced in production, so no pre-fix certificate is
  admissible. Club Create run `37410852864`, job `112098738405`, began its
  fixture at `2026-10-06T03:52:52Z` and one second later reported that it had
  recovered and hard-deleted one stale reserved account. That deleted the
  fixture created at `2026-10-06T03:12:09Z` by still-running client job
  `112087516486`; read-only production inspection confirmed zero remaining
  unretired reserved accounts. Club Create still retired its own club and
  account, so this is exact evidence of cross-run fixture ownership loss, not
  leftover data. Protected main subsequently added independent foreign-fixture
  preservation in `1ae64375a65198bf4b1cc340a8b96ccfeec4dc0b`; the 90-minute
  timeout/headroom guard remains mergeable on top and is still required for
  explicit stale-recovery callers.
- Publisher `37409445438` completed successfully for protected cashier-fix
  commit `d5070158b518ac60a45f52ce5c84b5bfcf2454d7`. At
  `2026-10-06T03:53Z`, both public build-info endpoints independently served
  that exact SHA, build time `2026-10-06T03:44:54Z`, and run
  `37409445438`. It predates the proven fixture-race repairs and therefore is
  publication evidence only, not the final Phase 1 certificate.
- PR #6253 protected-squash merged at `2026-10-06T04:09:35Z` as
  `646d37fb6bc2d232fd61c01b0bb389708092a2a9` after TypeScript, four client,
  four server-engine, four PostgreSQL-17 accounting, source-binding,
  migration-ledger, money-trigger, silent-revert, source-window, and stub
  checks all passed. The merged guard retains stale identities for 90 minutes
  and binds that threshold to at least ten minutes beyond every maintained
  fixture-owning workflow ceiling. Exact containing publisher
  `37412368457` is pending; an older artifact remains inadmissible.
- Engine receiver `37408439736` completed successfully and sealed exact
  repaired engine `a56efbd25208aed63fe24b81a8a8e27fe96dd52c`, image digest
  `sha256:6a666b8ed3a87148b8f3da4147b74e1ed698a0d968ecf69bfe15b71e3ff254fe`,
  on elected leader/instance `1-6cdb9614`. Post-thaw public health remained
  HTTP 200 with status/liveness/running OK; all eight waves and all 315 prior
  tables resumed, with zero stalls, dead stalls, quarantines, held events,
  lease or heartbeat errors, retained custody, or F06 custody stalls.
- Adjacent protected migration `20261006031707` was installed by run
  `37411949153`, job `112102110603`, in one 44-ms transaction. Independent
  SELECT-only production readback found exactly one ledger row, one recorded
  statement, 3,212 recorded SQL bytes, and recorded MD5
  `cf82d11a4ed20704cc77875de863022e`, matching source SHA-256
  `eb60f783ef688d4519a08267be09aeec3d89966143df3341c6ff0867a7c90010`.
  Installed `fn_update_table_bomb_settings(uuid,jsonb)` is owned by `postgres`,
  SECURITY DEFINER with `search_path=public`; browser-anonymous execution is
  closed while authenticated and service roles retain the intended door.
- Current containing protected descendant
  `821094dbec0b4e98874135edf66289f777b1e5f9` includes the certification fix;
  its only later client change is independently checked throwable
  presentation, with no Table Studio, theme, settings, realtime, persistence,
  avatar-library, or Final Table overlap. Its adjacent accounting prerequisite
  `20261003232339` was installed once by run `37412999520`, job
  `112105385962`, at `2026-10-06T04:18:05Z`. Independent production readback
  found one ledger row/statement, 30,056 recorded bytes, MD5
  `87e686d1c8c1194adda3145c55168c0a`, matching source SHA-256
  `ec61f6e295b147b2ccaf7a7504066056ef18a95a3737e91507fccb50f3cd4546`.
  The new unlogged RLS split-parts table and functions are owned by `postgres`,
  closed to anonymous/authenticated direct reads, and retain intended
  service-role access. Any certificate bound to the earlier `0f80666e`
  artifact remains non-final.
- Containing publisher `37412813977` then completed successfully: all four
  client shards passed, immutable artifact `11389768858`
  (`club-arena-dist-821094dbec0b4e98874135edf66289f777b1e5f9`) was sealed,
  and origin transaction job `112106718837` succeeded. Both public build-info
  endpoints independently served exact protected SHA
  `821094dbec0b4e98874135edf66289f777b1e5f9`, build time
  `2026-10-06T04:20:42Z`, and run `37412813977`. Fresh post-deploy run
  `37413504507` was created for this artifact; its exact source binding, both
  behavior lanes, durable seal, and fixture cleanup remain required.
- A later engine-only protected descendant,
  `c2283099ba7ec87829ef8bee7b0ba81e7bbc7fe5`, preserved the exact audited
  client/customization tree and became the current client identity without
  adding a Phase 1 engine dependency. Publisher `37413492258` passed all four
  client shards and origin transaction `112108510588`; at
  `2026-10-06T04:31:35Z` both build-info endpoints independently served exact
  `c2283099ba7ec87829ef8bee7b0ba81e7bbc7fe5`, build time
  `2026-10-06T04:26:58Z`, and run `37413492258`. Fresh exact post-deploy run
  `37414069731` is the current certificate candidate. Superseded pending or
  pre-publication lanes are non-verdicts.
- Protected migration-only descendant
  `11a1aae092e6ea3309200ccd8848be82ba911dc9` does not change the published
  client, engine, or Phase 1 paths. Its sole database prerequisite
  `20261006041001` was installed exactly once by run `37414364745`, job
  `112109597531`, in a 131-ms transaction. Durable readback found one
  statement/ledger row, 3,393 bytes, source SHA-256
  `8bd0d912e20691fa58d9c023405e38908c43002d94dc6ebeecc0f1b17dc53a0f`,
  guarded leave-function post-image MD5 `4789ec1e...`, `postgres` ownership,
  SECURITY DEFINER, `public, extensions` search path, authenticated/service
  execution with anonymous closed, and the protected trigger still enabled.
- The same migration-only descendant was republished as exact current-main
  client identity: publisher `37414216292`, all four client shards and origin
  job `112110565115` succeeded; both build-info endpoints served exact
  `11a1aae092e6ea3309200ccd8848be82ba911dc9`, build time
  `2026-10-06T04:36:22Z`, and run `37414216292`. Artifact-bound post-deploy
  run `37414730395` passed its gate with source run `37414216292`, trigger SHA
  `11a1aae...`, and immutable artifact `11390722231` / digest
  `sha256:2d2dacc8bcf22e976f7cf69caac7103e7275b627853367c49ae9557dd3e986b6`.
  Behavior lanes, stable-engine seal, and exact fixture cleanup remain pending.
- After the latest context resumption, the canonical and portable policy
  readers were executed and fully reread at `2026-10-06T05:02:29.850Z` and
  `2026-10-06T05:04:32.168Z`. Both emitted policy version 2.9, manifest
  `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`,
  and owner, operating-law, hardening, and reference-index SHA-256 values
  `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`,
  `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`,
  `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`,
  and `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`.
  The canonical comparison passed. Repository, publication, deployment,
  storage, migration, visual, and complete checkpoint references were reread
  from the owned external-SSD worktree before another production operation.
  Protected main is now the containing docs-only descendant
  `afa9cb9b4b696bea0bb98faf5f6ca8696d20c6d6`; it has no client, server,
  workflow, migration, configuration, or Phase 1 source delta from
  `016cb2be6b76c0b95e88ace7529a08527f419b01`.
- The newest compatible engine cutover is complete. Receiver run
  `37413585242` published and activated exact engine
  `c2283099ba7ec87829ef8bee7b0ba81e7bbc7fe5`, image digest
  `sha256:f39827e65829c7f49771d2b4d3c8f4a6c00a1ef94a143ac750d585f811574731`,
  on elected leader/instance `1-dae23c42`; publish job `112108690449`,
  append-only receipt job `112115070842`, and certificate dispatch job
  `112115220395` all succeeded. Post-thaw live health independently reported
  status, liveness, and running OK, dealer prerequisites ready, all eight
  resume waves and all 307 prior tables resumed, maintenance/presentation
  idle, and zero unparked, F06-custody, stopped-custody, stalled,
  dead-stalled, quarantined, or retained-custody tables. A cache-busted
  2026-10-06T05:06Z readback still returned the same exact release and
  leader with 426 active tables and no fleet stall.
- The production-certificate account race is closed in source and runtime.
  Protected PR #6253 merged as `646d37fb6bc2d232fd61c01b0bb389708092a2a9`;
  current protected descendants retain a 90-minute stale threshold with at
  least ten minutes of headroom beyond every fixture-owner ceiling and no
  cross-run stale sweep at account creation. The obsolete reserved identity
  `bf97105c-7532-4913-8501-4d0d08239a14` was checked after thaw through its
  exact supported cleanup RPC only, which returned `already_removed=true`.
  Independent readback found zero Auth, profile, public-user, membership,
  seat, club/union-owner, wallet, live-ledger, or ledger-archive residue; four
  audit-archive rows remain as the expected durable audit trail. No broad
  fixture sweep ran.
- All three adjacent current-main migration prerequisites were independently
  proven installed and require no replay. `20261006024500` has one exact
  ledger statement (source without its terminal newline), ledger SHA-256
  `b02dd015b1e242c870c25908e86779047763ec5d509ea9af31cc234e66ffb4c6`,
  and the ten intended content-engine objects, RLS, owners, policies, function
  ACLs, and restricted trivia projection. `20261006040328` has one exact
  executable DDL statement, ledger SHA-256
  `b54922adfa387649705cbd1b8e4c0256e88073d31859dc9bf9dd4e53df0e8e11`,
  the intended presence/horse-heartbeat function post-images, and its valid,
  ready live-seat index; current source adds only a non-mutating postcheck.
  `20261006040333` has one semantically exact statement, ledger SHA-256
  `981b1061036e3835541bd4d6314ca2aca97b3d3b5c3a58cb1e8693649e0fa9f9`,
  and exact function/trigger owners, security, paths, ACLs, topic derivation,
  canonical YouTube thumbnail behavior, and zero migration-probe residue; its
  only source/ledger spelling difference is equivalent combined versus
  separate `REVOKE` clauses.
- Obsolete post-deploy run `37416495732` was cancelled only after exact
  inspection proved both behavior lanes were still pending and had never
  provisioned an account. It became terminal cancelled at
  `2026-10-06T05:06:29Z`; both lanes and the seal were cancelled with zero
  fixture or cleanup obligation. This is a superseded non-verdict, not a
  failed behavior certificate.
- Final pre-install client candidate `3ae2684bd1b8c49a1e2c2182965653a38ffa84f0`
  contains the Phase 1 work, the certificate-account repair, and an unrelated
  whole-tournament-chip correction; it has no Table Studio, customization,
  avatar, appearance-realtime, Final Table, or migration-path regression.
  Publisher `37417558302` checked out that exact protected descendant, passed
  all four client shards, sealed immutable artifact `11391442252` with digest
  `sha256:162939ff2681691ab5cfc3917fb955814a6654970475b1653a0863a59ba50209`,
  and completed origin job `112121256172`. Both required public build-info
  endpoints independently served exact `3ae2684b`, build time
  `2026-10-06T05:17:24Z`, and run `37417558302`.
- Redundant same-SHA publisher `37417630181` was cancelled before any origin
  publication; it emitted no competing post-deploy run and did not change the
  served run identity. Obsolete engine-triggered post-deploy
  `37416203900` was force-cancelled only after its non-final live lane passed
  and cleaned its own fixture. Its remaining client fixture
  `62ebbbdb-e247-45c6-9067-3717927f2e47` was then retired through the exact
  supported cleanup RPC, which archived four audit rows; independent readback
  found zero Auth, profile, public-user, membership, seat, club-owner, wallet,
  live-ledger, or ledger-archive residue. No broad sweep ran.
- Exact artifact-bound pre-install post-deploy run `37418196160` passed its
  origin gate for source run `37417558302` and the immutable `3ae2684b`
  artifact. Its authenticated client and live-table lanes, durable cutover
  seal, and exact fixture cleanup remain pending at this checkpoint.
- After the latest resumption, the canonical and portable policy readers were
  executed and fully reread at `2026-10-06T05:30:13.622Z` and
  `2026-10-06T05:30:22.196Z`. Both emitted policy version 2.9, manifest
  `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`,
  and the unchanged owner, operating-law, hardening, and reference-index
  hashes recorded above; the canonical comparison passed. Root and repository
  policy, publication, storage, migration, visual, deployment-path, and this
  complete checkpoint were reread from the owned external-SSD worktree before
  another write.
- Pre-change diagnosis at `2026-10-06T05:36Z` found a fail-open boundary in
  `.github/workflows/post-deploy-e2e.yml` lines 841-844, 1088-1090, 1130-1173,
  and 1195-1206. Live-table job `112121673041` recorded the MTT case as the
  explicit UNKNOWN non-verdict "no subject" while its other three cases passed;
  the per-file execution check therefore passed and the release-window step
  exposed `certified=true`. That output could admit the Phase 1 cutover seal
  without any MTT execution. Run `37418196160` was force-cancelled before a
  seal job existed. The correction will derive a separate exact MTT-case
  verdict from Playwright's JSON report and require it in the seal condition;
  absent-subject remains a named non-defect for the general live-table job but
  can no longer certify the MTT-only Final Table transition.
- The correction adds `phase1-mtt-certificate-verdict.mjs`, which reads the
  exact Playwright case result and exposes a separate
  `phase1_mtt_certified` job output. The cutover seal now requires that output
  in addition to stable client/engine identities and both successful job
  shells. A skipped MTT remains an explicit non-verdict and exits cleanly for
  the general production audit, but its output is false; malformed, missing,
  failed, timed-out, or interrupted evidence fails closed. The changed source
  was reread after formatting. Five directly connected Vitest files passed 76
  of 76 assertions, the new Node entrypoint passed syntax validation, and
  `git diff --check` passed.
- A focused independent review confirmed the parser matches Playwright 1.58's
  nested suite/spec/test/result shape and this workflow's single project,
  worker, and zero-retry invocation. It found no fail-open path: only a last
  result of `passed` emits the literal `true`; skip/unset emits false, and
  missing, malformed, duplicate, failed, timed-out, or interrupted evidence
  makes the live-table job non-success. GitHub's exact string comparison then
  keeps every non-true output out of the seal.
- The cancelled workflow briefly entered attempt 2, but root cancelled and
  force-cancelled it before fixture provisioning. The attempt-2 seal job shell
  `112126330531` was created already cancelled with no runner and no steps;
  exact production readback at `2026-10-06T05:41:53Z` again found zero seal
  rows for client `3ae2684b` and engine `c2283099`. Exact cleanup/readback for
  fixtures `bf97105c`, `62ebbbdb`, `8f39ff95`, `f6f202ac`, `b9a92189`, and
  `6b90749c` found every live identity, membership, seat, owner, wallet,
  ledger, rake-source, and audit surface empty; only expected immutable audit
  archives remained. The supported 90-minute stale inventory returned zero
  reserved rows at `2026-10-06T05:43:26Z`. No broad fixture sweep or mutation
  ran.

# Unmerged branches on origin: the triage list (2026-09-03)

Tonight 176 branches whose pull request had merged were deleted (a merged PR
keeps its commits and offers "Restore branch", so nothing was lost). What is
left is every branch that is ahead of `main` with **no merged pull request**:
400 of them. A script cannot decide these - each is either somebody's live
work, an abandoned attempt, or a recovery snapshot - so this is the list a
human needs, ordered by age.

Buckets: 232 under 7 days (active agents, leave alone), 151 between 7 and
30 days, 17 older than 30 days. By namespace: `agent/*` 124, `rescue/*` 83
(recovery snapshots made by git-unstick and the snapshot guard; never
proposed by policy), `fix/*` 51, `auto/*` 50, `sentry-autofix/*` 14,
`ci-marker/*` 11 (CI result markers, keep), `feat/*` 9, `phase6/*` 8 (inside
#2559).

Suggested rule once reviewed: a `rescue/*` or `sentry-autofix/*` branch older
than 30 days, and any branch older than 60 days with no PR, is deleted by the
orphan sweep after being named in this file for a week. Not enabled; it is a
proposal.

| branch | age (days) | ahead | last author | last subject |
|---|---|---|---|---|
| `sentry-autofix/javascript-react-ae-mo7yvgah` | 135 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [FinancialAlertService._log.insert] [object Ob |
| `sentry-autofix/javascript-react-ae-mo7uh4z0` | 135 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [FinancialAlertService._log.insert] [object Ob |
| `sentry-autofix/javascript-react-ae-mo7s9g15` | 135 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [FinancialAlertService._log.insert] [object Ob |
| `sentry-autofix/javascript-react-ad-mo7yv87y` | 135 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [CreditService.getAgentInvoices] [object Objec |
| `sentry-autofix/javascript-react-ad-mo7uh6lb` | 135 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [CreditService.getAgentInvoices] [object Objec |
| `sentry-autofix/javascript-react-ac-mo7yv663` | 135 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [AchievementService.incrementProgress.insert]  |
| `sentry-autofix/javascript-react-ac-mo7uh6dc` | 135 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [AchievementService.incrementProgress.insert]  |
| `sentry-autofix/javascript-react-ac-mo7s9m7r` | 135 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [AchievementService.incrementProgress.insert]  |
| `sentry-autofix/javascript-react-ae-mo8p5ufy` | 134 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [FinancialAlertService._log.insert] [object Ob |
| `sentry-autofix/javascript-react-ae-mo87lvkt` | 134 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [FinancialAlertService._log.insert] [object Ob |
| `sentry-autofix/javascript-react-ad-mo8p5nrp` | 134 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [CreditService.getAgentInvoices] [object Objec |
| `sentry-autofix/javascript-react-ad-mo87lq51` | 134 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [CreditService.getAgentInvoices] [object Objec |
| `sentry-autofix/javascript-react-ac-mo8p5jif` | 134 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [AchievementService.incrementProgress.insert]  |
| `sentry-autofix/javascript-react-ac-mo87lp8w` | 134 | 1 | Smarter Poker Autofix | autofix(sentry): Error: [AchievementService.incrementProgress.insert]  |
| `sweep-4-engine-fixes` | 41 | 13 | Smarter-Poker | chore(sweep-4): probe10 (temp) |
| `sweep-4-clean` | 41 | 1 | Smarter-Poker | chore(sweep-4): stage PreciseActionTimer + RakebackSettlerService |
| `horse-ai-v2` | 41 | 5 | Smarter-Poker | fix(engine): HandController - betting-round float live-lock + pineappl |
| `fix/wave1-m6-rakeback-keyset-cursor` | 27 | 11 | Smarter-Poker | chore(m6): settler service |
| `patch/tournament-lobby-live-pane` | 18 | 2 | github-actions[bot] | agent-patch: apply lobby-live-pane.patch |
| `patch/share-hand-cash-surface` | 18 | 2 | Smarter-Poker | chore(agent): queue share-hand.patch |
| `patch/reconnect-grace-timebank` | 16 | 1 | Smarter-Poker | Fix time bank handling on player reconnect |
| `patch/verify-fixes` | 15 | 1 | Smarter-Poker | Restore the real rake in the Game Rules modal, out of the file that ke |
| `chore/schema-manifest-87fc017` | 15 | 1 | github-actions[bot] | chore(ci): refresh Supabase schema manifest |
| `chore/schema-manifest-a4effa5` | 14 | 1 | github-actions[bot] | chore(ci): refresh Supabase schema manifest |
| `chore/schema-manifest-c5e0a42` | 13 | 1 | github-actions[bot] | chore(ci): refresh Supabase schema manifest |
| `backup/wip-2026-08-20-final` | 13 | 6 | Smarter-Poker | backup(wip): final snapshot of Dan's club-arena working tree, 2026-08- |
| `backup/wip-2026-08-20-cowork` | 13 | 5 | Smarter-Poker | backup(wip): snapshot of Dan's club-arena working tree 2026-08-20 |
| `backup/wip-2026-08-20-cowork-2` | 13 | 6 | Smarter-Poker | backup(wip): refreshed snapshot of Dan's club-arena working tree 2026- |
| `rescue/2026-08-21-force-push-dropped-commits` | 12 | 5 | Smarter-Poker | feat: dealer tipping is gone, all of it |
| `fix-spin-500-test` | 12 | 1 | Smarter-Poker | test(spin): the payout suite still asked for the retired 500x tier |
| `ci-marker/ea6d5308-deps` | 12 | 3 | Smarter-Poker | feat(throwables): double size, 3.5s life, and a blue selector that fit |
| `ci-marker/ea6d5308-checkout` | 12 | 3 | Smarter-Poker | feat(throwables): double size, 3.5s life, and a blue selector that fit |
| `ci-marker/e0f707a0-deps` | 12 | 4 | Smarter-Poker | fix(ci): the deploy gate could not load handCompletionLaw - a path tha |
| `ci-marker/e0f707a0-checkout` | 12 | 4 | Smarter-Poker | fix(ci): the deploy gate could not load handCompletionLaw - a path tha |
| `ci-marker/e0f707a0-build` | 12 | 4 | Smarter-Poker | fix(ci): the deploy gate could not load handCompletionLaw - a path tha |
| `ci-marker/d884f5fd-deps` | 12 | 2 | Smarter-Poker | fix(ca): re-land the BBJ silver palette and the styles a stale-tree co |
| `ci-marker/d884f5fd-checkout` | 12 | 2 | Smarter-Poker | fix(ca): re-land the BBJ silver palette and the styles a stale-tree co |
| `ci-marker/9f75f8b7-deps` | 12 | 5 | Smarter-Poker | feat: dealer tipping is gone, all of it |
| `ci-marker/9f75f8b7-checkout` | 12 | 5 | Smarter-Poker | feat: dealer tipping is gone, all of it |
| `ci-marker/9f75f8b7-build` | 12 | 5 | Smarter-Poker | feat: dealer tipping is gone, all of it |
| `chore/schema-manifest-ef46b1a` | 12 | 1 | github-actions[bot] | chore(ci): refresh Supabase schema manifest |
| `build/world-hub-sync-e0f707a0` | 12 | 5 | github-actions[bot] | build: compiled dist for world hub sync (e0f707a0) |
| `build/world-hub-sync-9f75f8b7` | 12 | 6 | github-actions[bot] | build: compiled dist for world hub sync (9f75f8b7) |
| `backup/orphaned-voices-2026-08-21` | 12 | 2 | Smarter-Poker | feat(throwables): per-item behaviours - voices, captions, and 30+ sign |
| `backup/orphaned-cleanup-2026-08-21` | 12 | 5 | Smarter-Poker | chore(throwables): drop the dead mouse_card timing entry |
| `backup/mac-local-2026-08-21` | 12 | 1 | Smarter-Poker | feat(ca): avatar action choreography, and fix the last .single() |
| `build/world-hub-sync-8c11d80a` | 11 | 1 | github-actions[bot] | build: compiled dist for world hub sync (8c11d80a) |
| `agent/cowork-sandbox/docs/pushing-is-enough` | 11 | 1 | Smarter-Poker | docs: pushing is enough, and an agent wrote a .command file anyway |
| `agent/cowork-replaysurface/fix/replay-surface-consolidation` | 11 | 1 | Smarter-Poker | fix(hand-history): the type said 'all-in' and nothing ever said 'all-i |
| `agent/cowork-perf8/fix/purge-user-caches-on-logout` | 11 | 1 | Smarter-Poker | fix(auth): signing out left the whole account cached on the device |
| `agent/cowork-lobbytruth/fix/lobby-truth` | 11 | 2 | Smarter-Poker | fix(lobby): the filters sheet had the same untrapped-dialog hole as th |
| `agent/cowork-identity/fix/an-unattributable-commit-cannot-deploy` | 11 | 3 | Smarter-Poker | fix(estate): watch for the hook mode that makes a guard decorative |
| `agent/cowork-embeds/fix/broken-supabase-embeds` | 11 | 1 | Claude | fix(data): seven embedded selects returned 400 and no rows, on every c |
| `agent/cowork-embedaudit/fix/replay-blocklist-seatlist-audit` | 11 | 1 | Smarter-Poker | fix(replay): the query was fixed and the mapping was not - every field |
| `rescue/uncommitted-wallet-cashier-work-2026-08-23` | 10 | 1 | Smarter-Poker | rescue: uncommitted wallet and cashier work found in the shared clone |
| `rescue/shared-clone-edits-2026-08-23b` | 10 | 1 | Smarter-Poker | rescue: uncommitted edits found in the shared clone (second sweep) |
| `rescue/cowork-clubscope` | 10 | 2 | Smarter-Poker | harden(lobby): the club/union scope rule, written once instead of six  |
| `rescue/cowork-claude-claim` | 10 | 4 | Smarter-Poker | feat(ca): a horse is a person now — name, alias, number, VIP, brain, |
| `rescue/antigravity8` | 10 | 7 | Smarter-Poker | fix(cashier): trigger CI |
| `rescue/antigravity-ui-pending` | 10 | 2 | Smarter-Poker | fix(help): ensure answers are also title case per user request |
| `rescue/ag-playbook-upgrade` | 10 | 1 | Smarter-Poker | docs: military grade playbook upgrade to strictly enforce root cause e |
| `land/spin-seat-first` | 10 | 3 | Smarter-Poker | fix(guard): repin throwables to the SHA that landed on main |
| `land/spin-seat-first-173833` | 10 | 2 | Smarter-Poker | fix(ci): title-case gate must not case a multiplier prefix, and stub t |
| `fix/center-stakes-col` | 10 | 2 | Smarter-Poker | fix(lobby): rename Stakes / Buy-In to Stakes and center numeric column |
| `backup/cashier-trade-unpushed-20260823` | 10 | 1 | Smarter-Poker | fix(cashier): overhaul trade page UI, colors, layout and role filterin |
| `auto/2026-08-23T22-28-25-24981b58` | 10 | 3 | Smarter-Poker | fix(table): the pot-to-winner fan claimed up to 3x the pot it was ship |
| `auto/2026-08-23T22-20-01-b134b707` | 10 | 3 | Smarter-Poker | fix(table): the pot-to-winner fan claimed up to 3x the pot it was ship |
| `auto/2026-08-23T22-16-44-b3ef21db` | 10 | 4 | Smarter-Poker | fix(table): the pot-to-winner fan claimed up to 3x the pot it was ship |
| `auto/2026-08-23T22-10-48-32922326` | 10 | 3 | Smarter-Poker | fix(guard): repin throwables to the SHA that landed on main |
| `auto/2026-08-23T21-52-58-8f0b54d2` | 10 | 14 | Smarter-Poker | fix(ci): title-case gate must not case a multiplier prefix, and stub t |
| `agent/cowork-variants/fix/pineapple-street-and-real-variants` | 10 | 1 | Smarter-Poker | fix(share): the variant map was wrong twice, and the discard street wa |
| `agent/cowork-standby/feat/leader-standby-failover` | 10 | 3 | Smarter-Poker | chore(ci): refresh the schema manifest for engine_leader |
| `agent/cowork-spinmenu/feat/spin-owner-menu` | 10 | 2 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/cowork-spinmenu/ |
| `agent/cowork-spinboards/feat/per-owner-spin-boards` | 10 | 5 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/cowork-spinboard |
| `agent/cowork-seat/fix/seat-first-count-sync` | 10 | 2 | Smarter-Poker | chore(guards): pin the seat-first count fix, half of which was lost on |
| `agent/cowork-s11/fix/union-club-cascade` | 10 | 1 | Smarter-Poker | fix(union): the cascade to clubs must never collapse on a blip |
| `agent/cowork-players/fee-rollup-timeout` | 10 | 1 | Smarter-Poker | fix(engine): the fee rollup loop could never complete a single batch |
| `agent/cowork-perf14/perf/club-home-single-round-trip` | 10 | 1 | Smarter-Poker | perf(lobby): the whole club lobby in one round trip instead of six |
| `agent/cowork-perf13/perf/parallelize-page-waterfalls` | 10 | 1 | Smarter-Poker | perf(pages): four round trips that were waiting on queries they never  |
| `agent/cowork-perf12/perf/club-home-overlap-round-trips` | 10 | 1 | Smarter-Poker | perf(lobby): two of the club lobby's six round trips were waiting for  |
| `agent/cowork-perf11/docs/perf-phase5-6-record` | 10 | 1 | Smarter-Poker | docs(perf): record phases 5-6 - what measuring the bundle and auditing |
| `agent/cowork-openpr/perf/open-a-pr-once-per-branch-not-once-per-push` | 10 | 2 | Smarter-Poker | fix(workspace): warn that the shared node_modules link writes through |
| `agent/cowork-oneclone/fix/one-clone-per-repo-for-every-agent` | 10 | 1 | Smarter-Poker | fix(clones): one clone per repo, for every agent and the dev server |
| `agent/cowork-npmforce/fix/npm-force-disabled-protections-everywhere` | 10 | 3 | Smarter-Poker | fix(workspace): give each worktree its own node_modules, not a symlink |
| `agent/cowork-nmclone/fix/worktrees-need-their-own-node-modules` | 10 | 1 | Smarter-Poker | fix(workspace): give each worktree its own node_modules, not a symlink |
| `agent/cowork-mtt2/fix/ramp-gate-parity-and-step-cap` | 10 | 1 | Smarter-Poker | fix(tournaments): close two holes in the MTT pre-start ramp |
| `agent/cowork-mtt/fix/mtt-prestart-horse-ramp` | 10 | 2 | Smarter-Poker | fix(guards): repin the orphaned-work entry to the SHA that actually ca |
| `agent/cowork-liveness/fix/a-slow-database-is-not-a-dead-process` | 10 | 1 | Smarter-Poker | fix(engine): a slow database is not a dead process |
| `agent/cowork-fleetalarm/feat/the-fleet-tells-you-itself` | 10 | 1 | Smarter-Poker | feat(engine): the fleet tells you itself |
| `agent/cowork-dealproof/feat/liveness-the-engine-cannot-fake` | 10 | 1 | Smarter-Poker | feat(engine): liveness the engine cannot fake |
| `agent/cowork-claude-r2/fix/decision-core-round2-clean` | 10 | 1 | Smarter-Poker | fix(ca): PLO was deciding inside its own noise, and three dead code pa |
| `agent/cowork-claude-horse/docs/horse-audit-changelog` | 10 | 4 | Smarter-Poker | chore: remove local benchmark scratch files |
| `agent/cowork-cigate/perf/run-only-the-checks-the-diff-can-break` | 10 | 1 | Smarter-Poker | perf(ci): run only the checks the diff can actually break |
| `agent/cowork-bootlive/fix/booting-is-not-dead` | 10 | 2 | Smarter-Poker | fix(engine): a standby must decide before it touches anything |
| `agent/cowork-boardtick/fix/one-board-tick-at-a-time` | 10 | 1 | Smarter-Poker | fix(lobby): one board tick at a time, or the board builds itself twice |
| `agent/cowork-binding/docs/make-the-agent-rules-binding` | 10 | 1 | Smarter-Poker | docs(rules): make the agent rules binding, not advisory |
| `agent/antigravity7/fix/add-profile-tab` | 10 | 1 | Smarter-Poker | fix(ui): add Profile tab to club footer containing settings and role m |
| `agent/antigravity5/fix/toast-freeze` | 10 | 1 | Smarter-Poker | fix(ui): optimistic update for club welcome message |
| `agent/antigravity3/fix/union-cascading` | 10 | 1 | Smarter-Poker | fix(club): add toast on description save and fix union_id missing on u |
| `agent/antigravity2/fix/table-metadata-fetch-clean3` | 10 | 2 | Smarter-Poker | fix(table): remove duplicate menu, fix table metadata fetch, and fix b |
| `agent/antigravity2/fix/mobile-css-cache` | 10 | 1 | Smarter-Poker | fix(mobile): resolve CSS specificity overrides and PWA cache preventin |
| `agent/antigravity/fix/table-metadata-fetch-clean` | 10 | 2 | Smarter-Poker | fix(ci): fix phantom column and avatar_url alias in HorseOnboarding |
| `agent/antigravity-ui/fix/club-home-ui-refresh` | 10 | 1 | Smarter-Poker | fix(lobby): ui refinements for all games tab, observe links, and refre |
| `agent/ag-fix-nested-slugs/fix/nested-slugs` | 10 | 2 | Smarter-Poker | fix: enforce nested slugs globally via SlugEnforcer and ignore cached  |
| `land/spin-seat-first-clean` | 9 | 9 | Guard Test | base |
| `fix/club-arena-home-ui` | 9 | 5 | Guard Test | base |
| `fix-cashier-regression` | 9 | 4 | smarter-poker-autopilot[bot] | Merge branch 'main' into fix-cashier-regression |
| `docs/playbook-schedule-wait` | 9 | 12 | Guard Test | fix(test): strip GIT_ env vars in orphanedWorkGuard test to allow runn |
| `agent/cowork-sec/docs/session-audit` | 9 | 1 | Smarter-Poker | docs(changelog): anon wallet exposure, the PUBLIC-grant trap, and what |
| `agent/cowork-perf/fix/ca-boot-latency` | 9 | 2 | Smarter-Poker | perf(boot): take the post-paint services out of the entry chunk, prelo |
| `agent/cowork-felt2/fix/spectate-felt-visuals` | 9 | 1 | Smarter-Poker | fix(table): the felt as a spectator sees it - card backs, card side, o |
| `agent/cowork-db-saturation/feat/rabbit-hunt` | 9 | 3 | smarter-poker-autopilot[bot] | Merge branch 'main' into agent/cowork-db-saturation/feat/rabbit-hunt |
| `agent/cowork-claude/fix/liveness-progress-veto` | 9 | 3 | smarter-poker-autopilot[bot] | Merge branch 'main' into agent/cowork-claude/fix/liveness-progress-vet |
| `agent/cowork-claude-wallets/perf/dedupe-gate-r2` | 9 | 2 | Smarter-Poker | docs: record the realtime firehose fixes and the force-on-event regres |
| `agent/cowork-claude-wallets/feat/always-on-wallet` | 9 | 2 | Smarter-Poker | feat(always-on): club lobby paints from cache, wallet listener is glob |
| `agent/cowork-claude-bankops/feat/claim-back-promo-send` | 9 | 2 | Smarter-Poker | chore(ci): manifest gains the three wallet RPCs applied to production |
| `agent/antigravity8/fix/profile-tab-updates` | 9 | 8 | Guard Test | base |
| `agent/antigravity/fix/club-bank-3d-upgrade` | 9 | 2 | Guard Test | base |
| `agent/antigravity-format/format-game-titles` | 9 | 1 | Smarter-Poker | fix: format game titles to strip trailing zeroes |
| `rescue/claude-tabfocus` | 8 | 1 | Smarter-Poker | fix(a11y): the footer tablists moved the selection and left focus behi |
| `rescue/claude-statsroll` | 8 | 1 | Smarter-Poker | fix(stats): the rollup grew back, because only the backfill ever prune |
| `rescue/claude-refunds` | 8 | 2 | Smarter-Poker | fix(bbj): the conservation check reports the truth again |
| `rescue/claude-provguard` | 8 | 1 | Smarter-Poker | fix(agents): repair dependencies on a dirty tree, and verify the paylo |
| `rescue/claude-phantomseat` | 8 | 2 | Smarter-Poker | fix(spins): a vacated seat could never be sat in again, and that is wh |
| `rescue/claude-countfamily` | 8 | 1 | Smarter-Poker | fix(clubs): one client page was writing its own RLS view into a shared |
| `rescue/claude-cachever` | 8 | 1 | Smarter-Poker | fix(clubs): the member-count fix could be overruled by a week-old loca |
| `rescue/claude-auditclose` | 8 | 1 | Smarter-Poker | fix(stats): a ref was being mutated during render, and two "defects" w |
| `rescue/antigravity-diamond-store` | 8 | 2 | Smarter-Poker | fix(diamond-store): replace em dash with hyphen (ci guard) |
| `rescue/agent` | 8 | 1 | Smarter-Poker | fix(ui): center elements in game lobby panel action square |
| `fix/club-join-links` | 8 | 3 | Smarter-Poker | fix(club-arena): generated share links include referrer player_number; |
| `agent/swarm-tourney-ui/fix/tournament-ui-wiring` | 8 | 1 | Smarter-Poker | fix(tournament-ui): a failed query must never render as an empty tourn |
| `agent/swarm-registration/fix/registration-honesty` | 8 | 1 | Smarter-Poker | fix(registration): stop reporting unverified outcomes as success |
| `agent/swarm-mobile-fit/fix/mobile-fit-and-taps` | 8 | 1 | Smarter-Poker | fix(mobile): three real tap/zoom defects, and two stale lobby assertio |
| `agent/swarm-cosmetics-themes/fix/themes-and-skins` | 8 | 1 | Smarter-Poker | fix(themes): every theme and skin offered is real, persists, applies l |
| `agent/swarm-cosmetics-shop/fix/cosmetic-ownership` | 8 | 1 | Smarter-Poker | fix(cosmetics): make every cosmetic price and ownership claim true |
| `agent/swarm-cosmetics-cards/fix/card-backs-and-felts` | 8 | 3 | Smarter-Poker | fix(cosmetics): five theme presets, five different tables, and 37 dead |
| `agent/swarm-cosmetics-avatars/fix/avatars-and-throwables` | 8 | 1 | Smarter-Poker | fix(avatars): honour avatar_unlocks, stop drawing failed loads as empt |
| `agent/cowork-mtt-neverdealt/fix/mtt-started-never-dealt` | 8 | 1 | Smarter-Poker | fix(tournaments): rescue any tournament that started and never dealt,  |
| `agent/cowork-lobbycards/feat/lobby-flags` | 8 | 3 | Smarter-Poker | feat(tables): NIT GAME becomes a real rule, enforced at the door and b |
| `agent/claude-footer/perf/footer-phase5` | 8 | 1 | Smarter-Poker | perf(footer): stats page paid recharts on every load and asked the sam |
| `agent/claude-deckfix/fix/plo6-deck-exhaustion` | 8 | 1 | Smarter-Poker | fix(tournaments): a PLO6 table cannot deal 54 hole cards from a 52-car |
| `agent/claude-agent2agent/fix/agent-to-agent-credits-agent-wallet` | 8 | 2 | Smarter-Poker | test(cashier): pin the plain-player role by the name the database uses |
| `agent/TableSettingsFix/feat/search-self-in-wallets` | 8 | 1 | Smarter-Poker | feat(cashier): make all roles and self searchable in wallets, allow se |
| `rescue/cowork-cashier` | 7 | 2 | Smarter-Poker | ci(cashier): regenerate schema manifest — fn_ensure_agent_row is liv |
| `rescue/antigravity2` | 7 | 1 | Smarter-Poker | fix(table): strip baked button borders to reveal raw 3D assets and del |
| `fix/sentry-dsn` | 7 | 2 | Smarter-Poker | fix(sentry): remove triggerSentryTestCrash hook |
| `fix/seat-away-and-waitlist-badges` | 7 | 1 | Smarter-Poker | chore(db): backfill rls auth_rls_initplan fixes |
| `fix/mid-hand-reconnect-safety` | 7 | 1 | Smarter-Poker | fix(reconnect): mid-hand reconnect safety - cancel normal turn clocks  |
| `fix/horse-bypass-and-slug-guard` | 7 | 4 | Smarter-Poker | fix: resolve club slugs before query to prevent postgres type errors i |
| `feature/redesign-club-flow` | 7 | 3 | Smarter-Poker | trigger ci |
| `feat/seat-image-buttons` | 7 | 3 | Smarter-Poker | fix(table): use BASE_URL for coin image paths — absolute /images/... |
| `feat/playwright-e2e-net` | 7 | 1 | Smarter-Poker | test(e2e): add buy-in idempotency net |
| `auto/2026-08-26T06-31-24-3f81e38e` | 7 | 5 | Smarter-Poker | refactor(invite): exhaustive-deps for qr code effect |
| `auto/2026-08-26T06-30-54-5079bed1` | 7 | 4 | Club Arena Agent | refactor(invite): lint exhaustive-deps and remove unused imports |
| `agent/swarm-dbperf/fix/hand-history-size-and-profit` | 7 | 1 | Smarter-Poker | fix(db): reclaim hand_history empty pages and stop the profit reconcil |
| `agent/fix-lobby-remaining-work` | 7 | 15 | Smarter-Poker | fix: resolve conflict with main |
| `agent/cowork-wip-dedupe-ca/fix/snapshots-that-do-not-multiply` | 7 | 2 | Smarter-Poker | docs(snapshots): state the retention behaviour in the usage header |
| `agent/cowork-seatexit/fix/detector-and-dead-refund-pool` | 7 | 4 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/cowork-seatexit/ |
| `agent/cowork-lobbytitle/fix/lobby-audit-max` | 7 | 3 | Smarter-Poker | fix(lobby): three ways the board went quietly stale |
| `agent/cowork-lobby/stop-mtt-card-flicker` | 7 | 11 | Smarter-Poker | docs(handoff): full operational handoff for the tournament lobby |
| `agent/cowork-dan/fix/tablepage-audit` | 7 | 2 | Smarter-Poker | chore(table): remove 12 CSS rules whose markup left years ago |
| `agent/cowork-brain/feat/horse-hand-reviews` | 7 | 3 | Smarter-Poker | fix(horses): prune rejection handler on a real Promise - supabase buil |
| `agent/cowork-brain/feat/horse-hand-reviews-v2` | 7 | 5 | smarter-poker-autopilot[bot] | Merge branch 'main' into agent/cowork-brain/feat/horse-hand-reviews-v2 |
| `agent/cowork-addon-leak/fix/markseatasleft-destroys-stack-on-throw` | 7 | 2 | Smarter-Poker | ci: retrigger — the previous run hit the estate-wide Actions startup |
| `agent/claude-cashfin/fix/cashier-finish` | 7 | 4 | Smarter-Poker | chore(migrations): renumber the cashout closing legs migration |
| `agent/claude-agent/docs/table-handoff` | 7 | 1 | Smarter-Poker | docs(handoff): what four rounds of table work did not finish |
| `agent/claude-agent/docs/showdown-review-changelog` | 7 | 3 | Smarter-Poker | docs: MIGRATION-CHANGELOG entry for showdown review fixes (PR #923) |
| `agent/antigravity/feat/systemic-upgrades` | 7 | 5 | smarter-poker-autopilot[bot] | Merge branch 'main' into agent/antigravity/feat/systemic-upgrades |
| `rescue/cowork-brain` | 6 | 5 | Smarter-Poker | test(spin): the two pinned signatures gained an optional argument, not |
| `rescue/cowork-arena-look` | 6 | 2 | Smarter-Poker | fix(gameplay): the emoji gate now decodes escapes, and the two it miss |
| `rescue/codex-visual-system` | 6 | 2 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-visual-sys |
| `rescue/club-arena-phase-2` | 6 | 1 | Smarter-Poker | refactor(arena): phase 2 technical debt — remove critical 'as any' c |
| `rescue/claude-audit` | 6 | 1 | Smarter-Poker | fix(audit): the leak-spike detector divided by seven and counted raw h |
| `rescue/antigravity-wallet-fixes` | 6 | 2 | Smarter-Poker | fix(test): add contains to union wallet modal test mock |
| `rescue/antigravity-deep-fixes` | 6 | 1 | Smarter-Poker | fix(arena): resolve deep audit regressions (polling, routing, zeroes) |
| `rescue/antigravity-buyin-band` | 6 | 1 | Smarter-Poker | fix(buyin): cap rathole restriction at max buy-in and optimize quick a |
| `rescue/antigravity-ads` | 6 | 1 | Smarter-Poker | feat(ads): add dismiss button and support template variables in target |
| `fix/union-wallet-enhancements` | 6 | 3 | Smarter-Poker | trigger ci |
| `feat/profile-telemetry` | 6 | 5 | Smarter-Poker | feat(auth): integrate profile gate telemetry into MasterBus |
| `auto/2026-08-27T23-12-24-a7f54490` | 6 | 2 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/cowork-mobile/fe |
| `auto/2026-08-27T23-10-03-f275f7a7` | 6 | 3 | Club Arena Agent | feat(ca): mobile round 3 - showdown cards, vertical slider, flush foot |
| `auto/2026-08-27T21-27-55-b8cfdfe0` | 6 | 2 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/cowork-mobile/fe |
| `auto/2026-08-27T21-20-29-bb357067` | 6 | 1 | Smarter-Poker | feat(ca): mobile round 2 - RIT reveal, 95% board, collapsed action bar |
| `agent/fix/club-service-syntax-duplicate` | 6 | 2 | smarter-poker-autopilot[bot] | Merge branch 'main' into agent/fix/club-service-syntax-duplicate |
| `agent/cowork-mobile3/feat/mobile-round-3` | 6 | 3 | Smarter-Poker | fix(table): raise the hero's bet - the one seat off the oval, by Dan's |
| `agent/cowork-create-audit/fix/create-flow-phase3` | 6 | 2 | smarter-poker-autopilot[bot] | Merge branch 'main' into agent/cowork-create-audit/fix/create-flow-pha |
| `agent/cowork-brain/fix/audit-silence-league-starvation` | 6 | 2 | Smarter-Poker | feat(horses): pooled league significance + a watchdog on the analysis  |
| `agent/antigravity/fix/union-wallet-enhancements` | 6 | 2 | Smarter-Poker | fix(wallet): restore kind selector and reserve text for tests |
| `fix/claude-engine-fixes` | 5 | 2 | Smarter-Poker | On main: wip snapshot 20260828T182642Z (main) |
| `feature/sit-out-and-evictions` | 5 | 3 | Smarter-Poker | style(ca): add glowing red CSS for sitting out badge |
| `auto/2026-08-28T08-33-38-7b042e27` | 5 | 2 | Club Arena Agent | fix(ca): tournament money path - guarantees, consolidation, rake, spin |
| `auto/2026-08-28T08-24-08-25ab387e` | 5 | 2 | Club Arena Agent | fix(ca): tournament money path - guarantees, consolidation, rake, spin |
| `auto/2026-08-28T08-09-04-8750cee8` | 5 | 2 | Club Arena Agent | fix(ca): tournament money path - guarantees, consolidation, rake, spin |
| `auto/2026-08-28T07-57-59-edfc2956` | 5 | 1 | Smarter-Poker | fix(ca): tournament money path - guarantees, consolidation, rake, spin |
| `auto/2026-08-28T07-40-25-b16a6130` | 5 | 1 | Smarter-Poker | fix(ca): tournament money path - guarantees, consolidation, rake, spin |
| `agent/cowork-tmoney/fix/tournament-money-path` | 5 | 2 | Club Arena Agent | fix(ca): tournament money path - guarantees, consolidation, rake, spin |
| `agent/cowork-bombpot/fix/rake-test-slice-window` | 5 | 2 | Smarter-Poker | test(rake): the slice-window fix itself (previous commit landed empty) |
| `rescue/codex-theme-studio` | 4 | 6 | Smarter-Poker | fix: follow marketplace copy laws |
| `rescue/codex-lobby-footer` | 4 | 1 | Smarter-Poker | fix(ca): remove lobby footer and compact chrome |
| `rescue/codex-lobby-controls` | 4 | 2 | Smarter-Poker | docs: require visual approval before release |
| `rescue/codex-lobby-assets` | 4 | 1 | Smarter-Poker | fix(lobby): resolve premium artwork under deployed base |
| `rescue/codex-footer` | 4 | 1 | Smarter-Poker | feat(ca): publish approved global club footer |
| `agent/cowork-spin2/fix/round11-spins` | 4 | 5 | Smarter-Poker | fix(merge): HamburgerMenu resolves to main's navigation-registry refac |
| `agent/cowork-finish/fix/pinned-bar-offset` | 4 | 2 | Smarter-Poker | test(layout): match the declaration, not Prettier's line breaks |
| `agent/cowork-fable/fix/overlays-fund-from-union-bank` | 4 | 2 | Smarter-Poker | fix(money): close fn_apply_prize_guarantee to browser roles - only the |
| `agent/cowork-bombpot2/fix/bomb-round8` | 4 | 3 | Smarter-Poker | fix(ui): title case two bomb-report copy strings |
| `work/scroll-fix` | 3 | 6 | Smarter-Poker | Merge remote-tracking branch 'origin/agent/cowork-tourney/fix/pre-seat |
| `rescue/cowork-claude-banner` | 3 | 2 | Smarter-Poker | fix(ticker): reduced motion ellipsises the announcement instead of cut |
| `rescue/codex-members` | 3 | 1 | Smarter-Poker | feat(players): rebuild club roster command |
| `rescue/codex-members-p2` | 3 | 3 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-members-p2 |
| `rescue/codex-leaderboard-phase1` | 3 | 1 | Smarter-Poker | fix(leaderboard): canonicalize UTC periods |
| `rescue/codex-footer-hardening-complete` | 3 | 7 | Smarter-Poker | ci(footer): configure isolated route build |
| `rescue/codex-fixed-footers-global` | 3 | 1 | Smarter-Poker | fix(ca): lock footer to viewport |
| `rescue/codex-data9` | 3 | 1 | Smarter-Poker | feat(club-data): harden operator ledger |
| `rescue/codex-data8` | 3 | 1 | Smarter-Poker | feat(club-data): rebuild live operator ledger |
| `rescue/codex-data7` | 3 | 2 | Smarter-Poker | feat(club-data): rebuild live operator ledger |
| `rescue/codex-daily-missions` | 3 | 5 | Smarter-Poker | fix(challenges): honor the no-hover interaction law |
| `rescue/codex-daily-missions-phase2` | 3 | 3 | Smarter-Poker | fix(challenges): align mission recovery copy |
| `rescue/codex-customization-phase-5` | 3 | 5 | Smarter-Poker | fix(ci): support current Supabase server keys |
| `rescue/codex-customization-phase-4` | 3 | 1 | Smarter-Poker | feat(customization): restore purchases after checkout |
| `rescue/codex-club-arena-completion` | 3 | 1 | Smarter-Poker | feat(support): rebuild help and legal trust workspace |
| `rescue/codex-cashier` | 3 | 2 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-cashier/fe |
| `rescue/claude-unionlaw` | 3 | 1 | Smarter-Poker | docs(union): repo record - union law restored into the weighted rake r |
| `rescue/claude-uiscroll` | 3 | 1 | Smarter-Poker | fix(tournament-ui): the entries card speaks only of rebuys, and the pr |
| `rescue/claude-satfix` | 3 | 1 | Smarter-Poker | feat(satellite): the guarantee is a floor, and conservation has a watc |
| `rescue/claude-rebuyfix` | 3 | 1 | Smarter-Poker | fix(tournament): a rebuy never races the bust sweep, and never pauses  |
| `rescue/claude-entries` | 3 | 2 | Smarter-Poker | fix(satellite): an undecided satellite stuck in COMPLETING goes back t |
| `rescue/claude-bustflow` | 3 | 1 | Smarter-Poker | fix(tournament): an all-in shows every hand with no button, and a bust |
| `rescue/claude-bootfix` | 3 | 1 | Smarter-Poker | fix(engine): the boot claim retries through the staleness window, and  |
| `rescue/antigravity-fix-login` | 3 | 1 | Smarter-Poker | fix(db): revert is_club_admin(uuid) to VOLATILE to fix PostgREST query |
| `rescue/agent-1629` | 3 | 2 | Smarter-Poker | fix(wiring): real diamond reroll RPC, push preference filter rewired t |
| `rescue/agent-1586` | 3 | 1 | Smarter-Poker | fix(engine): make the four-table claim atomic, and give tournaments a  |
| `auto/2026-08-30T21-14-22-5dda8970` | 3 | 2 | Smarter-Poker | test(satellite): structurally bound source pin |
| `auto/2026-08-30T21-06-38-84e53a79` | 3 | 2 | Smarter-Poker | fix(ui): rebuild tournament lobby as reference machine |
| `auto/2026-08-30T21-02-07-f9e951d6` | 3 | 2 | Smarter-Poker | test(satellite): structurally bound source pin |
| `auto/2026-08-30T20-59-12-c387df26` | 3 | 1 | Smarter-Poker | fix(leaderboard): canonicalize UTC periods |
| `auto/2026-08-30T20-58-28-ea53a99d` | 3 | 3 | Smarter-Poker | docs(roster): record phase one verification |
| `auto/2026-08-30T20-52-54-0fedeb1c` | 3 | 7 | Smarter-Poker | fix(ui): the last three page grounds go black, and the dead route-art  |
| `auto/2026-08-30T20-25-50-37d60863` | 3 | 6 | Smarter-Poker | fix(ui): the ticker takes the band under the global header, the action |
| `auto/2026-08-30T20-08-51-162f3e78` | 3 | 5 | Smarter-Poker | docs(ca): incident record - Sunday 200 Deep Stack stall, ipv6 dns + su |
| `auto/2026-08-30T19-54-45-e95af567` | 3 | 4 | Smarter-Poker | fix(table): move the reconnect banner off the BBJ's lane onto the felt |
| `auto/2026-08-30T19-32-58-0f8a6371` | 3 | 2 | Smarter-Poker | secure and scale Player Command phase three |
| `auto/2026-08-30T19-19-54-78aa7d9c` | 3 | 3 | Smarter-Poker | fix(engine): reopen 71 live tournament tables the legacy engine closed |
| `auto/2026-08-30T19-17-58-0e951b77` | 3 | 3 | smarter-poker-autopilot[bot] | Merge branch 'main' into auto/2026-08-30T19-17-58-0e951b77 |
| `auto/2026-08-30T18-24-42-48663099` | 3 | 2 | Smarter-Poker | perf(leaderboard): harden live ranking operations |
| `auto/2026-08-30T17-19-20-1f512d67` | 3 | 5 | Smarter-Poker | fix(copy): satisfy club arena text policy |
| `agent/cowork-tourney/fix/recovery-and-resilience` | 3 | 2 | Smarter-Poker | fix(satellite): a winner who already held a seat was paid nothing for  |
| `agent/cowork-seatfix/fix/seat-open-push-and-bb-between-blinds` | 3 | 1 | Smarter-Poker | fix(cash): a seat offer nobody asked for, and a post-BB answer that wa |
| `agent/cowork-herohub/four-upgrades` | 3 | 2 | Smarter-Poker | chore(ci): register the new telemetry table+views in the schema manife |
| `agent/codex-stats6/feat/stats-accuracy-performance` | 3 | 4 | Smarter-Poker | fix(stats): normalize visible date range copy |
| `agent/codex-club-arena-continuation-phase-6` | 3 | 11 | Smarter-Poker | fix(friends): preserve mobile footer anchoring |
| `agent/codex-cashier/feat/cashier-casino-realism` | 3 | 1 | Smarter-Poker | feat(cashier): rebuild the club vault in casino realism |
| `agent/codex-cashier-phase1/fix-release-window` | 3 | 1 | Smarter-Poker | test(release): bound satellite source pin structurally |
| `verify/phase-6` | 2 | 3 | Smarter-Poker | chore: retrigger CI |
| `rescue/cowork-claude-viewguard` | 2 | 2 | Smarter-Poker | fix(security): an event trigger function is not an API either |
| `rescue/cowork-claude-rescue1971` | 2 | 2 | Smarter-Poker | docs(changelog): record the #1971 rescue and the commit deliberately s |
| `rescue/cowork-claude-alarm` | 2 | 4 | Smarter-Poker | fix(migrations): name both files for the version they were actually ap |
| `rescue/codex-stats5` | 2 | 6 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-stats8/fix |
| `rescue/codex-stats-release` | 2 | 3 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-stats-rele |
| `rescue/codex-members-resilience1` | 2 | 6 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-members-re |
| `rescue/codex-leaderboard-phase1-audit` | 2 | 4 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-leaderboar |
| `rescue/codex-leaderboard-p2` | 2 | 1 | Smarter-Poker | feat(leaderboard): version prize programs by period |
| `rescue/codex-leaderboard-p2-gate` | 2 | 7 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-leaderboar |
| `rescue/codex-leaderboard-p2-fix` | 2 | 1 | Smarter-Poker | fix(leaderboard): lift prize wizard above shell nav |
| `rescue/codex-data-program-p1c` | 2 | 2 | Smarter-Poker | chore(schema): refresh live Supabase manifests |
| `rescue/codex-customization` | 2 | 9 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-customizat |
| `rescue/codex-club-arena-phase-5` | 2 | 1 | Smarter-Poker | fix(deploy): preserve prior runtime generation on retries |
| `rescue/codex-club-arena-phase-4` | 2 | 1 | Smarter-Poker | fix(lobby): keep club carousel visible |
| `rescue/codex-cashier-phase3` | 2 | 4 | Smarter-Poker | test(cashier): certify reconciliation console in production |
| `rescue/codex-cashier-audit` | 2 | 3 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-cashier-au |
| `rescue/codex-case` | 2 | 2 | Smarter-Poker | Refresh live Supabase schema manifests |
| `rescue/claude-compliance` | 2 | 1 | Smarter-Poker | fix(agents): a staff demotion neither strands chips nor raises |
| `ops/engine-restart-windows-five` | 2 | 1 | Smarter-Poker | ops(engine): five restart windows — 4am, 10am, 2pm, 6pm and 10pm Chi |
| `fix/the-copy-rules-reach-the-engine-and-the-database` | 2 | 2 | Smarter-Poker | test: repoint three stale source pins at the seams settlement actually |
| `fix/pineapple-discard-round-2` | 2 | 2 | Smarter-Poker | Merge branch 'main' of https://github.com/Smarter-Poker/Smarter-Poker- |
| `fix/hamburger-menu` | 2 | 3 | Smarter-Poker | trigger ci |
| `fix/create-table-help-switches` | 2 | 4 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into fix/create-table-help- |
| `feat/stake-descent` | 2 | 2 | Smarter-Poker | feat(horses): the ladder gets a way down, and merit becomes a ceiling |
| `docs/handoff-pineapple-p3-full` | 2 | 1 | Smarter-Poker | docs(handoff): Crazy Pineapple phases 3 and 4 - complete state, eviden |
| `docs/handoff-bankroll-incident` | 2 | 1 | Smarter-Poker | docs(handoff): horse bankroll layer and the 2026-08-31 cash-floor outa |
| `cowork-claude-vipbasis` | 2 | 1 | Smarter-Poker | fix(vip,reporting): award VIP points on the rake, state the tournament |
| `cowork-claude-tourneytable` | 2 | 1 | Smarter-Poker | fix(table): a tournament table plays no cash rules |
| `cowork-claude-spintruth` | 2 | 1 | Smarter-Poker | fix(spin): the tier outranks a stale payout_structure, and the draw sy |
| `cowork-claude-payplaces` | 2 | 1 | Smarter-Poker | fix(tournaments): the paid-places floor was applied after the cap, so  |
| `cowork-claude-moneyguards` | 2 | 1 | Smarter-Poker | fix(money): guard the buy_in_fee siblings forward and alarm on the res |
| `cowork-claude-docslie` | 2 | 1 | Smarter-Poker | docs: the five claims agents were following off a cliff |
| `cowork-claude-configtruth` | 2 | 1 | Smarter-Poker | feat(ci): the database mirrors get a parity gate, and data-only migrat |
| `codex/verify-latest-header-sync` | 2 | 2 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into verify-pr-2358 |
| `codex/global-header-remove-white-selector` | 2 | 2 | Smarter-Poker | fix(header): remove selectors and offset mobile badge |
| `claude/phase4-security-sweep` | 2 | 1 | Smarter-Poker | security(rpc): close 61 anon-executable SECURITY DEFINER doors, includ |
| `auto/2026-09-01T00-16-18-dc605b9b` | 2 | 1 | Smarter-Poker | fix(club): isolate new-club membership and financial data |
| `auto/2026-08-31T21-43-45-8ebabc41` | 2 | 8 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into feature/new-club-openi |
| `auto/2026-08-31T19-44-31-1ffcf848` | 2 | 2 | Smarter-Poker | fix(profile): recover transient gate reads |
| `auto/2026-08-31T19-29-44-c9650961` | 2 | 4 | Smarter-Poker | fix(missions): retry failed realtime receipts |
| `auto/2026-08-31T17-43-47-b95b853a` | 2 | 1 | Smarter-Poker | fix(e2e): preserve honest production verdicts |
| `auto/2026-08-31T16-38-55-928c6f86` | 2 | 6 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-members-ph |
| `auto/2026-08-31T16-33-29-b9491ea3` | 2 | 2 | Smarter-Poker | fix(ui): enforce title case on every page |
| `auto/2026-08-31T14-48-32-f5d93252` | 2 | 2 | Smarter-Poker | Phase 3 complete Club Data exports before rebase |
| `auto/2026-08-31T14-35-50-bd74a68a` | 2 | 1 | Smarter-Poker | test(ci): repair late release-gate assertions |
| `auto/2026-08-31T09-52-12-948f04c2` | 2 | 3 | Smarter-Poker | security(stats): establish owner-only v2 foundation |
| `auto/2026-08-31T09-46-30-1a15991d` | 2 | 1 | Smarter-Poker | feat(challenges): make mission state truly realtime |
| `auto/2026-08-31T09-37-27-95ea4498` | 2 | 1 | Smarter-Poker | security(stats): establish owner-only v2 foundation |
| `auto/2026-08-31T09-07-40-a6866705` | 2 | 1 | Smarter-Poker | fix(test): enforce joinable seat-first tables |
| `auto/2026-08-31T09-05-54-72438fe7` | 2 | 1 | Smarter-Poker | test(engine): follow joinable-table board guard rename |
| `auto/2026-08-31T08-25-29-6a13b427` | 2 | 5 | Smarter-Poker | perf(roster): defer recovery code from startup [allow-revert] |
| `auto/2026-08-31T08-21-41-0fa233a5` | 2 | 2 | Smarter-Poker | chore(schema): refresh live Supabase manifests |
| `auto/2026-08-31T08-20-33-59754235` | 2 | 5 | Smarter-Poker | perf(roster): keep recovery code off startup path |
| `agent/cowork-create4/fix/title-case-and-em-dashes` | 2 | 3 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/cowork-create4/f |
| `agent/cowork-claude/main-is-red-two-stale-pins` | 2 | 4 | Smarter-Poker | chore: nudge CI |
| `agent/cowork-claude-roles/credit-and-lifecycle` | 2 | 4 | Smarter-Poker | docs(handoff): continuation record for the credit and promotion lifecy |
| `agent/codex-stats-cert/fix/world-sync-script-checkout` | 2 | 2 | Smarter-Poker | test(cashier): wait for reconciliation readiness |
| `agent/codex-final-certification-repair` | 2 | 1 | Smarter-Poker | fix(deploy): retain previous Club Arena assets |
| `agent/codex-final-certification-repair-v3` | 2 | 1 | Smarter-Poker | fix(deploy): make runtime retention publishable |
| `agent/codex-final-certification-repair-v2` | 2 | 1 | Smarter-Poker | fix(deploy): wire bounded runtime retention |
| `agent/codex-data-publish-gate/fix-joinability-test` | 2 | 1 | Smarter-Poker | fix(test): track joinable-table board guard |
| `agent/codex-data-program-p7/final-certification` | 2 | 11 | Smarter-Poker | chore(club-data): keep final audit change scoped |
| `agent/codex-data-program-p7/cold-start-cert` | 2 | 1 | Smarter-Poker | test(club-data): settle authenticated cold starts |
| `agent/codex-data-program-p3/complete-exports-rebased` | 2 | 2 | Smarter-Poker | chore(ci): refresh live schema manifest |
| `agent/codex-daily-missions-reconciliation-v2` | 2 | 1 | Smarter-Poker | fix(missions): retry failed realtime receipts |
| `agent/codex-customization/fix/release-source-windows` | 2 | 1 | Smarter-Poker | fix(ci): bound engine source guards structurally |
| `agent/codex-customization/fix/release-buyin-contract` | 2 | 2 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-customizat |
| `agent/codex-customization/fix/live-cashier-canary` | 2 | 1 | Smarter-Poker | test(cashier): certify the heading players actually see |
| `agent/codex-cashier/phase4-ops-resilience` | 2 | 9 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-cashier/ph |
| `agent/claude/title-case-and-em-dashes` | 2 | 1 | Smarter-Poker | fix(copy): the casing gates could not see most of the copy |
| `rescue/codex-phase5` | 1 | 3 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-phase5/aud |
| `rescue/codex-phase4` | 1 | 4 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/codex-phase4/aud |
| `rescue/codex-members-phase2` | 1 | 1 | Smarter-Poker | fix(e2e): bound customization reload certification |
| `rescue/claude-phase7` | 1 | 1 | Smarter-Poker | fix(agents,club): stop showing money nobody measured |
| `rescue/ca-drift` | 1 | 18 | Smarter-Poker | merge origin/main: keep both law-registry rows |
| `rescue/ca-drift2` | 1 | 4 | Smarter-Poker | fix(agents): read a sub agent's owed commission from the ledger, not a |
| `phase6/wheel-stays-on-its-tile` | 1 | 1 | Smarter-Poker | fix(spin): a wheel belongs to its own table, not to all four |
| `phase6/wheel-clock` | 1 | 3 | Smarter-Poker | fix(spin): the wheel agrees with the shared clock |
| `phase6/seat-fill-and-headsup` | 1 | 21 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into phase6/seat-fill-and-h |
| `phase6/registration-retry-truth` | 1 | 1 | Smarter-Poker | fix(tournament): a retry never tells a paid player they did nothing |
| `phase6/prize-and-finish` | 1 | 1 | Smarter-Poker | fix(tournament): a paid finish is not a bust, and the badge says what  |
| `phase6/no-dead-felt` | 1 | 1 | Smarter-Poker | fix(spin): the wheel never hands back an empty table |
| `phase6/lobby-truth` | 1 | 2 | smarter-poker-autopilot[bot] | Merge branch 'main' into phase6/lobby-truth |
| `phase6/a11y-and-viewport` | 1 | 4 | Smarter-Poker | fix(a11y): an overlay does not claim what it is not, and a short scree |
| `fix/zero-drift-phase-1-and-2` | 1 | 25 | Smarter-Poker | feat(tournaments): overlay ledger names the tournament; payout percent |
| `fix/seat-first-healer-husk-class-b` | 1 | 3 | smarter-poker-autopilot[bot] | Merge branch 'main' into fix/seat-first-healer-husk-class-b |
| `fix/restore-hamburger` | 1 | 1 | Smarter-Poker | fix(navigation): restore all hamburger menus and harden against regres |
| `fix/pickfreehorses-pin-survives-prettier` | 1 | 1 | Smarter-Poker | fix(ci): the pickFreeHorses pin survives a wrapped signature |
| `fix/new-club-automated-boundary` | 1 | 1 | Smarter-Poker | fix(clubs): keep automated players on house boards |
| `fix/engine-watchdog-deadline-contract` | 1 | 2 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into fix/engine-watchdog-de |
| `fix/engine-watchdog-copy-contract` | 1 | 1 | Smarter-Poker | test(ci): align watchdog restart-window contract |
| `fix/action-stage-window-is-structural` | 1 | 1 | Smarter-Poker | fix(ci): the action-stage pin is bounded by the switch, not by 4000 by |
| `feat/role-scoped-trade-ledger` | 1 | 4 | smarter-poker-autopilot[bot] | Merge branch 'main' into feat/role-scoped-trade-ledger |
| `feat/ledger-surfaces-and-ladders` | 1 | 2 | smarter-poker-autopilot[bot] | Merge branch 'main' into feat/ledger-surfaces-and-ladders |
| `codex/release/approved-mobile-club-arena` | 1 | 2 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into codex/release/approved |
| `codex/release/approved-mobile-club-arena-v2` | 1 | 3 | Smarter-Poker | fix(club-lobby): restore mobile share touch target |
| `codex/fix-payout-sweep-test` | 1 | 1 | Smarter-Poker | test(payouts): track measured deep sweep limit |
| `chore/schema-manifest-refresh` | 1 | 9 | github-actions[bot] | chore(ci): refresh Supabase schema manifest |
| `auto/2026-09-01T13-58-20-01c36d1b` | 1 | 1 | Smarter-Poker | fix(clubs): scope onboarding and creation controls |
| `auto/2026-09-01T13-42-54-6d93acbe` | 1 | 1 | Smarter-Poker | fix(clubs): scope onboarding and creation controls |
| `auto/2026-09-01T13-40-22-870cae96` | 1 | 1 | Smarter-Poker | fix(clubs): scope onboarding and creation controls |
| `agent/cowork-horse-audit/fix/fleet-counts-enabled-horses` | 1 | 1 | Smarter-Poker | fix(horses): the fleet is the horses that are supposed to play |
| `agent/cowork-claude/the-seat-exit-guard-crashed-when-it-fired` | 1 | 2 | Smarter-Poker | fix(guards): 'has_human IS TRUE' cannot reach an index declared 'WHERE |
| `fix/the-migration-ledger-has-two-repos` | 0 | 1 | Smarter-Poker | fix(ci): the migration ledger has two repos, and more than a thousand  |
| `fix/the-chip-supply-snapshot-stops-rescanning-the-ledger` | 0 | 4 | smarter-poker-autopilot[bot] | Merge branch 'main' into fix/the-chip-supply-snapshot-stops-rescanning |
| `fix/the-boot-sweep-no-longer-cashes-out` | 0 | 6 | Smarter-Poker | perf(table-management): the board row arrives whole |
| `fix/the-board-opens-on-the-live-floor` | 0 | 3 | Smarter-Poker | fix(table-management): three defects the audit of this page turned up |
| `fix/spin-ladder-is-drawn-not-computed` | 0 | 5 | smarter-poker-autopilot[bot] | Merge branch 'main' into fix/spin-ladder-is-drawn-not-computed |
| `fix/notifications-fullscreen-overlay` | 0 | 2 | Smarter-Poker | fix(notifications): clear the badge from every door, add swipe to dism |
| `fix/horses-fill-the-floor` | 0 | 3 | Smarter-Poker | test(horses): the decision budget measures this code, not the runner |
| `fix/horses-are-indistinguishable` | 0 | 3 | Smarter-Poker | fix(ca): the horse machinery is not in the bundle a player downloads |
| `fix/horse-identity-is-not-readable` | 0 | 4 | smarter-poker-autopilot[bot] | Merge branch 'main' into fix/horse-identity-is-not-readable |
| `fix/enforce-club-arena-tos` | 0 | 1 | Smarter-Poker | feat(ca): the Terms of Service gate actually gates |
| `fix/diamond-p2-lanes` | 0 | 14 | Smarter-Poker | fix(diamond): phase 2 lanes A, B, D, E, G consolidated, and the baseli |
| `fix/diamond-g-controls` | 0 | 1 | Smarter-Poker | fix(diamond): G - an hourly trial balance that names the account, four |
| `fix/diamond-e-earn` | 0 | 1 | Smarter-Poker | fix(diamond): E - every earn engine has a budget line and a daily cap  |
| `fix/diamond-d-purchase` | 0 | 2 | Smarter-Poker | docs(diamond): stamp the Lane D changelog with both pull request numbe |
| `fix/diamond-b-mint` | 0 | 1 | Smarter-Poker | fix(diamond): B - the Mint issues diamonds to the house, the signup 50 |
| `fix/diamond-a-identity` | 0 | 3 | Smarter-Poker | fix(diamond): A - the supply snapshot declares who may call it |
| `fix/data-truth-vip-analytics-horses` | 0 | 1 | Smarter-Poker | fix(ca): numbers on a screen should be measured, not invented |
| `fix/club-scoped-nav-context` | 0 | 2 | Smarter-Poker | fix(ca): four defects found reviewing the club-context change itself |
| `fix/club-context-page-resolvers2` | 0 | 3 | Smarter-Poker | fix(ca): a page never guesses which club it is about |
| `fix/club-card-poker-alias-not-real-name` | 0 | 6 | smarter-poker-autopilot[bot] | Merge branch 'main' into fix/club-card-poker-alias-not-real-name |
| `fix/club-card-name-across-the-top` | 0 | 4 | smarter-poker-autopilot[bot] | Merge branch 'main' into fix/club-card-name-across-the-top |
| `fix/club-boards-fill-from-their-own-members` | 0 | 20 | smarter-poker-autopilot[bot] | Merge branch 'main' into fix/club-boards-fill-from-their-own-members |
| `fix/chip-std-spin-chips` | 0 | 8 | Smarter-Poker | test(engine): the maintenance-pause pin loads the real engine once, in |
| `fix/chip-std-rake-spec` | 0 | 7 | Smarter-Poker | ci(chip-std): the tier parity gate reads the tiers where the spec keep |
| `fix/chip-std-p1-declared-legs` | 0 | 4 | Smarter-Poker | fix(chip-std): the declaring functions state their grants in the file |
| `fix/chip-std-free-buy` | 0 | 6 | Smarter-Poker | test(engine): the maintenance-pause pin loads the real engine once, in |
| `fix/auth-join-and-delete-defects` | 0 | 9 | smarter-poker-autopilot[bot] | Merge branch 'main' into fix/auth-join-and-delete-defects |
| `fix/arena-is-always-the-alias` | 0 | 9 | Smarter-Poker | fix(security): the arena-name RPCs are not reachable before login |
| `fix/a-correction-is-not-a-mint` | 0 | 36 | Smarter-Poker | fix(union): a union's level is the union's, not the viewer's |
| `feat/find-player-fuzzy-affiliations` | 0 | 3 | Dan Bekavac | fix(find-player): a boolean not a count, and your own seat is not a sp |
| `feat/engine-restart-programme-phase-3` | 0 | 6 | Smarter-Poker | feat(restart): phase 3 of 9 - the resume is staggered, not a burst |
| `feat/club-data-rake-snapshot` | 0 | 1 | Smarter-Poker | feat(club-data): a rake snapshot that answers day, week, month, and ye |
| `cowork-claude-feefwd` | 0 | 12 | smarter-poker-autopilot[bot] | Merge branch 'main' into cowork-claude-feefwd |
| `ci/css-beat-e2e-runs-on-the-box` | 0 | 1 | Smarter-Poker | ci(cost): CSS Beat E2E runs on the estate runner |
| `ci-marker/agent-open-pr-result` | 0 | 1 | github-actions[bot] | marker: agent-open-pr result for agent/cowork-pgrst/fix/pgrst002-resil |
| `agent/swarm-mtt-payouts/phase7-no-result-without-a-hand` | 0 | 41 | Smarter-Poker | merge origin/main, taking the union of two fixes for the same red test |
| `agent/cowork-spinwallet/feat/spin-wallet-per-owner` | 0 | 3 | Guard Test | base |
| `agent/cowork-pgrst/fix/pgrst002-resilience` | 0 | 17 | smarter-poker-autopilot[bot] | Merge branch 'main' into agent/cowork-pgrst/fix/pgrst002-resilience |
| `agent/cowork-claude/zd-deepstack-hardening-and-handoff` | 0 | 4 | smarter-poker-autopilot[bot] | Merge branch 'main' into agent/cowork-claude/zd-deepstack-hardening-an |
| `agent/cowork-claude/the-drain-outlives-the-hand` | 0 | 9 | smarter-poker-autopilot[bot] | Merge branch 'main' into agent/cowork-claude/the-drain-outlives-the-ha |
| `agent/cowork-claude/fix/spin-fairness-and-watchdogs` | 0 | 30 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/cowork-claude/fi |
| `agent/cowork-claude/fix/seat-first-capacity` | 0 | 8 | Smarter-Poker | Merge remote-tracking branch 'origin/main' into agent/cowork-claude/fi |
| `agent/cowork-claude-live/fix/no-random-refresh-and-the-bbj-rake-funds-the-promo-wallet` | 0 | 1 | Smarter-Poker | fix(club): clubs stop refreshing themselves, and the Promo Wallet show |

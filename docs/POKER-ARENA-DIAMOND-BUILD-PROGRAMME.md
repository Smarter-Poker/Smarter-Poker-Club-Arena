# Poker Arena: Diamond Arena Build Programme

Date: September 8, 2026. Phase count: 12.

## Execution Update, September 8, 2026

Dan explicitly authorized starting Phase 3 while Phase 2 push/publication is monitored and repaired in the background. This supersedes the earlier instruction to block Phase 3 solely on Phase 2 deployment. Phase 2 must still be verified and any regression corrected; queued publication does not count as completed publication. Public funded Diamond games remain subject to the later gameplay and accounting release gates.

## Execution Update, September 9, 2026

Dan authorized Phase 4 development while Phase 3 publication is verified in the background. Phase 3 runtime adoption and its recorded repair/regression checks are verified as of September 9 at 21:05 UTC. Pending publication is not a passed gate. This continuation preserves the prior-phase audit and does not authorize public funded Diamond games ahead of their gameplay and accounting gates.

## Execution Update, September 10, 2026

Dan accepted ownership of the remaining World Hub lobby image and explicitly authorized Phase 6 after the other Phase 5 implementation and publication checks passed. The image is excluded from this continuation. Phase 6 uses the shared engine and dedicated Diamond custody; public funded play remains subject to the existing accounting and release gates.

The initial Phase 6 engine change enforces whole-Diamond hand amounts and fixes a reproduced duplicate runout payout. It is not a completed funded-game certificate. The remaining atomic seat/custody, accepted-hand accounting, cash-out and controlled runtime acceptance work is tracked in [the Phase 6 audit](audits/2026-09-10-diamond-phase-6-cash.md).

## Execution Update, September 11, 2026

Phase 6 is closed. The shared NLH Diamond cash integration is merged as 85da6479, its three approved production migrations are applied, engine adoption and frontend publication are verified, and the permitted authenticated live acceptance passed on September 11 between 13:57 and 14:23 UTC. That acceptance found one layout defect in the Diamond shell, which was repaired, merged as 29b6ae08, published and rechecked live at 15:06 UTC. Evidence is in [the Phase 6 audit](audits/2026-09-10-diamond-phase-6-cash.md) and [the integration changelog](changelog/2026-09-10-diamond-phase-6-shared-cash-integration.md).

Dan's standing authorization to proceed after the Phase 6 deployment and acceptance pass now applies, and Phase 7 has started in its own owned tree with its own evidence. Dan also restated the product target for the arena itself on September 11: "DIAMOND ARENA NEEDS TO BE A 1:1 CLONE OF THE CLUB ARENA. (ONLY DIFFERENCE IS ITS ALL 'ONE OPEN CLUB' WITH NO UNIONS OR AGENTS AND ITS PLAYED WITH DIAMONDS INSTEAD OF CHIPS)". Phase 7 therefore opens on lobby parity, not on a new surface: the arena's own route renders the shared Club Arena lobby rather than a placeholder panel, while the chip operator routes underneath a club keep the safe shell so that "no unions or agents" holds on a typed URL. Public funded Diamond games remain closed behind the existing accounting and release gates, and `cash_games_enabled` remains false.

## Execution Update, September 11, 2026, Phase 7 Opening

Phase 7 is under way. It opened on the one to one lobby parity Dan restated that day rather than on a checklist feature, because no cash game feature can be exercised or seen through the placeholder panel the arena route used to render. The arena route now renders the shared Club Arena lobby; the chip operator routes underneath a club keep the safe Diamond shell so that "no unions or agents" holds on a typed URL. Evidence, including the two defects that work introduced and repaired, is in [the lobby parity changelog](changelog/2026-09-11-diamond-phase-7-lobby-parity.md).

No Phase 7 checklist item is claimed by that work. The survey the rest of the phase works from is [the supported feature survey](audits/2026-09-11-diamond-phase-7-feature-matrix.md), which also records the phase's real blocker: there is no Diamond table creation door, because the only live cash creation path always writes a cluster id, run it twice on and rake -1, all of which the Phase 6 admission guard refuses. Public funded Diamond games remain closed and `cash_games_enabled` remains false.

Dan also asked, on the same day, for Diamond Arena to use a white or light colour scheme against Club Arena's dark one, explicitly in the next phase rather than this one.

## Execution Update, September 12, 2026, Phase 7 Custody Top-Up And Feature Charge Audit

Two Phase 7 checklist lines are now ticked, and one new money door exists.

A seated Diamond player could not add to a stack. The chip add-on debits `club_members.chip_balance` and a Diamond entitlement has no row in that table, so `addChips` refused. `fn_poker_diamond_top_up` (migration 20260912004100, applied once to kuklfnapbkmacvwxktbh) reserves settled Diamonds into the SAME custody row the seat is bound to and raises `table_seats.stack` in the same transaction, which is the only shape the deferred seat-keeps-custody constraint allows. It is engine-only, whole units, capped at the table maximum, refused mid hand and refused again on a stale seat. Twenty-two assertions in the isolated Phase 6 fixture cover every refusal, the money move, the journal, idempotent replay, a hand settling on the topped-up stack and the full return of every Diamond on cash-out. Evidence: [the top-up changelog](changelog/2026-09-12-diamond-phase-7-custody-top-up.md). Mid hand add-ons, Auto Top Up and bust rebuy remain honestly unavailable for Diamond. Checklist line two is NOT claimed: it also covers seat changes, must move and clusters, which stay outside this phase.

Checklist lines five and six are claimed, on the evidence in [the feature charge and side feature audit](audits/2026-09-12-diamond-phase-7-feature-charges-and-side-features.md): no feature charge writer and no Diamond stake writer share any storage in either direction, every in-game feature door is idempotent under a caller-held request id, and insurance and BBJ stay refused at all six layers because their counterparty is a chip account that Phase 9 owns.

That audit also found a defect it deliberately did not fix. `fn_purchase_feature` is a shim that mints a fresh request id before delegating to the idempotent `fn_purchase_feature_v2`, so for the four `per_use` features a lost response followed by a second tap on the VIP page's a-la-carte grid charges twice. It is not a Diamond path and the fix belongs to the customization and VIP commerce estate; it is recorded in the audit and reported to Dan rather than repaired inside a Diamond slice.

## Execution Update, September 12, 2026, Diamond Straddles

Phase 7 checklist line three has started with the only one of its four features that asks nothing of the chip economy. A straddle is priced at exactly two times the current blind, every Diamond guard already refuses a table whose blinds are not whole, and HandController never refused a straddle for Diamond in the first place. Two places did, the table-load boundary and the SQL admission door, and both now admit one. A new staff door turns straddles on for a table that already exists, carries the creation door's authority, moves no money and refuses any table the boundary would not admit afterwards. Evidence: [the straddle changelog](changelog/2026-09-12-diamond-phase-7-straddles.md).

Certifying it in the isolated fixture found a defect in the admission door that was not the one being changed: UNSET IS NOT OFF was taught to the TypeScript boundary on September 11 and never to the SQL. A table with a NULL run-it column passed the door, reserved the player's Diamonds and seated them, and would then have been refused by the engine's own table load on every hand. `rake_cap_bb` was not read there at all. Migration 20260912014500 makes the door read all four columns the way the engine does; all seventeen live tables already carry explicit zeros and falses, so nothing that exists today changed.

Line three is NOT claimed. Bomb pots, board counts and run it twice remain. Run it twice halves a pot and an odd pot of whole Diamonds does not halve, so it needs an odd-unit rule certified first; bomb pots ride the `p_units` award lane, which the accepted-hand commit refuses for a Diamond hand.

## Execution Update, September 12, 2026, Diamond Run It Twice

The second of Phase 7 line three's four features. Run it twice was refused for Diamond because of arithmetic rather than policy: the runout cut every pot into integer CENTS, which is the indivisible unit of a chip and HALF of a Diamond, so a five Diamond pot over two runs paid two and a half Diamonds a board and the hand guard would have refused the hand the table had just dealt. A pot meets two divisions on that path and both now happen in the table's own unit, with the odd unit going where it always went: to the earliest board, and inside a chop to the first seat clockwise of the button. The chip arithmetic is unchanged by construction. Evidence: [the run it twice changelog](changelog/2026-09-12-diamond-phase-7-run-it-twice.md).

The two run-it columns still have to be STATED, because the engine reads an absent one as true and this arena inherits nothing from the chip schedule; what changed is that the answer may now be either boolean. A staff door writes all three columns so the engine's composite is exactly the answer it was given.

Line three is NOT claimed. Bomb pots and their board counts remain: a bomb pot's award rides the `p_units` lane that the accepted-hand commit refuses for a Diamond hand, so it needs a Diamond obligation lane rather than a rounding rule.

## Execution Update, September 12, 2026, Lifecycle And Denomination Regressions

Checklist line seven is claimed. Until September 12 a Diamond table had exactly one shape, and a regression suite for one shape is a suite for one row; straddles and run it twice made it a matrix, which is where a feature quietly stops working in the cell nobody tests.

Three suites. A denomination law pins all FOUR dividers a Diamond pot can meet - the run-it-twice per-board slice, the multi-board settlement, the tie chop inside one board and the payout unit - to the same rule, and then pins each one to READING the asset, because a fifth divider written in cents would pass every arithmetic case and still deal a hand that cannot settle. A configuration matrix crosses six permitted shapes with the four live statuses, with the five terminal ones, and with all seventeen rungs of Dan's stake ladder, dealing a full hand at the maximum buy-in on every rung; twenty-three refusal reasons are each asserted against all six shapes, because a permitted flag must never launder a forbidden one. And a lifecycle pair proves that a permitted change lands on a running table without a restart while a refused row is refused whole, so the permitted half of a mixed row does not sneak in beside the forbidden half.

The claim is scoped honestly: line seven is met for every configuration the arena CAN open today. Bomb pots and the variants beyond NLH are not omitted cells, they are features the boundary still refuses, and both matrices are written as arrays so a new feature joins them rather than forcing a rewrite. Evidence: [the lifecycle and denomination audit](audits/2026-09-12-diamond-phase-7-lifecycle-and-denomination-regressions.md).

## Execution Update, September 12, 2026, Diamond Bomb Pots And Line Three Complete

The last of line three's four features, and the line is now complete: bomb pots, board counts, straddles and run it twice are all reusable at a Diamond table, each behind its own Diamond tests.

A Diamond bomb pot was not a missing feature, it was a contradiction. A bomb hand that paid anybody must carry its per-pot award breakdown, and the Diamond branch of the accepted-hand commit refused any hand that carried one, so the hand could be dealt and could never be committed. The breakdown is a record, not a movement, so the Diamond rule became the rule that commit already applies to every other amount on the hand: each unit's amount must be whole. The multi-board settlement needed nothing at all; it has cut its shares in the table's own unit since the tournament fix, so one, two and three board bombs divide in whole Diamonds by the same rule run it twice does.

Two things about the row are still refused, because either one deals a hand the boundary then rejects: an ante that could not be a whole Diamond, and a bomb variant override, which is refused for the same reason plo4 is refused on the table itself. Evidence: [the bomb pot changelog](changelog/2026-09-12-diamond-phase-7-bomb-pots.md).

Both migrations edit the live function definition in place rather than restating it. `fn_ca_commit_hand_settlement` is 34,418 characters and every chip hand in the estate settles through it; retyping 34KB to change three lines is an estate-wide outage waiting on a typo. The body is read with `pg_get_functiondef`, one clause is replaced, and the result re-created, with the starting md5 pinned, the match required to be unique, and every refusal the branch already carried re-asserted afterwards. The function grew by exactly the difference in length between the two clauses.

## Execution Update, September 12, 2026, Diamond Side Features And Line Four Complete

Checklist line four is claimed. Skins, card decks, time banks, rabbit hunt, chat, voice and throwables were never built for chips: every one of them is priced in `profiles.diamonds` and charged through `deduct_diamonds`, and has been since long before this arena existed. At a Diamond table they are not being ported, they are being left alone, so the work of this line is proving that nothing hides them by asset and nothing about them can reach a stake.

Three properties, each a way the integration could have been wrong. Reachable: no asset condition appears anywhere in chat, voice, throwables, the throw controller, the rabbit hunt panel, the time bank store, the skins and card deck modal, or the per-player feature toggles, and inside the table page the same is proved per control because that file legitimately does read the asset for the cashier. Separate: no charge door names custody, a seat or a stack. Idempotent: each charge carries a caller-held request id, and the rabbit hunt's is derived from the table, the hand and the player rather than minted per attempt.

Where supported is answered in the data rather than by assumption. All seventeen live Diamond cash tables carry the same explicit side-feature settings as all 7,083 chip cash tables, with no NULL in any of those columns on either side. They agree because the values are stated, not because nobody looked, which is the same UNSET IS NOT OFF rule the admission door was corrected for on September 12.

The first version of the reachability pin was a census of `arenaAsset` conditions bounded by a guessed number, which would have gone red for an unrelated cashier change and green for a gate added to the rabbit hunt. It is a property of the controls now, bounded by the structures it watches, and both pins were checked by mutation. Evidence: [the side features changelog](changelog/2026-09-12-diamond-phase-7-side-features.md).

That work found two defects it did not fix, both in the multi-table tab bar's menu, both about the seat's money rather than a side feature, and both belonging to line two. The tab bar renders "Add Chips" and "Auto Top Up" unconditionally because it does not know the arena; at a Diamond table the first does nothing, since the `REBUY` bus case still breaks for any non-chip asset even though a Diamond cash seat now has a funded top-up writer, and the second flips a badge the auto-top-up effect ignores. Neither is reachable by a real player while public funded Diamond games remain closed. They are the starting point of the line two work.

## Execution Update, September 12, 2026, Diamond Arena Is The Light Room

Dan asked on September 11 for Diamond Arena to use a white or light colour scheme against Club Arena's dark one, explicitly in this phase rather than the last. It is built.

It lands on top of his older instruction, "THE WHOLE BACKGROUND SHOULD BE SOLID BLACK AND ALL THE SAME COLOR", which is written on the body rule, on the lobby ground and in the layout, and which an earlier piece of work enforced by deleting a per-route art system. The two only disagree if the light one is global. Scoped, they are one instruction: black is the rule for the chip estate, and the Diamond Arena is the one room that is not part of it. Every note carrying the black instruction is left exactly as it was.

`<html>` already carried two theme attributes that had to be prised apart after a production incident served the light palette to players who had chosen dark, so this is a third attribute with one writer rather than a fourth writer on an existing one: `data-arena-scheme` says where the player IS, while `data-theme` says what they PREFER and `data-color-theme` says what the felt looks like. It never reads or writes the player's setting. Its input is the same pair the club footer takes, because the in-table "+" opens a club lobby as a tab while the URL stays on the table.

It paints the room and not the table. The seat-plate law holds plates, felt and timer dark in every scheme because it is about hole cards being readable, and the new law enforces that same token list a second time, since the original reads a sheet this scheme is deliberately not declared in. Measured against production's own DOM before any of it was written: of 85 elements over 80 by 40, 79 carry no opaque background of their own and follow the ground, so they came with it. The lobby is the shared Club Arena lobby, which is the point of a one to one clone, so the scheme is the same page in a different room rather than a fork, and only the surfaces that decide light from dark are overridden. Evidence: [the light room changelog](changelog/2026-09-12-diamond-arena-is-the-light-room.md).

The Diamond Arena card on the home carousel also said ACTIVE PLAYERS. Dan asked for "JUST 'ACTIVE' AND THE NUMBER UNDER IT", and it was the one label on that carousel not matching its neighbours. It says ACTIVE now.

Still dark, and said so plainly: the club card panels and the global header, which are artwork with their own guards, and the table page, which the seat-plate law binds.

## Execution Update, September 12, 2026, Every Game The Estate Deals

Checklist line one is claimed. The arena opened with one game; the chip cash create screen offers nine, and a one to one clone deals the same nine: nlh, plo4, plo5, plo6, plo8, pineapple, short deck, fixed limit hold'em and fixed limit Omaha hi-lo.

The only question another game asks of an indivisible unit is whether it divides a pot somewhere the cent-denominated code did not have to care about. Every such place was already made unit-aware while this arena was NLH only, and the one this list newly reaches is the hi-lo split, which takes the same unit the tie chop takes: the low half of a Diamond pot is a whole number of Diamonds and the odd unit goes to high. A one Diamond pot therefore pays high entirely, which is not a rounding defect but what an indivisible pot means, and the same answer a live room gives with one chip in the middle. Nothing else divides, and that was checked rather than assumed: pot-limit sizing is pure addition, fixed limit multiplies the blind and its two halvings are reopen thresholds that are never wagered, short deck derives no ante.

The refusal was written in five places, which is how the plain-cash rule had drifted into five rules earlier the same day, so the games are named exactly twice, once per language, and a law holds the two together. That law also derives the TypeScript list from the chip create screen's own list, so the arena cannot fall behind it.

Two things were quietly backwards and are now right. The bomb-pot override compared against the literal nlh rather than the table's own game, which is indistinguishable from the real rule while there is one game and exactly backwards once there are nine. And a NULL game was neither admitted nor refused, because NULL IN is NULL: every caller happened to treat unknown as refusal, which is the kind of accident that holds until one of them does not.

The creation door hardcoded its game and had no parameter for one. It names the game now, refuses one the arena does not deal, and proves the row it wrote would be admitted before returning it. Its six-argument signature is dropped rather than replaced, because an ambiguous staff door is worse than a missing one.

The strongest evidence was already written and had been skipping the Diamond arm under a note that had stopped being true: a multi-board suite crossing plo4, plo8 and flo8 against two and three boards and three denominations, checked against an independent reference allocator rather than the engine's opinion of itself. It runs now. The configuration matrix gained its fourth axis, and the isolated fixture went from 41 checks to 63. Evidence: [the variants changelog](changelog/2026-09-12-diamond-phase-7-every-game-the-estate-deals.md).

Line two remains the only open line in Phase 7: mid-hand add-ons need a custody holding lane of their own, because a Diamond seat's stack must EQUAL its custody balance at every commit, and waitlists, offers, seat changes, must move and clusters are still to certify.

## Execution Update, September 12, 2026, The Last Line Of Phase 7

Checklist line two is claimed, and Phase 7 is complete.

Most of the line turned out to need nothing built. Waitlists move no money at all, `fn_offer_open_seat` reads no asset, the Diamond cash-out fires it through the same wrapper a chip cash-out does, and `atomic_table_buyin` has been an asset router since September 10, so a claimed offer lands on the Diamond buy-in door, which honours the hold and settles the waitlist row itself. That is worth writing down because it was not obvious until it was checked, and because the work that remained was all about what the queue TOLD a Diamond player rather than whether it worked.

Three things were wrong there. Every Diamond refusal reached the player as the caller's generic "check your balance", so the arena told a waitlisted player who arrived on time that they were short of Diamonds; thirteen are translated now, matched on the SQL exception name, with a second test reading those names back out of the migrations so a translation cannot outlive the refusal it handles. The lobby tested full before it tested the closed gate, so the one board that could still offer an action while Diamond cash was closed was a board with no seats on it. And the client opened six tables on a desktop while the server enforced four in three places, which is the direction its own note forbids.

Mid-hand add-ons were the real work. The chip lane takes the money on the tap and lands the chips at the end of the hand, and this arena cannot do that: the deferred seat-keeps-custody trigger requires a Diamond seat's stack to EQUAL its custody balance at every commit, so a reservation made now and applied later is a committed state the database refuses. There is no ordering of the chip lane's two steps this arena permits. So a mid-hand Diamond top-up is an intent rather than a debit. Nothing moves until the hand ends, and then the whole top-up happens in the one transaction that is allowed, through the door that already exists. The promise is narrower than the chip one and the player is told so rather than given the more comfortable sentence: the chip lane says the difference returns to your wallet, which is true because the chips were taken on the tap, and nothing has been taken here to return. The local balance, the session buy-in total and the rebuy count stay still until it lands, because counting a purchase nobody made is how a session P/L starts lying.

Seat changes and must-move remain unavailable, and they are unavailable BY CONSTRUCTION rather than by omission, which is the distinction the phase exit asks for. Both are provided by the cluster structure; a Diamond table belongs to no cluster and the boundary refuses one, so there is no `cash_games` row to name, no roster to spend a seat change from, and nothing that has to be remembered to keep them off. Evidence: [the queue changelog](changelog/2026-09-12-diamond-phase-7-the-queue-and-what-it-tells-you.md) and [the mid-hand changelog](changelog/2026-09-12-diamond-phase-7-a-seat-adds-mid-hand.md).

Phase 7 exit is met: the supported-feature matrix is explicit and passing, and every unsupported feature is refused by a rule rather than left out.

## Approved Product Contract

This replaces the earlier recommendation for two separate World Hub destinations. The World Hub has one player-facing Poker Arena entrance. Reuse the existing Club Arena application as the shared shell, lobby and game implementation. Diamond Arena is a diamond-only skin and operating policy inside it, not a second poker application.

The user explicitly approved:

- Rename the player-facing Club Arena umbrella to Poker Arena.
- Show Shark Club, Diamond Arena and the user's other joined clubs in the shared selector.
- Shark Club is the default chip-club selection, but the user must join before accessing its games or member content. Default selection is not membership.
- Every platform user is already a Diamond Arena member. No join request, join button, approval queue or private-club membership requirement applies to Diamond Arena.
- Other chip clubs retain explicit membership and existing approval rules. Show only a minimal public discovery/join surface to nonmembers; no member data or gameplay access.
- Diamond Arena contains players only. No union structure, agents, subagents, downlines, commissions, agent wallets or private-club ownership flow.
- Player-to-player diamond transfers ARE allowed through the platform wallet and from inside Diamond Arena.
- Diamond Arena gameplay, available balances, custody, fees, prizes, refunds, house funding and reporting are diamond-only. Never convert them to chips or include them in chip balances, journals, treasury totals or supply.
- Preserve the original Diamond Arena card artwork supplied by Dan on September 8, 2026 as the Diamond club image inside Poker Arena. This approved artwork is explicitly exempt from legacy code cleanup. Use the original asset without redesigning it.
- Remove the standalone Diamond Arena card from the World Hub; Poker Arena is the shared entry point.
- Reuse Club Arena code and approved assets extensively. Treat the old independent Diamond Arena application as zero: no reuse and no completion credit. Remove all old Diamond Arena runtime code and legacy paths, not merely hide or disable them.
- Preserve active tables when switching lobbies; never automatically switch the player's active table.
- Platform operations remain staff-authorized. A staff permission is not an agent hierarchy.
- Existing horse parity rules remain applicable; “players only” describes the absence of union/agent business roles, not a new exclusion of horses. Any automated participation must use the same funded diamond paths and existing authorization rules.

## What Phase 1 Means

Phase 1 is the architecture, dependency inventory and implementation contract. It does not claim to deliver a playable skin. Phase 2 begins the access/policy implementation; funding and gameplay follow in dependency order.

Phase 1 deliverables:

1. Isolated branch from freshly fetched canonical Club Arena origin/main.
2. This complete phased programme.
3. Source ownership and boundary map.
4. Reconciliation of older written rules with the user's latest directions.
5. Explicit acceptance gates, existing release prerequisites, and no unknowns disguised as completed work.

Source baseline for this phase:

- Canonical checkout: /Users/smarter.poker/Documents/club-arena.
- Worktree: /Users/smarter.poker/Documents/.agent-trees/club-arena/codex-diamond-arena-plan.
- Branch: agent/codex-diamond-arena-plan/feature/poker-arena-diamond-phase-1.
- Fetched baseline: 5717a6d1e2221d0d9054f3ca76fd8ab0d009dc11.
- World Hub source inspected earlier: e6aaa044e52bc01ef6639c133e52498014b02601. Refresh its authoritative head in its own worktree before implementation.

No source checkout containing other agents' unfinished work will be reset, cleaned, copied wholesale or used as the implementation branch.

## Source Evidence And Corrections

The existing HomePage loads memberships through ClubsService.getUserMemberships and uses ClubJoinService. ClubJoinService calls fn_preview_club_join and fn_join_club_atomic. These remain the chip-club entry path.

ClubHomePage accepts clubIdOverride, which is a useful composition seam. It does not make the whole page currency-independent or authorize automatic membership.

The existing router and Vite asset base use /hub/club-arena. Rename visible labels first and preserve working URLs; do not rename the repository, engine service, RPC namespace or deployment directory simply to match branding. A /hub/poker-arena alias can be added through the established route configuration with deep-link tests. Remove /hub/diamond-arena and its legacy aliases; update incoming links to select the new Diamond skin inside Poker Arena.

Current platform accounting migrations already created clubs.asset, clubs.is_platform and an arena identity. Their presence earns zero completion credit for this build. Inspect and safely reconcile them rather than creating a duplicate system arena or erasing records.

Older rules in DIAMOND-RULINGS 4 and 16 prohibited wallet transfers; the user's explicit instruction here supersedes that prohibition. Current code may have removed or disabled the old transfer route/UI. Phase 4 must verify the current implementation and restore a single atomic authorized path where necessary. Merely displaying an old wallet control is insufficient.

Older arena funding functions use club_members.chip_balance. That storage model conflicts with the latest diamond-only requirement and must not power the new skin. Keep generic gameplay algorithms; provide distinct diamond-denominated custody and ledger ownership. Existing chip-named financial fields are not acceptable diamond wallet storage.

The prior read-only live audit found a diamond system club with no union, one configured arena settings row, and no arena_deposit/arena_withdraw journal rows under that exact filter. That narrow result is not a full balance or migration certificate. Re-inventory all holdings and pending obligations before retiring any old path.

Existing DIAMOND-ACCOUNTING-ROADMAP requires seven consecutive clean trial-balance days, zero suspense and no open critical diamond incident before public Diamond tables open. This programme retains that public release gate. It does not prevent implementation, staging or isolated certification testing. Do not invent completed clean days or weaken the gate to finish a phase.

## Architecture

One application, one shared engine implementation, two explicit kinds of game context:

- Joined chip club: current membership and chip economy.
- Global Diamond Arena: automatic platform membership, diamond economy, no business hierarchy.

An arena context should carry stable identity, kind, asset, navigation and capabilities. The server derives financial context from authoritative table/tournament configuration. Browser-supplied asset, club ID or role cannot select an alternative wallet or grant access.

A system clubs row may remain as a nonfinancial foreign-key identity for existing table/tournament relations. It must never acquire chip balances, union associations, agent assignments or ordinary club-creation grants. Existing chip clubs remain unaffected.

Automatic Diamond membership should be a platform entitlement for every account. If shared components require a participation row, create/repair it idempotently behind the entitlement, including existing accounts and new signups, without asking the player to join. A missing materialized row is not a reason to show a join wall. Login/session revocation and normal platform security still apply.

A Diamond participation record must not consume a private-club membership slot, affect agent counts, create an upline, or grant access to Shark Club.

Reuse one engine artifact. Worker placement may later be separated for capacity and failure isolation, but do not fork the game rules or create a new dealer.

## Reuse And Change Map

Paths are relative to Club Arena unless marked World Hub.

| Domain              | Existing Source / Contract                                                                            | Required Treatment                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Arena directory     | src/pages/HomePage.tsx; src/services/ClubsService.ts                                                  | Shared selector; explicit chip membership; automatic Diamond entry; no fabricated memberships  |
| Join flow           | src/services/ClubJoinService.ts; ClubEntryTrustService.ts; fn_preview_club_join; fn_join_club_atomic  | Preserve for chip clubs; Diamond entitlement is separate                                       |
| Membership          | src/services/MembershipService.ts                                                                     | Do not inherit role hierarchy or membership-slot limits for Diamond                            |
| Shared lobby        | src/pages/ClubHomePage.tsx; src/components/lobby/GameLobbyPanel.tsx                                   | Reuse composition and existing cards through an explicit skin/policy boundary                  |
| Game visuals        | src/components/lobby/game-cards/; src/components/table/                                               | Reuse approved artwork, layout, animation and controls; diamond-specific units and identity    |
| Persistent table UI | src/components/table/PersistentTableLayer.tsx; src/App.tsx                                            | Keep seated tables alive across selector/navigation changes                                    |
| Cash queues         | src/services/cashGameLobby.ts; fn_cash_game_lobby; fn_cash_game_join                                  | Reuse queue/must-move behavior with arena isolation and entitlement                            |
| Client transport    | EngineStateClient.ts; EngineSocketMux.ts; TableWebSocket.ts; GameServerAPI.ts                         | One authoritative protocol; asset-aware financial events and reconnect                         |
| Table access        | server/src/services/TableViewerAccess.ts                                                              | Add global entitlement to HTTP/WS paths without opening private clubs                          |
| Engine              | server/src/GameServer.ts; server/src/engine/HandController.ts; PokerEngine.ts; ServerTableEngine\*.ts | Reuse game lifecycle; replace currency-coupled financial boundary, not engine                  |
| Rule extensions     | VariantRules.ts; BombPotScheduler.ts; RunItTwiceEngine.ts; StraddleEngine.ts; TimeBankEngine.ts       | Reuse verified behavior per game; no new untested variants implied                             |
| Configuration       | server/src/services/supabase/tables.ts                                                                | Load authoritative asset and arena capability; validate before play                            |
| Funding             | src/services/TableService.ts; server/src/services/supabase/seats.ts and wallets.ts                    | Shared seat lifecycle, distinct diamond funding/settlement implementation                      |
| Tournaments         | server/src/tournament/TournamentManager\*.ts; settleObligation.ts                                     | Reuse scheduling/state/obligation model with diamond custody and payouts                       |
| Rake and treasuries | ServerTableEngineSettlement.ts; services/supabase/rake.ts; rakeAllocation.ts; FeeReconciler.ts        | Diamond house destinations only; no commission/union/chip legs                                 |
| Platform wallet     | src/services/DiamondService.ts; World Hub useDiamondBalance.js                                        | One authoritative platform available balance, separately identified game custody               |
| Wallet transfer     | World Hub DiamondWalletModal.jsx; pages/api/store/diamond-transfer.js, current successors             | Verify/restore single atomic player-to-player path; preserve existing eligible-recipient rules |
| History/stats       | HandHistoryService.ts; StatsFactsService.ts; SessionStatsService.ts; LeaderboardService.ts            | Shared facts infrastructure, separate asset/scope and replay privacy                           |
| Operations          | financialAlerts.ts; integrity modules; platform staff API                                             | Reuse alerts/recovery, scope incidents and powers explicitly                                   |
| Navigation/publish  | src/main.tsx; vite.config.ts; World Hub next.config.js; publish-club-arena.yml                        | Same SPA/origin; remove legacy Diamond routes and iframe implementation                        |
| Capacity            | server/src/services/tableLease.ts; server/src/scale/                                                  | Verify actual live integration before claiming horizontal scaling                              |

Every implementation phase must expand its row into exact current callers, database functions, triggers, constraints and tests before editing. This table is the boundary inventory, not a claim that all transitive dependencies have been certified.

## Diamond Money Contract

Use the existing authoritative platform diamond balance for available funds. Add/reuse only properly diamond-denominated game custody. Prefer automatic funding on buy-in and automatic release after settled cash-out rather than a second manually funded spendable wallet.

Every movement must:

- Identify authenticated owner, source and destination, asset, amount, operation type and stable idempotency key.
- Bind retries to the exact request; altered payloads cannot replay another movement.
- Validate amount, funds, membership/entitlement, game state and permitted destination server-side.
- Lock in a consistent order and commit funding, custody, seat/entry and journal effects atomically.
- Record enough evidence to recover after a lost response, engine restart or partial delivery.
- Refuse an invalid/unfunded transaction without shutting down the whole arena.
- Produce management alerts for discrepancies and preserve valid unpaid obligations for reconciliation.
- Never invoke chip minting, conversion, distribution, agent credit or union settlement.

Supply conservation counts available wallets, cash-game custody, tournament prize custody, house holdings and any funded Diamond reserves once each. If stacks/pots decompose table custody, do not count both. Transfers and buy-in/cash-out move existing diamonds; they are not mint/burn events.

Use integer diamond units consistent with current wallet/journal storage. Review engine rounding, odd pots, split boards, fees and payout remainders. Do not silently create fractional wallet diamonds.

Tournament playing stacks are nonredeemable tournament units. Entry and prize money are diamonds. Tournament units must never become withdrawable diamonds just because the UI uses diamond artwork. This distinction does not associate the game with Club Arena's spendable chips.

Player transfers spend only available funds. Simultaneous transfer/store purchase/buy-in must never double-spend. Seated users can open the wallet, verify a recipient and transfer available diamonds without abandoning their table. Both parties receive durable records and balance updates.

Purchased-lot provenance, refunds, debts, chargeback handling and existing settlement-window rules must be preserved through transfers and game custody. Do not use generic feature-spend logic that grants VIP users free stakes; any sponsorship must be funded explicitly.

## Phases And Exit Gates

### Phase 1 Of 12: Architecture, Inventory And Programme

- [x] Record all decisions from this conversation, including latest membership correction.
- [x] Establish an isolated current Club Arena worktree and branch.
- [x] Map shared frontend, engine, access, wallet, settlement and deployment boundaries.
- [x] Identify obsolete transfer prohibition, manual Diamond join requirement and chip-named arena funding.
- [x] Define all remaining phases and objective exit gates.
- [x] Update conflicting current specification sections while preserving historical evidence.
- [x] Prepare the verified specification and changelog for branch publication; actual commit/push status is reported separately.

Exit: reviewable programme and reconciled policy, required checks passed, merged source content verified on main, and publication evidence recorded before Phase 2. Phase 1 adds no runtime gameplay. See the Phase 1 verification changelog; branch push alone does not satisfy the publication gate.

### Phase 2 Of 12: Arena Identity, Access And Asset Boundaries

- [x] Inspect current schema/RPC/trigger chain and preserve any existing arena obligations.
- [x] Establish exactly one system Diamond identity; no ordinary club grants.
- [x] Define typed frontend/server arena context and explicit capability rules.
- [x] Implement automatic Diamond entitlement for current/new users and repairable participation.
- [x] Keep explicit join/approval before chip-club games and member data, including Shark Club.
- [x] Enforce no union, agent, commission or private membership-slot association.
- [x] Authorize lobby, direct links, table state, WebSockets and staff routes consistently.
- [x] Make unknown/mismatched asset fail at transaction entry; no fallback to chips.

- [x] Verify the merged Phase 2 frontend on production and confirm the engine runs the Phase 2 server code. Both serve release 4932f6f91ad9b08300cf20afbeb9576b6559770f, a verified descendant of the Phase 2 merge, on September 8, 2026.
- [x] Complete the authenticated live recheck of the automatic-entry card and Diamond navigation repair. Verified September 9 on published Phase 3 merge `ec5a84f994`: automatic home entry, UUID/finance/agents access-only routes, no Diamond operations rail or chip footer, and automatic stale-invite redirect. The shared selector artwork and skin remain Phase 5.

Implementation and audit evidence: PR #3814, merged as ea30980397158749d0d91c1726c9f8e004e83e56. All 24,638 unit tests, 166 browser checks and 39 isolated SQL assertions pass. Six production migrations are applied. Runtime publication and the repaired Diamond UI acceptance are verified. The additional Shark seat-query regression discovered during Phase 3 acceptance is tracked in PR 3982. The user explicitly authorized Phase 3 to proceed while Phase 2 publication and any scoped repairs are monitored in the background. Phase 2 rollout latency does not block Phase 3. See the Phase 2 changelog for exact release and browser evidence.

Exit: access and wrong-asset integration tests pass, merged frontend and server publication verified, no public funded games yet.

### Phase 3 Of 12: Diamond Custody, Ledger And Reconciliation

- [x] Select dedicated diamond custody records; retire dependence on chip_balance.
- [x] Implement atomic reserve/release and entry/seat contracts using proven Club Arena semantics.
- [x] Enforce nonnegative amounts, valid denominations and request-bound idempotency.
- [x] Inventory/forward-migrate any old arena balances without erasing history.
- [x] Extend all diamond supply/trial-balance/snapshot surfaces and exclude diamond holdings from chip books.
- [x] Preserve provenance, purchased-lot/debt treatment and audit identities.
- [x] Verify atomic failure rollback and management error visibility. The September 9 production cutover retired deferred custody obligations and recovery sweeps.

Exit: concurrent/replayed/failure-path movements conserve diamonds and produce zero chip effects.

Runtime adoption verified September 9 at 21:05 UTC: healthy engine 561eaa52 contains final repair 4c385b09; both frontend origins serve descendant b30e1b85. See docs/audits/2026-09-08-diamond-phase-3-custody.md for exact ancestry and reused acceptance evidence.

### Phase 4 Of 12: Wallet And Player-To-Player Transfers

- [x] Inspect current platform transfer route, UI and database status; reconcile earlier retirement.
- [x] Reuse current wallet components/services where compatible; restore one atomic transfer path if absent.
- [x] Verify recipient identity, confirmation, server-side eligibility and existing policy.
- [x] Show available and in-play diamonds separately, with no chip conversion action.
- [x] Make transfer UI accessible while seated and while browsing.
- [x] Verify both-party ledger/balance updates and retry behavior.
- [x] Test transfer versus buy-in, store spend and other outgoing transfer races.

Exit: authorized test users can transfer available diamonds once; reserved game funds remain untouched.

Release and acceptance verified September 9, 2026: Club Arena 70fd31cf, World Hub f278b167 plus evidence 27235a03, and applied migration 20260909200327. See docs/changelog/2026-09-09-wallet-transfers-commit-together.md for exact source, CI, SQL, publication and authenticated review evidence. Production acceptance did not submit a real-player transfer.

### Phase 5 Of 12: Poker Arena Shell And Diamond Skin

- [x] Rename visible umbrella/header/World Hub tile to Poker Arena.
- [x] Locate and preserve the original approved Diamond Arena card asset before cleanup (World Hub candidate: public/cards/diamond-arena.png; visually match Dan's supplied September 8 screenshot); reuse it for the Diamond club card inside Poker Arena.
- [x] Remove the standalone Diamond Arena card and navigation target from the World Hub on desktop and mobile, including alternate card lists and cached navigation configurations.
- [x] Reuse current selector: Shark default, Diamond adjacent, joined clubs included.
- [x] Shark nonmember sees Join, not member content; Diamond never shows Join.
- [x] Reuse shared lobby sections and approved game-card designs.
- [x] Scope labels, available balance, icons, filters and persistent preferences to selected arena.
- [x] Preserve active table, animation and sound behavior across navigation.
- [x] Keep shared Club Arena technical URLs where needed; create the new Diamond selection inside Poker Arena. Remove the old standalone Diamond route, redirects, aliases and iframe entry points.
- [x] Test mobile, desktop, deep links, back/refresh, auth return and old caches.

Exit: correct shell/selection/access behavior without old iframe or simulated game content.

Release verified September 10, 2026: Club Arena implementation bc72ffc6 plus footer repair d600427d are published through both shared frontend endpoints; World Hub entry and evidence are live at b1250716. Exact CI, authenticated navigation/table preservation, retired-route checks and the managed-browser WebGL limitation are recorded in docs/changelog/2026-09-09-poker-arena-shell-phase-5.md. No engine or database deployment was needed.

Phases 3 Through 5 Recheck: the September 10 audit repaired and published the transfer session/retry defects through PR 4078, verified production contracts and live routes, and retained the user-owned World Hub image exclusion. Exact evidence is in [the prior-phase recheck](audits/2026-09-10-diamond-phases-3-through-5-recheck.md).

### Phase 6 Of 12: First Fully Playable Diamond Cash Game

- [x] Wire shared NLH engine to Diamond buy-in, actions, settlement and leave.
- [x] Fund seat, blinds, bets, pots and cash-out in diamonds only.
- [x] Wire hand history, result events and wallet refresh.
- [x] Test actual multi-user play in a controlled certification environment.
- [x] Verify all-in, side pot, tie, disconnect, restart, pending leave and response-loss retry.

Exit: complete play-and-cash-out flow reconciles every diamond; no chip or hierarchy writes.

Phase 6 Of 12 Is Done, verified September 11, 2026. Implementation merge 85da6479 (PR 4088) passed required CI 34440835759; production migrations 20260910050142, 20260910050156 and 20260910050209 were applied once against approved source; engine adoption cut over at 86aab0e6 on September 10 with later descendants serving since; frontend publication was verified through both build-info endpoints; and the permitted authenticated live acceptance passed on the six Diamond and chip-club routes plus the Diamond Wallet. One layout defect in the Diamond shell was found by that acceptance, repaired in PR 4313, merged as 29b6ae08, published and rechecked live. Controlled multi-user play, all-in, side pot, tie, disconnect, restart, pending leave and response-loss retry were certified in the isolated environment, not in a public funded game, and public funded Diamond games remain closed behind the accounting release gate. Exact evidence: [Phase 6 audit](audits/2026-09-10-diamond-phase-6-cash.md) and [integration changelog](changelog/2026-09-10-diamond-phase-6-shared-cash-integration.md).

### Phase 7 Of 12: Cash Game Parity And Table Features

- [x] Enable each intended Club Arena variant only after corresponding Diamond tests.
- [x] Reuse waitlists, offers, rebuys/add-ons, seat changes, must-move and multi-table flows.
- [x] Reuse supported bomb pots, board counts, straddles and run-it-twice.
- [x] Integrate table skins, cards, time banks, rabbit hunt, chat, voice and throwables where supported.
- [x] Keep feature diamond charges separate from game stakes, with no double charge.
- [x] Audit insurance and side-feature liabilities before enabling any such product.
- [x] Run table lifecycle and denomination regression tests across configurations.

Exit: explicit supported-feature matrix passed; unsupported features remain honestly unavailable.

### Phase 8 Of 12: Tournament, SNG And Heads-Up Funding

- [x] Reuse registration, late entry, re-entry, rebuy/add-on, balancing and blind clocks.
- [x] Separate Diamond prize escrow from tournament playing units.
- [x] Reuse single obligation settlement for prizes, refunds and cancellations.
- [x] Preserve finishing-position evidence and recover pending obligations after restart.
- [x] Test every paid place, ties, canceled events and duplicate payout attempts.

Exit: all funded tournament lifecycles close exactly and cannot pay playing-stack units to wallets.

Phase 8 Of 12 Is Built, September 14, 2026, behind a switch that is still off: `tournaments_enabled` is false and every Diamond tournament door refuses by name. Three production migrations were applied once against approved source, each rehearsed first as real clients through the real doors inside a rolled-back transaction: 20260914024241 (a tournament entry is custody: the registration, rebuy, unregistration and cancellation cores take and return a Diamond entry as a `poker_diamond_custody` row, ACTIVE from the moment it is paid and never bound to a seat, with an append-only ledger that decomposes every movement into prize, bounty and fee parts; a started event is never voided; the immutable cancellation receipt is written and proved against Diamond rails), 20260914032315 (a tournament pays from its own custody: the chip estate's one terminal path is kept and `fn_credit_and_log` and `fn_settle_tournament_rake` learn, for a Diamond event only, to pay whole-Diamond places out of the prize parts of the custody rows into the winner's wallet under the same credit key, bank cap and payout evidence, and to bank each player's own fee part to the house through the register so players + house + custody = register before and after; the escrow shadow opens from the ledger with exact parts and closes at exact zero; a replay pays nothing twice) and 20260914034708 (the doors answer the client with reasons and receipts). The seat guards that admit a tournament seat only against an active entry (P0810-P0815) were built in parallel by another agent and merged as #4553. Playing units are tournament chips on `table_seats`; the deferred entry guard proved, at every simulated commit, that no custody row ever binds a seat or holds anything but its movements. The engine deals a Diamond tournament table as a tournament table (boundary, switch, hand, seat) and prices a place in whole Diamonds; the client reads the Diamond receipts, says the Diamond reasons and labels the arena's events Not Open Yet while the switch is off. Every chip function edited is edited in place with its md5 pinned and the reverse substitution proved. Restart recovery of pending obligations is the chip estate's existing sweep, which routes through `fn_credit_and_log` and therefore through the Diamond leg. Ties are settled by the chip ladder rule, which is unit-aware since 2026-09-12. What remains for the switch: bounty and satellite formats are Phase 9 and refused by name; the lobby's projected ladder and sign-up dialog spoke chips for a Diamond event until 2026-09-15, when the tournament read learned to carry its arena and all five place-pricing surfaces took the unit from it ([priced in Diamonds](changelog/2026-09-15-a-diamond-event-is-priced-in-diamonds.md)); there is no isolated SQL fixture runner for the tournament lifecycle yet - the evidence is the three rolled-back production rehearsals and the law tests that pin the migration text. Exact evidence: [entry is custody](changelog/2026-09-14-diamond-phase-8-a-tournament-entry-is-custody.md), [pays from its own custody](changelog/2026-09-14-diamond-phase-8-a-tournament-pays-from-its-own-custody.md), [doors, engine and client](changelog/2026-09-14-diamond-phase-8-a-tournament-door-answers-the-client.md). Merged as 6f734856b38f69cfb21c5950ce680f1518433a88 (PR 4583) and published through both build-info endpoints; the money doors were put on the guard watchlist (20260914041258), the ledger's arena foreign key indexed after the post-deploy gate caught it (20260914043752, PR 4585), and Phases 1 through 8 were rechecked end to end: [the recheck](audits/2026-09-14-diamond-phases-1-through-8-recheck.md). A second, deeper recheck of Phase 8 alone then walked every caller of the chip unregistration authority and found the seat exit a heads-up or sit-and-go player uses (and three smaller doors) still on the chip rails for a Diamond event; migration 20260914103912 routes inside the authority itself so every exit door sends a Diamond entry home, replays a settled request as a whole receipt, keeps the chip clock and names the asset on the seat-first receipt, with the client's seat door saying the Diamond reasons and moving the Diamond balance: [a seat exit goes home](changelog/2026-09-14-diamond-phase-8-a-seat-exit-goes-home.md).

Phase 8 Code Re-Landed, September 19, 2026. The September 16 baseline restore (#4711) archived every Phase 8 commit above out of `main` while production kept the migrations they call (`fn_poker_diamond_tournament_*`, `fn_poker_diamond_create_tournament`, seat guards P0810-P0815, all read back from `supabase_migrations.schema_migrations` on September 19). The engine, client, test and law code of #4553, #4583, #4587, #4620 and #4685 was cherry-picked back onto the current `main` in one series, each step reconciled with the newer main it landed on (the engine's tournament-switch read now keeps a failed settings read apart from a closure exactly as the cash read learned to; the prize-unit wiring sits on main's current tournament surfaces; no migration or schema-manifest file is carried, those return through the migration-records restoration). The checklist above describes what is on `main` again once that series merges; `tournaments_enabled` stays false. Exact evidence: [the Diamond tournament code comes home](changelog/2026-09-19-the-diamond-tournament-code-comes-home.md).

### Phase 9 Of 12: Spins, Bounties, Satellites And Reserves

- [ ] Adapt spins prize draw/reserve logic to funded diamonds.
- [x] Wire bounty, PKO and mystery-bounty pools and activation rules.
- [ ] Implement diamond-to-diamond satellite escrow transfer and duplicate qualification handling.
- [ ] Fund guarantees and promotional entries from authorized diamond house/budgets.
- [ ] Implement rake/fees/BBJ destinations only in Diamond accounts, where approved.
- [ ] Remove every inherited union/agent distribution and chip treasury dependency.
- [ ] Test prize-pool conservation, capped exposure, rounding and cancellation recovery.

Exit: specialty prize liabilities and reserves reconcile; no inferred new prices/guarantees.

Phase 9 Of 12 In Progress, September 14, 2026, behind the switch (`tournaments_enabled` false). First piece built: knockout and progressive (PKO) bounties pay from the Diamond bounty bank. Migration 20260914111709 opens the bank the Phase 8 ledger already held (the drain holds it per custody row, the payer pays category bounty from it in whole Diamonds and opens the escrow shadow from the ledger's exact parts because a knockout is paid mid-event, the charge carries a bounty part and follows an open shadow), admits `bounty` and `progressive_bounty` at the creation door under the chip door's rule (a whole bounty within the buy-in after the fee; no price invented), carries the head on the Diamond roster row, and teaches six chip readers of "bounty paid" the Diamond ledger in place. The chip knockout machinery (the engine's claim, `fn_collect_bounty` and its PKO half rule, `fn_finalize_bounty_pool` at the terminal) is reused whole. A Phase 8 gap found on the way was closed first: both knockout doors proved a bought-back generation only by a chip rebuy leg, so a Diamond player who busted, bought back and busted again would have been refused for ever (20260914111558). A full Diamond PKO lifecycle was rehearsed through the real doors and rolled back before the applies: [a bounty is paid from its own bank](changelog/2026-09-14-diamond-phase-9-a-bounty-is-paid-from-its-own-bank.md). Second piece built the same day: mystery bounties in Diamonds (20260914113514) - the seed floors the mystery half to the unit and holds every chest to it, the reserve splits a chest in whole Diamonds, the complete marker (the evidence a knockout was settled exactly) expects the split at the unit, the terminal settlement reads the Diamond ledger, the creation door admits and stamps the format under the chip configuration door's rules, and the engine builds the chest ladder at the unit it read beside the tournament row, refusing to seed at one it has not: [a mystery chest holds whole Diamonds](changelog/2026-09-14-diamond-phase-9-a-mystery-chest-holds-whole-diamonds.md). Every bounty format the chip estate deals now runs in Diamonds. Still to build in this phase: satellites, spins and their reserve, guarantees and promotional entries from the house, the fee destinations for those formats, and the conservation tests across them.

Phase 9 Code Re-Landed, September 19, 2026. The bounty-bank and mystery-chest engine code of #4638 (`buildInventoryAtUnit`, the seed that refuses an unknown unit, the law tests) was archived by #4711 with the Phase 8 work and is cherry-picked back onto the current `main` in the same series; its three migrations are installed in production (20260914111558, 20260914111709, 20260914113514) and their files return through the migration-records restoration. The ticked line above is true again once that series merges; nothing else in this phase moved. Evidence: [the Diamond tournament code comes home](changelog/2026-09-19-the-diamond-tournament-code-comes-home.md).

### Phase 10 Of 12: History, Statistics And Management

- [ ] Scope histories/replays, earnings, stats, leaderboards and wallet records to Diamond.
- [ ] Verify public/private fields and opponent card privacy.
- [ ] Show real member/online/seated/table counts with meaningful zero/error states.
- [ ] Add staff-only game configuration, incident review and audited adjustments.
- [ ] Integrate financial push alerts and reconciliation without arena-wide automatic lockout.
- [ ] Verify no agent panels, union menus, chip metrics or synthetic players appear as real activity.

Exit: every displayed metric and management action has an authoritative, tested source.

### Phase 11 Of 12: Adversarial, Load And Regression Verification

- [ ] Test cross-asset request forgery and unauthorized membership/management access.
- [ ] Test transfer/store/game concurrency, duplicate delivery and crash recovery.
- [ ] Verify one engine owner per table and safe release/recovery.
- [ ] Exercise shared chip-club regression suite without spending real user funds.
- [ ] Measure lobby fan-out, action latency, event-loop load, database locks and reconnect storms.
- [ ] Verify actual scaling integration before enabling additional engine workers.
- [ ] Test old bookmarks, expired/revoked sessions, stale storage, service workers and mobile rotation.

Exit: reproducible evidence, measured operating envelope and no unresolved critical build defects.

### Phase 12 Of 12: Release, Retirement And Live Proof

- [ ] Verify existing clean-accounting release prerequisites with actual time-series evidence.
- [ ] Complete an exact migration/engine/frontend compatibility and rollback manifest.
- [ ] Use established Hetzner static/engine publishing; World Hub routing through its pipeline.
- [ ] Verify published SHAs and real public route behavior.
- [ ] Verify certified buy-in/play/leave/transfer end to end after deployment.
- [ ] Delete all legacy Diamond Arena runtime modules, routes, API handlers, iframe assets, jobs, deployment targets, flags and obsolete configuration after dependency verification. Disabled or unreachable code does not satisfy removal.
- [ ] Remove exclusive obsolete database functions, triggers and tables through new forward migrations after reconciling balances and obligations. Preserve historical migration files and financial journal evidence.
- [ ] Search both repositories and deployment configuration for every inventoried legacy symbol/path; document each remaining match as shared infrastructure or historical evidence. Verify old URLs expose no Diamond Arena screen, API or redirect alias.
- [ ] Verify shared Diamond Wallet, player transfers and Club Arena gameplay still work after deletion.
- [ ] Keep rollback compatible with outstanding Diamond tables/obligations.
- [ ] Update phase evidence and all programme status records.

Exit: usable published Diamond skin, exact financial reconciliation, no orphan routes or chip contamination.

## Legacy Removal Contract

Inventory legacy Diamond Arena files, routes, database objects, deployment resources and incoming callers in Phase 2. Remove replaced writers during Phase 3, old UI and route paths during Phase 5, and remaining exclusive infrastructure during Phase 12. Do not build new code on legacy Arena services. Reuse comes from Club Arena and the shared platform wallet. Removing an old Arena wrapper must retain the shared service it calls. No compatibility route for the old standalone Diamond Arena is required; update every internal caller to the new Poker Arena selection. Financial records remain historical evidence, not a legacy execution path. Rollback must not reactivate old Diamond writers or chip-backed funding.

## Verification Standard

A phase closes only when its stated deliverable exists and the relevant checks have passed. A pushed branch is not a published feature; a migration file is not an applied migration; a passing typecheck is not a completed poker hand.

For phases adding runtime code: record exact commit, changed callers, focused behavior tests, required repository checks, schema application evidence where applicable, and deployment status. For Phase 1 documentation: inspect diff, validate source paths and phase coverage, run required hooks/typecheck, and record branch publication separately.

Report format:
“Phase N Of 12 Is Done.”
Brief result and material limitation.
“Ready For Phase N+1 Of 12.”

Do not change phase numbers silently or count existing old Diamond work as completed phases.

## Settings And Prerequisites

No additional user input is required for Phase 1 or the architectural foundation. Audit current approved economic settings before building them into production. If an exact Diamond stake schedule, rake rate/cap, guarantee or prize structure has not been approved, propose concrete settings at the relevant phase; do not silently copy chip amounts or invent future player entitlements. CLAUDE.md 10.9 reserves those future economics to the user. This does not hold up the earlier phases.

The existing seven-clean-day release condition is documented in DIAMOND-ACCOUNTING-ROADMAP, not invented by this programme. Any inability to satisfy it must be reported honestly at release; do not claim an immediate public launch while it remains unmet.

## Immediate Next Batch

Phase 7: cash game parity and table features, on Dan's standing authorization after the Phase 6 deployment and acceptance passed. It opens on the one-to-one lobby parity Dan restated on September 11, then enables each feature only behind its own Diamond tests, starting from a supported-feature matrix built from the current shared code and the Phase 6 admission guard. Public funded Diamond games remain subject to the gameplay and accounting release gates; no Phase 7 work is claimed by the Phase 6 release.

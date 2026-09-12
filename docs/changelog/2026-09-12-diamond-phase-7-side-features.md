# Diamond Phase 7: A Diamond Seat Keeps Its Side Features

Status: Phase 7 In Progress. Checklist Line Four Is Claimed. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## What This Line Actually Asked For

Skins, card decks, time banks, rabbit hunt, chat, voice and throwables were never built for chips.

Every one of them is priced in `profiles.diamonds` and charged through `deduct_diamonds`, and that has been true since long before this arena existed. So at a Diamond table they are not being ported. They are being **left alone**, and the work of this line is proving that nothing hides them by asset and nothing about them can reach a stake.

That is a narrower claim than "integrate", and it is the honest one. A feature that already works does not need integrating; it needs a guarantee that the arena did not quietly break it.

## The Three Properties

**Reachable.** No asset condition appears anywhere in chat, voice, throwables, the throw controller, the rabbit hunt panel, the time bank store, the skins and card deck modal, or the per-player feature toggles. Each of those files is read whole, because none of them owns money or makes a stake decision, so there is no legitimate reason for the arena's denomination to appear in any of them at all.

`useUserTableSettings` is in that list on purpose. The rabbit-hunt button, the emoji overlay and the text-message toggle are read from it, and it is a per-PLAYER row rather than a per-table one. A player's own feature settings therefore follow them to a Diamond seat unchanged, which is exactly what a one to one clone means here.

Inside the table page the same property is proved per control rather than per file, because that file legitimately does read the asset for the cashier. Each of the four in-page controls is read to the end of its own declaration, and each of the three rendered elements to its own closing token.

**Separate.** No charge door names custody, a seat or a stack. The money moves in the wallet; the stake lives in `poker_diamond_custody`. A feature charge and a stake cannot be the same Diamond, and the live-schema half of that, in both directions, is in [the feature charge audit](../audits/2026-09-12-diamond-phase-7-feature-charges-and-side-features.md).

**Idempotent.** Each charge carries a caller-held request id, so a lost response answers with the first receipt instead of charging twice. The rabbit hunt's id is derived from the table, the hand and the player rather than minted per attempt, so the same hand asks the same question however many times the engine retries it.

## Where Supported, In The Data

All seventeen live Diamond cash tables carry the same explicit side-feature settings as all 7,083 chip cash tables: `allow_rabbit_hunt` true, `ban_chat` false, `time_bank_enabled` true, `time_bank_max_uses` 4. There are no NULLs in any of those columns on either side.

That distinction matters here for the same reason it mattered to the admission door. UNSET IS NOT OFF: a column the arena left unset would be answered by the chip schedule's default rather than by this arena, and the two happen to agree today. They agree because the values are stated, not because nobody looked.

## The Test That Was Wrong First

The first version of the reachability pin counted `arenaAsset` conditions in the table page and demanded the total stay under a number. It was wrong in both directions at once.

The number was guessed rather than measured. It said eight; the page holds eleven. And even corrected, a census is the wrong instrument: it would have gone red for a cashier change that touches no side feature, and stayed green for a gate added to the rabbit hunt in any commit that happened to delete an unrelated one.

It is now a property of the controls instead, with both windows bounded by the structure they watch rather than by a count. Both pins were checked by mutation: adding an asset gate to the time bank opener and an asset-derived prop to the rabbit hunt panel turns them red, and the file is green again with the mutations removed.

The element anchors carry a newline for a reason worth recording. `<RabbitHunt` on its own first matches `Promise<RabbitHuntRevealResult>` nine thousand lines earlier, because a generic type parameter is a literal `<RabbitHunt` too, and the window then ran from a type to the next `/>` in the file. That is precisely the anchor collision `tests/helpers/sourceWindow.ts` was written about, and the test found it on its own first run.

## Two Defects Found, Scheduled Rather Than Fixed Here

Both are in the multi-table tab bar's menu, both are about the seat's money rather than a side feature, and both belong to checklist line two, which is the next piece of work.

`createDefaultMenuSections` renders "Add Chips" and "Auto Top Up" unconditionally, because the tab bar does not know the arena. At a Diamond table both are dead. The `REBUY` bus case in the table page breaks for any non-chip asset, so the item does nothing even though a Diamond cash seat now HAS a funded top-up writer; the `AUTO_TOP_UP` case has no asset condition at all, so it flips a badge that the auto-top-up effect then ignores for Diamond. The label is also a chip word at a Diamond seat.

Neither is reachable by a real player today, because public funded Diamond games remain closed. They are recorded here rather than repaired inside a side-features slice.

## Evidence

- `tests/unit/aDiamondSeatKeepsItsSideFeatures.test.ts`, 28 assertions, green.
- [The feature charge and side feature audit](../audits/2026-09-12-diamond-phase-7-feature-charges-and-side-features.md) for the live-schema half.

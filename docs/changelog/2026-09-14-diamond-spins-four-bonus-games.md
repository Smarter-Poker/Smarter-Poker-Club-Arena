# Diamond Spins: Four Bonus Games

Players can choose a 25–2,500-diamond entry, add one equal Double Down before play, and keep that selection through Buy More or a reload. Plinko accepts the complete chosen batch once: a 100-diamond entry supports 100×1, 20×5, 10×10, 4×25, 2×50 or 1×100. One batch counts as one entry in player limits and host reports.

Donkey Crossing and Mines join Plinko and Crash. All four scenes render actual Three.js geometry inside the existing painted Club Arena consoles. Crossing reveals the sealed final street and the highest chip prize possible within the accepted round limit. Crash reveals the eventual crash point and its highest possible book. Mines reveals every original mine after settlement. All settled proofs check the chip amount as well as the revealed outcome.

## Money And Outcomes

The internal target is 80% expected return, charged once per entry/stopping strategy. No return percentage is presented in player or operator UI. Mines uses the inverse probability of surviving the chosen number of tiles. Crossing and Crash use the same 48-bit survival boundary. Plinko keeps its audited full tables; a board is refused if its maximum batch prize cannot be covered. Independent sealed rounding preserves fractional-cent expected value for small entries.

Player diamond entries go to the current host owner's diamond wallet. Chip prizes debit the **BBJ-funded Promo Wallet first**, then the **Union Main Bank** for a shortfall, or the **Club Main Bank** for a standalone club. No minting or change to that existing payout order is introduced. Accepted liabilities are reserved across all four games, and the actual wallet rows reject withdrawals that would consume those reservations.

The owner agreement is an immutable, versioned receipt. Only the current wallet owner can accept; an administrator cannot sign for the owner. A new owner must accept again. New game doors begin closed, and all four bonus game admissions require the owner's agreement. The agreement also states the owner's diamond obligations for future item/VIP wheel rewards. Installation does not create owner consent or award items.

## Recovery And Entry

The server saves one result per commitment and validates the full original request on retry. Clients retain an unanswered request before calling the money endpoint and clear it only after validating a complete receipt or an explicit transactional refusal. Boards and road outcomes are private until settlement. The player, club, game, seed, entry, Double Down, denomination, and round settings remain bound to the request.

The first footer cell is Diamond Spins and links to the wheel. The other five painted cells are unchanged. The lobby bust invitation requires confirmed zero member chips, at least 25 diamonds, and no occupied seat, including an all-in seat. Account changes and failed reads clear eligibility. Daily activity and referral links are available from the invitation and all four games.

The earning guide reads the existing catalog and current allowance (110 regular / 150 VIP daily activity diamonds). Qualified 500-diamond referrals have a separate uncapped daily ledger; other referral awards retain their existing caps. Qualification and the existing monthly referral limit remain with the referral service.

## Verification Before Release

- Fresh local PostgreSQL installation of both migrations; sealed boards, request identity, compare-and-swap moves, exactly-once settlement, reserve release, both game reports, and earning cap checks.
- Actual two-connection wallet contention: the second game waited for the wallet row and could not reserve cover already promised to the first game.
- Browser playthroughs of all six Plinko allocations, 25+25 Double Down, lost-response/reload recovery without a second charge, Crash cashout, and both new games' final reveals.
- 5,000 single-diamond Plinko drops settled atomically in the maximum Double Down entry.
- 393px, 820px, and 1440px renders of all four games, footer, earning guide, bust prompt, and owner terms, with no horizontal overflow or page errors.
- Browser proof checks backed by saved local PostgreSQL vectors, plus negative tests for altered receipts, leaked boards, and rewritten chip prizes.
- Full local suite: 1,518 files / 20,734 tests passed, one existing test skipped. An initial uncapped run hit seven process timeouts; those 85 affected checks passed at bounded concurrency and the full bounded run then passed. TypeScript and the optimized application build passed.
- Live self-aborting PostgreSQL proof completed all four games at a standalone club and a union-affiliated club. Both diamond transfer legs, exact retry identity, sealed reveals, daily spending, chip journal sums, and the Union receipt issuer reconciled. All probe transfers, config edits, agreement receipts, game entries, invoice messages and notifications rolled back.
- Live shortfall proof verified Promo Wallet first, the appropriate Main Bank for only the deficit, the two balanced journal legs, and atomic refusal when their combined cover is insufficient. Both host types passed.

The live proof exposed and repaired two inherited integration boundaries: the profile guard now recognizes the private shared bonus transfer, and game accounting receipts resolve the Union behind a physical wallet account. New prizes also carry their own ledger categories. Each forward migration pins its live predecessor; applied migrations are unchanged. All changes are installed; the new game doors remain closed and no real owner agreement was created.

Protected CI, publisher completion, and public-route verification must be recorded separately. Database and local evidence are not a frontend release claim.

The first protected CI run exposed two migration-checker errors: session-local `pg_temp` patch helpers were treated as persistent objects, and the checker ignored a later retirement migration already on main. The checker now excludes only explicit temporary-schema objects and follows later drops, recreations and column renames in migration order. The live catalog confirmed the old free-spin functions were retired and `welcome_spin_enabled` replaced `free_spin_enabled`; no missing object was added to the manifest to silence the check. All 26 branch migrations pass, with 79 parser, command-line and manifest regression checks covering the failure and negative controls.

## Next Wheel Phase

The user reserved the final wheel design and reward instructions for the next phase. This change does not invent its segment weights, item costs, VIP eligibility grants, or prepaid wheel-to-bonus ticket contract. The existing wheel remains while those instructions are pending; the 25–2,500 entry control in this change belongs to the four bonus games. A prepaid wheel ticket must replace that game's base debit, never charge the same base twice.

Research: [InOut Chicken Road Two](https://inout.games/en/game/chicken-road-two), [Stake Mines](https://stake.com/casino/games/mines), [Stake verification implementation](https://stake.com/provably-fair/implementation), and [game event mappings](https://stake.com/provably-fair/game-events). These informed game mechanics and verification only; the assets and payout model are original to this implementation.

The footer asset was edited with ImageGen from the approved footer reference, replacing only the Settings cell with a faceted icy-blue diamond, metallic orbit ring and Diamond Spins label. The application clips that new artwork to the first cell and retains the other five cells from the original master. Asset: `public/images/club-footer/diamond-spins-footer-art.png`.

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
- Full local suite: 20,577 passed, one outdated recovery fixture failed, one unrelated existing test skipped. The fixture was corrected to use a complete PostgreSQL receipt; its focused rerun and the affected report tests passed (56 tests). TypeScript and the optimized application build passed.

Production installation, protected CI, publisher completion, and public-route verification must be recorded separately. Local evidence is not a production release claim.

## Next Wheel Phase

The user reserved the final wheel design and reward instructions for the next phase. This change does not invent its segment weights, item costs, VIP eligibility grants, or prepaid wheel-to-bonus ticket contract. The existing wheel remains while those instructions are pending; the 25–2,500 entry control in this change belongs to the four bonus games. A prepaid wheel ticket must replace that game's base debit, never charge the same base twice.

Research: [InOut Chicken Road Two](https://inout.games/en/game/chicken-road-two), [Stake Mines](https://stake.com/casino/games/mines), [Stake verification implementation](https://stake.com/provably-fair/implementation), and [game event mappings](https://stake.com/provably-fair/game-events). These informed game mechanics and verification only; the assets and payout model are original to this implementation.

The footer asset was edited with ImageGen from the approved footer reference, replacing only the Settings cell with a faceted icy-blue diamond, metallic orbit ring and Diamond Spins label. The application clips that new artwork to the first cell and retains the other five cells from the original master. Asset: `public/images/club-footer/diamond-spins-footer-art.png`.

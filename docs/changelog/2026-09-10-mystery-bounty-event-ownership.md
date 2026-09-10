# Mystery Bounty Event Ownership

Phase 3 B06 scoped correction, September 10, 2026, based on 09c01fba4.

The mystery lobby reused one in-flight flag and recursive load closure across
tournament changes. A slow event A response could populate event B, prevent B
from starting, and consume B's refresh by requesting A again. Disabling the
feature also allowed the pending response to restore old awards. Timers and
retained shared-channel callbacks could restart the old request.

The hook now owns transport state, debounce and channel callbacks within each
event effect. Cleanup invalidates responses and callbacks, clears the timer
and releases exactly its own channel reference. Switching events immediately
loads the new event and clears the outgoing totals. Broadcasts still trigger
authoritative reads only; they do not add winnings or draw/pay any chest.
The channel creator also refreshes after subscription to close its initial
snapshot/subscription gap.

Callers: TournamentPage and tournament/TournamentDetails both invoke this
same hook; their existing panel/result props receive the corrected data.

Verification: original code failed four of six new actual-hook lifecycle
cases. After correction, all 58 tests passed across the six lifecycle cases,
mysteryBountyLobby, MysteryBountyPanel and TournamentRankingCardMysteryBounty.
The full build passed TypeScript, Vite and media optimization, then the
provenance gate refused a base four commits behind origin/main. Integration
must rerun the final build on the refreshed release base. No bypass was used.

The comparator is PokerStars' Mystery Bounty help page, retrieved September
10, 2026: https://www.pokerstars.com/help/articles/mystery-bounty/ . It describes
public tracking of remaining prizes and equal splits for chopped pots.
Smarter's approved rebuy/add-on activation condition remains unchanged.

B06 is not fully closed: this fixes client event ownership and repeat-refresh
presentation, not installed reserve/reveal/pay transactions or deployed
gameplay. B01/B03/B05 actual funded bounty settlement acceptance remains open.
Separate B02 discovery: aggregated hand-history winners discard later pot
identities for a player winning more than one pot. Its correction follows in
a separate commit. The high/low recipient policy differs from PokerStars
section 9.2; changing that local policy is not part of this correction.

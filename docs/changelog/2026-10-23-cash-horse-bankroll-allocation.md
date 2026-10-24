# Cash horse allocation and closed lobby counts

The owner superseded the profit, fixed-variant/stake and activity eligibility rules for the fifty cash horses: their bankroll decides what they can play. Cash-roster membership continues to bound the ordinary pool to fifty. Independent pilot fill assignments and normal player admission, wallet ownership, aggregate exposure and four-game limits remain intact.

HorseFleetManager now offers funded roster horses every affordable cash variant/stake throughout the day, targets full Holdem/PLO tables and fills existing games before scattering into more sparse games. HorseSitVerdict and StableHand use the same bankroll-only verdict; the floor executor no longer withdraws these horses for its activity curve. Waiting players still receive a seat yield. The session rotator retains hand-boundary departures and bankroll session decisions, without a sleep-window departure multiplier for the cash roster.

The database refresh keeps the existing fifty first, ranks replacements by bankroll rather than past profit, gives all fifty PLO eligibility, and removes variant/stake persona tags. The seat trigger removes the PLO profit test while preserving the cash-pool boundary and separate pilot-fill scope. Activity history and play counters are retained.

The screenshot's Closed games have disabled admission and real occupied seats. They now say Join Closed while retaining their real counts and disabled join action. Separately, historical truly closed empty cash tables had stale saved counts. Closure now writes zero in its original transaction only after the existing occupied-seat refusal succeeds; the migration corrects only closed tables with no live seats. No seat, stack or wallet is cleared.

Validation: the eligibility regression failed before the change; focused engine checks passed129 tests, lobby checks passed75 tests, and both compilers passed before final integration. The exact three database function postimages passed the existing native PostgreSQL fixture runner, including a loss-history PLO horse, cash-pool refusal, stale empty count correction and occupied-table closure refusal. The retained fixture runs in the required accounting CI shard. Final hook/provider outcomes and installation/live evidence belong in the task checkpoint; these local results are not production delivery.

Engine activation follows the existing daily04:00America/Chicago rule. Database and client delivery proceed independently through their applicable safeguards. No off-cycle restart or new scheduled repair was introduced.

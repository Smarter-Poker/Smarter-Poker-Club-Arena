# Player Stats recorded opportunity rates

Burls' club comparison printed 0.0% 3-bet even though persisted facts contained accepted re-raises. The club overview predates nullable opportunity facts and still returned a literal zero. The comparison, profile, advanced cards and alerts did not consistently honor measurement availability.

The migration patches the installed readers in place, preserving their funded-club source, authorization, ACLs, calendar bounds and query configuration. Club 3-bet and flop C-bet use matching recorded action/opportunity populations. Position rows carry 3-bet opportunities. All Clubs now derives these advanced rates, fold-to-3-bet, showdown counts and WTSD from the complete selected fact window rather than inheriting a latest-750 legacy sample. WTSD divides showdowns by flops seen. Tournament-with-hands counts cover the full window; recent finishes use the consumer's finish_rank field and bounty counts reach the tournament aggregate.

Comparison/coaching and alerts omit unmeasured 3-bet values. Profile and advanced cards retain unavailable state. CSV availability applies to All Clubs as well as selected clubs. Tournament-only play does not fabricate a cash BB/100 comparison.

The existing fact passive_actions counter includes checks and calls. It cannot establish the call-only Aggression Factor denominator. This patch explicitly stops certifying that ratio as measured; capturing exact calls and qualifying historical coverage remain an acceptance gap, not a completed repair. Legacy summed hand duration is likewise not certified as elapsed play time.

Validation: local PostgreSQL executes the actual funded-club predecessor before the candidate, reproduces zero despite a known re-raise, then verifies measured rates, cash/tournament participation, nullable historic opportunities, full-window showdown rates, tournament result fields and unchanged self-only access. The existing required Data Console PostgreSQL suite invokes this harness. Render tests cover unavailable/recorded comparison values, tournament-only cash suppression and advanced-card unavailable states. Delivery and live evidence are recorded in CHECKPOINT-burls-stats.md.

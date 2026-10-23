# Durable Hold'em and PLO opponent memory

Hold'em and PLO4/5/6/8 horses retain distinct opponent reads for each variant,
cash/tournament context and dealt table size. The new private
`horse_exploit_profiles` store survives sessions, worker restarts and engine
restarts. A RAM cache eviction cannot delete a persisted profile.

Learning belongs to accepted hand-history insertion. The AFTER INSERT trigger
updates decayed counters in the same transaction as the accepted hand; an
idempotent duplicate insert cannot increment them twice, and a rolled-back
hand cannot leave learning behind. Rows are locked in sorted player order.
No cards, outcomes, balances or player settings enter the model.

Legacy profiles initialize once from that player's own retained hands, with
no 72-hour expiry or shared 12,000-hand floor limit. Initialization scans at
most the latest 1,024 legacy hands per player/game/context, ordered by the
stored creation time and UUID. This is a bounded reconstruction, not an exact
full-lifetime sequence: the remaining long-window weight is below 2^-34.
Lifetime basic statistics remain in their existing durable stores. Every new
accepted hand updates the persistent decayed profile without that truncation.
The migration marks new hands independently of wall-clock transaction starts,
so an initializer can separate historical data from concurrent accepted hands.
It scans without holding a live profile row lock, then atomically discounts
and combines historical mass with the new accepted-hand count.

The main client fetches a bounded profile receipt before enqueueing compute,
coalesced once per table hand. It never waits on network IO inside the shared
worker FIFO. The worker imports monotonically versioned snapshots, ignoring
stale or duplicate delivery, and preserves the exact game/context read in the
portable second-look frame. A failed read is reported; no completed
restoration or opponent tendency is invented.

The preserved exploit strategy still requires evidence for each adjustment.
A loose opener, a frequent re-raiser, a calling station and a postflop
aggressor need different responses. PLO's existing nut-potential, redraw,
blocker, equity and multiway checks remain authoritative. No player-specific
name or ID is embedded in the policy, and no winning result is guaranteed.

Read-only investigation captured 396 public-action hands of the reported
player. The strongest sustained read was in PLO5. The smaller PLO4 sample and
recent Hold'em raising did not consistently clear the existing aggressive-read
thresholds. The regression fixture remaps every identity and contains only
public action categories, game and dealt count; it contains no holdings or
financial outcomes.

Validation and delivery status are recorded in
`CHECKPOINT-horse-opponent-memory.md`. PostgreSQL qualification is wired into
existing accounting shard 2; the required Server Engine join retains both its
unit and database prerequisites. Protected pack selections remain unchanged;
this change does not promote an unqualified strength pack.

The hand_history column and triggers require a hot-table DDL lock. The migration
is declared for the existing daily-maintenance installer; it is never applied
manually during play. Engine and schema activation remain pending until that
qualified 04:00 Chicago transaction has installed and verified both.

The accepted hand carries the authoritative dealt-card-map count separately
from the access-control roster. A chair included only for historical access
cannot move a short-handed read into the full-ring bucket. Legacy rows whose
authoritative count is unavailable retain their explicit roster inference.

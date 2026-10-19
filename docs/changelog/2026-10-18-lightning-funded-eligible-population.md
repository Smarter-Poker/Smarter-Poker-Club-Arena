# Lightning population counts funded, live anchors

The Phase 4 rule excludes busted players from the population that can be dealt
right now. Its seated half obeyed that rule, but the pool half counted an
active session after its anchor busted. The private Action pilot therefore
reported 38 eligible sessions while 29 anchors were zero and only nine players
could receive hands. This hid the normal OFF threshold and limited actual
latency sample throughput.

Both the scalar and the dashboard breakdown now ask the existing authoritative
anchor-eligibility predicate for each pool member. The overlap and idle counts
use the same rule. The in-hand breakdown also requires a live instance;
abandoned historical hand rows no longer appear as players still playing.
The board count still includes seated busted players. Thresholds remain 18/12
for six seats, money and pool state are unchanged, and every actor receives
the same treatment. The existing hand-safe transition owns any normal fallback.

The required native accounting chain settles real isolated all-in hands that
bust five players, including horses and humans, reproduces the old inflated
count, and verifies 13 playable versus 18 seated after installation. It verifies
abandoned/live hand distinctions, disconnect arithmetic and the unchanged
hysteresis, including the OFF verdict after two further players bust. Exact
production preimage/postimage hashes and security metadata are pinned.

This is a database reader repair. It creates no funding, rebuy, roster change,
threshold override, scheduler, mode write or public rollout. Installation and
live readback remain separate evidence.

# Every paid jackpot retains its reporting owner

The shared Main/Mini credit already publishes the private member/roster change
for every successful loser, winner and table-share recipient. The follow-up
captures the actual receiving seat/wallet club and game variant inside that same
transaction, so later seat removal, membership changes or hand retention cannot
lose the paid award's reporting owner. Duplicate/rolled-back/parked credits do
not leave a paid reporting receipt or signal.

The reader now resolves historical departed-player awards from their exact
posted wallet-credit idempotency key. It snapshots proven existing ownership
once at installation. Explicit seeded hand history is display-only and never
counts as money. This does not change existing chips, payouts, or hand facts.

The full production census before this change had 1,170 recipient rows: 922
resolved from hand/outcome/funding/rake evidence, 24 more resolved by the exact
posted wallet credit, and 25 belonged to explicit seeded display hands. The
remaining 199 older rows (July through September) lack sufficient original
funded-club evidence in these sources. They remain explicit unavailable evidence;
this migration does not guess a current home club or call them zero. Thus new
payout durability and the recovered records are verified separately from the
unresolved historical ownership cohort. No claim of complete historical coverage.

Native PostgreSQL regression exercises distinct recipients across both kinds,
all three share roles, seat and wallet destinations, original wallet evidence,
seed exclusion, retention/membership changes, duplicate/rollback and six private
signals. Existing before/after card, roster, detail, stats and Chicago period
proof remains enforced by the same required accounting workflow.

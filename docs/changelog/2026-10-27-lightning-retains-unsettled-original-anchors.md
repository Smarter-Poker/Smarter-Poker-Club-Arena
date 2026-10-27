# Lightning departure retains every original unsettled anchor

Stop Playing and the disconnect/responsible-gaming reaper used a committed
reservation as their hand-ownership test. Normal and fast folds release that
reservation before the hand settles. Closing the pool session then released the
physical anchor's departure guard, so the eventual settlement correctly refused
its missing anchor and froze the cluster.

Both departure doors now use the existing live-hand reader, including released
folders, and retain pending-reservation and frozen-cluster protections. Original
settlement and anchor money guards are unchanged. The body-only migration takes
no lock on a hot table and does not move money or recover an incident.

The native PostgreSQL regression executes seven hash-checked original functions,
reproduces both premature exits before the patch, and proves normal/fast folders
retain their anchors until completion or abandonment. It also checks pending and
committed reservations, disconnects, responsible gaming, frozen evidence, terminal
exit idempotency and the existing anchor stack/deletion guards. Configuration and
RG eligibility are fixture boundaries; terminal states are supplied directly.
The existing Lightning native workflow runs this regression for relevant changes.

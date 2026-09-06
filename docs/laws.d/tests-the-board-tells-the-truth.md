# tests/the-board-tells-the-truth.law.test.ts

The conservation delta reads a tournament's guarantee overlay out of the
journal and takes the GREATEST of the journal leg and the legacy side table,
never their sum. The rake door resolves a hand from hand_history before giving
up on its id, refuses a second unlinked row for the same table and hand number,
and derives its leg key from (table_id, hand_number) instead of a random uuid -
a random key can never collide, so it can never dedupe, and that is what
double-counted 16,426.46 of rake. The frozen pool baseline may move only
alongside a recorded reason in ca_frozen_pool_baseline_changes.

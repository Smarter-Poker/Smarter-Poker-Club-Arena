# tests/a-stats-bypass-names-its-writer.law.test.ts

Four AFTER INSERT triggers on hand_history decline to write when
`app.atomic_hand_commit` is on, by design (20260908042100, after five
synchronous triggers cancelled 726 hand inserts in five minutes). This law
keeps the bypass tied to its compensating writer: the GUC is declared in this
repo and not only in production; any migration that turns the bypass on also
writes ca_hand_player_stat or enqueues the hand_projection_outbox claim a
writer drains; the chain from fn_project_hand_side_effects reaches that insert,
the player index and the DELETE of its own claim; the engine really calls it
from services/supabase/handProjection.ts and holds EXECUTE on it, so
"this function has no callers" cannot be concluded again; and the bypass branch
says so out loud at a bounded rate while the trigger still cannot block a hand.

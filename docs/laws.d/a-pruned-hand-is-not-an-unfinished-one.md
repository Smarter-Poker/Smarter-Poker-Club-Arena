# tests/a-pruned-hand-is-not-an-unfinished-one.law.test.ts

The table-admission door (fn_ca_resume_hand_submission) never holds a table on a retained submission whose commit coordinate is empty while a later commit exists on the same table (retention took it, or the door could never continue it), and sp_prune_hand_history keeps the last commit of every live table so that proof survives; a different commit at the coordinate, pending post-commit work, a 'reserved' permit and an empty coordinate with no later commit are still selected exactly as before (20260927145821).

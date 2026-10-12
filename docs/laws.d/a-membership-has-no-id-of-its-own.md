# tests/a-membership-has-no-id-of-its-own.law.test.ts

club_members is keyed by (club_id, user_id) and has no `id` column. Building
account closure on 2026-09-29 - which applies the staff departure rules to
every club - found fn_remove_settled_club_member reading `v_target.id` and
`cm.id` in its downline check, its audit row and its departure UPDATE.
PL/pgSQL does not check a record's fields until the line runs, so the function
was created cleanly and failed at run time with 42703 for every settled member
club staff tried to remove; no staff removal had ever succeeded. This law holds
the definition in force of every function in the corpus to naming a membership
by its club and its player: a `club_members%ROWTYPE` variable is never read as
`.id`, a `cm` alias for club_members never as `cm.id`, and the removal itself
finds, audits and departs the membership by (club_id, user_id).

# An agent's book is not public reading

2026-09-02. The last item phase 7 left open, closed.

## The hole

`fn_agent_unsettled_commission(p_club_id, p_user_id)` was `SECURITY DEFINER`,
granted `EXECUTE` to `authenticated`, and carried **no authorization check at
all**. Any logged-in user could pass any other user's id and any club id and be
told exactly what that club still owed that person.

RLS on `agent_commissions` is correct and would have refused the same read — an
agent reads their own rows, a union overseer reads the clubs they oversee. The
definer function walked straight past it.

Phase 7 recorded this as open rather than fixing it, because the obvious fix
(restrict to `auth.uid()`) breaks `fn_club_set_member_role`: the role-change
path calls this function to report what the club owes the person whose role is
changing, and that person is by definition not the caller.

## The fix is the split, not the restriction

Two different reads were wearing one function:

1. **The caller's own read.** `CommissionService.unsettledCommission` passes
   `user.id`, always. It is the only client caller in the repo.
2. **The officer's read**, inside `fn_club_set_member_role` — itself
   `SECURITY DEFINER`, and it has _already_ authorized its actor through
   `fn_club_grantable_roles` before it gets there.

So the role-change path reads the sum inline, and the RPC gets the guard it
should always have had. The report cannot regress on the guard, because it no
longer depends on it. Same `SELECT`, same partial index
(`agent_commissions_unsettled_idx`).

`fn_agent_may_read_commission(p_club_id, p_user_id)` is the predicate, split
out on its own so the client can ask "may I" without provoking an error, and so
the next commission surface reuses it instead of inventing a fifth definition
of who may look. It admits four kinds of caller:

- **yourself**, in any club;
- **a club officer** — admin, co-owner or owner (`fn_role_rank` ≥ 5). The person
  who can change your role can see what you are owed;
- **your upline**, at any depth (`fn_is_agent_ancestor`) — the same relationship
  `fn_agent_downline_commission` already reports on, so it grants nothing new;
- **the service role**.

Everyone else gets `42501`. **Not a zero.** A zero is indistinguishable from
"owes nothing", and a caller who is not entitled to the figure is not entitled
to know which of the two it is. A null argument gets `22023` rather than being
treated as a wildcard.

## Verified against production, in transactions that were rolled back

| Caller                                    | Result                           |
| ----------------------------------------- | -------------------------------- |
| service role                              | 434.95                           |
| the agent, reading their own book         | 434.95                           |
| the club owner, reading that agent's book | 434.95                           |
| an unrelated logged-in user               | refused 42501                    |
| logged out                                | refused 42501                    |
| null club id                              | refused 22023                    |
| role change, ledger holding 123.45        | report says 123.45, success true |

Then applied, and re-verified live: predicate exists, RPC guarded,
`fn_club_set_member_role` no longer names the RPC anywhere, `anon` cannot
execute, `authenticated` can, migration recorded.

## Two things the rehearsal caught before production did

1. **`pg_get_function_identity_arguments` strips DEFAULTs.**
   `fn_club_set_member_role` has four, so `CREATE OR REPLACE` fed the identity
   form dies with `42P13`, _cannot remove parameter defaults from existing
   function_. `pg_get_function_arguments` is the correct one. This would have
   been a failed apply against production.
2. **The comment I inserted named the RPC**, and the migration's own assertion
   proves the call is gone by searching the source for that name — so a comment
   mentioning it is indistinguishable from a call. Phase 7 hit this exact trap
   patching this exact function; it is now written down inside the patch.

Both are pinned by the law, so the next agent editing this migration cannot
reintroduce either.

## Two improvements to the page while it was open

Both are the same defect the phase 7 audit exists to remove — a failed read
rendering as a number — found by reading the component line by line.

1. **The Summary tab went blank on a failed read.** The panel is gated on
   `summary &&`, which is right: four zero cards are indistinguishable from
   "you earned nothing". But the gate rendered _nothing at all_ — a blank tab,
   no explanation, no way back. It now says the summary could not be loaded and
   offers Try Again. (`setOwed(null)` on a failed unclaimed read was already
   correct and is pinned now too.)

2. **A failed downline read showed every sub-agent as owed 0.** The `catch`
   around `CommissionService.downlineCommission` left `downlineOwed` empty, and
   `downlineOwed[a.id] || 0` then rendered `0` on every sub-agent card — "the
   club owes this downline nothing", which an upline cannot tell from the
   truth, and which they would act on. `totalCommission` is `number | null`
   now: `null` means the read failed and renders **Unavailable**, `0` still
   means owes nothing. `|| 0` is pinned out, because it collapses the two back
   together.

## Then I swept for the shape of it, and found two more

A SECURITY DEFINER function in the agent / commission / credit family, granted
`EXECUTE` to `authenticated`, taking somebody else's id, never consulting
`auth.uid()` or any role helper. Two more had exactly that shape
(`20260902013900_two_more_definers_that_answered_anybody.sql`):

1. **`sum_agent_volume(p_club_id, p_agent_id, p_start)`** sums `ABS(amount)`
   from `action_audit_logs` for one member. Any logged-in user could ask it
   about any other member in any club. **Zero** callers in the database, and
   exactly one in either repo: `pages/api/club-arena/agent-analytics.js`,
   through `getSupabase()` — the service role.
2. **`fn_club_rakeback_margin_violations(p_club_id)`** returns every
   manager-to-manager and manager-to-player edge under a ten-point margin, and
   every player under the ten percent floor — which means it returns **the
   club's entire rate card**: each agent's user id, role and `commission_rate`,
   and each player's user id and `rakeback_rate`. Any logged-in user with a
   club id could read a competitor club's commercial terms. **Zero** callers
   anywhere; only the CI schema manifest names it.

Neither got a guard, because neither has a caller that needs one. They lost
`EXECUTE` for `authenticated` and kept it for `service_role`, which is smaller,
cannot be got wrong, and — since `GRANT`/`REVOKE` is not in `pgrst_ddl_watch`'s
list — fires no schema-cache reload at all.

### Five more assessed and deliberately left

`fn_ensure_club_wallet` (misnamed: it is a read-only membership `EXISTS`),
`fn_is_agent_ancestor`, `fn_is_agent_of_player`, `fn_player_rakeback_rate` and
`fn_resolve_player_club_for_agent` match the same grep but are a different
thing: boolean or scalar predicates, two of them called by the guards
themselves, all on the live seating and rakeback paths. They disclose a
relationship or a rate the parties already know, not a book. Changing their
grants without tracing every engine caller risks breaking seating — a worse
outcome than the mild disclosure — so they are recorded here rather than
touched.

## Law

`tests/an-agents-book-is-not-public-reading.law.test.ts`, registered in
`docs/LAWS.md`. Twenty-four pins across seven groups: the read is guarded and
refuses rather than zeroing; one definition of who may look, admitting exactly
four kinds of caller; the role-change report is patched rather than re-emitted,
keeps its parameter defaults, reads the ledger inline, and its comment does not
name the RPC; grants are written down and `anon` is revoked; the client only
ever asks about itself and surfaces a refusal rather than reading it as zero.

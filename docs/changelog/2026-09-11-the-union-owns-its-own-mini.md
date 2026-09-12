# The union owns its own mini

2026-09-11. Branch `fix/bbj-the-rules-page-and-the-engine-agree`. The largest
gap the post-programme sweep found.

Phase 3 gave the mini jackpot two controls and a runway: a switch, a per-pool
reserve floor, and a measurement of whether that reserve is draining. All three
are keyed on a CLUB, and all three refuse a club that belongs to a union:

```
{"ok": false, "reason": "union_club_follows_the_union"}
```

That refusal is right. One member club must not flip a switch that decides what
every table under the union pays, out of a reserve every member club draws on.

**The union was then given nothing to follow that sentence to.**

```
SELECT count(*) FROM pg_proc WHERE proname LIKE 'fn_bbj_set_union%';  -->  0
```

And the larger pool on this platform is a union pool. Measured today:

| pool               | kind      | main      | backup        | floor    | mini |
| ------------------ | --------- | --------- | ------------- | -------- | ---- |
| Midway Union       | **union** | 52,369.37 | **43,893.73** | 5,000.00 | on   |
| Deep Stack Society | club      | 19,418.68 | 13,556.93     | 5,000.00 | on   |

So for the pool that holds more than three quarters of the platform's mini
reserve, nobody could turn the mini off, nobody could raise or lower its floor,
and phase 3's entire control surface was unreachable. A club operator got a
switch and an input. The union operator got a sentence and a dead end.

---

## What was added

`fn_bbj_set_union_mini_enabled(union, enabled)` and
`fn_bbj_set_union_mini_floor(union, floor)` — migration `20260911214403`. The
same two controls, keyed on the union and authorized against it. Everything
else is deliberately phase 3's:

- **`fn_is_union_operator` is the authority** — the union's owner, or a row in
  `union_admins`. Not the broader `fn_is_union_overseer`, which also admits
  club-member admins of a union-shaped club: a control that changes what every
  table under a union pays should answer to the union's own people.
- **Name the actor, authorize, then explain.** `pool_not_found` arrives only
  after the caller has proved they operate this union, so a refusal tells a
  stranger nothing they could not already see.
- **The function reads `auth.uid()` itself.** Derived one call down it would
  answer a `service_role` caller — which has no `auth.uid()` — with the
  misleading `not_a_union_operator`.
- **The floor's lower bound is derived, not chosen:** one payout at the largest
  ENABLED tier (1,500 today). A reserve may be small, but not so small that the
  felt shows an amount the payout RPC must refuse.
- **Pre-login roles revoked**, `PUBLIC` named as well as `anon`, and the
  migration asserts the revoke landed rather than assuming it.

### One thing that is not a copy of phase 3

`uq_bbj_pools_union_active` is UNIQUE on `(union_id)` **only** `WHERE club_id
IS NULL AND status = 'active'`. A bare `WHERE union_id = p_union_id` is not
unique here — a member club's vestigial row can carry a union_id, and retired
rows keep theirs — and plpgsql's `SELECT INTO` does **not** raise on multiple
rows, it silently takes one. That would be a control writing to an arbitrary
pool. Both functions resolve on the full unique predicate.

## Proved before it was believed

One MCP call, one self-aborting `DO` block, rolled back (CLAUDE.md 11.5 — the
error is the success case):

```
AS SERVICE ROLE   -> not_signed_in           (both functions, every argument)
AS THE UNION OWNER
    floor 1       -> floor_below_one_payout, minimum 1500.00
    floor 9000    -> ok
    switch off    -> ok
    wrong union   -> union_not_found
AS A SIGNED-IN STRANGER
    switch        -> not_a_union_operator
```

Live state before and after: floor 5,000.00, mini on. Nothing moved.

## The surface

The union dashboard, beside **Fund BBJ Pool**, because it is the same money —
the mini is paid out of `backup_balance`, and that tile already says so. The
switch and the floor input sit behind the page's own permission gate (a viewer
who is not the union's owner or an appointed admin never loads this page at
all), and the two RPCs check `fn_is_union_operator` again regardless of what
the browser believes.

The button shows what the **database** says after the write, never what was
clicked: an optimistic flip the server then refused would leave an operator
believing they had switched off a jackpot that kept paying. Every reason either
function can return has a sentence — `floor_below_one_payout` carries the
actual minimum, because a refusal an operator cannot act on is not an answer.

## Pinned

`tests/the-mini-reserve-has-a-runway.law.test.ts` — both controls exist and are
keyed on the union; `fn_is_union_operator` is the authority and neither
`fn_is_union_overseer` nor the club predicate appears; each function names its
own actor and authorizes before it explains; the pool is resolved on the
predicate that is actually unique; the floor bound is derived and its refusal
carries the number; no pre-login role holds EXECUTE; the migration creates the
controls and writes no pool row of its own; and the surface has words for every
refusal reason.

The law reads the migration with **comments stripped**, because the file
explains in prose which predicate it deliberately did not use — asserting on
raw text would make that explanation illegal and teach the next author to
delete the reasoning to get the law green.

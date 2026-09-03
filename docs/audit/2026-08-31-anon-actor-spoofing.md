# 2026-08-31 — An Unauthenticated Caller Could Set Any Club Role

## The vulnerability

`fn_club_set_member_role` decided who was acting with one line:

```sql
v_actor := COALESCE(auth.uid(), p_actor_user_id);
```

`auth.uid()` is NULL for `anon` **by definition**. So for an unauthenticated
caller that COALESCE fell through to `p_actor_user_id` — a value the **caller**
supplies. Everything downstream then authorised against the spoofed identity:
`fn_club_grantable_roles(p_club_id, v_actor, p_user_id)` decided which roles
could be granted, and the `audit_trail` row named the spoofed actor as the
person who did it.

The function held EXECUTE for **PUBLIC and anon** — `pg_proc.proacl` read
`=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres`
— and is reachable over PostgREST at `/rest/v1/rpc/fn_club_set_member_role`.

**Impact:** anyone holding only the publishable anon key could pass a club
owner's uuid as `p_actor_user_id` and set any member's role in that club,
including granting `co_owner` or `admin`. Club uuids and user uuids are not
secrets; they travel in ordinary listing payloads.

**Not proven by exploiting it.** CLAUDE.md 11.5 forbids probing a live
privilege path against production, so this was established by reading the
definition, the ACL and the grant history — never by calling it.

## How it got there

`20260822_club_roles_rpcs.sql:105` grants `TO authenticated, anon` on a
**three-argument** version of the function. The live function has six arguments
and the COALESCE. The anon grant outlived the shape it was written for.

## Why the existing gate missed it

`scripts/ci/check-definer-authorization.mjs` exists for exactly this class and
had one line at its centre:

```js
if (/auth\.(?:uid|role|jwt)\s*\(/i.test(fn.body)) continue;
```

Mention `auth.uid()` anywhere and you were cleared. This function mentions it —
inside the spoofable COALESCE. Meanwhile the guidance the same script _prints_
already said **"Never from a parameter: a caller-supplied ..."**. It did not
enforce its own sentence.

## The fix, in two independent layers

1. **The function no longer takes its actor from a parameter** unless the caller
   is a trusted backend, using the house idiom
   `COALESCE(auth.role(),'service_role') = 'service_role'` — true only when
   there is no JWT at all or the JWT is literally service_role. For anon over
   PostgREST `auth.role()` is `'anon'`, so it is false.
2. **PUBLIC and anon lose EXECUTE.** PUBLIC had to go too: revoking `anon`
   alone would have left identical access standing through the `=X/postgres`
   grant.

The parameter is **kept, not dropped**. Dropping it changes the signature, and
PostgREST resolves overloads by argument names, so an old-shaped call would get
a confusing 404 instead of a clear refusal. It now means "a trusted backend is
naming the actor" rather than "anyone may claim to be anyone".

No caller is affected: the only one in the codebase is
`src/pages/MemberManagementPage.tsx:746`, which passes `p_club_id`, `p_user_id`
and `p_role` only and already relies on `auth.uid()`.

## Verified against production

|                                  | before   | after     |
| -------------------------------- | -------- | --------- |
| `anon` EXECUTE                   | **true** | **false** |
| `authenticated` EXECUTE          | true     | true      |
| ACL PUBLIC grant (`=X/postgres`) | present  | **gone**  |
| spoofable COALESCE in body       | present  | **gone**  |

The migration carries `DO $$ ... RAISE EXCEPTION $$` assertions for all three
conditions, so it cannot silently no-op; it was then re-verified by an
independent query.

## The gate now enforces its own sentence

`spoofableIdentityFallback()` treats `COALESCE(auth.uid(), <non-literal>)` as
_not_ asking who is calling. A **literal** fallback stays allowed —
`COALESCE(auth.role(),'service_role')` is the documented way to recognise a
trusted backend and cannot be steered from a browser.

Pinned by `tests/anon-cannot-name-itself-the-actor.test.ts` (7 tests), which
also feeds the gate the exact vulnerable shape and its repaired twin.

## Scope check: was anything else exposed?

A live sweep found **7** functions using `COALESCE(auth.uid(), ...)`. Only this
one was both anon-executable and took the actor from a parameter:

- three (`fn_audit_club_entry_mutation`, `fn_audit_club_settings_change`,
  `fn_club_members_ledger_writer`) return `trigger` and are not RPC-callable;
- `fn_assign_player_to_agent` is authenticated-only, where `auth.uid()` is
  non-null so the COALESCE never reaches its fallback;
- two horse-treasury functions hold no browser grant at all.

The other two anon-callable RPCs (`fn_cancel_club_join_request`,
`fn_set_player_search_preferences`) were read and are **correct** — both do
`IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'`. That is the
pattern this function should always have used.

## A note on `--all`

`check-definer-authorization.mjs --all` sweeps the whole migration directory and
was **already failing before this change** — 68 offenders on pristine `main`.
Migrations are append-only, and much of this schema was applied through the MCP
rather than from these files, so that mode reports historical text rather than
live exposure. CI and `.husky/pre-push` both run changed-migration mode, which
is where blocking actually prevents the bug, and where the new rule is active.

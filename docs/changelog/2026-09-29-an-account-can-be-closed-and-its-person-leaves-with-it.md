# 2026-09-29 - An account can be closed, and its person leaves with it

Walking the app for store review: Settings, Close Account, Close My Account
answered HTTP 500. So did the World Hub's settings page - both call the World
Hub's `DELETE /api/auth/delete-account` - so nobody could delete an account
from anywhere. App Review 5.1.1(v) and Google Play both require that an
account created in the app can be deleted from the app.

## Why

The endpoint hard-deleted the player's rows with the service role and then
hard-deleted the Auth user. The database had since made that impossible twice:

1. `service_role` holds no write privilege on `cashout_requests` - money moves
   only through the cashier's definer functions - so the endpoint's first
   write, "cancel pending cashouts", failed with 42501 for every account.
2. Financial journals are append-only (`trg_ca_append_only`), and every
   account is born with one: The Mint's signup grant in
   `diamond_transactions`, which references `profiles` and `auth.users` ON
   DELETE CASCADE. Deleting either cascades into the journal and is refused
   (P0403), measured in a rolled-back transaction on the walkthrough account.

## What changed

Migration `20260929051751_an_account_can_be_closed_and_its_person_leaves_with_it`
adds `public.fn_close_account(p_user_id)`, service-role only, and the World Hub
endpoint now calls it and soft-deletes the Auth user
(`auth.admin.deleteUser(id, true)`, World Hub change of the same day).

The function refuses, changing nothing, while the player holds money or
authority - the club's own departure rules (`fn_remove_settled_club_member`)
applied to every club, then `fn_ca_gdpr_financial_precheck` as the last word.
Otherwise, in one transaction, it leaves every club through the lifecycle door
(membership `departed`, `Account Closed`, an `audit_trail` row per club, the
row kept; a Diamond Arena membership keeps its `automatic` status), deletes
friendships, friend requests, sessions, MFA factors, push subscriptions,
notification preferences and non-accounting notifications, scrubs every name,
contact, location, social link, avatar, bio, birthday and preference from the
profile (tombstone username `deleted-<12 hex>`, status `deleted`) and the
legacy `users` mirror, and records the closure in `gdpr_deletion_requests`.
Financial journals, promo redemptions and reward claims are kept, keyed by an
id that no longer points at anyone.

The money guard (`fn_ca_money_rpc_registry_guard`) refused the first draft -
it reads `UPDATE club_members` beside balance column names - so the migration
registers the function as `system` (moves no money) above the CREATE.

## Measured before applying

In transactions rolled back by design, against production, calling the
function the way the World Hub does (role `service_role`, service-role
claims):

- a signed-in player calling it directly: 42501;
- a seated player: `seated`; an agent, a club owner and a union owner:
  `club_chips` (each still held chips); no profile anywhere was scrubbed;
- the walkthrough account, after joining SHARK CLUB through `fn_join_club` as
  itself: closed - the membership departed (`suspended`, inactive, `Account
Closed`, by itself) with one `audit_trail` row, two friendships deleted, the
  profile and `users` mirror scrubbed, `gdpr_deletion_requests` at
  `anonymized` with a summary, its `diamond_transactions` row kept, the club's
  member count back where it was; called again: `already_closed` with the
  same request id;
- the Diamond Arena's one `automatic` membership departs through the same
  UPDATE and passes the arena's guard.

Applied 05:17 UTC; the live body's md5 matches this file's.

`tests/an-account-closes-without-touching-the-books.law.test.ts` holds the
definition in force to it: every settlement check before the first write, no
delete of the rows the journals hang from, no balance or journal write, the
lifecycle door, service-role only, and exactly the refusal reasons the World
Hub answers with an instruction.

## Found on the way, not changed here

- `fn_remove_settled_club_member` (staff removing a settled member) reads
  `club_members.id`, which does not exist - the key is `(club_id, user_id)` -
  so it fails at run time whenever it gets that far; `audit_trail` holds no
  `depart_club_member` row and no membership has ever been `departed`.
- `/api/account/delete-gdpr` and `/api/admin/users/delete-gdpr` on the World
  Hub still hard-delete the Auth user and would hit the same cascade; nothing
  calls them.

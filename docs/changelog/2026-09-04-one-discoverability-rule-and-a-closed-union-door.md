# 2026-09-04 - One discoverability rule for every cashier, and a closed union door

Branch: `fix/cashier-one-discoverability-rule`. Two of Dan's follow-ups.

## 1. The cashier rule now covers both surfaces

The first fix (#2995) corrected the trade page, where `mapCashierRoster`
deleted the viewer's own row before the search saw it. Asked whether that was
the root cause, I checked the second surface and it was not clean:
`WalletCashierModal` did the same thing twice over -

```ts
members.filter(
  (m) =>
    (needsAgent ? canHoldAgentWallet(m.role) : true) && !(excludeSelf && m.user_id === user?.id)
);
```

- the viewer, deleted whenever the destination refuses a self-send;
- **every member whose role cannot hold an agent wallet, deleted** - which is
  literally the case Dan named: "if they don't have a wallet, like (admins),
  you can't send them anything, but all users should still be searchable."

Both are now the same rule, in one place: `cashierRecipientBlock` in
`src/lib/cashierRoster.ts` returns a reason or null, the modal lists everyone
and renders the blocked ones with a "You" / "No Wallet" tag, disabled, sorted
below the sendable ones. The empty state stopped claiming "No Agents In This
Club Yet" when the truth was "your search matched nobody". The modal also
searches `#short_id`, closing the same gap the trade page had.

`fn_club_bank_send` is still exempt from the self-rule, deliberately: an owner
funding their own float out of the treasury is the route the whole agent
hierarchy hangs off, and the server has no self guard there.

## 2. Will a new club have the roster problem?

No, and the reason is a database guarantee rather than a habit.
`trg_club_owner_has_a_player_wallet` on `public.clubs` is a deferred
constraint trigger: it inserts the owner into `club_members` as
role `owner`, status `active`, on every club INSERT, and repairs the row if a
later update would leave it non-active. Verified across all four clubs today -
every owner is a member, no membership has a status the roster filters out,
and 385 of Deep Stack Society's 417 members have no wallet row and are
returned anyway. The bug was only ever the client's.

## 3. Union creation is an allowlist

Dan: "HIDE ALL CREATE UNION PAGE AND FUNCTIONALITY FOR ALL ACCOUNTS EXCEPT FOR
MINE."

Hiding links would not have been a permission. `/unions/create` is a URL
anyone could type, and the endpoint behind the form
(`manage-union.js`, action `create`) runs as the **service role**, so RLS
never applied to it. The decision therefore lives on the table:

- `public.union_creators` - the list. RLS: service role writes; a person may
  read only their own row, so nobody can enumerate who else holds it.
- `trg_union_creation_is_allowlisted` BEFORE INSERT on `public.unions` -
  refuses anyone not on it, for every caller. Proved by inserting as the
  service role for another account and watching it refuse (rolled back; the
  union count is unchanged at 1).
- `fn_can_create_union(uuid)` - what the UI asks.

Seeded from whoever already owned a union, so no migration and no bundle
carries a person's address (the World Hub's
`a-script-never-wears-a-persons-face` law is the same principle). On a fresh
database with no unions it seeds nobody, which is the correct closed default.

UI, all failing closed: `UnionCreationGuard` on the route itself,
and the hamburger quick action, the Unions directory (header button,
empty-state action, CTA section, and the modal) and the section rail all ask
`useCanCreateUnion` first. Transferring an existing union is untouched -
that is a different decision.

The World Hub side is a one-file change in a separate PR: `manage-union.js`
asks `fn_can_create_union` before it inserts, purely so the refusal is a
sentence rather than a constraint violation.

## Laws

- `tests/every-member-is-discoverable-in-the-cashier.law.test.ts` extended:
  the two block reasons, the club-bank exemption, and pins that neither
  cashier surface filters a member out of its list to avoid a refusal.
- `tests/union-creation-is-an-allowlist.law.test.ts` (new, registered): the
  trigger, the RLS shape, one transaction, no person named, the guarded route,
  and the four surfaces that must ask first.

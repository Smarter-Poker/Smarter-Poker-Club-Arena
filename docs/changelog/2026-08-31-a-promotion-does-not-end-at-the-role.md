# A Promotion Does Not End At The Role

**2026-08-31 - Phase 5 Of 7, Client Half**

Two gaps of the same shape: the database could do the thing, and no screen
asked it to.

## Fund Them Now?

A promotion assigns the TERMS - commission, rakeback, prepaid or a credit line

- and not one chip. A prepaid agent with an empty wallet cannot send anything
  at all: `fn_agent_wallet_send` refuses them for want of float, and the credit
  path is closed to them by definition. The person who just promoted them is the
  person holding the club bank, standing in front of the screen that can fix it,
  and was shown nothing.

After a promotion to an agent role, `MemberManagementPage` now reads the new
agent's wallet balance and, when it is empty, offers the funding step: **Send
Chips** opens the existing transfer modal aimed at that member, **Not Now**
finishes the flow. Re-grading an agent who already carries float is not asked,
because the answer is obvious.

It is an offer, not an action. Funding somebody is a transfer of chips and it
is not implied by choosing their commission rate.

The balance read binds its error rather than discarding it. `supabase-js`
returns a failure, it does not throw one, so an unbound `error` would read a
denied read and an empty wallet as the same number - and "Their Agent Wallet Is
Empty" is exactly the claim this prompt makes to the person's face.

## Hand Over This Club

`transfer_club_ownership` has always permitted the owner to hand the club over

- it checks that the caller IS the current owner and refuses anybody else - but
  the only screen that called it was `AdminDashboardPage`, which a club owner
  cannot open. The one person the rule was written for had to ask a platform
  admin to do it for them.

`ClubSettingsPage` now carries an **Ownership** section, gated on `isOwner`,
above the Danger Zone and deliberately amber rather than red: handing a club to
somebody is a considered act, not a destructive one.

The dialog lists only members the RPC would actually accept - active or
approved, excluding the current owner - and requires both a chosen member and
the club name typed out, the same guard the delete dialog uses. It has real
dialog semantics: `role="dialog"`, `aria-modal`, Escape to close, and focus
returned to the control that opened it.

Nothing about the handover is re-implemented client side. The RPC refuses a
non-member, demotes the outgoing owner to admin, writes both `role_changes`
rows and the audit row, and tells both people. When it refuses, its own
sentence is shown rather than a generic failure.

On success the page navigates away, because every owner-only control on it just
stopped belonging to the person looking at it.

## Evidence

`tests/a-promotion-does-not-end-at-the-role.law.test.ts` - 12 pins on the
wiring: that the offer is made, that it is an offer, that it is aimed at the
right person, that a promotion which already succeeded cannot be failed by an
unreadable balance, and that the handover cannot fire by accident.

Full suite: 764 files, 10,694 passing. Two ratchets caught this change and both
were real: a byte-counted source window in the new test (now bounded by the
structure it is about) and the discarded error read described above.

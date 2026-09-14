# 2026-09-14 - A sponsor's flight is billed, and a phone sponsor can log in

Branch `agent/cowork-ads10/feat/a-sponsors-flight-is-billed`. Migration
`20260914004548_a_sponsors_flight_is_billed`. Follows
`2026-09-13-a-sponsor-is-quoted-a-price-in-dollars.md`, which froze a dollar
quote on every sponsor flight and told staff "$70 To Invoice" for ever, and
closes the first item on `2026-09-13-a-sponsor-owns-their-own-flights.md`'s
still-to-do list (the hand-off).

## The marks

Money coming in from a sponsor is a person raising an invoice and a person
seeing it paid. The platform's part is to remember both. `ad_campaign` gains
`invoiced_at`, `paid_at` and `billed_by`; `fn_sponsor_campaign_bill(campaign,
mark)` sets them for platform staff with `mark` in `invoiced`, `paid`, `none`
(the undo for a slip: the same hand clears it, nobody edits a row). Only a
sponsor flight (`club_id` null, `quoted_cents` set) and only once approved,
because an invoice is for a flight that runs; `paid` on an uninvoiced flight
sets both, since the money arrived. Nothing here moves chips or diamonds.
This is not a payment provider and money never leaves the platform through
it; 10.9's "money leaving the platform" stays Dan's.

Both campaign lists return the marks. The sponsor's page reads one
`billingLabel`: Quoted, To Be Invoiced, Invoice Sent, Paid. The staff queue's
reviewed table gains a Billing column with that word and the one next action
(Invoice Sent, then Paid), plus Clear once anything is marked.

## The hand-off

A sponsor opened over the phone (`fn_sponsor_campaign_create`) has
`self_serve = false` and the member of staff as owner, so nobody could log in
as it. `fn_sponsor_advertiser_handoff(advertiser, email)` finds the account in
`auth.users` by e-mail, refuses if that account already owns a self-serve
sponsor (the one-per-owner index would refuse anyway; this says why in words),
and sets `owner_user_id` + `self_serve`. From then on that person's own
Advertise page lists every flight staff booked for them, quotes and marks
included, and they can book their own.

`fn_sponsor_advertiser_list()` gives staff the roster: each sponsor, its
contact, whether it logs in (owner e-mail) or is a phone sponsor, its flight
count and what is unpaid. The queue renders it below the reviewed table with a
Hand Off control on every phone sponsor, prefilled with the contact e-mail.

## Tests

`tests/unit/advertiserSelfServe.test.ts`: the marks are staff-only on approved
sponsor flights, paid never without invoiced, the bill function touches no
chips or diamonds, both lists return the marks, the hand-off resolves by
e-mail and refuses a second sponsor per account, and the two pages read the
same `billingLabel`.

## Still to do

- Edge-resolved country, then geo-gating, before any real-money operator.
- `table_between_hands` is priced ($16) and not bookable until something
  renders it.

# The rebuy and the add-on, on the four-bay deck

2026-09-14. Branch `feat/felt-buy-in`, second commit. Fifth and sixth
surfaces of the felt sweep; with the buy-in they complete the buy-in family.

`RebuyModal` was the generic metallic chassis: a header with a close glyph,
five rows, two bevelled buttons. `AddOnModal` was inline styles: a green
heading, a countdown box, five rows, two buttons, and once a decision was in,
a result line with no button under it. A rebuy and an add-on are buy-ins
(Dan 2026-09-09: the four-bay deck is the buy-in family's and nobody else's),
so both now wear the deck the buy-in wears.

## What prints where

Rebuy:

- Eyebrow Tournament, title Rebuy (`rebuy-modal-title` kept as the
  accessible name), the offer as the pill: +10,000 in green.
- The price as the figure on the glass - Rebuy For, 110, Chips - and the
  chips it returns as a line under it.
- Rebuy Cost, House Fee, Total Charged and Wallet Balance in the four bays,
  the split cent-exact and the total whole, as before; the wallet in red when
  it does not cover the total.
- The shortfall as red copy on the glass: Insufficient Balance - You Need 110
  To Rebuy. No ".00" on a tournament figure.
- Decline and Rebuy 110 on the two plates; Processing... while the request
  is in flight. The confirm still guards before it sounds.

Add-on:

- Eyebrow Re-Entry Period Has Ended, title Add-On, the clock as the pill: the
  bare seconds the tests read, green, red from ten.
- Chips Received as the figure on the glass: +10,000 in green.
- Add-On Cost, House Fee, Total Charged and Your Balance in the four bays; a
  dash in the price bays when the price is unknown, and the sheet still
  refuses to sell at a zero price.
- The shortfall and the unknown price as red copy on the glass.
- Decline and Accept For 110 (or Accept Add-On when the price is unknown) on
  the two plates.
- Once a decision is in, the outcome prints on the glass - Add-On Accepted,
  Add-On Declined, Insufficient Balance - Add-On Denied, or Add-On Failed
  with its reason as an alert - and the Decline plate reads Close. Before,
  a failed add-on left a sheet with no way out: the buttons were gone with
  the rows. Close is `onDecline`, the parent's own dismissal.

## The bays learn to wrap

A bay's label zone is 130 of 900 wide. Min and In Blinds fit it; Total
Charged and Wallet Balance do not, and at the half-size floor they were 4.5px
tall and still clipped. The bay label now wraps to two lines (ZoneText's
`wrapBelow`, the same mechanism the four-bay plates use), each a touch
smaller and tight-leaded so both sit inside the 44px zone above the bay.
The labels are the labels the tests read; none was shortened.

## Re-rendered, not rewritten

Everything above each render is untouched: the cent-exact total and the gate
on it, the zero-price refusal, the persisted deadline and the once-only
auto-decline, the sound-after-guard accept, the honest outcome.

## Verification

Rendered at 393px: the rebuy at 500, at 105 (short), with a 13.50 + 1.50
split, and processing; the add-on at 5,000, at 105 with 8 seconds left, at
an unknown price, and after a refused accept; the rebuy at a 1000px viewport
where the dialog sits at its 560px cap. Every plate label sits inside its
face on one line; every bay label sits inside its zone. Copy gates and
no-emoji OK; the covering suites pass.

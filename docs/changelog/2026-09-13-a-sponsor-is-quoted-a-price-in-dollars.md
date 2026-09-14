# 2026-09-13 - A sponsor is quoted a price in dollars, and the popup carries the sponsor's door

Branch `agent/cowork-ads7/feat/a-sponsor-is-quoted-a-price`. Migration
`20260913235536_a_sponsor_is_quoted_a_price_in_dollars`, applied to production
2026-09-14 00:07 UTC. Follows `2026-09-13-a-sponsor-owns-their-own-flights.md`
(#4534), which left two decisions open. Dan, 2026-09-13: "NOTHING IS MINE,
THEY ARE ALL YOURS." So:

## The price

Derived, not guessed. `diamond_packages` sells 100 diamonds for $1.00 at every
tier, so a diamond is one cent and the club rate card already prices each
surface in cents. An outside sponsor sends players OFF the platform to its own
site and is invoiced by a person; that is worth more than a club promoting a
game inside the room, and it costs someone's time to bill. A sponsor pays
twice the club rate, in whole dollars (no decimals on a forward-facing page):

| surface               | club (diamonds/day) |   sponsor ($/day) |
| --------------------- | ------------------: | ----------------: |
| `lobby_strip`         |                 500 |                10 |
| `session_summary`     |                 400 |                 8 |
| `hub_promotions`      |                 300 |                 6 |
| `empty_state`         |                 250 |                 5 |
| `table_between_hands` |                 800 | 16 (not bookable) |

`ad_rate_card.sponsor_cents_per_day` carries it; the migration asserts every
price is a whole dollar and exactly twice the club rate, so a future edit that
breaks the rule has to say so. `0` means not for sale to a sponsor and the
page does not offer the surface.

**The quote is frozen on the flight.** `ad_campaign.quoted_cents` is written by
`fn_sponsor_ad_submit` (and the staff path `fn_sponsor_campaign_create`) from
the rate card at that moment, so the invoice a person raises matches what the
sponsor was shown when they booked, whatever the card says later. Both lists
return it: the sponsor's page shows "$70 Quoted" / "$70 Invoiced", and the
staff queue shows "$70 To Invoice" beside the approve button, whose confirm
now says that approving means somebody raises that invoice.

## The door

Everybody who sees an advert is a prospective advertiser, so the full-screen
popup is where the sponsor's door is. Club Arena's `AdInterstitial` carries an
"Advertise With Us" router link to `/advertise` (closing the popup first - a
dismiss, not a click); the Hub's popup carries the same link as a real
navigation to `/hub/club-arena/advertise` (World Hub PR, same branch name).
The route is reachable now, so its entry in `ALLOWED_ORPHANS` is gone.

## Tests

`tests/unit/advertiserSelfServe.test.ts` gains three describes: the derived
whole-dollar twice-club price with its apply-time proof, the frozen quote and
the not-for-sale refusal, no decimals in `formatDollars`, and the popup link
with the orphan entry removed.

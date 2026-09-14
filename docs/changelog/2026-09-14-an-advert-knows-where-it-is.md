# 2026-09-14 - An advert knows where it is

Branch `agent/cowork-ads11/feat/an-advert-knows-where-it-is` (Club Arena) and
`agent/cowork-ads7/feat/an-advert-knows-where-it-is` (World Hub). Migration
`20260914011104_an_advert_knows_where_it_is`. Closes the last item on
`2026-09-13-a-sponsor-owns-their-own-flights.md`'s still-to-do list:
"edge-resolved country, then geo-gating, before any real-money operator."

## The list

An outside sponsor sends players to its own site, and some sponsors may only
serve some places. `ad_campaign.countries text[]` is ISO 3166-1 alpha-2, upper
case; null means everywhere, which is what every club flight and every flight
that existed before today has. `fn_ad_countries_clean` trims, upper-cases,
de-duplicates and returns null for an empty list; one entry that is not two
letters makes the whole list invalid and both sponsor submits refuse with
`bad_countries` rather than dropping it. A sponsor who typed "USA" meant
something, and serving everywhere is the opposite of it. The client applies
the same rule (`parseCountries`) before the round trip, so the page says so
under the field instead of after the submit.

## The check

`fn_resolve_ads` takes `p_country`. A gated flight is served only to a player
whose country is known AND in the list. Unknown is inside no list: a flight
that must not run in some place is not run for a player we cannot place.
House and club flights carry no list and are untouched, so a missing country
changes nothing they serve. The old three-argument signature is dropped, not
overloaded; PostgREST cannot choose between two functions that differ only in
defaults, and the migration asserts one overload each of the five functions
it touches.

## Where the country comes from

Vercel stamps `x-vercel-ip-country` on every request that reaches a function,
and both the Hub and Club Arena are served from `smarter.poker` (Club Arena
through the rewrite), so a same-origin `GET /api/geo` answers with that one
header and nothing else: no IP, no city, no session. Both clients
(`src/lib/hubAds.js` on the Hub, `AdService.resolve` here) fetch it once per
page load, memoised, and pass it as `p_country`. A failed fetch, local dev or
a missing header is null.

It is a hint, never a credential. A player who lies about where they are sees
an advert they were not meant to; nothing on this platform is unlocked by it.
That is why the route is public, unauthenticated and `no-store`, and why it
must never widen to anything a person could be located by.

## The pages

The sponsor's Advertise page gains "Countries (Optional)" with the parsed list
read back under it; the staff sponsor form gains the same field; the sponsor's
flight list, the staff queue and the reviewed table show "US, CA Only" beside
the surface when a list is set.

## Tests

`tests/unit/advertiserSelfServe.test.ts` (Club Arena): the list and its
cleaning rule, the resolver's refusal on unknown, one overload each, the
client's single memoised read and null-on-failure, and both writers and
readers. `__tests__/house-ads-hub-promotions.test.mjs` (World Hub): the Hub
passes the country, and `/api/geo` reads the edge header alone.

## Still to do

- `table_between_hands` is priced ($16) and not bookable until something
  renders it.

# 2026-09-13 - A sponsor owns their own flights, and every flight has a poster

Branch `agent/cowork-ads6/feat/a-sponsor-owns-their-flights`. Migration
`20260913193627_a_sponsor_owns_their_own_flights_and_every_flight_has_a_post`,
applied to production 2026-09-13 19:40 UTC. Phase 5 of the ads programme;
phase 4 was `2026-09-13-an-advert-is-a-picture-everywhere.md`.

## Where it started

Dan, 2026-09-03: "allow others to advertise with us." Clubs could buy a flight
with diamonds since 09-03. A sponsor could not touch the platform: a member of
staff typed their flight into the admin queue, and the 09-09 changelog listed
"a sponsor-facing view of `fn_ad_campaign_report`" as still to do. Then phase 4
gave every flight a `poster_url` for the full-screen popup and gave neither
self-serve flow a way to supply one, so every club flight would have opened
full screen as its 6:1 strip.

## What a sponsor can do now

Signed in, at `/hub/club-arena/advertise` (Club Arena route `advertise`, any
account, `AuthGuard` only):

1. **Open their advertiser once** - business name, contact email
   (`fn_sponsor_advertiser_upsert`). One per account: `ad_advertiser.self_serve`
   plus a partial unique index `ad_advertiser_one_self_serve_sponsor_per_owner`.
   Staff-typed sponsors keep `self_serve = false` and their `owner_user_id` is
   the member of staff, so the two never collide.
2. **Upload into their own folder** - the storage policy
   `ad creatives sponsor owner insert` admits `sponsor/<advertiser id>/…` for
   that advertiser's owner and nobody else, and `fn_sponsor_ad_submit` refuses
   a creative or poster path outside it.
3. **Book a flight** - surface, creative at the surface's exact size, the 3:4
   poster, headline, days (1 to 365), and the `https://` address on their own
   site. It lands `submitted`, priority 90, in the same queue a club's flight
   and a staff-typed sponsor's flight land in. Nothing serves until staff
   approve it. No diamonds move, and the page says "Priced On Request" and
   "Invoiced By Smarter.Poker After Review" rather than inventing a number:
   what a sponsor pays is Dan's, quoted by a person.
4. **Withdraw** an unreviewed flight (`fn_club_ad_cancel` now branches: a club
   is refunded, a sponsor was never charged).
5. **Read their numbers** - the list with people / shown / seen / taps
   (`fn_sponsor_campaign_list`), and a day-by-day table per approved flight
   (`fn_ad_campaign_report`, now readable by the advertiser's owner as well as
   staff and club staff). Clubs get the same day-by-day panel on their page.

The sponsor's address never reaches a player's browser: approval mints the
opaque `click_code`, the resolver serves `/c/<code>`, and the World Hub
redirect counts the click. Nothing in phase 3's four same-origin locks moved.

## Every self-serve flight has a poster

`fn_club_ad_submit` and `fn_sponsor_campaign_create` gain a trailing
`p_poster_url` (default NULL, so the bundle already in players' tabs keeps
working while this one rolls out; the old signatures are dropped because two
overloads differing only by a defaulted trailing argument are ambiguous to
PostgREST). The advertise page requires both pictures before Submit in either
mode and uploads the poster at exactly 1080 x 1440 through the one upload path
(`uploadTo`). The staff sponsor form gains an optional poster path.

## The page

`ClubAdvertisePage` keeps its file name and its club route and gains
`mode="sponsor"`: no diamond balance, no club scope, an https address field
instead of the club-destination select, a "Your Business" card at the top, and
the one surface nothing renders (`table_between_hands`) is not offered. Same
dress as the club page: this family is not yet on the #ClubArenaConsole
master (the sweep runs in traffic order, operator pages last) and building the
sponsor mode on the same dress means the family is rebuilt once, together.

## Tests

`tests/unit/advertiserSelfServe.test.ts` pins the one-per-account index, the
owner-only folder policy and RPC check, owner-scoped list and report, the
cancel branch, the poster on both RPCs with one overload each, the poster
required in the page and uploaded at 3:4, the sponsor route, no diamonds and
no invented price in sponsor mode, and the day-by-day panel.
`tests/unit/houseAds.test.ts` follows the upload path to `uploadTo`;
`tests/unit/globalHeaderRouteAudit.test.ts` counts the new route.

## Still to do

- Staff hand-off of a staff-typed sponsor to a real account (set
  `owner_user_id` + `self_serve`), so a sponsor opened over the phone can log
  in later. A one-row admin action; not built yet.
- A sponsor's price. The rate card prices surfaces in diamonds for clubs;
  Dan decides what a sponsor pays and how it is invoiced.
- Edge-resolved country, then geo-gating, before any real-money operator.

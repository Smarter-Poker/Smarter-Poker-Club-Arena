# 2026-09-09 - a sponsor sends traffic to its own site

Dan, 2026-09-03: "allow others to advertise with us". Club owners have been
able to buy a flight with diamonds since `20260903190516`. An outside sponsor
still could not, and exactly one thing stopped them.

## The problem

An advert that cannot send a player to the advertiser's own site is not
something an advertiser will pay for. Every destination on this platform is a
rooted path on smarter.poker, enforced in four independent places - the
`ad_catalog` CHECK, the Hub API's `readSitePath`, `isSafeAdTarget` in Club
Arena, `isSafeHubDestination` on the Hub - and every one of those is correct.
Weakening any of them to let a sponsor in would have been the wrong trade.

## The shape that keeps all four

The external address is never handed to a browser and never travels in a
request. It is stored on the campaign; approval mints an opaque `click_code`;
the resolver serves **`/c/<code>`**, a rooted same-origin path. All four checks
see exactly what they saw yesterday. Not one was touched.

The World Hub route at that path calls `fn_ad_click_redirect`, which looks the
destination up **by code**, records the click, and returns the address for a 302. There is no URL parameter anywhere in the flow, so this cannot become an
open redirect: OWASP's rule is "never redirect to a user-supplied address", and
the way to obey it is to not accept one. An invented code gets `not_found`; a
guessed one still only reaches an address we approved.

## What changed

- `supabase/migrations/20260909071146_a_sponsor_sends_traffic_to_its_own_site.sql`
  (applied to production via the Supabase MCP, one transaction):
  - `ad_campaign` gains `external_url` (https-only CHECK), `click_code`
    (unique, and constrained so it cannot exist without a destination),
    `pacing`, `goal_impressions`.
  - `fn_sponsor_campaign_create` - platform staff only, takes no money (a
    sponsor is invoiced off-platform), lands in the same review queue a club
    flight does.
  - `fn_ad_campaign_review` mints the code on approval and points the catalog
    row at `/c/<code>`. Its reject branch now refunds only a flight that was
    actually paid for, so rejecting a sponsor no longer tries to hand back
    zero diamonds.
  - `fn_ad_click_redirect` - **service_role only**; a browser role could
    otherwise read every sponsor's destination and forge clicks.
  - `fn_ad_campaign_list` **LEFT JOINs clubs**. It inner-joined before, so a
    sponsor campaign - which has no club by definition - was invisible to the
    queue that is supposed to approve it. It would have been approved by
    nobody because nobody could see it.
  - `fn_ad_campaign_report` - day-by-day numbers computed on read. No rollup
    table and no scheduled job: section 11 routes every scheduled trigger
    through Open Claw, and a number recomputed on read cannot quietly go stale.
  - `fn_resolve_ads` paces: `ORDER BY priority DESC, pace_debt DESC, weighted
draw`. A flight behind its own even-delivery line sorts first; one ahead
    sorts last but never goes dark, because dark inventory is how a surface
    ends up empty while somebody is paying for it.
- `AdService`: `AD_CLICK_PREFIX` and `isExternalAdClick`.
- `HouseAdRotator`: an external destination leaves via
  `window.location.assign` rather than the router (this app is mounted under a
  basename, so `navigate('/c/x')` would resolve to `/hub/club-arena/c/x`), and
  **does not log the click** - the redirect counts it server-side, and
  counting in both places would bill a sponsor for double the clicks.
- `CampaignQueue`: a form for platform staff to open a sponsor flight.

## Proven, then rolled back

One `DO` block ran the whole path and raised at the end (11.5): create -> ok;
approve -> ok, code `587ee876ebcc40c9`; catalog target `/c/587ee876ebcc40c9`;
the resolver returned it labelled `sponsor`; the redirect returned
`https://acme.example/solver?...` and logged 1 click; an unknown code returned
`not_found` with no url; a cancelled flight returned `not_live`; the report had
1 day. After the rollback: 0 campaigns, 1 advertiser, 6 catalog rows, clicks
back to their prior 4.

## Deliberately not built

**No geo targeting.** A real-money operator may only be advertised where it is
licensed, and that is a compliance control rather than a preference. The only
country this database could consult is one the browser told it, and a control
a player can edit is decorative - it would read as armed while being nothing,
which is the failure shape this estate keeps paying for. Geo-gating needs a
country resolved at the edge; the World Hub sees one, the resolver is called
straight from the browser and does not. Until that exists `ad_rate_card` keeps
every surface a sponsor could self-serve **closed**, and a sponsor flight is
opened by staff who know who they are selling to.

## Still to do

- The World Hub route at `/c/:code` (companion PR).
- A sponsor-facing view of `fn_ad_campaign_report` - the numbers exist and are
  readable, but only staff can see them today.
- Edge-resolved country, then geo-gating, before any real-money operator.

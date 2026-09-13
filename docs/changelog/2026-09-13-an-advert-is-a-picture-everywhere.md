# 2026-09-13 - An advert is a picture everywhere, and a tap opens it full screen

Branch `agent/cowork-ads5/feat/ads-are-pictures-everywhere`.
Migration `20260913182547_an_advert_is_a_picture_everywhere_and_a_tap_opens_it_full_sc`
(applied to production 2026-09-13).
Law `tests/an-advert-is-a-picture.law.test.ts`, registry `docs/laws.d/an-advert-is-a-picture.md`.

## What Dan asked for

Verbatim: "MAKE SURE YOU MAKE THE STANDARD FOR ADS EVERYWHERE INSIDE OF
SMARTER.POKER TO BE RESPONSIVE FLUID IMAGES ONLY! AND ANY TIME THEY ARE
CLICKED THEY SHOULD BE OPEN AND DIRECTED TO WHATEVER THE AD IS DISPLAYING AS A
FULL SCREEN POP UP AS WELL."

Two standards, one for how an advert looks and one for what a tap does.

## Standard 1: pictures only, fluid, on every surface

Before this, `lobby_strip` and `session_summary` were three rotating pictures
(2026-09-03) while `empty_state` was still `HouseAdCard`, a text card with a
44px thumbnail and a geometric glyph, and the Hub's `hub_promotions` rail was
text with a 34px thumbnail. Two of four surfaces were still text.

Now:

- **`HouseAdCard` is deleted.** `empty_state` mounts `HouseAdRotator` with
  `className="ad-rotator--poster"`: 3:4, capped at 420px, centred in the dead
  space. Every Club Arena surface goes through the one rotator, which renders
  an `<img>` in a box that is `width: 100%` with a declared `aspect-ratio`
  and `object-fit: contain`. It shrinks with the page and is never cut off or
  distorted.
- **The resolver refuses a pictureless placement.** `fn_resolve_ads` now
  carries `AND COALESCE(pl.image_url, c.image_url) IS NOT NULL`. This is what
  makes it a standard rather than a convention: a renderer can be replaced or
  forgotten, the resolver cannot be bypassed. The migration asserts at apply
  time that no active placement is pictureless and that every slot still has
  at least three candidates.
- **Every surface has a picture for every campaign.** 18 new creatives under
  `public/assets/ads/`: all six campaigns now ship `lobby-strip` (6:1
  1200x200), `session-summary` (3:1 900x300), `hub-promotions` (16:9
  1200x675) and `poster` (3:4 1080x1440). The migration sets
  `ad_placement.image_url` for every placement to its surface's file.
- The World Hub's `HubPromoRail` is rewritten to the same rules in its own
  pull request (Next.js repo); the 16:9 creatives are served through the
  Club Arena origin at `/hub/club-arena/assets/ads/`.

## Standard 2: a tap opens the advert full screen

The obvious reading - open the destination page in a full-screen frame - is
not possible here, and it was ruled out on purpose rather than by accident:

- The one sanctioned iframe is `HubFrame`, and it lives only inside a table
  tab. Club Arena must never be framed inside itself (CLAUDE.md 1.3), and five
  of six house destinations are Club Arena routes.
- A sponsor's site refuses framing (`X-Frame-Options`, CSP) as a matter of
  course, and the sponsor's URL never reaches the client anyway - the resolver
  serves `/c/<code>` and the World Hub redirect counts the click server-side.

So "what the ad is displaying" is the advert itself. A tap opens
`AdInterstitial`: a `position: fixed; inset: 0` portal showing the poster
(`poster_url`, falling back to the surface creative) fluid and contained, with
the headline as a caption, a "Sponsored By X" / "From X" badge, one CTA
button, and Close.

- **The tap logs nothing.** `activate` only opens the popup.
- **The button is the click.** `proceed` logs the click for an internal
  destination and hands the path to the router; for an external destination
  it opens `/c/<code>` in a new tab with `noopener,noreferrer` and does NOT
  log - the redirect counts it, exactly as before.
- **Closing is a dismiss** (`logDismiss`), never a click.
- The rotation holds while the popup is open (`openRef`), so the poster on
  screen is the advert that was tapped.
- Escape closes, focus lands on Close, body scroll is locked, the animation
  scales with `--animation-speed` and collapses under reduced motion.
- The interstitial is `lazy()` loaded on the tap, so the entry chunk does not
  grow for a popup most sessions never open.

## Schema

- `ad_catalog.poster_url` and `ad_campaign.poster_url`, both under a
  same-origin CHECK (`ad_catalog_poster_is_same_origin`,
  `ad_campaign_poster_is_same_origin`), the same lock every ad URL carries.
- `fn_resolve_ads` returns a 13th column, `poster_url`, as
  `COALESCE(c.poster_url, pl.image_url, c.image_url)` - a popup always has a
  picture.
- `fn_ad_campaign_review` copies the campaign's poster into the catalog row
  on approval, so a sponsor's or club's poster reaches the popup.
- The admin composer (`HouseAdsPage`) gains a "Poster Path (Optional)" field.

## Tests

- New law pins both standards at every layer: no card component exists, every
  surface mounts the rotator, the rotator is a contained image in a
  fixed-shape box with no text, the resolver filter and its apply-time
  assertion, all 24 creatives, tap opens without logging, the button is the
  only click, close is a dismiss, rotation holds, popup is fixed/inset 0 with
  a contained image reading its own natural ratio.
- `tests/unit/houseAds.test.ts`: the `HouseAdCard` pins are rewritten to the
  rotator and the interstitial hand-off.
- `tests/action-bar-never-leaves.law.test.ts`: the `HouseAdCard` line is
  gone (the file it read no longer exists).

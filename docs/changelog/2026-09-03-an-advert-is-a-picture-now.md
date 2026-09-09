# 2026-09-03 - an advert is a picture now

Dan: "add the lobby strip, post session modal. i want to have it as 3 rotating
images for now, lets start with those only." And, mid-build: "IF A PAGE
SHRINKS, THE IMAGE SHOULD SHRINK AS WELL, IT SHOULD NEVER BE CUT OFF, OR
DISTORTED BY PAGES CHANGING SIZE."

## What was wrong

- **`lobby_strip` had been dark for five days.** PR #1759 (premium dynamic
  game cards, 2026-08-29) rebuilt the lobby top and dropped the
  `<LobbyAdStrip />` mount from `ClubHomePage.tsx`. The component, its CSS,
  its six placements and its 85 source pins all survived, so nothing went
  red. `ad_event` shows 620 lobby_strip events up to Aug 29 and zero after.
  The busiest ad surface on the platform served nobody, and no test pinned
  the mount - only the file.
- **No surface could show a full picture.** `HouseAdCard` and `HubPromoRail`
  rendered `image_url` as a 34-44px thumbnail beside text; the strip had no
  `<img>` at all. All six live ads had `image_url = NULL`.
- **One image per ad cannot serve two shapes.** The strip is 6:1, the
  session summary is 3:1.
- **"Impression" meant "resolved", not "seen".**

## What changed

- `supabase/migrations/20260903184811_an_advert_is_a_picture_now.sql`
  (applied to production via the Supabase MCP, one transaction):
  `ad_placement.image_url` with the same same-origin CHECK as the catalog;
  `ad_event.event_type` admits `viewable`; `fn_resolve_ads` prefers the
  placement creative and returns `placement_id`, `advertiser_kind`,
  `advertiser_name` (the last return-type change - club and sponsor
  campaigns reuse these columns); the first six creatives seated; exactly
  three active placements on each of the two picture surfaces, the
  text-only ones paused not deleted.
- `src/components/ads/HouseAdRotator.tsx` + `.css`: full-bleed responsive
  image with a fixed per-surface `aspect-ratio` and `object-fit: contain`
  (scales with the page, never cropped, never stretched), three creatives
  rotating every 7s (floor 3s), fade honours `--animation-speed`, reduced
  motion drops the fade but keeps the rotation (10.6: motion collapses,
  meaning does not), dots to pick one by hand, impression on render,
  `viewable` after 50% in view for 1000ms via IntersectionObserver and
  paused while the tab is hidden, click logged inside the safe-destination
  branch and the router handed the CHECKED string, a broken picture leaves
  the rotation, "Club" / "Sponsored" chip for non-house advertisers, and it
  renders nothing at all when no creative has a picture.
- Mounted in `ClubHomePage.tsx` directly under the action bar and in
  `SessionSummaryHost.tsx` (which now passes `useUserStore.currentClubId`,
  so Spins and the jackpot - whose destinations carry `{clubId}` - can be
  placed there).
- `LobbyAdStrip.tsx` / `.css` deleted. Club and union notices still have
  `ClubAnnouncementBanner` and the announcements page.
- `AdService`: `HouseAd` gains `placementId`, `advertiserKind`,
  `advertiserName`; `logViewable`; an unknown kind off the wire is treated as
  a sponsor, never as the house.
- Six creatives under `public/assets/ads/` (Spins, Bad Beat Jackpot, VIP at
  1200x200 and 900x300, 19-26 KB WebP each) in the house metallic style.
- `tests/unit/houseAds.test.ts` re-pointed from the strip to the rotator and
  now pins BOTH MOUNTS, the aspect-ratio/contain rule, the three-creative
  rotation, the viewable definition, and the label rule.

## Still to do (next PRs)

- `ad_advertiser` / `ad_campaign`, the diamond-paid club-owner flow, the
  approval queue, the `ad-creatives` storage bucket, and the World Hub
  rewrite that keeps uploaded creatives same-origin.
- World Hub `house-ads` API: accept `image_url` on placements; the admin
  panel's placement editor gains the field.
- `fn_ad_stats` does not yet count `viewable`; the panel shows impressions
  only until it does.

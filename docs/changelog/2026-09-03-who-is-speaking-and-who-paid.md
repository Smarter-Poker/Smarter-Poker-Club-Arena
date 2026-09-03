# 2026-09-03 - who is speaking, and who paid

Dan: "focus on any and all code and missing things we need to allow others
to advertise with us, and how we can implement club owners to start
advertising their club or events (using diamonds)."

## What was missing

`ad_catalog` had no advertiser. Every row was the house; nothing recorded who
a creative belonged to, who paid, when it was approved or by whom. There was
no price, no purchase, no review, no refund, and no place for a club owner to
upload a picture that the three same-origin locks would accept.

## What changed

- `supabase/migrations/20260903213000_who_is_speaking_and_who_paid.sql`
  (applied to production via the Supabase MCP, one transaction):
  - `ad_advertiser` (house | club | sponsor; one row per club; the house row
    seeded), `ad_rate_card` (diamonds per day, min/max days, exact creative
    size, weight budget, open flag; lobby strip 500/day and session summary
    400/day open, the other three closed; **prices are Dan's to change, in
    the rows**), `ad_campaign` (one purchased flight with its review state).
  - `ad_catalog.advertiser_id`, `campaign_id`, `priority` (house 50, club
    75). `fn_resolve_ads` reads kind and name off the advertiser row and
    orders by priority BEFORE the weighted draw: a paid flight beats the
    house, and within a tier share-of-voice still decides. Same return type
    as this morning, so no DROP.
  - `fn_club_ad_submit`: club staff only (`fn_club_is_staff`), surface must
    be open, days in range, creative must be under
    `/ad-creatives/club/<club id>/`, destination a rooted same-origin path;
    inserts the campaign and debits the diamonds THROUGH THE JOURNAL
    (`deduct_diamonds`, reference `adcamp:<id>`) in the same transaction; a
    failed debit raises and undoes the insert.
  - `fn_club_ad_cancel` (before review) and `fn_ad_campaign_review`
    (service_role or `fn_is_platform_admin`): reject refunds through
    `add_diamonds_to_balance` under `adcamp-refund:<id>`; approve turns the
    campaign into an `ad_catalog` row plus an `ad_placement` (club-scoped
    when the buyer chose "own club only"), so caps, events and reports work
    on it unchanged.
  - `fn_ad_campaign_list`: a club sees its own, the house sees all, with
    live / scheduled / finished derived from the dates (no scheduler,
    CLAUDE.md section 11) and people / shown / seen / taps per campaign.
  - `ad-creatives` storage bucket (600 KB, webp/png/jpeg): public read,
    insert only by that club's staff into `club/<uuid>/`, delete own.
- `src/services/AdCampaignService.ts`: rate card, upload (refuses the wrong
  type, weight or EXACT pixel size before uploading), submit, cancel,
  review, list. It never computes a price the database has not confirmed.
- `src/pages/ClubAdvertisePage.tsx` at `/clubs/:clubId/advertise`, nav entry
  "Advertise Your Club" for club staff: rate card with each surface's true
  shape, live preview in that shape, headline, destination (lobby /
  tournaments / announcements), days, scope, the total in diamonds, one
  confirm, and the club's campaigns with status and numbers. Fails closed on
  an unreadable role.
- `src/components/ads/CampaignQueue.tsx` on the House Ads admin page:
  pending flights with the picture, approve / reject (a rejection needs a
  note; the club reads it), and a reviewed-history table.
- Vite dev proxy for `/ad-creatives/*`; production needs the World Hub
  rewrite (next PR).

## Proven, then rolled back (CLAUDE.md 11.5)

A `DO` block impersonating the SHARK CLUB owner ran the whole path and raised
at the end: submit charged 1,500 (500 x 3 days), one journal row under
`adcamp:<id>`, the owner's list showed it, approval as service_role made the
resolver return one `club` / `SHARK CLUB` row for `lobby_strip`, a second
800-diamond flight was rejected and refunded to the diamond. After the
rollback: balance 494,070 unchanged, zero campaigns, zero journal rows.

## Still to do

- World Hub: rewrite `/ad-creatives/:path*` to the bucket, and accept
  `image_url` on placements in the `house-ads` API.
- Sponsors (kind `sponsor`) share every table here; what they lack is a
  self-serve portal, cash billing, a click-redirect endpoint and the
  "Sponsored" disclosure on external creatives (the rotator already labels
  them). See the roadmap in the 2026-09-03 house-ads deep dive.

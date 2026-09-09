# House Ads — every surface, what runs on it, and the size a dynamic creative needs

Written 2026-08-29 for Dan, who asked for the inventory before providing
guidance and creative. UPDATE 2026-09-03: `lobby_strip` and `session_summary` are BUILT as three rotating pictures (`src/components/ads/HouseAdRotator.tsx`, PR agent/cowork-ads3/feat/image-ad-rotator); the creative lives on `ad_placement.image_url` per surface. The other rows are still proposals - the proposed column is a
proposal.

Two standing rules this document is written under:

1. **Dan 2026-08-29: "DO NOT PUT ADS IN RANDOM PLACES OR OVERLAPPING IMAGES
   EVER."** Every surface below is in normal document flow and owns its own
   space. The one that did not — the Hub home strip — is deleted (WH PR #918).
2. **Same-origin only.** `ad_catalog.image_url` carries a database CHECK, and
   every client re-checks, that the path is rooted and same-origin. Creative
   files live under `public/` in the repo that serves the surface. No CDN, no
   external host — an outside URL hands every viewer's IP to a third party.

---

## 1. Where ads are inserted today

| #   | Slot                  | Where it renders                  | File                                                                         | Position on the page                                                                                                                                                                                                    | Live?                           |
| --- | --------------------- | --------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | `lobby_strip`         | Club Arena club lobby             | `src/components/lobby/LobbyAdStrip.tsx`                                      | One line directly under the game action bar, above the table list. Rotates every 7s. Shares the strip with CLUB and UNION notices; house ads always sort **last**.                                                      | Yes — 549 impressions, 6 people |
| 2   | `hub_promotions`      | World Hub `/hub/promotions`       | `src/components/ads/HubPromoRail.jsx` (World Hub)                            | A rail above the venue / tour / series feed.                                                                                                                                                                            | Yes — 26 impressions, 5 people  |
| 3   | `empty_state`         | Club Arena club lobby, empty view | `src/pages/ClubHomePage.tsx` line ~4447, via `HouseAdCard`                   | Only in the branch where the club is running **nothing**. The other three empty views carry a "Show All Games" button, and an advert beside a fix competes with the fix.                                                | Yes — 3 impressions, 1 person   |
| 4   | `session_summary`     | Session Complete popup            | `src/components/session/SessionSummaryHost.tsx` line ~446, via `HouseAdCard` | Below the stats tiles, above Share / Done. Never between the player and Done.                                                                                                                                           | Yes — 3 impressions, 3 people   |
| 5   | `table_between_hands` | —                                 | —                                                                            | **Declared in the slot list and built into nothing.** Zero placements, no component. Needs your call on whether an advert may appear at a live table at all.                                                            | No                              |
| —   | ~~Hub home~~          | ~~`pages/hub/index.js`~~          | ~~`HubPromoStrip.js`~~                                                       | **REMOVED 2026-08-29.** This is the one in your screenshot. It sat in normal flow while the 3D carousel is `position: fixed`, so it laid itself across the featured cards. Component deleted, absence pinned by a test. | Gone                            |

Event counts are production, read 2026-08-29.

---

## 2. What is advertised

Six campaigns, all active, all house inventory — no paid advertisers yet. The
plumbing is advertiser-shaped on purpose.

| Campaign            | Headline                      | Body                                                                                          | CTA             | Goes to                       | Weight | Runs on                    |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- | --------------- | ----------------------------- | ------ | -------------------------- |
| `vip_upsell`        | Unlock Every Table Theme      | VIP Opens All Felts, Card Backs, Backgrounds And Frames. Three Of Each Are Free For Everyone. | See VIP         | `/vip`                        | 120    | hub, lobby, session        |
| `spins_jackpot`     | Spins Pay Up To 1000x         | Three Players, One Hand, A Prize Drawn Before The Cards. Sit Down And It Starts.              | Find A Spin     | `/clubs/{clubId}/tournaments` | 110    | hub, lobby                 |
| `bbj_running`       | The Bad Beat Jackpot Is Live  | Lose With Quads Or Better At A Qualifying Table And The Whole Room Gets Paid.                 | How It Works    | `/clubs/{clubId}/jackpot`     | 100    | hub, lobby, empty          |
| `diamonds_store`    | Diamonds Buy Chips Instantly  | Top Up Without Leaving The Table. Every Purchase Is Server Priced.                            | Open Cashier    | `/cashier`                    | 90     | hub, lobby                 |
| `referral_invite`   | Bring A Friend, Both Get Paid | They Join, You Both Collect Diamonds When They Play Their First Hands.                        | Invite A Friend | `/invite`                     | 85     | hub, lobby, empty, session |
| `tournaments_daily` | Tournaments Run All Day       | Guarantees, Bounties And Mystery Chests. Late Registration Is Usually Still Open.             | See The Board   | `/tournaments`                | 80     | hub, lobby, empty, session |

Higher weight wins the slot more often. **Every one of the six has
`image_url = NULL` today** — every ad on the platform right now is text plus a
geometric glyph (◆ ◉ ★ ◈ ▣ ▲). That is the thing this upgrade replaces.

---

## 3. Current size vs. proposed dynamic-image size

Design width is 375px (mobile-first, house rule). "Display" is CSS pixels;
"deliver" is the file to produce, at 3x for retina.

### 3.1 `lobby_strip` — Club Arena lobby

|                    |                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current**        | One text line. **No image support at all** — the component has no `<img>`. 343 x 44px at 375px, full width, 12px headline, 8px source tag. Rotates every 7s.                                                                   |
| **Proposed**       | Wide banner, **6:1**. Display **343 x 57** at 375px; **704 x 117** at desktop. Deliver **1200 x 200**.                                                                                                                         |
| **Why this shape** | It is a horizontal band between the action bar and the table list. Anything squarer pushes the table list below the fold on a phone, which is the one thing this surface must not do.                                          |
| **Work needed**    | DONE 2026-09-03: `HouseAdRotator` renders the 6:1 creative full-bleed (`aspect-ratio: 6 / 1`, `object-fit: contain`), three rotating, headline as the accessible name. Creatives in `public/assets/ads/*-lobby-strip-v1.webp`. |

### 3.2 `hub_promotions` — World Hub promotions rail

|                    |                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current**        | Card with a **34 x 34** thumbnail beside two lines of text. One column at 375px, `auto-fit minmax(280px, 1fr)` above 768px.                                                        |
| **Proposed**       | Hero card, **16:9** image above the text. Display **343 x 193** at 375px; **≥280 x 158** per card on desktop. Deliver **1200 x 675**.                                              |
| **Why this shape** | It sits above venue, tour and series cards written by other people. 16:9 is what those feeds already use, so ours reads as part of the page rather than as a banner stapled to it. |
| **Work needed**    | Move the image from a 34px inline thumbnail to a full-bleed card header.                                                                                                           |

### 3.3 `empty_state` — Club Arena, club running nothing

|                    |                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current**        | `HouseAdCard`, **44 x 44** image (36 x 36 under 480px) beside text, card capped at 520px wide.                                                                                                                            |
| **Proposed**       | Portrait poster, **3:4** — the shape of the Poker Near Me tile in your first screenshot. Display **300 x 400**, centred, capped at 340 wide on phones. Deliver **1080 x 1440**.                                           |
| **Why this shape** | This is the only surface with genuine vertical room: the club has nothing running, so the space is dead and nothing is being displaced. It is also the only surface where a full poster can carry the message on its own. |
| **Work needed**    | A poster variant of `HouseAdCard`; the compact row stays for the other slots.                                                                                                                                             |

### 3.4 `session_summary` — Session Complete popup

|                    |                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current**        | `HouseAdCard`, **44 x 44** image beside text, inside a card `min(100%, 420px)` wide — usable width ~291px on a phone, ~376px on desktop.                                                                                           |
| **Proposed**       | Compact banner, **3:1**. Display **291 x 97** on a phone, **376 x 125** on desktop. Deliver **900 x 300**.                                                                                                                         |
| **Why this shape** | The player has just finished a session and is reading a number that matters to them. This surface gets the smallest premium treatment on the platform on purpose — and it must never grow tall enough to push Done below the fold. |
| **Work needed**    | Same poster/banner variant work as above.                                                                                                                                                                                          |

### 3.5 `table_between_hands` — not built

|                             |                                                                                                                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current**                 | Nothing. Declared in the slot list, zero placements, no component.                                                                                                                                                                                               |
| **Proposed if you want it** | **16:9**, display 343 x 193, deliver **1200 x 675** — but the real question is not the size. It is whether an advert may appear at a live table at all, how long it holds, and what happens when the next hand starts. That is your call, not a sizing decision. |

---

## 4. Formats — what "dynamic" can mean, and what it costs

The current renderer is a plain `<img>`. That decides a lot:

| Format            | Works today with no code change? | Notes                                                                                                                                      |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Animated WebP** | **Yes**                          | The zero-code path. Loops, alpha, good compression. Recommended default.                                                                   |
| **APNG**          | Yes                              | Larger files than WebP for the same result.                                                                                                |
| **GIF**           | Yes                              | Poor colour, large files. Not recommended for premium work.                                                                                |
| **MP4 / WebM**    | **No**                           | Needs a `<video>` element, a poster frame, autoplay/muted/playsinline handling, and a reduced-motion path. Real work on all four surfaces. |
| **Lottie / JSON** | **No**                           | Needs a runtime library. Smallest files and crispest at any size, but it is a dependency on every surface.                                 |

If the creative can be authored as **animated WebP**, we can ship the new sizes
without a rendering rewrite and add motion the same day. If you want video or
Lottie, say so and I will scope the component work.

**Budgets**, because these load on phones on 4G at a poker table:

- Static: **≤ 250 KB** per creative.
- Animated: **≤ 600 KB**, **≤ 6 seconds**, loop seamlessly.
- Under `prefers-reduced-motion` an animated creative must degrade to its first
  frame, not vanish. Club Arena's animation law says motion may be reduced but
  meaning may never be dropped.

---

## 5. Things worth deciding while you are looking at this

1. **The lobby strip cannot show an image today.** It is the busiest surface by
   far — 549 of 581 impressions. Any premium upgrade that skips it changes
   almost nothing about what players actually see.
2. **All six creatives are one set of six.** The system supports a different
   image per surface already, so `vip_upsell` can be a 6:1 banner in the lobby
   and a 3:4 poster in an empty club, from the same campaign.
3. **`{clubId}` templating.** Two destinations carry `/clubs/{clubId}/...`. That
   works everywhere a club is in scope; on the Session Complete popup there is
   no club, so those campaigns simply do not serve there. Not a bug — worth
   knowing when you decide which campaign belongs on which surface.
4. **A/B is already wired.** `experiment_key` splits traffic between two
   creatives with the same key. Nothing uses it yet. Two versions of a new
   premium creative would be the obvious first test.

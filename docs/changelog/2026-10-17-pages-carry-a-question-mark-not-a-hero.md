# Pages carry a question mark, not a hero (2026-10-17)

Dan, verbatim: "PAGES DON'T NEED TITLES LIKE THIS... REMOVE ALL DESCRIPTIONS THAT EXIST LIKE THIS ON ANY AND ALL PAGES. ADD A ? MARK ICON INSTEAD IN THE UPPER RIGHT CORNER OF THE PAGES THAT CAN EXPLAIN ANYTHING AND ALSO LAUNCH A TUTORIAL AT THE BOTTOM WHEN CLICKED. ALL THESE WORDS ARE DISTRACTING AND MAKES IT HARDER TO USE THE SITE, WE NEED TO SIMPLY PAGES. MAKE SURE YOU ADJUST THIS ANYWHERE AND EVERYWHERE IT EXISTS INSIDE OF SMARTER.POKER, CLUB ARENA, DIAMOND ARENA OR CLUB COMMANDER"

He was looking at the Notifications hero: "SIGNAL INBOX // LIVE PLAYER NETWORK", a giant "NOTIFICATIONS", a sentence about the page, "Unread / Loaded" tiles and hero artwork.

## What a page looks like now

- **No hero.** The eyebrow, the giant title, the description paragraph, the hero artwork, decorative status lines ("Integrity Circuit Online", "// LIVE") and figure tiles that repeat something already on the page are gone.
- **The page bar** (`src/components/help/PageBar.tsx`) is what is left: the live state that matters (Locked, Syncing, Refresh Needed, a club name on a cashier), the page's real live figures and its own buttons. The title stays in the document as a visually hidden heading for assistive technology and the browser outline.
- **The painted "?"** (`src/components/help/PageHelp.tsx`, art `images/header-help-v4.png`, the approved chrome help icon from the global header family) sits top right. Tapping it docks a panel at the bottom of the screen:
  1. **About This Page**: the words the hero used to print.
  2. **Start Tutorial**: a step-by-step tour. A step can point at a part of the page; that part scrolls into view and is lit while its step shows. Back / Next / Done, Escape closes, focus returns to the "?".
  3. Tours come from a curated list per route (`pageTutorials.ts`: notifications, club cashier, hand history, tournaments, friends), from steps a page passes (workspace hubs pass one step per tool card; Rakeback passes its "How Rakeback Works" explainer), or are built from the page itself: the remaining sentences of its explanation, then each visible section heading with its lead paragraph.
- **Painted consoles that carry the page's own content** (Promotions, Daily Bonus, and the operator consoles) keep their painted title, because an empty well reads broken; their eyebrows, descriptive subtitles and intro copy went, and the "?" sits above them.

## Kept on purpose

Form labels and field hints, money and consent warnings, legal document bodies, error, empty and loading messages, club identity (club name, the owner's club description, tagline and welcome message), user content (bios), in-table UI, modals and dev pages. The public Poker Arena landing page for people who are not members keeps its marketing copy.

## Guards

- `tests/pages-carry-a-question-mark-not-a-hero.law.test.ts` (registered in `docs/laws.d/`), and the resolved-conflict note in `docs/LAWS.md`: older hero-art contracts were rewritten to the new shape in this change; do not restore a hero to satisfy one.
- `tests/unit/PageHelp.test.tsx`: the explanation, the tour, lighting a target, the auto-built tour, the curated route tour, Escape, and rendering without a router.

## Same instruction elsewhere

World Hub (smarter.poker) and Club Commander carry the same change in their own repositories.

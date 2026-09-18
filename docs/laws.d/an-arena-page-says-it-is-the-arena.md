# tests/an-arena-page-says-it-is-the-arena.law.test.ts

Poker Arena is proxied in under smarter.poker/hub/club-arena and publishes its
own sitemap, which robots.txt declares alongside the World Hub's. Two sitemaps,
one domain.

Five of the six public titles were the bare document name, so with
" | Smarter.Poker" appended they read exactly like the World Hub's own pages.
Measured live on 2026-09-18, /hub/club-arena/legal/tos and /terms both shipped
"Terms Of Service | Smarter.Poker": identical titles, both indexed, one domain,
two different contracts. The privacy pages were the same pair, and the Help
Center sat one word away from the World Hub's /hub/help. An engine reading both
has no way to tell which document it wants, so the two pages compete.

This law pins three things. Every public title names the product whose document
it is. None of them is one of the titles the World Hub already owns. And none is
long enough for a result to cut, because a prefix costs characters and a title
that gets cut is the defect this estate has now made five times.

It also pins that the tab title and the head title come from the same place.
The legal layout used to build document.title from the visible heading, so the
moment the head carried a different string the title changed on hydration. Both
now read resolveSeo. The visible heading stays the bare document name: on a page
already headed "Poker Arena Legal Center" the prefix is noise.

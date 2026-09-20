# tests/the-public-arena-is-indexable-and-the-private-arena-is-not.law.test.ts

Until 2026-09-16 index.html said `noindex, nofollow`, which applies to every
route of the SPA, so Google had nothing to index for Poker Arena at all. The
arena root, the Help Center and the four legal documents are now indexable,
each with its own canonical URL and JSON-LD (src/lib/seo.ts); every signed-in
route (lobby data, cashier, wallet, tables, club dashboards, messages, shared
hand replays) is `noindex, nofollow` with no canonical, so a rendering crawler
never files a player's private page. This law pins both directions and that
index.html never carries the site-wide noindex again.

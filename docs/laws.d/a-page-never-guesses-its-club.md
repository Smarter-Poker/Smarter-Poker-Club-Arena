# tests/a-page-never-guesses-its-club.law.test.ts

The inbound half of Dan's 2026-09-02 club-context rule. `the-menu-stays-in-the-
club` pins that every link carries its club; this pins that every page which
receives one honours it, and that the fallback when it receives none is a
decision rather than an accident. Five global-path pages each hand-rolled the
same fallback and each copy was the same bug: a `club_members` read with
`.limit(1)` and no `.order()`, which asks Postgres for A membership rather than
THE membership - correct-looking forever for a single-club player, and a
different club on consecutive loads for anyone in two. It chose which shop you
saw, which club's events you got, whose commission book opened, which club you
administered, and which club's chip balance FlashPool showed you on a page
where those chips get spent. `resolvePageClubId` states one order of
preference - route path, `?club=`, the club last visited, then a deterministic
first eligible club - returns a UUID, and refuses to pass on an identifier it
could not resolve; the admin and agent dashboards keep their role filter but
pick deterministically. Marketplace is held to the outcome and not the helper:
a 2026-09-04 fix gave it a page-aware fallback (the club you are inside, then
the club with the most stock) that is better than the generic one and must not
be "unified" away. The law reconstructs every `club_members` read on each page
and refuses an unordered `limit(1)`.

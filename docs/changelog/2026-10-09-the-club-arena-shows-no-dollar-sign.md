# The Club Arena Shows No Dollar Sign

**Date:** 2026-10-09

Dan, 2026-10-09 23:44 CT: "you are forbidden from using $ the dollar sign anywhere in the club arena. it just needs to say 100 Chip Guarantee".

#6603 already strips the character at the JSX display boundary, which is the safety net. A net that deletes the symbol leaves "Cashout Paid You 120" and "Diamonds For 4.99": no dollar, but no unit either. This change writes the copy right at its source, in the database and in the code, and makes a rendered "$" a CI failure.

## The Database (Migration 20261010044850, Already Applied)

`supabase/migrations/20261010044850_the_club_arena_shows_no_dollar_sign.sql` records, byte for byte, the migration applied to production as version 20261010044850 (`the_club_arena_shows_no_dollar_sign`). It moves no money.

- `public.fn_ca_text_without_dollar(text)` is the one rewrite, pure and deterministic. A freeroll description ("$100 Guaranteed Prize Pool. Entry Is Free. ...") becomes "100 Chip Guarantee". "$100 Freeroll" becomes "100 Chip Guarantee Freeroll". "Rebuys Cost $8.00 And" becomes "Rebuys Cost 8 Chips And", and "One $8.00 Add-On" becomes "One 8 Chip Add-On". Any other "$N" becomes "N", so "Sunday $200 Deep Stack" becomes "Sunday 200 Deep Stack". No "$" survives.
- Every schedule's name, `shortDescription` and `satelliteTargetName` were rewritten with it, so every future occurrence is born without a dollar sign, and "Sunday 200 Deep Stack" and its satellites were renamed together: every satellite still finds its target by the same rewritten name.
- Every event not yet finished (announced, registering, running and the live states) was rewritten the same way, targets and satellites together. Finished events keep the names they were played under.
- `fn_guard_managed_game_lifecycle` still freezes a registered event's terms. It now admits exactly one change to a registered event's name, short description or description: that rewrite of the text it already had. No other edit to those three, and no edit to any other protected key, passes.
- The migration's own proof block checks the five sample rewrites, that no schedule and no unfinished event still shows a "$", and that the guard carries the new clause. Its `@live-proof` line is what `check-migrations-are-live` asks production.
- `fn_ca_text_without_dollar` is added to `scripts/ci/supabase-schema-manifest.json`.

## The Code

Replacement rules, applied at the source:

- Chip amounts: the plain number from the existing chip formatter, with "Chips" or "Chip" where the unit is needed ("Cashout Paid You 120 Chips", "Insurance Paid You 120 Chips", "Received +1.00 Chips Rakeback!", "Collected 12.00 Chips From The Table"). At a Diamond table the same toasts say "Diamonds" (`moneyWordAtUnit` of the seat's unit, read from the table ref because the socket handlers are registered once).
- Guarantees and named events: "Daily 25 Chip Freezeout", "Classic 0.5/1 Games".
- Real-money prices (Diamond packs, memberships, the Daily Bonus value): "4.99 USD", number then USD.
- Admin and operator pages (BBJ analytics, BBJ thresholds, club settings rake cap, analytics dashboard): figures without the sign, "Chips" in the sentences ("Biggest 1,200 Chips", "Backup Above Its 500 Chip Floor", "Announce At (Chips)", "3-20 Chips Depending On Blinds").
- The BBJ celebration and hit card, the Run It Twice panel and equity line, the session HUD ("Chips/Hr"), both wheel prize lists, the club stats coin glyph (now "C") and the dev buttons showcase.
- The BBJ hit card's accessible label said "Won 120 Dollars"; it says "Won 120 Chips".

## The Guard

`scripts/ci/check-ui-dollar.mjs` is started by `scripts/ci/check-ui-text.mjs`, the em dash gate, so it runs wherever that gate already runs: pre-push, the CI invariant guards and `scripts/ci/all-gates.sh`. Both verdicts print before either fails. It also runs alone: `node scripts/ci/check-ui-dollar.mjs`. It parses `src/`, `server/src` and `public/` with the TypeScript compiler and reads only text that can render: string literals, the static parts of template literals, JSX text and attributes, CSS `content:` values and the two HTML entry pages. It counts every spelling of the sign (the character, its fullwidth and small forms, `&#36;`, `&dollar;`, the JavaScript escapes). It allows only what cannot reach a screen: interpolation syntax, regex sources, back-reference replacements such as '$1', console and logger text, SQL positional parameters, JSONPath and types. Comments and tests are not scanned.

One file is exempt, by name and with its reason: `src/utils/pokerStarsExport.ts` writes the PokerStars hand-history grammar for Hold'em Manager and PokerTracker. That file is downloaded and read by a tracker, never shown on a Club Arena screen, and the grammar marks every cash amount with its currency symbol.

Law: `tests/the-club-arena-shows-no-dollar-sign.law.test.ts` runs the gate on a sample "$100" UI string and every other shape a rendered "$" has taken here (it must fail and name each), on the allowed machinery (it must pass) and on the swept tree (it must pass), and pins the single exemption. It also runs `check-ui-text` over the real tree with a "$100" fixture handed to the dollar half, and that must fail too. The tests that expected the old strings were updated with them.

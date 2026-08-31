# 2026-08-31 — The casing gates could not see most of the copy

Dan: "Make sure the first letter of every word on every single page and sub page
is capitalized, and remove any and all M bars."

Both rules already had CI gates, and both gates were green. They were green
because of what they were not looking at.

## What the gates could not see

`check-title-case` parsed **JsxText nodes in `src/**/\*.tsx`** and nothing else.
`check-ui-text` walked **`src/`\*\* and nothing else. Between them that left four
categories of player-facing copy unguarded:

| Category            | Found | Example                                                                   |
| ------------------- | ----- | ------------------------------------------------------------------------- |
| String attributes   | 324   | `aria-label="Mark as read"`, `placeholder="Search all players and clubs"` |
| Template attributes | 54    | ``aria-label={`${wagerVerb} amount`}``                                    |
| Ternary attributes  | 102   | `aria-label={exporting ? 'Cancel CSV export' : 'Export as CSV'}`          |
| The string table    | 37    | `src/i18n/index.ts` — `seat_open: 'Seat {{number}}: open - click to sit'` |
| The HTML shell      | 3     | `index.html` meta description, `og:title`, `twitter:title`                |

## Why each one matters

**`aria-label` is not decoration.** It is the _only_ text a screen-reader user
gets for a control with no visible label, and the table was full of them:
"(all in)", "(folded)", "Seat 3: open - click to sit", "Raise amount".

**The i18n table is copy by definition** and reaches the screen through `t(...)`,
which is an expression — so neither pass could ever have seen it. All 37 of its
uncased strings are table accessibility labels.

**The HTML shell is the most-read copy in the product.** The meta description,
`og:title` and `twitter:title` all read "Club Arena — Private Online Poker
Clubs". That is what a search result and a shared link render, and it is the only
copy a player sees _before_ they have an account. It carried the banned character.

## The bug the gap had already caused

`MultiTablePage` carried a literal `aria-label="Raise amount"` and the i18n table
carried `raise_amount_label: 'Raise amount'`. Casing the literal — which the new
attribute pass does — made the two spellings of the same control diverge, and the
test suite caught it. Both are now cased at their source, which is the point:
one label, one spelling.

## What is deliberately still exempt

- **Source comments**, per the existing policy — this codebase uses them as
  decision records and rewriting thousands would bury every real change.
- **`server/src` log lines** (281 of them). Every one is `console.log` output
  behind a `[GameServer]` prefix. They are operator text, the same category as
  comments, and no player ever sees one.
- **The dated audit reports** in the repo root. They are historical records, not
  app UI.
- **Expressions**, which are cased at their source — that is the rule the i18n
  pass now enforces rather than assumes.

## Safety

The riskiest part is rewriting inside templates, so the passes are narrow by
construction:

- only the **literal spans** of a template are cased; every `${...}` hole is left
  exactly as written;
- the **unit-suffix guard** from the JsxText pass carries over, so `${n}s` and
  `${x}px` are not turned into `${n}S`;
- **`{{token}}` interpolation keys are masked** before casing and restored after
  — casing `{{amount}}` to `{{Amount}}` would break the substitution rather than
  the sentence. Verified: zero uppercase tokens remain in the table;
- `notProse` exempts slugs, example values (`e.g. 40`), URLs and anything with no
  letters, because a gate that renames an identifier is worse than one that
  misses a word.

Two `.toLowerCase()` calls inside `aria-label` templates were removed rather than
fought: `wagerVerb` is already "Bet"/"Raise", so the label now reads "Open Raise
Panel" instead of the "Open raise Panel" the casing pass would otherwise have
produced.

## Verification

Both gates were verified to FAIL as well as to pass: reintroducing a single em
dash into `index.html`'s `og:title` turns `check-ui-text` red and names the line.

`npx tsc --noEmit` clean. Full client suite: **752 files, 10,551 passed, 1
skipped, 0 failed** — including 36 test expectations updated in the same commit,
because this deliberately replaced behaviour those tests pinned.

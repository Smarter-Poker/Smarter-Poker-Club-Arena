# The Title Case surface no gate could see

2026-08-31. Dan: "MAKE SURE THE FIRST LETTER OF EVERY WORD ON EVERY SINGLE PAGE
AND SUB PAGE IS CAPITALIZED AND REMOVE ANY AND ALL 'M BARS' AS THEY ARE BANNED
FROM USE."

## The em dashes: already closed by somebody else

Six em dashes were shipping to players as `&mdash;` entities, which
`check-ui-text` ignored because its header lists entities among the things it
skips. Found by scanning the DEPLOYED bundle rather than the source.

By the time this branch was rebuilt onto current main, **#2284 had fixed all
six and taught `check-ui-text` the entity forms** — more thoroughly than the
version drafted here, since theirs also catches escaped `—` spellings. So
nothing is changed here. Recorded because the finding is what prompted the
gate, and because the technique is worth keeping: **a gate that reads only
source can miss what the browser paints; scan the bundle.**

## The casing hole: two surfaces, neither gate could see them

`check-title-case` reads `JsxText` nodes and says so deliberately, because
casing arbitrary expressions renames identifiers. `check-nav-title-case` covers
the nav registry. A browser paints plenty from neither:

```
<input placeholder="Enter table name here..." />   <- a string ATTRIBUTE
<td>{ok ? label : 'Jackpot not available'}</td>    <- a string in an EXPRESSION
```

`scripts/ci/check-painted-text-case.mjs` covers both, with `--fix`, wired into
CI and the pre-push hook beside its two siblings. #2284 fixed most of the
attribute half independently; **19 remained on current main**, almost all of
them in the expression half — statement labels on Club Data and Union
Statements, the workspace tiles on Profile, and the Home page shortcuts.

## What this gate refuses to touch, and why that matters more than what it fixes

The first draft of this script was dangerous, and the rebuild is what caught
it. Three classes of false positive, each of which would have shipped a real
bug:

**1. CSS class names.** `let eqSide = ' equity-overlay--above'` became
`' Equity-Overlay--Above'`. `.equity-overlay--above` is a real rule in
`TablePage.css`, so that silently broke the equity overlay's position on the
felt — valid TypeScript, no test asserts on a class name, and the page still
renders. The leading space was what fooled the check: `" equity-overlay--above"`
contains whitespace, so a naive "has a space, must be a sentence" test passed
it. **The value is trimmed before that test now**, and `--` is excluded
outright.

**2. Compared values.** `{inv.direction === 'union owes club' ? '+' : '-'}`
puts a database enum inside a JSX expression. Casing it would not change a word
on any page; it would break the comparison and **flip the sign on every invoice
amount**. A literal whose parent is an equality test, a `case` label, or an
`includes`/`startsWith` argument is now skipped. The rendered halves of that
ternary are still checked.

**3. Example values in placeholders.** `your@email.com`,
`https://example.com/banner.png`, `/images/promo.png`, `spring_spins_push`.
"Your@email.com" is not an address anybody should type. Emails, paths, URLs,
snake_case identifiers and file names are excluded.

The prose test is the whole safety of `--fix`, so it is deliberately narrow: a
string qualifies only if it still contains whitespace after trimming, is six
characters or more, has a three-letter run, and contains none of the CSS,
identifier, path or address markers above.

## A bug in the casing rule itself

Copying `popupStyle.formatPopupText` treats an apostrophe as a word boundary,
which turns "what you'd like" into "What You'**D** Like". An apostrophe opens a
word here only when it follows a boundary itself, so `'quoted'` still
capitalises and `You'd` is left alone. **popupStyle has the same quirk on every
toast** — a separate call for Dan.

## Deliberately not touched

`aria-label` and friends. They are read aloud, not painted, and a screen reader
pronounces a word the same in any case. They are assistive text rather than
page text and they outnumber the painted strings; including them is one line in
`VISIBLE_ATTRS` if Dan wants it.

## Verification

`tsc` clean. Client unit **498 files** and non-unit **259 files**, all passing.
`check-title-case`, `check-nav-title-case`, `check-painted-text-case`,
`check-ui-text` and `check-no-emoji` all green. Verified after the fix that the
three `equity-overlay--` class names and all four `'union owes club'`
comparisons are still lower case.

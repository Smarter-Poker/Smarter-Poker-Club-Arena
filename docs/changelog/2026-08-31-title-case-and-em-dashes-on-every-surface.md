# Title Case on every surface, and the em dashes the gate could not see

2026-08-31. Dan: "MAKE SURE THE FIRST LETTER OF EVERY WORD ON EVERY SINGLE PAGE
AND SUB PAGE IS CAPITALIZED AND REMOVE ANY AND ALL 'M BARS' AS THEY ARE BANNED
FROM USE."

Both rules already had gates. Both gates had a hole, and the holes were the
same shape: they inspect the text a browser paints from JSX _children_, and a
browser paints plenty of text from somewhere else.

## The first hole: text painted from an attribute

`check-title-case` reads `JsxText` nodes and says so deliberately, because
casing arbitrary expressions would rename identifiers. `check-nav-title-case`
was added later for the nav registry, which renders `{item.label}` from config.
Between them they miss every string a browser paints from an ATTRIBUTE:

```
<input placeholder="Enter table name here..." />
<Toggle label="Auto restart" />
<span title="Playing now" />
<img alt="Club logo preview" />
```

**125 of those were lower case**, across 52 files, including page copy on the
create-table form, the cashier, the hand history panel and the table HUD.

`scripts/ci/check-visible-attribute-case.mjs` closes it, with `--fix`, and is
wired into CI and the pre-push hook beside its two siblings.

### What it deliberately leaves alone

**`aria-label` and friends: 252 of them, untouched.** Those are read aloud, not
painted; a screen reader pronounces a word the same in any case. They are
assistive text rather than page text, they outnumber the painted strings two to
one, and mass-rewriting them would put a large accessibility-adjacent diff
through fifty files this change has no other reason to open. The attribute
names are one line in the script if Dan wants them included.

Also left alone, for the reason `check-title-case` gives: values that are not
plain string literals, words already shouting (VIP, BBJ, NLH), and words
starting with a digit.

### A bug in the first version of the rule

The obvious implementation copies `popupStyle.formatPopupText`, which treats an
apostrophe as a word boundary. That is right for `'a quoted phrase'` and wrong
for a contraction: it turns "what you'd like" into "What You'**D** Like". The
first run produced exactly that. An apostrophe now opens a word only when it
follows a boundary itself, so `'quoted'` still capitalises and `You'd` is left
alone. Worth knowing that popupStyle has the same quirk on every toast.

## The second hole: `&mdash;`

`check-ui-text` reported OK for months while **six em dashes were shipping to
players**, because they were written as HTML entities rather than as the
character, and the script's header lists entities among the things it ignores.

That exemption is right for `&nbsp;` and `&rsquo;`. It is wrong for `&mdash;`,
which is an em dash the moment a browser paints it.

**Found by scanning the deployed bundle rather than the source** — the same
technique that settled the earlier phases. Two shipped assets carried them:

| surface              | text                                                          |
| -------------------- | ------------------------------------------------------------- |
| `BBJTicker`          | "No Hits Yet — It Could Be You."                              |
| `BBJRulesPanel`      | "...(In Omaha Games, Exactly Two) — For Both The Losing..."   |
| `BBJRulesPanel`      | "...Set By The Stakes You Were Playing — Not The Whole Pool." |
| `BBJAdminAnalytics`  | "Pool Split — Main $..."                                      |
| `BadBeatJackpotPage` | "...Of The Pool Shown Above — Not The Whole Pool."            |
| `ClubDataPage`       | the date-range divider, a bare `—` between two dates          |

Each is replaced by what the dash was actually doing, following the same rule
`popupStyle` applies at render: a clause break becomes a period, a label
separator becomes a colon, and the range divider becomes a hyphen.

`check-ui-text` now detects the entity forms too, including the numeric ones
(`&#8212;`, `&#x2014;`), because a rule that only knows the friendly spelling
is a rule with a hole in it. It **reports** rather than auto-rewriting them:
the correct replacement depends on what the dash was doing, and guessing would
produce exactly the sentence-mangling the `--fix` path avoids elsewhere. The
gate was then verified by reintroducing an entity and confirming it fails, and
removing it and confirming it passes — a guard that cannot fail is not a guard.

## One test followed a button

`handHistoryMoneyAgreement` clicks `getByTitle('Export all hands')`. The title
is Title Cased now, so the query is too, in the same commit. The behaviour
under test is unchanged.

## Verification

`tsc` clean. Client unit **495 files**, all passing. `check-title-case`,
`check-nav-title-case`, `check-visible-attribute-case`, `check-ui-text` and
`check-no-emoji` all green. Two non-unit suites failed once under parallel load
and pass in isolation; the machine was running several suites at once.

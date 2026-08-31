# 2026-08-31 — Dan's two copy rules reach the surfaces the gates could not see

Phase 7 verification pass. Phase 7 itself was found complete, merged and live.
These are the defects the pass turned up against Dan's two standing rules.

## 1. An em dash was live in production, written in the one form the gate could not read

`src/components/handdetail/HandDetailView.css` carried `content: '\2014'` — the
**CSS unicode escape**. `check-ui-text` states in its own header that it reads
CSS `content:` values, and it does: it looked for the character itself, for
JavaScript's `—`, and for HTML entities. CSS writes none of those. CSS
writes a backslash and bare hex.

So the character never appeared literally in source, the gate reported OK, and
production rendered an em dash on every run-2+ showdown row of the hand detail.

**Found by scanning the deployed bundle, not the repo.** Of 374 assets reachable
from the served `index.html`, exactly one stylesheet contained a dash the rules
forbid.

Fixed to a hyphen, and the gate now reads `\2014`, `\02014` and `\002014`, with a
guard so `\20145` — a different codepoint — does not match.

## 2. Three native dialogs were not Title Cased, on the one popup surface the Toast layer cannot reach

`popupStyle.formatPopupText` applies both of Dan's rules to every message the
Toast layer renders, which is why hundreds of lowercase toast strings in source
are correct on screen. `confirm()`, `alert()` and `prompt()` bypass it entirely
and paint the browser's own dialog with the raw string.

| File                           | Was                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `AgentFinancialPortal.tsx:172` | `prompt('Amount to transfer to Player Wallet?')`                                  |
| `CreateClubModal.tsx:309`      | `confirm('Close Create Club? Your text settings will remain saved as a draft.')`  |
| `ClubSettingsPage.tsx:312`     | `confirm('You have unsaved settings changes. Leave this page and discard them?')` |

`check-title-case` covers JSX text, UI attributes, UI properties and render
expressions. A call argument is none of those. It now reads
`confirm()`/`alert()`/`prompt()` too, and all three strings are Title Cased.

## 3. A gate exemption documented a reason that was false

`check-ui-text` exempts four files, on the note that `titleCase.ts` "writes them
as escapes so there is nothing here to match". It does not: lines 87-88 hold the
characters **literally**. The exemption is therefore load-bearing, not
belt-and-braces — removing it would re-run the incident where `--fix` rewrote
the stripper's own character class into a meaningless range and silently
disabled the rule. Note corrected; all four exemptions re-verified as strippers
with no player-visible dash.

## Pinned

`tests/unit/houseCopyRulesReachEveryPage.test.ts` — 10 tests. The CSS escape and
each native dialog form are proven caught by running the real gates against
fixtures, and proven not to false-positive on a different codepoint or a
non-literal argument. The `titleCase.ts` exemption is justified **behaviourally**
— `stripEmDashes` is imported and run — rather than by grepping the file, which
is what `report-source-grep-tests --ratchet` asks for and which caught the first
draft of this test.

## Scope, stated plainly

Zero em dashes now remain anywhere a player can read: `src/`, `public/`,
`index.html` and the reachable deployed bundle all scan clean, with the four
strippers as the only exemptions. Em dashes DO remain in source comments, server
console logs, test names and docs — roughly 20,000 of them. None reaches a
screen, and `check-ui-text` has excluded comments by design since it was written.
Rewriting them is a separate mechanical pass, not this one.

## Verified

- Both gates proven red on the exact defects that shipped, then green on the fix.
- CSS escape guard proven not to fire on `\20145`.
- Client suite **758 files / 10,615 tests pass**. `tsc --noEmit` exit 0.

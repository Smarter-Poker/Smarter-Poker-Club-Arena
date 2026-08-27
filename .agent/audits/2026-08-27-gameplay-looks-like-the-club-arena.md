# 2026-08-27 — Phase 4: gameplay must look like the Club Arena

Dan: "MOVE ONTO THE NEXT PHASE OF AUDITS, ENHANCEMENTS AND IMPROVEMENTS.
GAME PLAY MUST LOOK LIKE THE CLUB ARENA."

## What "looks like the Club Arena" means here

Not an opinion. This repo already writes it down, and already enforces two
thirds of it mechanically:

| Rule                                            | Source                                         | Enforced by                       |
| ----------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| No em dashes in player-facing text              | Dan 2026-08-20                                 | `scripts/ci/check-ui-text.mjs`    |
| Page copy is Title Cased                        | Dan 2026-08-21                                 | `scripts/ci/check-title-case.mjs` |
| **"NO EMOJIS - EVER"**                          | `.agent/workflows/design-guidelines.md` rule 1 | **nothing**                       |
| Facebook palette, no reference-image gold/amber | same file, rule 2                              | nothing                           |
| No user-visible PokerBros references            | same file, rule 3                              | nothing                           |

The third rule was the unenforced one, and gameplay is where it had rotted
furthest. So this phase did two things: fixed what had drifted, and made the
rule mechanical so it cannot drift again.

## The flagship finding: tapping your own avatar opened a competitor mock

`TablePage.onAvatarClick` -> `setShowProfileModal(true)` -> `ClubProfileModal`.
That is a live, reachable, mid-hand gameplay surface, and what it opened was a
traced screenshot of a competitor's profile sheet. The file said so itself:

    {/* Mock emojis as per image */}

Every element of it was scenery:

- **four tab buttons** (clock, snowflake, "V", smiley) whose `activeTab` state
  was read in exactly four places, all of them the tab's own `className`. No
  tab revealed different content, because there was no content;
- **a "Tag" text input** whose value went into `useState` and was never read
  again. Anything a player typed was silently discarded on close;
- **two badges** hard-coded to "Newbie" and "Normal";
- **"Recently Used"**, followed by an empty `<div>`;
- **"Character Emojis"**: `[...Array(10)]` placeholder squares, each priced
  "diamond-emoji 2", buying nothing;
- **"Free Emojis Left: 0"**, from a prop no caller passes.

Its CSS was equally off-brand: `z-index: 10000` jumped the entire `--z-*`
scale in design-tokens.css (so it painted over toasts and confetti that are
deliberately ranked above modals), a hard-coded `#ffa800` orange close button
in an app whose guidelines forbid the reference image's gold and amber, and
`font-family: sans-serif` opting one sheet out of the app font.

**Now:** the same tap, answered honestly. Identity (avatar, username, the real
`profiles.player_number` the rest of the app calls "ID", club name) and how the
session at THIS table is actually going: stack, net, big blinds, bought in,
hands, hands won, VPIP, PFR, time, hands per hour.

Every figure comes from `sessionStatsService.getStats(tableId)` - the same
source the Session Stats panel reads, kept live by the same two bus events, so
the two surfaces cannot disagree. `tableId` is now passed through
`TableModalsLayer`. Nothing on the sheet is invented: a figure that cannot be
read renders as `--` rather than as a confident zero. The CSS was rebuilt on
design-tokens.css, so the sheet follows the table theme the player chose, and
it gained Escape-to-close, a scroll lock, `role="dialog"`, and 44px touch
targets it never had.

Pinned by `tests/table-profile-is-real.test.tsx`, which RENDERS the component
rather than grepping it: it fails if the sheet stops reading the session
service, which is the specific way this could rot back into scenery.

## The gate that was missing

`scripts/ci/check-no-emoji.mjs`, in the same idiom as its two siblings: strip
comments, scan what remains, report file and line.

It enforces the correct definition - Unicode **Emoji_Presentation**, plus
U+FE0F, the variation selector that demands emoji rendering of whatever
precedes it. That definition is the entire point, because it is what lets the
gate leave alone the typography the Club Arena is actually built from:

    card suits    ♠ ♣ ♥ ♦      poker iconography, all over the felt
    arrows        ← → ↑ ↓      flow, sorting, deltas
    close, tick   ✕ ✓          CLAUDE.md permits plain Unicode symbols
    menu, gear    ☰ ⚙          text-presentation glyphs in the page font

Add U+FE0F and it becomes a picture, and the gate says so: `⚙` is a gear in
your font, `⚙️` is an emoji. A `\p{Emoji}` property escape would have been the
obvious implementation and is wrong - it is true for the ASCII digits and for
`#` and `*`, so that gate fails on every number in the codebase.

Comments are ignored, for the reason check-ui-text gives for the same choice:
they never reach a player, this codebase uses them heavily for decision
records, and rewriting the ~30 decorative emoji in gameplay file headers would
be a large diff with no user-visible effect burying the real change under it.

The two emoji pickers are allowlisted. Emoji are the product there.

Wired into `.github/workflows/ci.yml` beside the other two copy gates and into
`scripts/ci/all-gates.sh`. Pinned by `tests/no-emoji-gate.test.ts` - a gate
that exists but runs nowhere is the state we were already in.

## Everything the gate found, and what it became

24 player-facing emoji, app-wide (the profile sheet's five were already gone
with the rewrite above):

| Where                                               | Was                                | Now                                                                  |
| --------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `SessionHUD.css` hot-streak badge                   | flame `::before`                   | removed; the badge already reads "19W" in amber and pulses           |
| `AchievementsPage` + `AchievementService` `wins_10` | raised fist                        | `☆` - the wins ladder is already `☆` -> `★` -> `▲`                   |
| `DailyLoginReward` claim button                     | sparkles                           | plain "Claim Reward"                                                 |
| `ChallengeToastListener`                            | trophy                             | plain text                                                           |
| `DailyChallengesPage` (5 sites)                     | dice, snowflake, diamonds          | the words: "Reroll (10 Diamonds)", "Buy Streak Freeze (5K Diamonds)" |
| `LeaderboardPage` (5 sites)                         | gem/coin/money-bag/gear            | "Paid 1,000 Diamonds"; bare "Pay Out" and "Settings"                 |
| `DiamondsTab` nav (3 sites)                         | bag, trophy, gamepad               | `◈`, `★`, `♠` - the VIP row beside them already used `♛`             |
| `HelpPage` (3 sites)                                | speech bubble, envelope, magnifier | inline SVG icons                                                     |
| `HandReplayerPage` sound toggle                     | speaker on/off                     | "ON" / "OFF" - literally the replacement design-guidelines.md names  |
| `ShareHand` Telegram                                | aeroplane                          | empty, matching the WhatsApp button beside it                        |

## Audited and deliberately left alone

- **PokerBros references in player-facing code: zero.** Rule 3 is clean.
- **"bots":** one hit, in the union anti-collusion panel, describing an actual
  cheating bot in a colluding ring. That is the correct English word for that
  thing and is not the platform's AI players, who are horses. No change.
- **z-index across ~20 gameplay files** diverges from the `--z-*` scale, but
  those are deliberate per-file stacking decisions carrying their own
  rationale comments ("above ActionPanel, below global toasts"). Putting them
  on the token scale is a layering refactor with real mid-hand regression risk
  and no visual gain; it wants its own phase with a before/after screenshot
  pass, not a drive-by in this one. Recorded here rather than swept.
- **`font-family: 'JetBrains Mono'`** in InsuranceModal, HandHistoryPanel and
  HandNotation is intentional tabular typography for figures, not a component
  opting out of the brand.

## The gate went green while two emoji were still shipping

Worth recording plainly, because the lesson is the whole point of the phase.

After every local gate passed and PR #1440 merged, production was verified by
DECOMPILING the deployed bundle rather than by trusting the scan. The shipped
gameplay chunk still contained two emoji: a direct-hit target and a gift box,
in the tournament `bounty_collected` and `mystery_bounty_revealed` overlays.

They were invisible to the gate because they were not written as characters:

    icon: '\u{1F3AF}',
    icon: '\u{1F381}',

An escape renders identically to a pasted emoji and is a single keystroke away
from any author or autofixer. A gate that a keystroke walks around is not a
gate. `check-no-emoji.mjs` now decodes every `\u{...}` and `\uXXXX` (surrogate
pairs included) before scanning, and reports the escape the author wrote rather
than a character their editor may not render. Proved against all three forms
with a throwaway probe file: escaped, pasted, and a Misc-Symbols
emoji-presentation character. A third escaped emoji, a clipboard in
`TransactionLedgerView`, fell out of the same sweep.

The three are now `◎`, `◈` and `▤`, matching the typographic vocabulary the
overlay and the achievements ladder already use.

## Verification

`bash scripts/ci/all-gates.sh`: tsc clean, all nine house-rule gates OK
(including the new one), full vitest suite OK, production build OK.

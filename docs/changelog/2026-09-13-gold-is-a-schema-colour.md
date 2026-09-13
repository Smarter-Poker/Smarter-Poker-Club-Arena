# Gold is a schema colour: the browns and mauves come off the finished surfaces

2026-09-13. Branch `fix/gold-is-a-schema-colour`. Follows #4497.

Dan's law: "ALWAYS USE SMARTER.POKER COLOR SCHEMA COLORS, NO BROWNS OR PINKS."
Dan, today, after a first attempt replaced the browns with darkened copies of
themselves: "no you must stick to the smarter.poker color schema." That attempt
was reverted on sight - 24 computed tones are 24 colours the schema does not
own - and this is the one that obeys him.

## The rule that decided every replacement

Every colour goes to a token the LIVE schema already has. The live schema is
`src/styles/club-engine.css` - `design-system.css` and `globals.css` are not
imported by `main.tsx` and their tokens do not exist at runtime. By role:

| role                                 | count | became                                                                       |
| ------------------------------------ | ----- | ---------------------------------------------------------------------------- |
| dark stop of a gold ramp             | 9     | `#ffa500`, the dark end of the schema's own `--gradient-gold`                |
| a token named brass or identity-gold | 3     | `#d6ad52`, the brass the no-yellow law test sanctions as the warm accent     |
| a token named gold-deep or gold-lo   | 2     | `#ffa500`                                                                    |
| bevel under a gold plate             | 2     | `--club-black` (`#050507`) - a shadow is black                               |
| warm card border                     | 7     | brass at 45% over black, the same technique the console's engraved rules use |
| mauve border on a danger control     | 2     | `--danger-red` at 55%                                                        |

Plus the invite page's `--iv-gold` from `#d4af37` to brand `#ffd700` - the
ruling the standard recorded on 2026-09-09 and nobody applied.

## Left alone, on purpose

`.bronze-bar` on the leaderboard (`#a6673e`) is the third-place medal. Bronze
is brown because bronze is bronze; making it brass would make first and third
the same colour. If Dan wants it gone, it is one line.

## Not touched

The three account sheets the no-yellow law protects (`FriendListPanel`,
`ReferralDashboard`, `PlayerActivityFeed`), the HUD and the must-move modal.
Pale gold highlights (`#ffe29b`, `#f1d58e` and kin) are neither brown nor pink
and are out of scope here.

## Verification

Copy gates and no-emoji: OK. 1,398 tests pass across the 89 files that name a
touched surface, plus the no-yellow law and the must-move palette audit. No
test pins any replaced value. 25 replacements in 14 stylesheets, each asserted
to match exactly the expected number of times before it was made.

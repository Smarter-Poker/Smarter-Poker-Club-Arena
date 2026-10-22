# Every Horse Types Like Its Own Person (2026-10-22)

## Owner Instruction

"there should be like 100+ different short phrases and things said, and every horse should be different and say different things, in different styles, (like text styles) it must be 100% unique for each horse, some use emoji's some don't."

## What Changed

- `horseTableTalkLines.ts`: the pool now holds 132 distinct phrases (pot_lost, pot_won and all_in widened across all three voices).
- `horseVoiceStyle.ts` (new): a per-horse fingerprint read from the horse id by hash. It sets the share of the pool the horse ever uses and which lines (35 to 74 percent), case (lowercase, Sentence case, as written, rare ALL CAPS), punctuation (none, period, !, !!, ...), shorthand ("nh", "ty", "gl", "u" or the long forms), laugh (lol, haha, lmao, hah, hehe, lolol, ha), word stretching ("niiice"), an occasional sign off (bro, man, sir...), emoji (about half the fleet never uses any; the rest have their own two to four favourites per mood, used rarely or often), chattiness (0.35x to 1.6x how often it speaks) and throwiness (0.2x to 1.8x how often it throws).
- `HorseTableTalk.ts`: lines come from the horse's own share, are typed in its style, and pass `sanitizeStyledLine`, which admits only the style layer's own emoji. Speak chance is scaled per horse.
- `HorseTableGestures.ts`: each horse throws only its own favourite items and at its own rate.

## Proof

`horseVoiceStyle.test.ts`: 1,000 horse ids give 1,000 distinct fingerprints; every pool line typed by 150 horses passes the chat door; emoji only from the allowed set; every horse keeps at least one line per pool.

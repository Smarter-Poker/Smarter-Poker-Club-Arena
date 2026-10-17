# Complete Your Profile answers honestly and saves in one trip (2026-10-17)

This is a follow-up to the iPhone ENTER ARENA fix (#7285), from a line-by-line pass over the screen.

- **Case duplicates read as Taken.** The availability check ended in `.maybeSingle()`. Two existing accounts that differ only by case (`Tom`, `tom`) both match the case-insensitive search, and `maybeSingle` answers two rows with an error, so the alias showed neither Taken nor Available. It now asks for `.limit(1)` and reads any row as Taken.
- **A stale answer is never shown.** The debounce cancelled the timer but not a request already in flight. A slow answer about an alias the player had typed over could land after the new one and paint Taken (or Available) on the wrong name. Each question is numbered, and only the newest answer is applied.
- **One round trip on ENTER ARENA.** The alias row and the avatar are independent writes. They now go out together instead of one after the other, and both results are still checked before the player is let in.

Pinned in `tests/the-iphone-tap-still-submits.law.test.tsx`, with two new cases. The stale-answer case was proved to fail without the guard.

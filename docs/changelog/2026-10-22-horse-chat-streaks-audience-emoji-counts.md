# Horse Chat: Streaks, Audience, Emoji Counts And Typos (2026-10-22)

## Owner Instructions

- "never always use 3 emoji's it should be 1-5 and always randomly choses, never ever always 3"
- "HOW ELSE CAN THIS BE IMPROVED, ENHANCED OR OPTIMIZED STILL?"

## What Changed

- Emoji runs are 1 to 5, rolled per line (weights 40/25/17/11/7 percent), sometimes one favourite repeated and sometimes a mix of the horse's favourites.
- Typos: about 40 percent of horses occasionally swap two neighbouring letters in a word (6 or 14 percent of their lines); the rest never do.
- Tilt and heater: a horse that loses three or more showdowns in a row at a table talks like it ("cant catch a break tonight", "every hand, every single hand"); one that wins three or more in a row talks like a heater ("running lucky tonight", "whos next"). 33 new lines, 165 in all.
- Removed "rigged lol" from the pool: a horse must never suggest the platform is rigged.
- Audience: measured before this change, 879 horse chat lines and 1,470 horse throws in one hour, with 874 of those lines at tables no person had open (and only 8 human chat lines in 7 days). Throws and reactions now happen only when somebody has the table open (an engine TableStateHub subscriber; horses have no browser). Chat keeps one line in ten at unwatched tables so the history a player sees on arrival is not empty. This removes most of those database writes.

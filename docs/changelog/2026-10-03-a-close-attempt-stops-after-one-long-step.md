# A close attempt stops after one long step (2026-10-03)

## What happened

The chunked weekly close (`20261003101805_the_weekly_close_commits_one_round_at_a_time`) proves the
union P&L evidence step by step and stopped an attempt once less than 6 minutes of its 9-minute
budget were left. Measured on 2026-10-03 for the Midway week 2026-09-21..28 (one chunked close in
three attempts, job 414, then every step re-proved fresh in jobs 415-417 with identical results):
opening boundary 157 s, closing boundary 76 s, original flows 93 s, touched registrations 46 s,
earned plan 193 s and 320 s, club rows about 50 s. At the ~2.3x volume of the week closing
2026-10-05 the earned plan alone can take 440-740 s, so one attempt could prove the touched
registrations, start the earned plan and lose both to job 272's 720 s statement timeout; and an
attempt on the 50-minute fallback budget would have proved every remaining step in one transaction.

## Fix

Migration `20261003105926_a_close_attempt_stops_after_one_long_step`: `fn_accounting_close_warm_stop`
also stops an attempt that proved and kept a step once 60 seconds have passed since it began. Short
steps are still proved together; each long step is proved alone, on either budget. Nothing changes
outside a chunked union close attempt.

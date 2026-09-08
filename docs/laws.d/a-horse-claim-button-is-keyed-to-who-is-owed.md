# tests/a-horse-claim-button-is-keyed-to-who-is-owed.law.test.ts

The horse claim lived inside record_daily_challenge_event, so it ran only when an
event arrived for that horse: a horse that stopped playing stopped claiming,
while a human who stops playing keeps a claim button for the full seven days.
Twenty-three quiet horses accumulated 759 rewards worth 51,380 diamonds with 114
hours from expiry. fn_ca_horse_claim_due is keyed to who is OWED, oldest first,
on the same minute cadence the outbox drain already used, paying through the same
body a human's click reaches - it is not a repair job, it IS the button, the same
legitimate horse branch as HorseLogic and scheduleHorseAction. Moving it out of
the event path also removed the two duplicate copies of the loop. The health row
now separates a horse owed a claim (a defect, because nothing else presses its
button) from a human owed one (a person who has not logged in), after reporting
19 human rewards as a horse-mechanism failure.

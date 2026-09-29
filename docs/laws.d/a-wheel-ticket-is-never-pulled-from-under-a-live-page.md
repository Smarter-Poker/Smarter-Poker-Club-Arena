# tests/a-wheel-ticket-is-never-pulled-from-under-a-live-page.law.test.ts

Dealing a Diamond Wheel ticket never deletes a ticket another page of the same player is still holding: fn_wheel_commit sweeps only that player's expired, unconsumed tickets (migration 20260922032153, installed behind a preimage check in one bounded transaction), and no later migration may delete from wheel_seed_commits without the expires_at < now() condition.

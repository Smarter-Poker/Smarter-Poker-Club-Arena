# 2026-10-17 - A new player is asked one thing at a time, and the first run is certified on an iPhone

Follow-up to `2026-10-17-the-iphone-tap-still-submits.md` (#7285).

## What a referred player met

TomTomTamale and Dinodollars arrived on `/invite/<SHARK CLUB>?ref=1`. In order:

- the terms;
- Complete Your Profile, with the Club Arena welcome already mounted under it (9999 vs 10000);
- the welcome;
- the daily bonus sheet, still on the invite page;
- only then the Join button.

Dinodollars joined eight minutes after verifying his email.

## Changes

- **The welcome waits for the profile gate** (`AppLayout`). It mounts, and holds the prompt lane, only after the gate has decided and is down. A new player now finishes one pop-up and meets exactly one more.
- **The daily bonus never opens on an invite landing** (`isQuietPath`: `/invite/...` and `/i/...`). The landing's one job is the join. The sheet opens in the club, once joined.
- **The first run is certified after every client publish.** `post-deploy-e2e.yml` now runs a new first-run lane:
  - `production-e2e-account.mjs create-first-run` makes a disposable account exactly as a sign-up arrives: alias chosen, no arena avatar. Every other certification account is normalized past the gate, which is why the gate went uncertified.
  - `tests/e2e/production-first-run-iphone.spec.ts` runs on real WebKit with an iPhone 13 profile (`webkit-first-run` project). It walks terms -> profile -> avatar gallery -> taps ENTER ARENA where a finger lands. It requires the profile write and the gate down within 8 s, then the welcome after it and a durable `complete` on reload. It never joins a club.
  - `cleanup-first-run` hard-deletes the account through the reserved-namespace door.

The spec was run against production before merge (Chromium with an iPhone profile; WebKit is not installed in that sandbox). It reached the profile write in 345 ms and failed only on the one-prompt assertion this change ships.

## Pins

- `tests/first-run-asks-one-thing-at-a-time.law.test.ts`

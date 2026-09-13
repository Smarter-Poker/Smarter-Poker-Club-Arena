# Commander Staff Session Secret Rotation

This is not a Club Arena deployment procedure. Commander owns its staff
session secret, credential store, build, and release path in the
`Smarter-Poker/smarter-poker-commander` repository.

The earlier version of this file instructed operators to scrape Vercel and
Supabase credentials from a Club Arena workstation `.env` and call deployment
APIs directly. That path is retired. Do not put Commander credentials in Club
Arena env files, do not rotate them from this repository, and do not use a
Club Arena workflow to publish Commander.

Perform an authorized rotation only from Commander's current reviewed runbook
and credential authority. Verify the Commander health contract and signed-in
probe from the exact merged Commander build before closing the incident.

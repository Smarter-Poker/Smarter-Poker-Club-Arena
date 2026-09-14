# Seat-first creators retain their own request contract

Live engine logs at01:19UTC repeatedly refused satellite heads-up creation with `SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY`. The earlier paid-depth change, PR4533, incorrectly included `payout_percent` in both satellite heads-up and ordinary heads-up requests. The installed atomic creator accepts a deliberately narrower configuration and rejected the added field before inserting either row. This is a regression introduced by that change; earlier permissive RPC mocks did not exercise the current database request contract.

The engine removes paid-depth metadata from satellite heads-up and ordinary heads-up payloads. Their fixed payout/ticket rules remain unchanged. Field SNG, regular MTT and XMTT creators keep paid-depth selection. No database function, allowed-key list, grant, prize, target, stack, fee or existing tournament is changed.

## Verification

- Original actual caller tests: eight failures naming exactlypayout_percent; Spin's four cases and two controls passed.
- Repaired fifteen caller cases and existing MTT contract cases:39/2PASS. All current fields except the changing start timestamp match the payloads used by the native proof. Transport validates keys extracted from captured current SQL rather than assuming every RPC succeeds.
- Full service/tournament suites:5,350tests/350filesPASS, no skips. Final server build/typecheckPASS after correcting the test's intentionally partial RPC mock type.
- Native PostgreSQL17: eight groupsPASS against the **unchanged** captured `fn_create_seat_first_game_atomic(uuid,jsonb)`, bodyMD5b40dd95b7a87019070a8abf0fcc4fff3. Twelve actual payloads for three creators/twoowners/twostacks create one committed pair and exact replay; eight original payloads refuse without writes; changedtarget replay/freeze/browser-access refuse; late table insertion failure rolls back the tournament row.
- Private cluster stopped and removed. Fixture records captured274column types, actualpayload SHA256, source hash, result and limits. Synthetic defaults and purchase-freeze stand-in are explicit; no full production trigger graph, target admission, funding, JWT/HTTP or gameplay claim.

Source is limited to originalTournamentRecurringService lines3381/4264. See scripts/dev/fixtures/seat-first-caller-contract/README.md and scripts/dev/probe-seat-first-caller-contract-pg17.py. Existing full seat-first/satellite provider fixtures remain authoritative for broader qualification.

## Remaining release proof

Normal branch submission, required CI, exact served engine ancestry and actual successful satellite/headsup creation remain required. Serving wasb97e1680 when the live refusal was captured. No manual event/database mutation or deployment was made. R21's retained branch also carries the earlier caller rows and must compose this correction before later publication. Full MTT lifecycle acceptance remains open.

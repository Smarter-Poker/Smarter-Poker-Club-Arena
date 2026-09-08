# Hand-gap verification and remaining outliers

## Production verification, 2026-09-08 UTC

The normal 12:55 engine restart adopted e142d385, which contains #3731
(fe0af90b55), the unchanged-time-bank request optimization. All 226 tables
completed the eight resume waves. No forced restart was used.

Before adoption, a 106-second sample ending 12:50:29 on e692442a measured
sync_stacks means of 1898 ms cash, 1969 ms heads-up SNG, 1797 ms Spin,
and 2094 ms MTT. The rolling hand-gap median was 4067 ms and p90 6485 ms.

After adoption, a 169-second interval from approximately 13:04:47 to 13:07:36
on e142d385 measured sync_stacks means of 781 ms cash (319 calls), 749 ms
heads-up SNG (182), 701 ms Spin (557), and 811 ms MTT (409). Hand-history
means in the same interval were 724-784 ms. All those counter labels were
horse audience; these are fleet observations, not controlled human trials.
Other changes and load varied across the restart, so this is not an isolated
causal benchmark of #3731.

The later rolling 2000-sample health window had p50 2004 ms, p90 3716 ms,
maximum 20262 ms and 480 non-rebuy gaps exceeding 2500 ms. Rebuy pauses
are already excluded from these percentiles and maximum. The long outliers
therefore remain unresolved; the median is not evidence of complete repair.

## Diagnostic change

NextHandGapRecorder already retains table ID, timestamp and per-phase times
for at most 2000 hands within ten minutes, but its health snapshot discarded
the correlation and reported only phase medians. It now includes phase p90
and the five slowest over-budget non-rebuy samples with their own phase
breakdowns. This uses the existing bounded memory and health endpoint, adds
no database round trip or per-hand log, and includes no player identity,
cards, tokens or financial contents. Phase percentiles must not be summed:
they can describe different hands. Returned phase objects are copied.

Tests cover empty state, correct correlated phases, response bound, ordering,
threshold, rebuy exclusion, age expiry and snapshot mutation isolation.
This diagnostic change does not shorten a hand or bypass settlement. Its
production adoption must be checked after the next normal engine release.

Remaining investigation includes settlement tail latency, tournament chip
read/RPC sequencing, seat cleanup and move announcement waits, and physical
network-loss/recovery across all game formats. The maintenance thaw and
resume-wave delay also needs a durable reconnect-deadline audit.

## Release and reconnect checkpoint

- World Hub #1584 merged as fa0ae14ba5e701f659770a039b0914c72f5798be.
  Both public Club Arena root and deep table routes were checked with HTTP
  200 and stale-while-revalidate=60, matching the corrected Hetzner origin.
- Club Arena #3753 merged as e803e8b88c65c7ce2fe7f3034e00cc2ebe103ba4.
  The Hetzner build-info endpoint served that SHA at approximately 13:07 UTC.
- Initial HTTP login ownership is pushed as #3763, head 83df20bf. At the
  checkpoint its client test shards, TypeScript and production build passed;
  browser CI was still running. It is not counted as published yet.
- Caddy config staging initially installed a root-only file at 12:27:41 UTC.
  Mode 0644 and service restoration at 12:28:36 ended the 55-second outage.
  The permanent deployment-script correction merged in #3746. This incident
  was disclosed when it occurred; root validation alone was insufficient.
- Reconnect policy uses one server function for all formats: 30 seconds,
  or 45 for is_vip=true with future expiry or explicit null lifetime expiry.
  Invalid, missing and expired dates do not qualify. The loader preserves
  expiry values, and an old lifetime tier cannot override an expired card.
- Further HTTP outage work is required: bounding authentication does not
  bound the subsequent fetch or response body. Several GameServerAPI calls
  still have no network deadline. Any correction must preserve ambiguous
  mutation outcomes and must not automatically replay timed-out wagers,
  purchases, top-ups or other mutations.
- The global sessionRevoked probe and sign-out/redirect flow still lack
  complete identity ownership across SDK awaits. An outer socket deadline
  does not prevent late SDK side effects. This remains a separate fix.
- No physical mobile outage or Wi-Fi/cellular transition trial has been
  completed for every game type. Unit policy parity is not that evidence.

A subsequent 13:14:53 sample remained variable: median 2228 ms, p90 4199 ms,
maximum 9881 ms. The earlier two-second median must not be represented as a
stable universal result. The new diagnostics still need normal production
adoption before they can identify those specific outliers.

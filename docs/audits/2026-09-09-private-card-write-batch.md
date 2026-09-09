# Private Card Writes Share A Deal Request

Date: 2026-09-09 UTC. Scope: Club Arena engine only.

## Measured Cause

The database request path is saturated under the running fleet. This is separate
from the lease-row convoy fixed in #3881.

Read-only Supabase Metrics API samples at 2026-09-08 23:54:33 and 23:56:28 UTC
reported four CPU series and approximately 98.8% CPU execution time between
samples (idle approximately 1.0%, I/O wait approximately 0.2%). One-minute load
rose from 27.21 to 36.25. PostgREST reported 410 then 282 waiting requests and a
pool maximum of 60. Its available-connection gauge was inconsistent (34 then -7),
so that gauge is not treated as a reliable capacity count. The timeout counter
remained 2,211. Memory total was 16,360,001,536 bytes. These measurements supersede
earlier unverified assumptions about the database CPU count.

The engine event loop at 23:56 remained responsive: p50 20.46ms, p99 31.83ms,
governor scale 1. The fleet had 712 active tables and 440 active tournaments.
The 23:52 ten-minute hand-gap window still had p50 2,357ms and p90 10,902ms.
An earlier higher-load sample was p50 8,497ms. The complete hand-delay issue
is not resolved.

A read-only pg_stat_statements sample before this change counted 60,872
insert_hole_cards calls versus approximately 18,000 dealt-hand allocations.
HandController emits all dealt players synchronously, but the engine sent a
separate PostgREST request for each player. The installed insert_hole_cards
function already accepts an array: one cleanup followed by the same private
row upserts. No migration or privilege change is needed.

Official endpoint/authentication/60-second scrape guidance:
https://supabase.com/docs/guides/observability/metrics/grafana-self-hosted
https://supabase.com/blog/metrics-api-observability

## Change

One microtask collects a synchronous deal into one existing array RPC. Each
player's private socket row is still sent immediately, before the database
request. No timer delays the visible deal.

The queue belongs to one engine, hand number, and exact data-actor authority.
Service requests and different tournament lease generations cannot share a
batch. The async flush retains the originating authority. Card values are
serialized at enqueue time so subsequent array mutation cannot rewrite them.

Every caller still awaits durable completion. A flushed batch leaves the queue
before HTTP starts, so later reconnects and draws receive their own writes.
Transient failures retain three attempts and the existing backoff. Exhaustion
emits a recovery identity for every affected player, with no card values in
public events. Retirement or a newer hand cancels unstarted work and further
retries/recovery events for the old hand.

This removes redundant request overhead and repeated old-row cleanup. It does
not bypass settlement, change chip accounting, alter RLS, or claim to solve the
database's entire capacity problem.

## Verification

Before implementation, the new behavioral suite had 9 failures and 3 passes.
After implementation and adding two real HandController deals, all 14 cases
pass. The combined run passes 31 tests across four files, including existing
hand-record, stale-continuation and tournament authority guards. Server
TypeScript passes.

The real controller cases cover nine-seat NLH and six-seat PLO6. Other cases
cover immediate private fan-out, one awaited RPC, reconnect cache wiring,
immutable cards, separate tables/authorities, reconnect while a request is in
flight, error and thrown-error retries, per-player recovery, retirement and
new-hand cancellation. No production seats, buy-ins or wagers were used.

## Delivery And Remaining Work

#3897 merged as f17e8cba84bda2875017170fb23126107baef670. Both public and static
origin build-info served f8ca3d642e094b44e8c9041b4ecbc03ec1612764 at 23:52,
and git ancestry verifies that build includes #3897.

The engine was still 276faa64 at 23:59. Deployment run 34290558940 finished
green while skipping cutover: its drain log observed last_hand at 23:53,
then idle again before 23:54, and never readyForRestart. Do not count this
as a published server fix. The missed maintenance boundary needs diagnosis;
no forced restart was performed.

This branch must follow the normal branch push, PR, CI and scheduled engine
adoption route. Its runtime reduction remains unmeasured until that adoption.
The physical iPad home-screen/offline flow remains unverified because the
browser connection is unavailable. Paid join and Rabbit Hunt interaction
tests remain unperformed.

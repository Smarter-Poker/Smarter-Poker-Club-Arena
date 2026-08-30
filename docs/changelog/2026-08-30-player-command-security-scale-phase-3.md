# Player Command Security And Scale Phase Three

Date: 2026-08-30

## Outcome

The Club Arena Players surface now uses a role-shaped server contract instead of returning a full sensitive roster to every approved member. It also moves to lightweight summary reads, keyset pages, true row recycling, audited exports, and audited note edits.

## Data and authorization

- Ordinary approved members receive roster identity and live presence only.
- Agents receive private values only for themselves and their recursive downline.
- Club staff receive private values only for clubs they actually staff; child-club staff do not inherit union-wide financial visibility.
- Platform and union overseers retain their established scope.
- Player balances now read `club_members`; agent balances now read `agents`. The frozen `public.wallets` pool is no longer used.
- Member detail, statistics, and downline RPCs now share the same access decision.
- Direct browser writes to member nickname/notes are guarded. The authorized RPC is idempotent and writes an `audit_trail` entry.
- Full and selected roster exports are staff-only and audited. Search text is never copied into the audit record.

## Client and interaction

- The first paint is a 361-byte summary plus an 80-row page rather than one full roster payload.
- Search is debounced and server-side. Typed names and player numbers are kept in session state and removed from the URL/history.
- Superseded requests are aborted; stale responses cannot win; structural realtime bursts share a cooldown.
- The five-minute session cache is scoped by viewer and club and strips every financial, note, activity, and hierarchy field.
- The list recycles a fixed viewport window instead of accumulating rendered rows.
- Saved views now include recursive downline, seated, online, agents, admins, 30/60/90-day inactivity, and fees of at least 100.
- Staff can choose visible metric groups, select loaded players, and request an audited selected export.
- Search matches are highlighted and empty states distinguish online from seated players.
- Mobile filters have a visible continuation cue and the search/control console remains within reach.
- CSV cells beginning with spreadsheet formula characters are neutralized across the shared export helper.

## Visual direction

No new generated image was added. The accepted physical ledger hero remains, while the phase-three identity comes from the pit-tape console and roster hardware. The composition and its no-reuse rule are recorded in `docs/VISUAL-COMPOSITION-REGISTRY.md`.

## Verification and production evidence

- TypeScript compiler: passed.
- Targeted roster regressions: 54 passed.
- Full repository suite: 655 files and 9,591 tests passed.
- Production build: passed from the current branch with `behind-main=0`; the Player Command chunk is 17.28 kB (6.17 kB gzip).
- Transactional migration compile: passed and rolled back.
- Transactional role simulation: player, staff, agent-downline, and outsider contracts passed and rolled back.
- Production migration: applied and committed to `kuklfnapbkmacvwxktbh`.
- Live authorization probes: anonymous/internal-helper denial, ordinary-player redaction/export denial, staff export, recursive agent visibility, outsider denial, and direct-note-write guard all passed.
- Live audited write probes: selected export and atomic nickname/remark RPC both passed; the audit rows were verified and the probe transaction was rolled back so member data was not changed.
- Production-scale rollback probe on SHARK CLUB: summary 17.142 ms; first 80-row page 252.290 ms.
- Payload probe: summary 361 bytes; first page 81,556 bytes, versus the previous full roster measurement of 516,154 bytes.
- Protected merge, World Hub publication, and cold production verification are recorded by their immutable commit/PR and `build-info.json` evidence.

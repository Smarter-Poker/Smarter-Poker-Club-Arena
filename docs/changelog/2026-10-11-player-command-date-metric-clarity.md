# Player Command Date And Metric Clarity

## Change 1: Use The Server's UTC Calendar

**File:** `src/services/ClubRosterService.ts`, before lines 227–249.

**What Existed:** `lastDaysRange` took two separate current timestamps and used local `setDate`; `isoDate` used local calendar getters. The installed daily-fact projection uses `(played_at AT TIME ZONE 'UTC')::date`. The record RPC interprets From as UTC midnight and To as the following UTC midnight, exclusive; daily buckets include both From and To. A browser west of UTC near midnight submitted the previous day.

**What Changed:** Presets capture one timestamp, clone it, subtract calendar days with `setUTCDate`, and print UTC year/month/day. MemberRange documents inclusive UTC dates and Overall as all recorded activity. Only MemberManagementPage and PlayerStatisticsPage import these date helpers; unrelated similarly named private helpers are unchanged.

**Why:** Preset Day, 7 Days and Month must select the same UTC days the server records, independent of the viewer's timezone or DST.

**Verified:** YES. The original helper failed 4/5 real-clock boundary cases with `TZ=America/Los_Angeles`, including UTC midnight, DST dates, year rollover and offset date input. Two independent offset-calendar cases failed against original source even with `TZ=UTC`, preserving the regression under UTC hosted workers. All seven final helper cases pass.

## Change 2: Label Displayed Scope And Explain Existing Metrics

**Files:** `src/pages/MemberManagementPage.tsx` (before range captions 711–720 and Activity 732), `src/pages/PlayerStatisticsPage.tsx` (before range captions 355–367 and metric cards 420 onward), their corresponding CSS files, and `tests/components/playerCommandMetricScope.test.tsx`.

**What Existed:** Native custom dates were staged until Confirm, but no visible status distinguished unsubmitted dates from the displayed read. Captions omitted UTC; statistics omitted the actual returned game. Record Total Fee is cash-only rake and Total Winnings is cash net despite their names. Rates and retention limits lacked an accessible definition.

**What Changed:** Existing authoritative result captions identify inclusive UTC dates; statistics also identifies the returned game. Unconfirmed custom dates show Draft Dates Not Applied, without issuing a request or replacing the displayed scope. Confirm retains the original date arguments. A failed game refresh retains the prior read's scope and game, including the defensive nullable All Variants boundary. Empty-state game copy also follows the actual returned read. Native Metric Definitions disclosures use the existing card/control surfaces and inks. The performance guide is available for every authorized result, including zero hands; denied financial activity does not render its private guide. Hero readouts name their displayed scope.

**Producer Definitions:** `20261010090330_player_ranges_and_statistics_read_exact_daily_facts.sql` returns cash/MTT hand and rake splits, signed recorded net results, incoming rakeback/commission and outgoing transfer/send/distribution transaction totals. Hand wins are `net > 0`, win rate divides those wins by hands dealt, VPIP/PFR/3-bet divide their flags by hands dealt, fold-to-3-bet divides folded flags by faced flags, and C-bet divides bets by recorded opportunities. The guide states those exact meanings, chip units, currently recorded activity limits, and current rather than ranged wallets/downline counts. No SQL, formula, permission, transaction or retention rule changed.

**Verified:** YES. Original real-page scope tests failed 5/6; final six pass, covering draft no-query behavior, exact Confirm RPC arguments, delayed completion, prior-game failure scope, authorization and empty-range guide availability. The nullable component regression separately failed before the conditional was corrected; the current service normalizes backend null to `all`, so this is a defensive component boundary rather than a claim that current authorized RPCs emit null variants.

**Final Focused Validation:** 44/44 passed across the seven UTC cases, six new real-page cases, 19 existing action/privacy/ownership cases and 12 existing cinematic page cases. Final run uses `TZ=UTC`; the earlier Pacific run also passed its then-current cases. `git diff --check` passed. Original assertions were retained.

**Evidence:** External task archive logs `phase3-utc-range-before.log`, `phase3-offset-calendar-before.log`, `phase3-metric-component-before.log`, `phase3-null-variant-before.log` and `phase3-metric-scope-final.log`.

**TypeScript:** Pending root exact-candidate validation.

**Delivery Boundary:** Root owns the maintained production Record/Statistics journey, required final checks, protected delivery, publication and cold live proof. Local components do not certify the production database or release. No live financial, note or role writes were performed.

Root final accessibility validation strengthens the existing real-component and production checks to query semantic roles rather than accepting aria-label text on an unnamed paragraph. Displayed read captions are named status roles; export context is a named note. Five strengthened component checks failed before the roles were added; the same assertions are retained for the corrected candidate. No financial or request behavior changed.

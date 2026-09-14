/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE 2026-08-29 TOURNAMENT DETAIL TAB AUDIT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Six tabs that had never been read line by line. Every case below is a bug that
 * was live in production, and each one is pinned against the mechanism that
 * replaced it rather than against the shape of the fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastPaidPlace, paidPlaceCount } from '../../src/components/tournament/details/types';
import {
  mapSatelliteRowToCard,
  speedLabel,
  firstLevelMinutes,
  SATELLITE_COLUMNS,
} from '../../src/components/tournament/details/useSatellites';

const SRC = join(__dirname, '..', '..', 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
/** Comments describe the bugs, so every source assertion reads the code only. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

// ═══════════════════════════════════════════════════════════════════════════════
//  1. BLIND_LEVEL_CHANGE carries a 1-BASED display level, not an index
// ═══════════════════════════════════════════════════════════════════════════════
describe('the blind-level bus payload has one meaning, and all three readers use it', () => {
  /*
   * TournamentTimerService.handleLevelChange computes
   *   const displayLevel = newLevel + 1;
   * writes the raw 0-based `newLevel` to `tournaments.current_level`, and emits
   * `displayLevel` on the bus. The distinction was undocumented and all three
   * consumers guessed wrong -- each with a comment asserting the opposite.
   */

  it('the producer still emits the display level, which is what the readers assume', () => {
    const svc = strip(read('services/TournamentTimerService.ts'));
    expect(svc).toMatch(/const displayLevel = newLevel \+ 1/);
    // The bus gets displayLevel. If this ever becomes `newLevel`, every
    // consumer below is off by one again in the other direction.
    expect(svc).toMatch(/BLIND_LEVEL_CHANGE'[\s\S]{0,120}level:\s*displayLevel/);
  });

  it('TournamentDetails converts the payload back to an index before storing it', () => {
    // It used to write the 1-based payload straight into `current_level`, which
    // is the 0-based index. That corrupted the shared tournament object EVERY
    // tab reads, so one bad write put the whole page a level ahead until the
    // next poll.
    const page = strip(read('pages/tournament/TournamentDetails.tsx'));
    expect(page).toMatch(/current_level:\s*displayLevel - 1/);
    expect(page).not.toMatch(/current_level:\s*event\.payload\.level\b/);
  });

  it('TournamentClock does not add one to a number that already counts from one', () => {
    // The 2026-08-26 fix turned a clock that flashed one level BACKWARDS into
    // one that flashed a level FORWARD, on a projector, in front of the room.
    const clock = strip(read('components/tournament/TournamentClock.tsx'));
    expect(clock).not.toMatch(/Number\(payload\.level\)\s*\|\|\s*0\)\s*\+\s*1/);
    expect(clock).toMatch(/currentLevel:\s*Math\.max\(1,\s*Number\(payload\.level\)\s*\|\|\s*1\)/);
  });

  it('BlindsTab subtracts one from the bus value and not from the row value', () => {
    // The row is an index, the bus is a display level. Two branches, two units.
    const tab = strip(read('components/tournament/details/BlindsTab.tsx'));
    expect(tab).toMatch(/Math\.max\(0,\s*\(Number\(busLevel\.level\)\s*\|\|\s*1\)\s*-\s*1\)/);
    expect(tab).toMatch(/Math\.max\(0,\s*Number\(row\.current_level\)\s*\|\|\s*0\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. A COUNT IS NOT A PLACE NUMBER
// ═══════════════════════════════════════════════════════════════════════════════
describe('the money bubble reads the last paid place, not how many places pay', () => {
  const contiguous = JSON.stringify([
    { place: 1, percentage: 50 },
    { place: 2, percentage: 30 },
    { place: 3, percentage: 20 },
  ]);
  // Places 1, 2, 3 and 5. Four paid places; the deepest is FIFTH.
  const gapped = JSON.stringify([
    { place: 1, percentage: 40 },
    { place: 2, percentage: 25 },
    { place: 3, percentage: 20 },
    { place: 5, percentage: 15 },
  ]);

  it('agrees with the count on a contiguous ladder, which is why this hid for so long', () => {
    expect(paidPlaceCount(contiguous)).toBe(3);
    expect(lastPaidPlace(contiguous)).toBe(3);
  });

  it('differs the moment the ladder has a gap', () => {
    expect(paidPlaceCount(gapped)).toBe(4);
    expect(lastPaidPlace(gapped)).toBe(5);
  });

  it('refuses a retired range row instead of advertising a ladder SQL will not settle', () => {
    // Range rows were once expanded only in the browser. The atomic database
    // authority accepts the single persisted contract used by all new events:
    // explicit integer places. Treating this legacy shape as nine paid places
    // would now make the UI promise money the settlement transaction rejects.
    const range = JSON.stringify([
      { place: 1, percentage: 30 },
      { from: 2, to: 9, percentage: 8.75 },
    ]);
    expect(paidPlaceCount(range)).toBe(0);
    expect(lastPaidPlace(range)).toBe(0);
  });

  it('returns zero rather than guessing when no structure is published', () => {
    expect(lastPaidPlace(null)).toBe(0);
    expect(lastPaidPlace('')).toBe(0);
    expect(lastPaidPlace('not json')).toBe(0);
    expect(lastPaidPlace('[]')).toBe(0);
  });

  it('every bubble-distance caller now uses it', () => {
    const rewards = strip(read('components/tournament/details/RewardsTab.tsx'));
    expect(rewards).toMatch(/parsedPlaces = useMemo\(\(\) => resolvePayoutStructure\(tournament\)/);
    expect(rewards).toMatch(/finalPaidPlace = useMemo\(\(\) => lastPaidPlace\(parsedPlaces\)/);
    const detail = strip(read('components/tournament/details/DetailOverviewTab.tsx'));
    expect(detail).toMatch(
      /payoutStructure = useMemo\(\(\) => resolvePayoutStructure\(tournament\)/
    );
    expect(detail).toMatch(/lastPaidPlace\(payoutStructure\)/);
    const ranking = strip(read('components/tournament/details/RankingTab.tsx'));
    expect(ranking).toMatch(
      /deepestPaidPlace = useMemo\([\s\S]{0,100}lastPaidPlace\(resolvePayoutStructure\(tournament\)\)/
    );
    // paidPlaceCount is still right for "N Paid Places"; it must not be the
    // thing feeding hand-for-hand.
    expect(detail).not.toMatch(/paidPositions[\s\S]{0,80}paidPlaceCount/);
    expect(ranking).not.toMatch(/const paidPlaces[\s\S]{0,100}paidPlaceCount/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. The satellite mapper read three columns that do not exist
// ═══════════════════════════════════════════════════════════════════════════════
describe('the satellite mapper reads real columns', () => {
  const row = {
    id: 'sat-1',
    name: 'Sunday Feeder',
    status: 'REGISTERING',
    tournament_type: 'satellite',
    // The price is stored SPLIT. There is no `buy_in` column.
    buy_in_amount: 22,
    buy_in_fee: 3,
    guaranteed_prize: 5000,
    prize_pool: 1200,
    max_players: 180,
    current_players: 42,
    start_time: '2026-08-30T18:00:00Z',
    blind_structure: JSON.stringify([{ level: 1, durationMinutes: 4 }]),
    late_reg_levels: 6,
  };

  it('reads guaranteed_prize -- `guarantee` is not a column, so this was always 0', () => {
    // The single highest-impact line of the audit: EVERY satellite card ever
    // rendered showed a prize pool of zero.
    expect(mapSatelliteRowToCard(row).prizePool).toBe(5000);
  });

  it('sums the two halves of the price -- `buy_in` is not a column either', () => {
    // Found by the manifest case below, not by reading: the same card was
    // advertising a buy-in of ZERO next to its prize pool of zero. The column
    // is stored split as amount + fee and the card's contract is the total.
    expect(mapSatelliteRowToCard(row).buyIn).toBe(25);
  });

  it('is a satellite because the query said so, not because of a phantom flag', () => {
    // `is_satellite` is not a column, so the old test was always false and the
    // type fell through. Every row here was selected by satellite_target_id.
    expect(mapSatelliteRowToCard({ ...row, tournament_type: null }).type).toBe('satellite');
    // A more specific type still refines it.
    expect(mapSatelliteRowToCard({ ...row, tournament_type: 'spin' }).type).toBe('spin');
  });

  it('falls back to the collected pool when there is no guarantee', () => {
    expect(mapSatelliteRowToCard({ ...row, guaranteed_prize: 0 }).prizePool).toBe(1200);
  });

  it('derives the level length from the structure -- `blind_duration` is not a column', () => {
    expect(mapSatelliteRowToCard(row).blindDuration).toBe(4);
  });

  it('reads a Spin structure, whose `duration` is in SECONDS', () => {
    // The three-spellings trap: `duration: 180` means three minutes, not three
    // hours. blindLevelMinutes reads the canonical keys first for exactly this.
    const spin = { ...row, blind_structure: JSON.stringify([{ level: 1, duration: 180 }]) };
    expect(firstLevelMinutes(spin.blind_structure)).toBe(3);
    expect(mapSatelliteRowToCard(spin).blindStructure).toBe('Turbo');
  });

  it('labels the structure from the real level length, never a hardcoded "regular"', () => {
    expect(speedLabel(2)).toBe('Hyper Turbo');
    expect(speedLabel(3)).toBe('Turbo');
    expect(speedLabel(5)).toBe('Turbo');
    expect(speedLabel(10)).toBe('Regular');
    expect(speedLabel(20)).toBe('Slow');
    // Unknown duration is not evidence of regular speed.
    expect(speedLabel(0)).toBe('Unconfirmed');
    expect(mapSatelliteRowToCard(row).blindStructure).toBe('Turbo');
  });

  it('passes the late-registration fields the card needs to show a countdown', () => {
    // `hasLateReg` in TournamentLobbyCard reads late_reg_levels / late_reg_mins.
    // Neither was passed, so no satellite card has ever shown late reg.
    expect(mapSatelliteRowToCard(row).late_reg_levels).toBe(6);
  });

  it('selects named columns, not everything', () => {
    expect(SATELLITE_COLUMNS).not.toContain('*');
    expect(SATELLITE_COLUMNS).toContain('guaranteed_prize');
    expect(SATELLITE_COLUMNS).toContain('late_reg_levels');
  });

  it('every column it selects exists in the live schema manifest', () => {
    // The whole class of bug in one assertion: three of the mapper's reads were
    // for columns that are not on this table.
    const manifest = JSON.parse(
      readFileSync(join(SRC, '..', 'scripts/ci/supabase-columns-manifest.json'), 'utf8')
    );
    const real: string[] = manifest.columns.tournaments;
    const selected = SATELLITE_COLUMNS.split(',').map((c) => c.trim());
    expect(selected.filter((c) => !real.includes(c))).toEqual([]);
    // The five reads the old mapper made against columns that are not there.
    // Two of them (`buy_in`, `is_satellite`) were carried forward into the
    // rewrite by hand and were caught by THIS case rather than by reading, so
    // it earns its place: a name that looks right is not a column.
    for (const dead of ['guarantee', 'blind_duration', 'buy_in', 'is_satellite']) {
      expect(real, `${dead} is a real column now -- revisit the mapper`).not.toContain(dead);
    }
  });

  it('is defined exactly once -- both surfaces import it', () => {
    // It used to be duplicated byte for byte, so every bug above shipped twice.
    for (const f of ['SatellitesTab.tsx', 'DetailOverviewTab.tsx']) {
      const src = strip(read(`components/tournament/details/${f}`));
      expect(src, `${f} still defines its own mapper`).not.toMatch(/function mapSupabaseRowToCard/);
      expect(src, `${f} does not use the shared loader`).toMatch(/useSatellites/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. A failed read is not an empty result
// ═══════════════════════════════════════════════════════════════════════════════
describe('a query that fails does not render as a fact about the tournament', () => {
  it('RewardsTab pages its bounty queries and throws on error', () => {
    const src = strip(read('components/tournament/details/RewardsTab.tsx'));
    // A Supabase builder RESOLVES with {data: null, error}. The old code
    // destructured only .data, so the catch could never fire for a query error
    // and an RLS denial rendered "The Bounty Pool Is Not Funded Yet".
    expect(src).toMatch(/if \(error\) throw error/);
    expect(src).toMatch(/fetchAllRows/);
    expect(src).toMatch(/\.range\(from, to\)/);
    // And the UI can now tell the two apart.
    expect(src).toMatch(/ledger\.failed/);
    expect(src).toMatch(/The Bounty Pool Could Not Be Read/);
  });

  it('UnionsTab reports a failed union-name lookup instead of degrading silently', () => {
    const src = strip(read('components/tournament/details/UnionsTab.tsx'));
    expect(src).toMatch(/if \(unionErr\) reportError\(unionErr/);
  });

  it('UnionsTab pages the entrant query past PostgREST’s 1000-row cap', () => {
    const src = strip(read('components/tournament/details/UnionsTab.tsx'));
    expect(src).toMatch(/fetchAllPages/);
    // Past 1000 entrants the tail was dropped and those players were labelled
    // "By Membership" though their entered club id existed and was not fetched.
    expect(src).not.toMatch(
      /from\('tournament_players'\)\s*\.select\('user_id, club_id'\)\s*\.eq\([^)]*\);/
    );
  });

  it('DetailOverviewTab reports a failed deal-vote read', () => {
    const src = strip(read('components/tournament/TournamentDealReview.tsx'));
    // Was `if (!alive || error || !data) return;` -- a permission failure left
    // the panel showing "0/6 Votes" as a fact, with nothing reported.
    expect(src).toMatch(/reportError\(failure, 'TournamentDealReview\.proposal'\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. Work that only happens when it is needed
// ═══════════════════════════════════════════════════════════════════════════════
describe('polls and timers only run when something reads them', () => {
  it('the deal-vote poll waits for the panel to be possible, not merely enabled', () => {
    // Gated on `dealEnabled` alone, a 500-runner event polled every 15s from
    // level one for a panel that cannot render until one table is left.
    const src = strip(read('components/tournament/details/DetailOverviewTab.tsx'));
    expect(src).toContain('dealPanel &&');
    expect(src).toMatch(/dealPanel\.amSeated\s*&&\s*currentUserId/);
    expect(src).toContain('<TournamentDealReview');
  });

  it('the deal-vote poll drops a response that a newer one has overtaken', () => {
    const src = strip(read('components/tournament/TournamentDealReview.tsx'));
    expect(src).toMatch(/const mine = \+\+request.current/);
    expect(src).toMatch(/mine !== request.current/);
  });

  it('BlindsTab stops ticking once the event is over', () => {
    const src = strip(read('components/tournament/details/BlindsTab.tsx'));
    expect(src).toMatch(/clockIsDead/);
    expect(src).toMatch(/if \(clockIsDead\) return;/);
  });

  it('the satellite registration check is one query for the list, not one per card', () => {
    const src = strip(read('components/tournament/details/useSatellites.ts'));
    expect(src).toMatch(/from\('tournament_players'\)/);
    expect(src).toMatch(/\.in\(\s*'tournament_id'/);
    const card = strip(read('components/tournament/TournamentLobbyCard.tsx'));
    // ...and the card takes the answer rather than looking it up again.
    expect(card).toMatch(/knownRegistration/);
    expect(card).toMatch(/typeof knownRegistration === 'boolean'/);
  });

  it('a FAILED batch check makes the card look for itself, never assume "not registered"', () => {
    // Rendering a live Register button at an already-registered player is a
    // second entry attempt against real money (the 2026-08-25 rule).
    const card = strip(read('components/tournament/TournamentLobbyCard.tsx'));
    expect(card).toMatch(/knownRegistration\?: boolean \| null/);
    for (const f of ['SatellitesTab.tsx', 'DetailOverviewTab.tsx']) {
      expect(strip(read(`components/tournament/details/${f}`))).toMatch(
        /Registration \? Boolean\(sat\w*Registration\[sat\.id\]\) : null|registration \? Boolean\(registration\[sat\.id\]\) : null/
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. Things that were simply wrong on the page
// ═══════════════════════════════════════════════════════════════════════════════
describe('the page says true things', () => {
  it('no longer references an undefined CSS token', () => {
    // `var(--surface)` is defined nowhere in this repo, so both Band 4 panels
    // had no background and the wrapper's overlay washed the whole band.
    // strip(): the comment explaining the fix necessarily quotes the token.
    const src = strip(read('components/tournament/details/DetailOverviewTab.tsx'));
    expect(src).not.toContain('var(--surface)');
  });

  it('spells satellites correctly, in Title Case', () => {
    const src = read('components/tournament/details/DetailOverviewTab.tsx');
    // strip(): the comment recording the old copy necessarily quotes it.
    expect(strip(src)).not.toContain('SATELITTES');
    expect(src).toContain('No Satellites Available For This Tournament');
  });

  it('Band 4 sets its padding in CSS, where a media query can reach it', () => {
    // Inline `padding: 0` beat `.dov-info`'s own rule AND its 400px override,
    // and a hardcoded `padding: 16` replaced the 9px phones were meant to get.
    const src = strip(read('components/tournament/details/DetailOverviewTab.tsx'));
    expect(src).not.toMatch(/style=\{\{ padding: 0, overflow: 'hidden' \}\}/);
    expect(src).not.toMatch(/style=\{\{ padding: 16/);
    const css = read('components/tournament/details/DetailOverviewTab.css');
    expect(css).toMatch(/\.dov-band__section \{/);
    expect(css).toMatch(/@media \(max-width: 400px\)[\s\S]*\.dov-band__section/);
  });

  it('the final-table deal button uses the same "still in" rule as the count beside it', () => {
    // `field.alive` counts with isPlayerLive; this tested status === 'playing',
    // so a `registered` player at a final table was inside the denominator but
    // had no button, and the deal could never reach unanimity.
    const src = strip(read('components/tournament/details/DetailOverviewTab.tsx'));
    expect(src).toMatch(/amSeated: mySeat \? isPlayerLive\(mySeat\) : false/);
  });

  it('BlindsTab says so when the clock has run past the published structure', () => {
    // 3,079 production rows have current_level past the last level. Clamping
    // alone printed the last published blinds as if they were being dealt.
    const src = strip(read('components/tournament/details/BlindsTab.tsx'));
    expect(src).toMatch(/beyondStructure/);
    expect(read('components/tournament/details/BlindsTab.tsx')).toContain(
      'Past The Published Structure'
    );
  });

  it('a table with no id cannot collide with another one on the React key', () => {
    const src = strip(read('components/tournament/details/TablesTab.tsx'));
    expect(src).toMatch(/key=\{line\.table\.id \|\| `row-\$\{i\}`\}/);
  });

  it('a seat count taken from a stale row is labelled as reported, not as observed', () => {
    // seatCountIsFallback was computed, stored and documented, and read by
    // nothing at all.
    const src = strip(read('components/tournament/details/TablesTab.tsx'));
    expect(src).toMatch(/seatCountIsFallback \? 'Reported' : 'Players'/);
  });

  it('no decorative meter is left in the accessibility tree unlabelled', () => {
    // Five bare `tl-meter` divs with no role and no aria-* were announced as
    // empty groups. Each duplicates an adjacent figure, so they are hidden
    // rather than given a second voice for the same number.
    for (const f of [
      'BlindsTab.tsx',
      'DetailOverviewTab.tsx',
      'RankingTab.tsx',
      'RewardsTab.tsx',
      'TablesTab.tsx',
    ]) {
      const src = read(`components/tournament/details/${f}`);
      // The container is `tl-meter` plus optional modifiers; `tl-meter__fill`
      // and `tl-meter__mark` are its children and are inside it already.
      const opens = src.match(/className="tl-meter(?!__)[^"]*"/g) || [];
      const hidden = src.match(/className="tl-meter(?!__)[^"]*"\s+aria-hidden="true"/g) || [];
      expect(hidden.length, `${f}: ${opens.length} meters, ${hidden.length} hidden`).toBe(
        opens.length
      );
    }
  });
});

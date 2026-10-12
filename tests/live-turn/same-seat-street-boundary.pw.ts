/**
 * A SEAT THAT CLOSES A STREET IS SHOWN ITS NEXT TURN - IN A BROWSER.
 *
 * Dan, 2026-10-04, after a human-versus-human match: "MY HUMAN OPPONENT [WAS]
 * CONSTANTLY BEING TIMED OUT OR DISCONNECTED." The opponent was the big blind
 * heads-up: every time he called to close a street he was first to act on the
 * next, and the page showed him no action bar (TablePage's hero-acted fence
 * withheld the engine's new turn for the seat that had just acted).
 *
 * This mounts the BUILT app at a table, signed in as that seat, and plays it
 * the exact wire the real engine sent for such a hand (replay-engine.ts). The
 * player's own buttons are the only way the hand advances. With
 * LIVE_TURN_EXPECT_DEFECT=1 it asserts the defect instead, for a build that
 * predates the fix: the witness that this test can fail.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { PLAYER, newBackend, signIn } from '../stale-client/mock-backend';
import { ReplayEngine, readRecording, type Recording } from './replay-engine';

const FRAMES =
  process.env.LIVE_TURN_FRAMES ||
  fileURLToPath(new URL('./wire/same-seat-street-boundary.jsonl', import.meta.url));
const EXPECT_DEFECT = process.env.LIVE_TURN_EXPECT_DEFECT === '1';
const CLUB = 'c1ab0000-0000-4000-8000-0000000000c1';

test.skip(
  !process.env.LIVE_TURN_DIST,
  'needs the build under test: see playwright.live-turn.config.ts'
);
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

function recording(): Recording {
  const rec = readRecording(FRAMES);
  expect(rec.hero, 'the recording was made for the signed-in fixture player').toBe(PLAYER);
  return rec;
}

function backendFor(rec: Recording) {
  return newBackend({
    engineHttp: 'answered',
    rpc: {
      fn_poker_arena_context: () => ({
        body: {
          arena: { id: CLUB, asset: 'chips', is_platform: false, union_id: null },
          member: true,
          role: 'player',
          cashGamesEnabled: true,
          tournamentsEnabled: true,
        },
      }),
    },
    tables: {
      tables: [
        {
          id: rec.table,
          club_id: CLUB,
          // The embedded relation the table's own bootstrap read selects.
          arena: { id: CLUB, asset: 'chips', is_platform: false, union_id: null },
          union_id: null,
          tournament_id: null,
          name: 'NLH 2/5',
          game_variant: 'nlh',
          game_type: 'cash',
          status: 'running',
          small_blind: 2,
          big_blind: 5,
          min_buy_in: 200,
          max_buy_in: 1000,
          max_players: 6,
          current_players: 2,
          action_time_seconds: 15,
          is_deleted: false,
          created_at: '2026-09-29T00:00:00Z',
        },
      ],
      profiles: [
        {
          id: PLAYER,
          username: 'fixture',
          alias: 'Fixture',
          full_name: 'Live Turn Fixture',
          role: 'user',
          diamonds: 0,
          diamond_balance: 0,
          club_arena_tos_accepted_at: '2026-09-01T00:00:00Z',
          avatar_url: '/hub/club-arena/default-avatar.png',
          arena_avatar_url: '/hub/club-arena/default-avatar.png',
        },
      ],
      clubs: [
        {
          id: CLUB,
          slug: 'live-turn-club',
          name: 'Live Turn Club',
          asset: 'chips',
          is_platform: false,
          is_union: false,
          union_id: null,
          owner_id: null,
          member_count: 2,
          created_at: '2026-09-08T00:00:00Z',
        },
      ],
      club_members: [
        { club_id: CLUB, user_id: PLAYER, role: 'member', status: 'active', chip_balance: 5000 },
      ],
      // The seat row the table's ten-second liveness read looks for. Without
      // it the page concludes this player was removed and says so in a toast
      // that sits over the action bar.
      table_seats: [
        {
          id: '5ea70000-0000-4000-8000-000000000002',
          table_id: rec.table,
          user_id: PLAYER,
          seat_number: 2,
          stack: 1000,
          status: 'active',
          is_sitting_out: false,
          sit_out_at: null,
          left_at: null,
          leave_pending: false,
          joined_at: '2026-10-04T19:40:00Z',
          profiles: {
            id: PLAYER,
            username: 'fixture',
            alias: 'Fixture',
            full_name: 'Live Turn Fixture',
            avatar_url: '/hub/club-arena/default-avatar.png',
            arena_avatar_url: '/hub/club-arena/default-avatar.png',
          },
        },
      ],
    },
  });
}

interface Felt {
  call: Locator;
  check: Locator;
  fold: Locator;
}

function felt(page: Page): Felt {
  const panel = page.locator('.action-panel');
  return {
    call: panel.locator('.action-btn--call'),
    check: panel.locator('.action-btn--check:not([disabled])'),
    fold: panel.locator('.action-btn--fold'),
  };
}

interface BarEntry {
  kind: 'on' | 'off' | 'tap';
  t: number;
}

/**
 * Record, in the page and on the page's own clock, every tap and every moment
 * the action bar appears or disappears. Measured here rather than from the
 * test process, whose clicks wait on actionability before they are dispatched.
 */
async function watchActionBar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __bar?: Array<{ kind: string; t: number }> };
    if (w.__bar) return;
    const log: Array<{ kind: string; t: number }> = [];
    w.__bar = log;
    let shown: boolean | null = null;
    const read = () => {
      const on = !!document.querySelector('.action-panel .action-btn--fold');
      if (on === shown) return;
      shown = on;
      log.push({ kind: on ? 'on' : 'off', t: Date.now() });
    };
    read();
    new MutationObserver(read).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('pointerdown', () => log.push({ kind: 'tap', t: Date.now() }), true);
  });
}

async function actionBarLog(page: Page): Promise<BarEntry[]> {
  return page.evaluate(() => (window as unknown as { __bar: BarEntry[] }).__bar);
}

/** For each tap: how long until the bar next appeared, in page milliseconds. */
function barBackAfterEachTap(log: BarEntry[]): number[] {
  const out: number[] = [];
  log.forEach((entry, i) => {
    if (entry.kind !== 'tap') return;
    const back = log.slice(i + 1).find((later) => later.kind === 'on');
    out.push(back ? back.t - entry.t : Number.POSITIVE_INFINITY);
  });
  return out;
}

async function openTable(page: Page, rec: Recording): Promise<ReplayEngine> {
  await signIn(page, backendFor(rec));
  const engine = await ReplayEngine.install(page, rec);
  await page.goto(`table/${rec.table}`);
  return engine;
}

test('the seat that closes a street is shown its turn on the next one', async ({ page }) => {
  const rec = recording();
  const engine = await openTable(page, rec);
  const bar = felt(page);
  try {
    // Preflop: the button raises, the big blind (this player) faces it.
    await expect(bar.call).toBeVisible({ timeout: 60_000 });
    await watchActionBar(page);
    await page.waitForTimeout(1200);

    // He calls. That closes preflop, and he is first to act on the flop.
    await bar.call.click();

    if (EXPECT_DEFECT) {
      // A build from before the fix: the engine has handed him the flop
      // (armed snapshot and turn_change, 500ms after the call) and the page
      // shows nothing. Six seconds is four times the old fence's window.
      await page.waitForTimeout(6_000);
      expect(engine.problems).toEqual([]);
      expect(engine.accepted.map((a) => a.action)).toEqual(['call']);
      const armed = engine.sent.filter((f) => f.detail.startsWith('turn_change seat 2')).length;
      expect(armed, 'the engine did hand seat 2 the flop').toBeGreaterThanOrEqual(2);
      expect(await bar.check.isVisible(), 'the old page shows no action bar').toBe(false);
      expect(await bar.fold.isVisible()).toBe(false);
      return;
    }

    await expect(bar.check).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1200);

    // He checks; the button bets; he calls. That closes the flop, and he is
    // first to act on the turn: the hand from the report.
    await bar.check.click();
    await expect(bar.call).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1200);
    await bar.call.click();
    await expect(bar.check).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1200);

    // He checks, the button checks behind (ANOTHER seat closes the street):
    // the river turn is the case that always worked.
    await bar.check.click();
    await expect(bar.check).toBeVisible({ timeout: 5_000 });

    expect(engine.problems).toEqual([]);
    // Every action the page sent carried the decision the engine was waiting
    // on, in the recorded order.
    expect(engine.accepted.map((a) => `${a.action} ${a.actionContext}`)).toEqual(
      engine.decisions.map((d) => `${d.action} ${d.context}`)
    );
    expect(engine.timeBankRequests, 'a page that shows its turns asks for no time bank').toEqual(
      []
    );
    // The engine arms the next street 500ms after dealing it. On the page's
    // own clock the bar is back well inside the old 1500ms window, so it is
    // the rule that delivered the turn and not a timer running out.
    const [afterPreflopCall, , afterFlopCall] = barBackAfterEachTap(await actionBarLog(page));
    expect(afterPreflopCall, 'flop turn shown, ms after the preflop call').toBeLessThan(1_300);
    expect(afterFlopCall, 'turn-street turn shown, ms after the flop call').toBeLessThan(1_300);
    console.log(
      `[live-turn] action bar back ${afterPreflopCall}ms after the preflop call and ` +
        `${afterFlopCall}ms after the flop call`
    );
  } finally {
    engine.dispose();
  }
});

test('the action bar does not come back while the engine is between turns', async ({ page }) => {
  test.skip(EXPECT_DEFECT, 'the old fence held this case too');
  const rec = recording();
  const engine = await openTable(page, rec);
  const bar = felt(page);
  try {
    await expect(bar.call).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    await bar.call.click();
    await expect(bar.check).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1200);

    // He checks the flop. The engine's first frame after it still names him
    // (it has recorded the check and not yet moved the turn). Stretch the gap
    // before the frame that moves the turn to the button, as a slow link
    // would: for that long the only frame the page holds names a seat that
    // has already acted.
    engine.hold = {
      segment: 2,
      fromFirst: (frame) =>
        frame.type === 'DELTA' &&
        (frame.patch as Array<{ path: string }>).some((op) => op.path === '/current_player'),
      extraMs: 700,
    };
    await watchActionBar(page);
    const before = (await actionBarLog(page)).length;
    await bar.check.click();
    // The button's bet arrives 200ms after the turn moves; then it is his turn.
    await expect(bar.call).toBeVisible({ timeout: 6_000 });

    const after = (await actionBarLog(page)).slice(before);
    const tap = after.find((entry) => entry.kind === 'tap');
    expect(tap, 'his tap was seen').toBeTruthy();
    const sinceTap = after.filter((entry) => entry.t >= (tap?.t ?? 0) && entry.kind !== 'tap');
    // Exactly: it went away when he acted, and came back once.
    expect(sinceTap.map((entry) => entry.kind)).toEqual(['off', 'on']);
    // And only for the turn the engine armed after the bet: the 700ms hold
    // plus the 200ms until the button bets.
    expect(sinceTap[1].t - (tap?.t ?? 0), 'ms from his check to the bar returning').toBeGreaterThan(
      850
    );
    expect(engine.problems).toEqual([]);
  } finally {
    engine.dispose();
  }
});

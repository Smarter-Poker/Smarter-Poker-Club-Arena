/**
 * Render the REAL LobbyTable to static HTML with the REAL stylesheet, open it
 * in Chromium at 375px, and report every cell whose content is taller than the
 * box drawn around it. That is the exact failure Dan photographed on
 * 2026-08-25, and it is invisible to a unit test: jsdom has no layout, so a
 * clipped card and a correct one produce identical markup.
 *
 * Not part of the build or CI — a dev tool. Run it with:
 *   npx playwright install chromium          # once
 *   npx vitest run --config scripts/dev/lobby375.config.ts
 *
 * It always writes /tmp/lobby-shot/lobby.html, which can be opened by hand in
 * any browser's device toolbar at 375px even when the check itself skips.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { chromium } from 'playwright';
import LobbyTable, { type LobbyCategory } from '../../src/components/lobby/LobbyTable';
import {
  cashEntry,
  tournamentEntry,
  type LobbyTableRow,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';

const OUT = '/tmp/lobby-shot';
mkdirSync(OUT, { recursive: true });

const CSS = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.css'), 'utf8');

const iso = (mins: number) => new Date(Date.now() + mins * 60000).toISOString();

const MTT_BLINDS = JSON.stringify(
  Array.from({ length: 10 }, (_, i) => ({
    level: i + 1,
    smallBlind: 25 * (i + 1),
    bigBlind: 50 * (i + 1),
    ante: 0,
    durationMinutes: 10,
  }))
);
const SPIN_BLINDS = JSON.stringify(
  Array.from({ length: 12 }, (_, i) => ({
    level: i + 1,
    smallBlind: 10 + i * 5,
    bigBlind: 20 + i * 10,
    ante: 0,
    duration: 180,
  }))
);

const tourn = (o: Partial<LobbyTournamentRow>): LobbyTournamentRow =>
  ({
    id: Math.random().toString(36).slice(2),
    name: 'Game',
    game_type: 'NLH',
    buy_in_amount: 10,
    buy_in_fee: 0,
    guaranteed_prize: 0,
    start_time: iso(30),
    status: 'REGISTERING',
    current_players: 2,
    max_players: 3,
    starting_chips: 300,
    blind_structure: SPIN_BLINDS,
    ...o,
  }) as LobbyTournamentRow;

const table = (o: Partial<LobbyTableRow>): LobbyTableRow => ({
  id: Math.random().toString(36).slice(2),
  name: 'NLH 10/25',
  game_variant: 'nlh',
  small_blind: 10,
  big_blind: 25,
  min_buy_in: 1000,
  max_buy_in: 5000,
  current_players: 4,
  max_players: 6,
  status: 'active',
  ...o,
});

const MTT = tournamentEntry(
  tourn({
    name: 'Union PKO Afternoon (PLO4)',
    game_type: 'PLO4',
    variant: 'mtt',
    buy_in_amount: 20,
    guaranteed_prize: 600,
    status: 'RUNNING',
    started_at: iso(-20),
    level_started_at: iso(-4),
    current_level: 5,
    current_players: 16,
    max_players: 500,
    starting_chips: 6000,
    blind_structure: MTT_BLINDS,
    late_reg_mins: 60,
    late_reg_levels: 8,
  } as Partial<LobbyTournamentRow>),
  'mtt'
);
/* Dan 2026-08-25, image 1: "if a tournament has multiple tags (like Freezout,
   Turbo, Guaranteed, and more below it) they must ALWAYS ALL BE DISPLAYED."
   This row is built to produce the longest medallion list the platform can
   emit, so the check fails if any of them is clipped. */
const MTT_MANYTAGS = tournamentEntry(
  tourn({
    name: 'Afternoon PLO Turbo Mystery Bounty Re-Entry Rebuy (NLH)',
    variant: 'mtt',
    guaranteed_prize: 150,
    current_players: 4,
    max_players: 500,
    starting_chips: 12000,
    blind_structure: MTT_BLINDS,
    late_reg_mins: 45,
    late_reg_levels: 6,
    is_reentry: true,
    rebuy_cost: 5,
    addon_cost: 5,
  } as Partial<LobbyTournamentRow>),
  'mtt'
);
const MTT2 = tournamentEntry(
  tourn({
    name: 'Monday Grind NLH Mystery Bounty Deepstack Rebuy',
    variant: 'mtt',
    guaranteed_prize: 300,
    current_players: 21,
    max_players: 500,
    starting_chips: 25000,
    blind_structure: MTT_BLINDS,
    late_reg_mins: 90,
  } as Partial<LobbyTournamentRow>),
  'mtt'
);
const SPIN = tournamentEntry(
  tourn({
    name: '10 Chip Spin PLO6',
    game_type: 'PLO6',
    variant: 'spin',
  } as Partial<LobbyTournamentRow>),
  'spin'
);
const SPIN_RUN = tournamentEntry(
  tourn({
    name: '25 Chip Spin NLH',
    variant: 'spin',
    status: 'RUNNING',
    current_players: 3,
    starting_chips: 1000,
    spin_multiplier: 25,
    level_started_at: iso(-1),
    current_level: 2,
  } as Partial<LobbyTournamentRow>),
  'spin'
);
const HU = tournamentEntry(
  tourn({
    name: 'NLH Heads-Up 10',
    variant: 'sng',
    max_players: 2,
    current_players: 1,
    starting_chips: 1500,
    blind_structure: MTT_BLINDS,
  } as Partial<LobbyTournamentRow>),
  'sng'
);
const CASH = cashEntry(
  table({
    name: 'NLH 25/50 INSURANCE TEST',
    small_blind: 25,
    big_blind: 50,
    min_buy_in: 2000,
    max_buy_in: 10000,
    /* Columns, not `settings` — the live shape. */
    insurance_enabled: true,
    straddle_enabled: true,
    auto_utg_straddle: true,
    bomb_pot_enabled: true,
    bomb_pot_frequency: 10,
    bomb_pot_double_board: true,
    ante_enabled: true,
    ante: 5,
    seven_deuce_enabled: true,
    seven_deuce_amount: 20,
    time_bank_enabled: true,
    all_in_or_fold: true,
  })
);
/* Dan 2026-08-25, image 3: "the spacing needs to be there even if there isn't
   a table name". This row has none. */
const CASH_NONAME = cashEntry(
  table({
    name: 'PLO6 1/2',
    game_variant: 'plo6',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 80,
    max_buy_in: 400,
    current_players: 3,
    max_players: 6,
    run_it_twice: true,
    allow_run_it_twice: true,
  })
);
const CASH2 = cashEntry(
  table({
    name: 'PLO4 5/10 The Friday Night Big One',
    game_variant: 'plo4',
    small_blind: 5,
    big_blind: 10,
    min_buy_in: 400,
    max_buy_in: 2000,
    current_players: 8,
    max_players: 8,
    run_it_twice: true,
    allow_run_it_twice: true,
    time_bank_enabled: true,
  })
);

/* Dan 2026-08-25: the five lobby flags plus the five newly-enforced rule
   medallions all land in the title area, which is the most crowded part of the
   card. This row carries every one of them at once so the width sweep fails if
   any of them pushes something off the card. */
const CASH_EVERY_FLAG = cashEntry(
  table({
    name: 'NLH 2/5 The Vault',
    small_blind: 2,
    big_blind: 5,
    min_buy_in: 200,
    max_buy_in: 1000,
    current_players: 5,
    max_players: 6,
    is_featured: true,
    is_vip_only: true,
    label_as_new: true,
    cap_enabled: true,
    cap_bb: 40,
    no_rathole: true,
    pineapple_holdem: true,
    is_anonymous: true,
    restrict_observers: true,
    time_bank_enabled: true,
    insurance_enabled: true,
  })
);

const CTX = {
  waitlistedIds: new Set<string>(),
  seatedIds: new Set<string>([CASH.id]),
  registeredIds: new Set<string>([MTT.id]),
  favoriteIds: new Set<string>(),
  onRegister: () => {},
  onJoinTable: () => {},
  onViewTable: () => {},
  onToggleFavorite: () => {},
};

const TABS: { cat: LobbyCategory; rows: (typeof MTT)[] }[] = [
  /* ALL is MTTs and cash ONLY, matching what ClubHomePage actually builds
     ("SPINS AND HEADS UP ARE NEVER HERE", pinned by allTabScope.test.ts).
     Feeding it a Spin made the harness exercise a state production cannot
     reach, which is how a synthetic pass hides a real gap. */
  { cat: 'ALL', rows: [MTT, MTT2, CASH, CASH2, CASH_EVERY_FLAG] },
  { cat: 'MTT', rows: [MTT, MTT2, MTT_MANYTAGS] },
  { cat: 'HOLDEM', rows: [CASH, CASH2, CASH_EVERY_FLAG] },
  { cat: 'OMAHA', rows: [CASH_NONAME, CASH2] },
  { cat: 'SPIN', rows: [SPIN, SPIN_RUN] },
  { cat: 'SNG', rows: [HU] },
];

const shell = (body: string) => `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { --club-dark:#0a0b0f; --text-primary:#f3f4f6; --text-secondary:#c8ccd4;
          --text-tertiary:#8b8f98; --club-blue:#4169e1; --club-blue-light:#5b83e8;
          --success-green:#00d26a; --font-primary:system-ui,sans-serif; }
  * { box-sizing: border-box; }
  body { margin:0; background:#000; font-family: var(--font-primary); }
  h2 { color:#7fb0ff; font:700 12px var(--font-primary); margin:14px 8px 6px; letter-spacing:.08em; }
${CSS}
</style></head><body>${body}</body></html>`;

const html = shell(
  TABS.map(
    ({ cat, rows }) =>
      `<h2>${cat}</h2>` +
      renderToStaticMarkup(
        <LobbyTable
          entries={rows}
          category={cat}
          selectedId={null}
          onSelect={() => {}}
          onActivate={() => {}}
          ctx={CTX}
        />
      )
  ).join('')
);

writeFileSync(`${OUT}/lobby.html`, html);

import { it, expect } from 'vitest';

/* The check needs a real browser. Cloud agent sandboxes have no Playwright
   download and no route to the registry to get one, so it SKIPS there rather
   than failing — a skipped layout check is honest, a fake pass is not. On any
   machine with `npx playwright install chromium` it runs for real. */
const haveBrowser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

/* Dan photographed a phone, but the defect was never phone-specific: the
   lobby has five layout bands and only one of them was ever checked. The
   641-1023px band was running a stripped table that had shed Payout, Starting
   Stack, Level Time, Rules and Variant on the way down and never got them
   back, and had no action button either. So the check sweeps the bands. */
const WIDTHS = [
  { w: 375, band: 'phone' },
  { w: 414, band: 'large phone' },
  { w: 768, band: 'tablet portrait' },
  { w: 900, band: 'tablet, last card width' },
  { w: 1024, band: 'tablet landscape, back to a table' },
  { w: 1440, band: 'desktop' },
];

it.skipIf(!haveBrowser)(
  'renders every lobby card with nothing clipped, in every layout band',
  async () => {
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const failures: string[] = [];

    for (const { w, band } of WIDTHS) {
      const page = await browser.newPage({
        viewport: { width: w, height: 1000 },
        deviceScaleFactor: 1,
      });
      await page.goto(`file://${OUT}/lobby.html`);
      await page.waitForTimeout(250);

      const report = await page.evaluate(() => {
        const clipped: string[] = [];
        document.querySelectorAll('td').forEach((td) => {
          const el = td as HTMLElement;
          if (el.offsetParent === null && getComputedStyle(el).display === 'none') return;
          const cs = getComputedStyle(el);
          const hidden = cs.overflow === 'hidden' || cs.overflowY === 'hidden';
          if (hidden && el.scrollHeight > el.clientHeight + 1)
            clipped.push(
              `${el.className.trim()} :: content ${el.scrollHeight}px in a ${el.clientHeight}px box :: "${(el.textContent || '').slice(0, 46)}"`
            );
        });
        const vis = (el: Element | null) =>
          !!el && getComputedStyle(el as HTMLElement).display !== 'none';
        /* A Spin row is the densest thing the lobby draws, so it is the probe:
           if its payout survives the band, everything narrower did too. The
           SECOND one is running — a Spin that has not started has no level to
           show, and the card correctly hides an empty cell rather than
           printing an empty well. */
        const spins = [...document.querySelectorAll('tbody tr[data-kind="spin"]')] as HTMLElement[];
        const spin = spins[0] ?? null;
        const running = spins[1] ?? null;
        void running;
        return {
          clipped,
          overflowX: document.documentElement.scrollWidth > window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          spinPayout: vis(spin?.querySelector('.lt-col-payout') ?? null),
          spinStack: vis(spin?.querySelector('.lt-col-tstack') ?? null),
          /* The SPIN tab carries COL_LEVELTIME, not COL_TLEVEL — "3 Min
             Levels" is the fact a Spin has, and Current Level belongs to an
             MTT. Probing the wrong class is how a check passes while the thing
             it names is missing. */
          spinLevel: vis(spin?.querySelector('.lt-col-leveltime') ?? null),
          spinAction: vis(spin?.querySelector('.lt-col-actions') ?? null),
          rowsPerLine: (() => {
            const rows = [...document.querySelectorAll('tbody tr')] as HTMLElement[];
            if (rows.length < 2) return 1;
            const top = Math.round(rows[0].getBoundingClientRect().top);
            return rows.filter((r) => Math.round(r.getBoundingClientRect().top) === top).length;
          })(),
        };
      });

      await page.screenshot({ path: `${OUT}/lobby-${w}.png`, fullPage: true });
      await page.close();

      const card = w <= 900;
      console.log(
        `\n${w}px (${band}) | scrollWidth ${report.scrollWidth} | sideways ${report.overflowX} | ` +
          `${report.rowsPerLine} per line | spin: payout ${report.spinPayout} stack ${report.spinStack} ` +
          `level ${report.spinLevel} action ${report.spinAction} | clipped ${report.clipped.length}`
      );
      report.clipped.forEach((c) => console.log('  !', c));

      report.clipped.forEach((c) => failures.push(`${w}px: clipped ${c}`));
      if (report.overflowX) failures.push(`${w}px: the lobby scrolls sideways`);
      /* The Spin board is five columns wide at ANY size, so its three
         defining facts survive every band — the wide breakpoints shed columns
         for the eight-column ALL board and used to take this board down with
         them. The action button is a card affordance and correctly absent from
         the desktop table, where the panel carries it. */
      if (!report.spinPayout) failures.push(`${w}px: a Spin does not show its payout`);
      if (!report.spinStack) failures.push(`${w}px: a Spin does not show its stack`);
      if (!report.spinLevel) failures.push(`${w}px: a Spin does not show its blind speed`);
      if (card && !report.spinAction) failures.push(`${w}px: a Spin card has no action button`);
      /* The tablet half of the card band puts two cards on a line; a phone
         puts one, and the desktop table is one row per line by definition. */
      const want = w >= 641 && w <= 900 ? 2 : 1;
      if (report.rowsPerLine !== want)
        failures.push(`${w}px: ${report.rowsPerLine} cards per line, expected ${want}`);
    }

    await browser.close();
    console.log('\nscreenshots:', `${OUT}/lobby-<width>.png`);
    expect(failures, failures.join('\n')).toHaveLength(0);
  },
  180000
);

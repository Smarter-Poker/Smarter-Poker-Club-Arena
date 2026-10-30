import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { transpileModule } from 'typescript';
import { openLobbyGameSection } from '../e2e/support/lobbyGameSections';
import {
  scopedStalledTables,
  classifyMissingTournamentSubject,
} from '../e2e/support/certifiableSubject';
import {
  eligibleHudClock,
  hudCandidateTableIdBatches,
  mergeHudCandidateTableIds,
  MTT_HUD_LEVEL_CAP_MS,
  MTT_SELECTION_LOOKAHEAD_LEVELS,
  qualifyHudTournamentRows,
  scanHudCandidateBatches,
  selectableHudClock,
  selectHudTableCandidatesRoundRobin,
} from '../e2e/support/tournamentHudWitness';

/**
 * Production runs 36525050502 and 36526016402 (2026-09-29) both chose the MTT
 * table of the 383-player field, whose add-on period was open until 06:07:47Z,
 * and then refused "no eligible natural HUD clock" minutes later. The clock
 * predicate was right; the selector never asked it. Cash run 36525050502 failed
 * inside a 112-second, twelve-action hand that legitimately outlasted the fixed
 * 90-second budget (hand_history: started 05:27:17, ended 05:29:09).
 */
const id = '4dddfe78-e557-4237-87cc-428c4c9a98f8';
const now = Date.parse('2026-09-29T05:45:00Z');
const level = (minutes: number, extra: Record<string, unknown> = {}) => ({
  durationMinutes: minutes,
  ...extra,
});
const running = {
  id,
  format_contract: 'mtt-v1',
  status: 'RUNNING',
  current_players: 381,
  started_at: '2026-09-29T05:00:00Z',
  current_level: 3,
  level_started_at: '2026-09-29T05:43:00Z',
  on_break: false,
  // These baseline fixtures isolate add-on, occupancy and schedule behavior.
  synchronized_breaks: false,
  accelerated_mtt: false,
  addon_period_started_at: null,
  addon_period_ends_at: null,
  blind_structure: [level(10), level(10), level(10), level(10), level(10), level(10), level(10)],
};

describe('an MTT table is selected only if its tournament can yield an eligible HUD clock', () => {
  it('excludes a currently eligible synchronized clock whose recovery look-ahead reaches the break', () => {
    const synchronized = { ...running, synchronized_breaks: true };
    expect(eligibleHudClock(synchronized, now)).not.toBeNull();
    const qualifications = qualifyHudTournamentRows([synchronized], now);
    expect(qualifications[0].category).toBe('selection_lookahead_ineligible');
    expect(qualifications[0].clock).toBeNull();
    expect(
      selectHudTableCandidatesRoundRobin(qualifications, [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tournament_id: id,
          status: 'running',
          current_players: 9,
        },
      ])
    ).toEqual([]);
    const breakFree = qualifyHudTournamentRows([running], now);
    expect(
      selectHudTableCandidatesRoundRobin(breakFree, [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tournament_id: id,
          status: 'running',
          current_players: 9,
        },
      ])
    ).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
  });

  it('refuses the field whose add-on period is open, the exact production refusal', () => {
    const addOnOpen = {
      ...running,
      addon_period_started_at: '2026-09-29T05:09:47.640Z',
      addon_period_ends_at: '2026-09-29T06:07:47.640Z',
    };
    expect(eligibleHudClock(addOnOpen, now)).toBeNull();
    expect(selectableHudClock(addOnOpen, now)).toBeNull();
    // The same field once its add-on period has closed is selectable again.
    expect(
      selectableHudClock({ ...addOnOpen, addon_period_ends_at: '2026-09-29T05:44:00Z' }, now)
    ).not.toBeNull();
  });

  it('accepts a running, break-free, add-on-free tournament with its real clock', () => {
    const clock = selectableHudClock(running, now);
    expect(clock).toEqual(eligibleHudClock(running, now));
    expect(clock?.tournamentId).toBe(id);
    expect(clock?.remainingMs).toBe(8 * 60_000);
  });

  it.each([
    ['on a break', { on_break: true }],
    ['accelerated', { accelerated_mtt: true }],
    ['paused or terminal', { status: 'PAUSED' }],
    ['too few players', { current_players: 3 }],
    ['unreadable structure', { blind_structure: 'not json' }],
  ])('refuses a tournament that is %s', (_name, patch) => {
    expect(selectableHudClock({ ...running, ...patch }, now)).toBeNull();
  });

  it('refuses a break inside the look-ahead a level roll-over during setup would reach', () => {
    for (let ahead = 1; ahead <= MTT_SELECTION_LOOKAHEAD_LEVELS; ahead++) {
      const structure = running.blind_structure.map((entry) => ({ ...entry }));
      structure[3 + ahead] = level(5, { isBreak: true }) as never;
      expect(selectableHudClock({ ...running, blind_structure: structure }, now)).toBeNull();
    }
    // Past the look-ahead the later read is a fresh selection problem.
    const far = running.blind_structure.map((entry) => ({ ...entry }));
    far.push(level(5, { isBreak: true }) as never);
    expect(
      selectableHudClock({ ...running, current_level: 2, blind_structure: far }, now)
    ).not.toBeNull();
  });

  it('refuses a look-ahead level longer than the certifiable cap', () => {
    const structure = running.blind_structure.map((entry) => ({ ...entry }));
    structure[5] = level(MTT_HUD_LEVEL_CAP_MS / 60_000 + 1) as never;
    expect(selectableHudClock({ ...running, blind_structure: structure }, now)).toBeNull();
  });

  it('holds the last level once the schedule ends, as the engine does', () => {
    const short = { ...running, current_level: 5 };
    expect(selectableHudClock(short, now)).not.toBeNull();
  });

  it('finds a lower-occupancy eligible field behind forty tables from one ineligible field', () => {
    const ineligibleId = '44444444-4444-4444-8444-444444444444';
    const eligibleId = '55555555-5555-4555-8555-555555555555';
    const tournaments = [
      {
        ...running,
        id: ineligibleId,
        current_players: 360,
        addon_period_started_at: '2026-09-29T05:09:47.640Z',
        addon_period_ends_at: '2026-09-29T06:07:47.640Z',
      },
      { ...running, id: eligibleId, current_players: 8 },
    ];
    const highOccupancyTables = Array.from({ length: 40 }, (_, index) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
      tournament_id: ineligibleId,
      status: 'running',
      current_players: 9,
    }));
    const eligibleTableId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const qualifications = qualifyHudTournamentRows(tournaments, now);

    expect(
      qualifications.map(({ tournamentId, category }) => ({ tournamentId, category }))
    ).toEqual([
      { tournamentId: ineligibleId, category: 'addon_period_open' },
      { tournamentId: eligibleId, category: 'eligible' },
    ]);
    expect(
      selectHudTableCandidatesRoundRobin(qualifications, [
        ...highOccupancyTables,
        {
          id: eligibleTableId,
          tournament_id: eligibleId,
          status: 'running',
          current_players: 4,
        },
      ])
    ).toEqual([eligibleTableId]);
  });

  it('orders fields fairly, keeps a live backup after a stale top row, and rejects SNG contracts', () => {
    const firstMtt = '11111111-aaaa-4111-8111-111111111111';
    const secondMtt = '22222222-bbbb-4222-8222-222222222222';
    const sng = '33333333-cccc-4333-8333-333333333333';
    const qualifications = qualifyHudTournamentRows(
      [
        { ...running, id: firstMtt },
        { ...running, id: secondMtt },
        { ...running, id: sng, format_contract: 'sng-v1' },
      ],
      now
    );
    const staleTop = 'aaaaaaaa-0000-4000-8000-000000000001';
    const liveBackup = 'aaaaaaaa-0000-4000-8000-000000000002';
    const otherField = 'bbbbbbbb-0000-4000-8000-000000000001';
    const sngTable = 'cccccccc-0000-4000-8000-000000000001';

    expect(qualifications.at(-1)?.category).toBe('not_mtt_format');
    expect(
      selectHudTableCandidatesRoundRobin(
        qualifications,
        [
          { id: staleTop, tournament_id: firstMtt, status: 'running', current_players: 9 },
          { id: liveBackup, tournament_id: firstMtt, status: 'running', current_players: 8 },
          { id: otherField, tournament_id: secondMtt, status: 'running', current_players: 4 },
          { id: sngTable, tournament_id: sng, status: 'running', current_players: 9 },
        ],
        4
      )
    ).toEqual([staleTop, otherField, liveBackup]);
  });

  it('keeps discovered IDs ahead of scoped fallbacks and advances to a healthy backup batch', async () => {
    const ids = mergeHudCandidateTableIds(['stale-top', 'live-backup'], ['scoped-first'], 3);
    expect(ids).toEqual(['stale-top', 'live-backup', 'scoped-first']);
    const reads: string[][] = [];
    const scan = await scanHudCandidateBatches({
      batches: hudCandidateTableIdBatches(ids, 1),
      read: async (batch) => {
        reads.push(batch);
        return batch[0] === 'live-backup' ? ['live-backup'] : [];
      },
      usable: (rows) => rows.includes('live-backup'),
    });
    expect(reads).toEqual([['stale-top'], ['live-backup']]);
    expect(scan.requestedTableIds).toEqual(['stale-top', 'live-backup']);
    expect(scan.results).toEqual([[], ['live-backup']]);
  });
});

describe('the certificate spec applies that selection and a cash budget sized from real hands', () => {
  const spec = readFileSync(
    join(__dirname, '..', 'e2e', 'production-live-table-realtime.spec.ts'),
    'utf8'
  );
  const tournament = spec.slice(
    spec.indexOf('async function certifyReadOnlyTournamentFormat('),
    spec.indexOf("test.describe('production mobile WebKit live-table realtime continuity'")
  );
  const selection = spec.slice(
    spec.indexOf('async function selectProgressingTournamentTable('),
    spec.indexOf('function tableIdFromUrl(')
  );
  const cash = spec.slice(spec.indexOf("test('an already-running table stays live"));

  it('qualifies MTT tables by the HUD clock at selection, and only MTT', () => {
    expect(tournament).toContain("gameFormat === 'mtt' ? boardReader : undefined");
    expect(selection).toContain('options.hudReader.discoverSelectableTableIds(');
    expect(selection).toContain('mergeHudCandidateTableIds(');
    expect(selection).toContain('scanHudCandidateBatches({');
    expect(selection).toContain('readEngineHealth(request, { candidateTableIds: batch }');
    expect(selection).toContain('operationalPollFailure.rethrowIfPresent();');
    expect(selection).toContain('options.hudReader.clocks(');
    expect(selection).toContain('selectableHudClock');
    expect(selection).toContain('return fresh.filter((table) => clocks.has(table.tableId));');
    // It still refuses loudly when nothing qualifies, naming why.
    expect(selection).toContain('can yield an eligible natural HUD clock');
    // The post-recovery clock read is unchanged and still mandatory.
    expect(tournament).toContain('reader.clocks([candidate.id])');
    expect(tournament).toContain('The recovered MTT has no eligible natural HUD clock');
  });

  it('gives cash the tournament budget: base case + one hand bound, one fixed deadline', () => {
    expect(cash).toContain('testInfo.setTimeout(testInfo.timeout + CAUSAL_HAND_TIMEOUT_MS)');
    expect(cash).toContain(
      'const observationDeadline = caseStartedAt + testInfo.timeout - CASH_CASE_TAIL_MS'
    );
    // Both causal cycles draw on what is left of that one deadline, never on
    // a fresh fixed 90 seconds that a 112-second hand outlasts.
    expect(cash.match(/remainingObservationMs\(observationDeadline\)/g)).toHaveLength(2);
    expect(cash).not.toMatch(/CAUSAL_HAND_TIMEOUT_MS,\s*MAX_GAMEPLAY_SILENCE_MS/);
    // The silence limit, the real liveness proof, is untouched.
    expect(spec).toContain('const MAX_GAMEPLAY_SILENCE_MS = 45_000');
  });

  it('races several occupied cash tables to their next deal instead of one', () => {
    expect(spec).toContain('const CASH_PROGRESS_CANDIDATES = 8');
    expect(cash).toContain('selectOccupiedRunningCashTables(page, request)');
    expect(cash).toContain('selected.tables,');
    expect(cash).toContain('const { candidate } = engineBeforeNavigation.selected;');
    const prove = spec.slice(
      spec.indexOf('async function proveTableProgressedBeforeNavigation('),
      spec.indexOf('/**\n * Pick only from tables that were live before the browser existed')
    );
    expect(prove).toContain('continuouslyActive(');
    expect(prove).toContain('current.handCount > contender.table.handCount');
    expect(prove).toContain('remainingObservationMs(deadline)');
  });
});

describe('the actual cash selector scans across lobby tabs', () => {
  const source = readFileSync(
    join(__dirname, '../e2e/production-live-table-realtime.spec.ts'),
    'utf8'
  );
  const body = source.slice(
    source.indexOf('async function selectCashLobbyTab('),
    source.indexOf('async function proveTableProgressedBeforeNavigation(')
  );
  async function select(rows: Record<string, string[]>, removed: string[] = []) {
    let active = 'default';
    let cashSectionOpen = false;
    const readiness: string[] = [];
    const navigation = source.slice(
      source.indexOf('    // The engine-progress wait above can outlast'),
      source.indexOf('    const navigationStartedAt = Date.now();')
    );
    const visited: string[] = [];
    const reads: string[][] = [];
    const page = {
      goto: async () => {},
      url: () => 'https://example.invalid/clubs/fixture',
      locator: (selector: string) => ({
        first: () => ({
          waitFor: async () => {
            if (!cashSectionOpen)
              throw new Error('Cash Games must open before cash cards are ready');
            readiness.push('cards-ready');
          },
        }),
        // Exercise the real card branch; a hidden off-tab row is not visible.
        isVisible: async () => false,
        getByRole: () => ({
          viewId: /data-id="([^"]+)"/.exec(selector)?.[1],
        }),
      }),
      getByRole: (role: string, { name }: { name: string }) => ({
        requiresCashSection: role === 'tab',
        waitFor: async () => {
          if (role !== 'button' || name !== 'Cash Games')
            throw new Error(`Unexpected section control: ${role} ${name}`);
        },
        getAttribute: async () => (cashSectionOpen ? 'true' : 'false'),
        click: async () => {
          if (role === 'button') {
            if (name !== 'Cash Games') throw new Error(`Unexpected browse action: ${name}`);
            cashSectionOpen = true;
            readiness.push('cash-section-open');
            return;
          }
          if (!cashSectionOpen) throw new Error('Cash Games must open before selecting a cash tab');
          active = name;
        },
      }),
      waitForTimeout: async () => {},
    };
    const selector = new Function(
      'CLUB_LOBBY',
      'CASH_PROGRESS_CANDIDATES',
      'expect',
      'prepareCashLobbyActions',
      'openLobbyGameSection',
      'visibleRunningCashCandidates',
      'readEngineHealth',
      'healthyRunningTable',
      'CASH_SPECTATOR_ACTION',
      transpileModule(body, {}).outputText +
        transpileModule(
          `async function openWinner(page, selected) {
          const engineBeforeNavigation = { selected };
          const { candidate } = selected;
          ${navigation}
          return view;
        }`,
          {}
        ).outputText +
        '\nreturn { select: selectOccupiedRunningCashTables, open: openWinner };'
    )(
      'https://example.invalid/clubs/fixture',
      8,
      (locator: { viewId?: string; requiresCashSection?: boolean }) => ({
        toBeVisible: async () => {
          if (locator.requiresCashSection && !cashSectionOpen)
            throw new Error('Cash Games must open before cash tabs are visible');
          if (locator.viewId && !(rows[active] ?? []).includes(locator.viewId))
            throw new Error(`View ${locator.viewId} is hidden on ${active}`);
        },
        toHaveAttribute: async () => {},
      }),
      async () => {},
      openLobbyGameSection,
      async () => {
        visited.push(active);
        return (rows[active] ?? []).map((id) => ({ id, gameFormat: 'cash' }));
      },
      async (_: unknown, { candidateTableIds: tableIds }: { candidateTableIds: string[] }) => {
        expect(tableIds).toBeDefined();
        reads.push(tableIds);
        return { sequence: reads.length, tableIds };
      },
      (health: { sequence: number; tableIds: string[] }, id: string) =>
        health.tableIds.includes(id) && !(health.tableIds.length > 1 && removed.includes(id))
          ? { tableId: id, handCount: health.sequence }
          : null,
      /View|Watch/
    );
    return {
      result: await selector.select(page, {}),
      visited,
      reads,
      readiness,
      open: (selected: unknown) => selector.open(page, selected),
      active: () => active,
    };
  }

  it('opens the Cash Games section before waiting for cash cards and scanning variants', async () => {
    const { readiness, visited } = await select({ NLH: ['live'] });
    expect(readiness).toEqual(['cash-section-open', 'cards-ready']);
    expect(visited).toEqual(['NLH', 'PLO', 'LIMIT']);
  });

  it('keeps the first NLH table and discovers PLO and LIMIT witnesses without duplicates', async () => {
    const { result, visited, reads } = await select({
      default: ['nlh'],
      NLH: ['nlh'],
      PLO: ['plo'],
      LIMIT: ['limit'],
    });
    expect(visited).toEqual(['NLH', 'PLO', 'LIMIT']);
    expect(result.tables.map((row: any) => row.candidate.id)).toEqual(['nlh', 'plo', 'limit']);
    expect(reads.at(-1)).toEqual(['nlh', 'plo', 'limit']);
    expect(result.tables.every((row: any) => row.table.handCount === result.health.sequence)).toBe(
      true
    );
  });

  it('caps the race at eight and refreshes all baselines together', async () => {
    const { result, visited, reads } = await select({
      default: ['one'],
      NLH: ['one'],
      PLO: Array.from({ length: 12 }, (_, i) => `plo${i}`),
    });
    expect(result.tables).toHaveLength(8);
    expect(new Set(result.tables.map((row: any) => row.candidate.id)).size).toBe(8);
    expect(visited).not.toContain('LIMIT');
    expect(reads.at(-1)).toHaveLength(8);
  });

  it('removes a witness that is no longer healthy at the shared baseline read', async () => {
    const { result } = await select({ NLH: ['departed'], PLO: ['live'] }, ['departed']);
    expect(result.tables.map((row: any) => row.candidate.id)).toEqual(['live']);
  });

  it.each(['NLH', 'PLO'])(
    'restores the selected %s witness after the scan leaves LIMIT active',
    async (winnerTab) => {
      const fixture = await select({
        default: ['nlh'],
        NLH: ['nlh'],
        PLO: ['plo'],
        LIMIT: ['limit'],
      });
      expect(fixture.active()).toBe('LIMIT');
      const id = winnerTab === 'NLH' ? 'nlh' : 'plo';
      const winner = fixture.result.tables.find((entry: any) => entry.candidate.id === id);
      await expect(fixture.open(winner)).resolves.toMatchObject({ viewId: id });
      expect(fixture.active()).toBe(winnerTab);
      expect(winner.tabName).toBe(winnerTab);
    }
  );

  it('excludes a stale contender without poisoning the healthy cash backup', async () => {
    const { result } = await select({ NLH: ['stale', 'healthy'] }, ['stale']);
    expect(result.tables.map((row: any) => row.candidate.id)).toEqual(['healthy']);
  });
  it('refuses cash discovery when every contender is stale', async () => {
    await expect(
      select({ NLH: ['stale-one', 'stale-two'] }, ['stale-one', 'stale-two'])
    ).rejects.toThrow('no occupied');
  });
  it('uses discovery scope throughout pre-navigation races and retains strict chosen subjects', () => {
    expect(source).toContain(
      'candidateTableIds: contenders.map((contender) => contender.candidate.id)'
    );
    expect(source).toContain('candidateTableIds: baselines.map((t) => t.tableId)');
    expect(source).toContain('tableIds: [candidate.id]');
    expect(source).toContain('tableIds: subjects.map((entry) => entry.candidate.id)');
  });
  it('refuses a lobby without any healthy occupied witness', async () => {
    await expect(select({})).rejects.toThrow('no occupied');
  });
});

describe('exact candidate health is discovery, selected health is strict', () => {
  const source = readFileSync(
    join(__dirname, '..', 'e2e', 'production-live-table-realtime.spec.ts'),
    'utf8'
  );
  const body = source.slice(
    source.indexOf('async function readEngineHealth('),
    source.indexOf('/**\n * Say the fleet')
  );
  const sha = 'a'.repeat(40);
  const readHealth = new Function(
    'expect',
    'scopedStalledTables',
    'reportStallsThisCertificateIsNotJudging',
    'ENGINE_HEALTH_URL',
    'EXPECTED_ENGINE_SHA',
    'CLUB_ID',
    'UNION_ID',
    transpileModule(body, {}).outputText + ';return readEngineHealth;'
  )(
    expect,
    scopedStalledTables,
    () => {},
    'https://engine.smarter.poker/health',
    sha,
    'club',
    'union'
  );
  const admitted = new Function(
    'MAX_GAMEPLAY_SILENCE_MS',
    transpileModule(
      source.slice(
        source.indexOf('function healthyRunningTable('),
        source.indexOf('async function visibleRunningCashCandidates(')
      ),
      {}
    ).outputText + ';return healthyRunningTable;'
  )(45000);
  const stale = {
    tableId: '8a3c1b31-1111-4111-8111-111111111111',
    gameFormat: 'mtt',
    clubId: 'club',
    seated: 8,
    dealable: 8,
    handCount: 3,
    msSinceProgress: 821000,
    paused: false,
    loopPhase: 'playing',
  };
  const healthy = {
    ...stale,
    tableId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    msSinceProgress: 1000,
  };
  const request = (rows: unknown[]) => ({
    get: async () => ({
      status: () => 200,
      json: async () => ({
        liveness: 'ok',
        wholeFleetStalled: false,
        releaseSha: sha,
        tableLiveness: rows,
      }),
    }),
  });
  it('allows stale candidates to be excluded while a healthy backup remains readable', async () => {
    const health = await readHealth(request([stale, healthy]), {
      candidateTableIds: [stale.tableId, healthy.tableId],
    });
    expect(scopedStalledTables(health.tableLiveness).map((row) => row.tableId)).toEqual([
      stale.tableId,
    ]);
    expect(
      health.tableLiveness
        .filter((row: typeof stale) => admitted(health, row.tableId, 'mtt') !== null)
        .map((row: typeof stale) => row.tableId)
    ).toEqual([healthy.tableId]);
  });
  it('still refuses a selected table that stalled', async () => {
    await expect(readHealth(request([stale]), { tableIds: [stale.tableId] })).rejects.toThrow();
  });
  it('still names the real failure when every discovered candidate is stale', async () => {
    const health = await readHealth(request([stale]), { candidateTableIds: [stale.tableId] });
    expect(scopedStalledTables(health.tableLiveness).map((row) => row.tableId)).toEqual([
      stale.tableId,
    ]);
    expect(
      health.tableLiveness.filter(
        (row: typeof stale) => admitted(health, row.tableId, 'mtt') !== null
      )
    ).toEqual([]);
    const verdict = classifyMissingTournamentSubject({
      rows: health.tableLiveness,
      gameFormat: 'mtt',
      clubIds: ['club'],
      minimumStableSeats: 3,
      maxGameplaySilenceMs: 45000,
    });
    expect(verdict.verdict).toBe('stalled');
    expect(verdict.stalled.map((row) => row.tableId)).toEqual([stale.tableId]);
  });
});

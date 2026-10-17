import type { Page } from '@playwright/test';
import type { EngineSocketJournal } from './liveTableRealtime';
import { remainingInitialTableReadinessMs } from './initialTableReadiness';

/** Snapshot before page cleanup; retain protocol facts, never frame payloads. */
export function naturalMultiRunTransportEvidence(
  journal: Pick<EngineSocketJournal, 'summary' | 'frames'>,
  tableId: string
) {
  return {
    ...journal.summary(tableId),
    physicalControlFrames: journal.frames
      .filter(({ message }) => message.type === 'PING' || message.type === 'PONG')
      .map(({ at, socketId, direction, message }) => ({
        at,
        socketId,
        direction,
        type: message.type,
      })),
  };
}

export interface NaturalMultiRunCandidate {
  id: string;
  current_players: number;
  status: string;
  game_type: string;
  tournament_id: string | null;
  max_players: number;
  is_deleted: boolean;
  is_template: boolean;
  run_it_twice?: boolean | null;
  allow_run_it_twice?: boolean | null;
  run_it_twice_enabled?: boolean | null;
  run_it_mode?: string | null;
}

export function naturalMultiRunCandidateQuery(clubId: string): URLSearchParams {
  return new URLSearchParams({
    select:
      'id,current_players,status,game_type,tournament_id,max_players,is_deleted,is_template,run_it_twice,allow_run_it_twice,run_it_twice_enabled,run_it_mode',
    club_id: `eq.${clubId}`,
    status: 'eq.running',
    game_type: 'eq.cash',
    tournament_id: 'is.null',
    max_players: 'gt.2',
    current_players: 'gte.2',
    is_deleted: 'eq.false',
    is_template: 'eq.false',
    order: 'current_players.desc,id.asc',
    limit: '32',
  });
}

/** Match the serving engine's effective cash RIT gate, including legacy flags. */
export function eligibleNaturalMultiRunTable(table: NaturalMultiRunCandidate): boolean {
  return (
    table.status === 'running' &&
    table.game_type === 'cash' &&
    table.tournament_id === null &&
    table.max_players > 2 &&
    table.current_players >= 2 &&
    table.is_deleted === false &&
    table.is_template === false &&
    (((table.run_it_twice ?? true) && (table.allow_run_it_twice ?? true)) ||
      (table.run_it_twice_enabled ?? false))
  );
}

/** At most two cold starts share one deadline; all six remain open for observation. */
export async function initializeNaturalMultiRunObservers<T>(
  tables: T[],
  initialize: (table: T, navigationBudgetMs: number, remainingSetup: () => number) => Promise<void>,
  setupStartedAt: number,
  now = Date.now
): Promise<void> {
  if (tables.length !== 6) throw new Error('Natural multirun proof requires all six observers');
  const remainingSetup = () => remainingInitialTableReadinessMs(setupStartedAt, 120_000, now());
  let next = 0;
  let failed = false;
  let failure: unknown;
  const startNext = async () => {
    while (!failed && next < tables.length) {
      const table = tables[next++];
      try {
        // Every active start consumes the same original allocation. The
        // ordinary baseline retains its separate connection-latency law.
        await initialize(table, remainingSetup(), remainingSetup);
        remainingSetup();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };
  // Both workers settle before the caller can close their pages on failure.
  await Promise.all([startNext(), startNext()]);
  if (failed) throw failure;
}

export interface NaturalMultiRunHistoryRow {
  table_id: string;
  rit_boards: unknown[];
}

/** Use the existing (table_id, created_at, id) index, never global history. */
export async function readNaturalMultiRunHistory(
  tableIds: string[],
  readRows: (query: URLSearchParams) => Promise<NaturalMultiRunHistoryRow[]>,
  now = Date.now()
): Promise<NaturalMultiRunHistoryRow[]> {
  if (
    !tableIds.length ||
    tableIds.length > 32 ||
    tableIds.some((id) => !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))
  )
    throw new Error('Natural multirun history requires 1 to 32 candidate table IDs');
  const rows: NaturalMultiRunHistoryRow[] = [];
  // Bound both database work per query and simultaneous read requests.
  for (let offset = 0; offset < tableIds.length; offset += 4) {
    const batch = await Promise.all(
      tableIds.slice(offset, offset + 4).map((id) =>
        readRows(
          new URLSearchParams({
            select: 'table_id,rit_boards',
            table_id: `eq.${id}`,
            created_at: `gte.${new Date(now - 30 * 60_000).toISOString()}`,
            rit_boards: 'not.is.null',
            order: 'created_at.desc',
            limit: '500',
          })
        )
      )
    );
    rows.push(...batch.flat());
  }
  return rows;
}

/**
 * Passive DOM witness. No hand, action, balance or table setting is written.
 *
 * DRIVEN BY DOM MUTATIONS, NOT ONLY BY ANIMATION FRAMES (2026-10-17). Six
 * observer tabs share one browser and only one is in front, so a sampler that
 * runs only on requestAnimationFrame can be throttled or paused on the others.
 * Run 39056430595 watched six natural multirun hands that way and recorded
 * board 1 already complete when first seen, two-run board 1 never naming its
 * winner, and not one chip landing. The ordinary payout journal
 * (installMobileAwardJournal) already samples on mutations; this does the same,
 * keeps the frame loop as a second trigger, counts a chip removed at its
 * recipient as a landing, and records the page's visibility so a hidden
 * observer is evidence rather than silence.
 */
export async function installNaturalMultiRunWitness(page: Page) {
  await page.addInitScript(() => {
    const hands: Record<string, any> = {};
    const flights = new Map<string, any>();
    const active = new Map<string, { chip: HTMLElement; id: string }>();
    const violations = new Set<string>();
    const visibility = { visibleSamples: 0, hiddenSamples: 0 };
    let currentHand = 0;
    let stopped = false;
    let frame = 0;
    const finalize = (key: string) => {
      const record = hands[key];
      if (!record || record.finalized) return;
      record.finalized = true;
      record.lanes.forEach((lane: any, index: number) => {
        if (lane.winnerAt === null)
          violations.add(`${key}: Run ${index + 1} Never Named Its Winner`);
      });
    };
    const measure = (
      chip: HTMLElement,
      recipient: string | undefined,
      table: Element | undefined
    ) => {
      const seat = Array.from(
        (table ?? document).querySelectorAll<HTMLElement>('[data-player-id]')
      ).find((node) => node.dataset.playerId === recipient);
      const target = seat?.querySelector('.seat__info')?.getBoundingClientRect();
      if (!target?.width) return null;
      const rect = chip.getBoundingClientRect();
      return Math.hypot(
        rect.x + rect.width / 2 - target.x - target.width / 2,
        rect.y + rect.height / 2 - target.y - target.height / 2
      );
    };
    const sample = () => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') visibility.hiddenSamples++;
      else visibility.visibleSamples++;
      const table = Array.from(document.querySelectorAll('.table-page')).find((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      const hand = Number(
        table?.querySelector('.table-brand__hand')?.textContent?.match(/\d+/)?.[0]
      );
      const lanes = Array.from(table?.querySelectorAll('.community-area__run') ?? []);
      const now = Date.now();
      const key =
        hand > 0 && (lanes.length === 2 || lanes.length === 3) ? `${hand}:${lanes.length}` : null;
      // The next hand has been dealt: every board of the last one must have
      // named its winner by then, or the player never saw who won it. Keyed on
      // the hand number, not on the lanes, so a re-render cannot end a hand.
      if (hand > 0 && hand !== currentHand) {
        for (const record of Object.values(hands))
          if (record.hand === currentHand) finalize(`${record.hand}:${record.runs}`);
        currentHand = hand;
      }
      if (key) {
        const record = (hands[key] ??= { hand, runs: lanes.length, firstAt: now, lanes: [] });
        lanes.forEach((lane, index) => {
          const witness = (record.lanes[index] ??= { pendingAt: null, winnerAt: null });
          const count = lane.querySelectorAll('.community-cards__card').length;
          const animating = !!lane.querySelector('[data-rs-animating="true"]');
          const winner = !!lane.querySelector('.community-area__run-winner');
          if (count < 5 || animating) witness.pendingAt ??= now;
          if (winner && (count < 5 || animating))
            violations.add(`${key}: Run ${index + 1} Award Before River`);
          if (winner && count === 5 && !animating) witness.winnerAt ??= now;
        });
      }
      for (const chip of table?.querySelectorAll<HTMLElement>('[data-chip-recipient]') ?? []) {
        const id = chip.dataset.chipFlight;
        if (!id) continue;
        const flight = flights.get(id) ?? {
          hand,
          recipient: chip.dataset.chipRecipient,
          landedAt: null,
          distance: null,
          lastDistance: null,
        };
        flights.set(id, flight);
        active.set(id, { chip, id });
        if (flight.landedAt) continue;
        const distance = measure(chip, flight.recipient, table);
        if (distance === null) continue;
        flight.lastDistance = distance;
        if (chip.dataset.chipPhase === 'landed') {
          flight.distance = distance;
          flight.landedAt = now;
          if (distance > 2) violations.add(`${hand}: Payout Missed Its Recipient`);
        }
      }
      // A chip removed at its recipient landed there even when the brief
      // landed attribute fell between two samples; one removed elsewhere did not.
      for (const [id, { chip }] of active) {
        if (chip.isConnected) continue;
        active.delete(id);
        const flight = flights.get(id);
        if (!flight || flight.landedAt) continue;
        if (flight.lastDistance !== null && flight.lastDistance <= 2) {
          flight.distance = flight.lastDistance;
          flight.landedAt = now;
        } else {
          violations.add(`${flight.hand}: Payout Disappeared Before Reaching Its Recipient`);
        }
      }
    };
    const loop = () => {
      sample();
      if (!stopped) frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    const observer = new MutationObserver(sample);
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-chip-phase', 'data-rs-animating'],
    });
    (window as any).__naturalMultiRunWitness = {
      read: () => ({
        hands: Object.values(hands),
        flights: Array.from(flights.values()).filter((f) => f.landedAt),
        violations: [...violations],
        visibility: { ...visibility, state: document.visibilityState },
      }),
      stop: () => {
        stopped = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
      },
    };
  });
}

export interface NaturalRunPacket {
  hand: number;
  runs: number;
  at: number;
  recipients: string[];
}

/** A result packet alone or a joined/replayed final board cannot certify ordering. */
export function completedNaturalRuns(packets: NaturalRunPacket[], witness: any) {
  return packets.filter((packet) => {
    const hand = witness.hands.find(
      (item: any) => item.hand === packet.hand && item.runs === packet.runs
    );
    if (!hand || hand.lanes.length !== packet.runs) return false;
    if (
      !hand.lanes.every(
        (lane: any) =>
          lane.pendingAt !== null && lane.winnerAt !== null && lane.pendingAt < lane.winnerAt
      )
    )
      return false;
    if (!packet.recipients.length) return false;
    const flights = witness.flights.filter(
      (flight: any) => flight.hand === packet.hand && flight.landedAt >= packet.at
    );
    if (
      flights.some(
        (flight: any) => !packet.recipients.includes(flight.recipient) || !(flight.distance <= 2)
      )
    )
      return false;
    return packet.recipients.every((recipient) =>
      flights.some((flight: any) => flight.recipient === recipient && flight.distance <= 2)
    );
  });
}

/** Use the immutable deployment identity; version is only a display label. */
export function naturalMultiRunEngineIdentity(
  health: { version?: string; releaseSha?: string },
  expected: string
): string {
  const observed = String(health.releaseSha || '').trim();
  if (
    !/^[0-9a-f]{40}$/.test(expected) ||
    !/^[0-9a-f]{40}$/.test(observed) ||
    observed !== expected
  ) {
    throw new Error('Natural multirun proof requires the exact serving engine releaseSha');
  }
  return observed;
}

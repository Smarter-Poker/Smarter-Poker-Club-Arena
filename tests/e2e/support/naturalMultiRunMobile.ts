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

/** Passive DOM witness. No hand, action, balance or table setting is written. */
export async function installNaturalMultiRunWitness(page: Page) {
  await page.addInitScript(() => {
    const hands: Record<string, any> = {};
    const flights = new Map<string, any>();
    const violations = new Set<string>();
    let stopped = false;
    let frame = 0;
    const sample = () => {
      if (stopped) return;
      const table = Array.from(document.querySelectorAll('.table-page')).find((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      const hand = Number(
        table?.querySelector('.table-brand__hand')?.textContent?.match(/\d+/)?.[0]
      );
      const lanes = Array.from(table?.querySelectorAll('.community-area__run') ?? []);
      const now = Date.now();
      if (hand > 0 && (lanes.length === 2 || lanes.length === 3)) {
        const key = `${hand}:${lanes.length}`;
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
        };
        flights.set(id, flight);
        if (flight.landedAt) continue;
        const seat = Array.from(
          table?.querySelectorAll<HTMLElement>('[data-player-id]') ?? []
        ).find((node) => node.dataset.playerId === flight.recipient);
        const target = seat?.querySelector('.seat__info')?.getBoundingClientRect();
        if (!target?.width) continue;
        const rect = chip.getBoundingClientRect();
        const distance = Math.hypot(
          rect.x + rect.width / 2 - target.x - target.width / 2,
          rect.y + rect.height / 2 - target.y - target.height / 2
        );
        if (chip.dataset.chipPhase === 'landed') {
          flight.distance = distance;
          flight.landedAt = now;
          if (distance > 2) violations.add(`${hand}: Payout Missed Its Recipient`);
        }
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    (window as any).__naturalMultiRunWitness = {
      read: () => ({
        hands: Object.values(hands),
        flights: Array.from(flights.values()).filter((f) => f.landedAt),
        violations: [...violations],
      }),
      stop: () => {
        stopped = true;
        cancelAnimationFrame(frame);
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

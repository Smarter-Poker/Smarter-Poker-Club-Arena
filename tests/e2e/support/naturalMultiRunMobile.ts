import type { Page } from '@playwright/test';
import { remainingInitialTableReadinessMs } from './initialTableReadiness';

/** Cold starts are sequential; all six pages stay open for the observation. */
export async function initializeNaturalMultiRunObservers<T>(
  tables: T[],
  initialize: (table: T, navigationBudgetMs: number, remainingSetup: () => number) => Promise<void>,
  setupStartedAt: number,
  now = Date.now
): Promise<void> {
  if (tables.length !== 6) throw new Error('Natural multirun proof requires all six observers');
  const remainingSetup = () => remainingInitialTableReadinessMs(setupStartedAt, 120_000, now());
  for (const table of tables) {
    await initialize(table, Math.min(12_000, remainingSetup()), remainingSetup);
    remainingSetup();
  }
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

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

/** One foreground observer consumes the original cumulative setup allocation. */
export async function initializeNaturalMultiRunObserver<T>(
  table: T,
  initialize: (table: T, navigationBudgetMs: number, remainingSetup: () => number) => Promise<void>,
  setupStartedAt: number,
  now = Date.now
): Promise<void> {
  const remainingSetup = () => remainingInitialTableReadinessMs(setupStartedAt, 120_000, now());
  await initialize(table, remainingSetup(), remainingSetup);
  remainingSetup();
}

export interface NaturalMultiRunHistoryRow {
  table_id: string;
  rit_boards: unknown[];
}

/** Raw dispatch JSON preserves numeric-vs-string authority before opening fixtures. */
export function naturalMultiRunRequiredRuns(
  targetJSON?: string,
  mobileJSON?: string,
  engineJSON?: string
): Array<2 | 3> {
  let target: unknown;
  try {
    target = targetJSON === undefined ? null : JSON.parse(targetJSON);
  } catch {
    throw new Error('Invalid natural multirun target JSON');
  }
  if (target === null) return [2, 3];
  if (target !== 3 || mobileJSON !== 'true' || engineJSON !== 'null')
    throw new Error('Natural multirun target requires numeric 3, mobile true and no engine pin');
  return [3];
}

/** Bounded recent history predicts opportunity; actual live evidence certifies both run counts. */
export function selectNaturalMultiRunSubject(
  tables: NaturalMultiRunCandidate[],
  recent: NaturalMultiRunHistoryRow[],
  requiredRuns: Array<2 | 3> = [2, 3]
): NaturalMultiRunCandidate {
  const targetThree = requiredRuns.length === 1 && requiredRuns[0] === 3;
  const counts = new Map<string, [number, number]>();
  for (const row of recent) {
    if (!Array.isArray(row.rit_boards) || ![1, 2].includes(row.rit_boards.length)) continue;
    const count = counts.get(row.table_id) ?? [0, 0];
    count[row.rit_boards.length - 1]++;
    counts.set(row.table_id, count);
  }
  const ranked = tables
    .filter((table) => {
      // Exclude a mandatory count that cannot supply the requested live coverage.
      const mode = String(table.run_it_mode || '').toLowerCase();
      return (
        eligibleNaturalMultiRunTable(table) &&
        mode !== 'mandatory_twice' &&
        (targetThree || mode !== 'mandatory_three')
      );
    })
    .map((table) => {
      const [two, three] = counts.get(table.id) ?? [0, 0];
      return { table, balanced: Math.min(two, three), total: two + three };
    });
  ranked.sort(
    (a, b) =>
      (targetThree ? (counts.get(b.table.id)?.[1] ?? 0) - (counts.get(a.table.id)?.[1] ?? 0) : 0) ||
      b.balanced - a.balanced ||
      b.total - a.total ||
      b.table.current_players - a.table.current_players ||
      (a.table.id < b.table.id ? -1 : a.table.id > b.table.id ? 1 : 0)
  );
  const selected = ranked[0]?.table;
  if (!selected) throw new Error('Natural multirun observation requires one eligible cash table');
  return selected;
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
    const confirmations: Record<string, any[]> = {};
    let finalBanner: { node: Element; text: string; hand: number; entry: any } | null = null;
    let activeResultKey: string | null = null;
    const flights = new Map<string, any>();
    const active = new Map<string, { chip: HTMLElement; id: string }>();
    const targets = new Map<
      string,
      {
        node: HTMLElement;
        recipient: string | undefined;
        rect: { x: number; y: number; width: number; height: number };
      }
    >();
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
    const measure = (chip: HTMLElement, flight: any, table: Element | undefined, now: number) => {
      const seat = Array.from(
        (table ?? document).querySelectorAll<HTMLElement>('[data-player-id]')
      ).find((node) => node.dataset.playerId === flight.recipient);
      let target;
      if (seat) {
        // A replacement or moving recipient is always measured afresh. A live
        // hidden/unmeasurable node cannot borrow its earlier visible position.
        const box = seat.querySelector('.seat__info')?.getBoundingClientRect();
        if (!box?.width || !box.height) {
          targets.delete(flight.id);
          flight.targetProvenance = 'unavailable';
          return null;
        }
        target = { x: box.x, y: box.y, width: box.width, height: box.height };
        targets.set(flight.id, { node: seat, recipient: flight.recipient, rect: target });
        flight.targetRect = target;
        flight.targetObservedAt = now;
        flight.targetProvenance = 'live-recipient';
      } else {
        const previous = targets.get(flight.id);
        flight.targetProvenance = 'unavailable';
        if (!previous || previous.recipient !== flight.recipient || previous.node.isConnected)
          return null;
        flight.recipientDepartedAt ??= now;
        // Only an explicit landing can be verified against this same flight's
        // actual recipient geometry recorded before its node disconnected.
        if (chip.dataset.chipPhase !== 'landed') return null;
        target = previous.rect;
        flight.targetProvenance = 'departed-recipient';
      }
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
      // October 28: any settled-choice strip is a regression. The observer
      // never drives consent or a hand; it measures the real pending strip.
      const banner = table?.querySelector('.rit-felt-banner') ?? null;
      const bannerText = banner?.textContent?.trim() ?? '';
      const isFinal =
        /^(?:(?:Players Have Accepted Running It|Mandatory Run It) (?:Twice|3 Times)|Running It Once\.)/.test(
          bannerText
        );
      if (banner && (isFinal || lanes.length >= 2))
        violations.add(`${hand}: Settled Run Choice Still Covers The Table`);
      if (banner) {
        const strip = banner.getBoundingClientRect();
        const board = table?.querySelector('.community-area')?.getBoundingClientRect();
        const pot = table?.querySelector('.pot-display')?.getBoundingClientRect();
        if (strip.width > 0 && strip.height > 0) {
          if (board?.height && strip.bottom > board.top + 0.5)
            violations.add(`${hand}: Run Choice Covers Board Cards`);
          if (pot?.height && strip.top < pot.bottom - 0.5)
            violations.add(`${hand}: Run Choice Is Not Below Pot`);
          for (const card of table?.querySelectorAll('.seat__cards img') ?? []) {
            const box = card.getBoundingClientRect();
            if (
              box.width > 0 &&
              box.height > 0 &&
              strip.left < box.right &&
              strip.right > box.left &&
              strip.top < box.bottom &&
              strip.bottom > box.top
            )
              violations.add(`${hand}: Run Choice Covers Player Cards`);
          }
        }
      }
      if (
        finalBanner &&
        (finalBanner.node !== banner ||
          finalBanner.text !== bannerText ||
          finalBanner.hand !== hand)
      ) {
        finalBanner.entry.hiddenAt = now;
        finalBanner = null;
      }
      if (banner && isFinal && hand > 0 && !finalBanner) {
        const entry = { text: bannerText, shownAt: now, hiddenAt: null };
        (confirmations[String(hand)] ??= []).push(entry);
        finalBanner = { node: banner, text: bannerText, hand, entry };
      }
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
      if (activeResultKey && activeResultKey !== key) {
        hands[activeResultKey].resultEndedAt ??= now;
      }
      activeResultKey = key;
      if (key) {
        const record = (hands[key] ??= {
          hand,
          runs: lanes.length,
          firstAt: now,
          resultEndedAt: null,
          lanes: [],
        });
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
          id,
          hand,
          recipient: chip.dataset.chipRecipient,
          landedAt: null,
          distance: null,
          lastDistance: null,
          targetProvenance: 'unavailable',
          targetRect: null,
          targetObservedAt: null,
          recipientDepartedAt: null,
        };
        flights.set(id, flight);
        active.set(id, { chip, id });
        if (flight.landedAt) continue;
        const distance = measure(chip, flight, table, now);
        flight.lastDistance = distance;
        if (distance === null) continue;
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
        targets.delete(id);
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
        confirmations,
        flights: Array.from(flights.values()).filter((f) => f.landedAt),
        unlandedFlights: Array.from(flights.values()).filter((f) => !f.landedAt),
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

/** No settled-choice overlay; retain the full default-speed winning-card reads. */
export function naturalMultiRunTiming(packet: NaturalRunPacket, witness: any) {
  const hand = witness.hands.find(
    (item: any) => item.hand === packet.hand && item.runs === packet.runs
  );
  const confirmations = witness.confirmations?.[String(packet.hand)] ?? [];
  const violations: string[] = [];
  if (confirmations.length) violations.push('Settled Run Choice Still Covers The Table');
  if (confirmations.length > 1) violations.push('Run Confirmation Repeated');
  const confirmation = confirmations[0];
  const confirmationMs = !confirmation
    ? 0
    : confirmation.hiddenAt == null
      ? null
      : confirmation.hiddenAt - confirmation.shownAt;
  const winnerAt = (hand?.lanes ?? []).map((lane: any) => lane.winnerAt);
  const complete =
    winnerAt.length === packet.runs && winnerAt.every((at: any) => typeof at === 'number');
  const resultGapsMs = complete
    ? winnerAt.slice(1).map((at: number, index: number) => at - winnerAt[index])
    : [];
  if (resultGapsMs.some((ms: number) => ms < 4000 || ms > 4700)) {
    violations.push('Winning Card Result Did Not Receive Its Additional 1500ms');
  }
  const lastResultMs =
    complete && hand?.resultEndedAt != null
      ? hand.resultEndedAt - winnerAt[winnerAt.length - 1]
      : null;
  if (lastResultMs !== null && lastResultMs < 4000)
    violations.push('Final Winning Cards Cleared Early');
  return {
    ready: confirmations.length === 0 && complete && lastResultMs !== null,
    violations,
    confirmationMs,
    resultGapsMs,
    lastResultMs,
  };
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

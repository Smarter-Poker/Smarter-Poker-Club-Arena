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
  created_at?: string | null;
}

/** Raw dispatch JSON preserves numeric-vs-string authority before opening fixtures. */
export function naturalMultiRunRequiredRuns(
  targetJSON?: string,
  mobileJSON?: string,
  engineJSON?: string,
  horseJSON = 'null',
  navigationJSON = 'null'
): Array<1 | 2 | 3> {
  let target: unknown;
  try {
    target = targetJSON === undefined ? null : JSON.parse(targetJSON);
  } catch {
    throw new Error('Invalid natural multirun target JSON');
  }
  if (target === null) return [2, 3];
  if (
    (target !== 1 && target !== 3) ||
    mobileJSON !== 'true' ||
    engineJSON !== 'null' ||
    horseJSON !== 'null' ||
    navigationJSON !== 'null'
  )
    throw new Error(
      'Natural multirun target requires numeric 1 or 3, mobile true, no engine pin and no mixed mode'
    );
  return [target];
}

/** Bounded recent history predicts opportunity; actual live evidence certifies both run counts. */
export function selectNaturalMultiRunSubject(
  tables: NaturalMultiRunCandidate[],
  recent: NaturalMultiRunHistoryRow[],
  requiredRuns: Array<1 | 2 | 3> = [2, 3]
): NaturalMultiRunCandidate {
  const targetThree = requiredRuns.length === 1 && requiredRuns[0] === 3;
  const targetOnce = requiredRuns.length === 1 && requiredRuns[0] === 1;
  const counts = new Map<string, [number, number]>();
  const latestThree = new Map<string, number>();
  for (const row of recent) {
    if (!Array.isArray(row.rit_boards) || ![1, 2].includes(row.rit_boards.length)) continue;
    const count = counts.get(row.table_id) ?? [0, 0];
    count[row.rit_boards.length - 1]++;
    counts.set(row.table_id, count);
    const at = Date.parse(row.created_at ?? '');
    if (row.rit_boards.length === 2 && Number.isFinite(at))
      latestThree.set(row.table_id, Math.max(latestThree.get(row.table_id) ?? 0, at));
  }
  const ranked = tables
    .filter((table) => {
      // Exclude a mandatory count that cannot supply the requested live coverage.
      const mode = String(table.run_it_mode || '').toLowerCase();
      return (
        eligibleNaturalMultiRunTable(table) &&
        mode !== 'mandatory_twice' &&
        (targetThree || mode !== 'mandatory_three') &&
        (!targetThree || (counts.get(table.id)?.[1] ?? 0) > 0) &&
        (!targetOnce ||
          (mode === 'player_choice' && (counts.get(table.id) ?? [0, 0]).some((n) => n > 0)))
      );
    })
    .map((table) => {
      const [two, three] = counts.get(table.id) ?? [0, 0];
      return { table, balanced: Math.min(two, three), total: two + three };
    });
  ranked.sort(
    (a, b) =>
      // A recent natural three-run hand predicts opportunity better than an older larger count.
      (targetThree ? (latestThree.get(b.table.id) ?? 0) - (latestThree.get(a.table.id) ?? 0) : 0) ||
      (targetThree ? (counts.get(b.table.id)?.[1] ?? 0) - (counts.get(a.table.id)?.[1] ?? 0) : 0) ||
      (targetOnce ? b.total - a.total : 0) ||
      b.balanced - a.balanced ||
      b.total - a.total ||
      b.table.current_players - a.table.current_players ||
      (a.table.id < b.table.id ? -1 : a.table.id > b.table.id ? 1 : 0)
  );
  const selected = ranked[0]?.table;
  if (!selected)
    throw new Error(
      targetOnce
        ? 'Natural once observation requires one player-choice cash table with actual RIT history'
        : targetThree
          ? 'Natural multirun observation requires one eligible cash table with positive three-run history'
          : 'Natural multirun observation requires one eligible cash table'
    );
  return selected;
}

/** Keep natural opportunities through provider queue time using the existing table/created index. */
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
            select: 'table_id,rit_boards,created_at',
            table_id: `eq.${id}`,
            created_at: `gte.${new Date(now - 2 * 60 * 60_000).toISOString()}`,
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
    const singleRuns: Record<string, any> = {};
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
      for (const decision of Object.values(singleRuns)) {
        if (decision.expired) continue;
        if (hand !== decision.hand) {
          decision.expired = true;
          continue;
        }
        const cards = Array.from(
          table?.querySelectorAll('.community-area .community-cards__card') ?? []
        ).filter((card) => {
          const box = card.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        }).length;
        if (banner) {
          if (decision.statusClearAt !== null || now - decision.markedAt > 1_000)
            violations.add(`${hand}: Run Choice Remains After Single Decision`);
          continue;
        }
        decision.statusClearAt ??= now;
        if (lanes.length || cards < 3 || cards > 5 || document.visibilityState !== 'visible')
          continue;
        decision.firstClearAt ??= now;
        decision.lastClearAt = now;
        decision.clearSamples++;
        decision.boardCards = cards;
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
      // Called by the Node observer only after validating an actual received wire event.
      markSingleRunDecision: (packet: { hand: number; at: number; reason: string }) => {
        const visibleTable = Array.from(document.querySelectorAll('.table-page')).find((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        });
        const shown = Number(
          visibleTable?.querySelector('.table-brand__hand')?.textContent?.match(/\d+/)?.[0]
        );
        if (shown !== packet.hand || singleRuns[String(packet.hand)]) return;
        singleRuns[String(packet.hand)] = {
          ...packet,
          markedAt: Date.now(),
          statusClearAt: null,
          firstClearAt: null,
          lastClearAt: null,
          clearSamples: 0,
          boardCards: 0,
          expired: false,
        };
        sample();
      },
      read: () => ({
        hands: Object.values(hands),
        singleRuns: Object.values(singleRuns),
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

export interface NaturalSingleRunPacket {
  hand: number;
  runs: 1;
  at: number;
  reason: string;
}

/** An ordinary one-board hand, replay or malformed decision is never once evidence. */
export function naturalSingleRunPackets(
  frames: Array<any>,
  tableId: string,
  since: number
): NaturalSingleRunPacket[] {
  const reasons = [
    'chooser_chose_one',
    'player_declined',
    'no_agreement',
    'no_consent_recorded',
    'deck_too_short',
  ];
  return frames.flatMap((frame) => {
    const p = frame.message?.payload;
    if (
      frame.direction !== 'received' ||
      frame.message?.type !== 'EVENT' ||
      !Number.isFinite(frame.at) ||
      frame.at < since ||
      p?.table_id !== tableId ||
      p?.type !== 'rit_single_run' ||
      p.replayed === true ||
      frame.message.replayed === true ||
      !Number.isInteger(p.hand_number) ||
      p.hand_number <= 0 ||
      p.runs_dealt !== 1 ||
      !reasons.includes(p.reason)
    )
      return [];
    return [{ hand: p.hand_number, runs: 1 as const, at: frame.at, reason: p.reason }];
  });
}

/** Same visible hand, actual cards and two clear samples after the real decision mark. */
export function completedNaturalSingleRuns(
  packets: NaturalSingleRunPacket[],
  witness: any,
  clock: { nodeBefore: number; browserNow: number; nodeAfter: number }
) {
  if (!naturalSingleRunClockAligned(clock)) return [];
  // The lower possible browser-minus-Node offset gives a conservative elapsed upper bound.
  const offsetLower = clock.browserNow - clock.nodeAfter;
  return packets.filter((packet) =>
    (witness.singleRuns ?? []).some(
      (decision: any) =>
        decision.hand === packet.hand &&
        decision.at === packet.at &&
        decision.reason === packet.reason &&
        !decision.expired &&
        decision.markedAt - packet.at >= -100 &&
        decision.markedAt - packet.at - offsetLower <= 500 &&
        decision.statusClearAt - packet.at - offsetLower <= 1_000 &&
        decision.firstClearAt !== null &&
        decision.firstClearAt >= decision.markedAt &&
        decision.statusClearAt !== null &&
        decision.statusClearAt >= decision.markedAt &&
        decision.statusClearAt - decision.markedAt <= 1_000 &&
        decision.clearSamples >= 2 &&
        decision.lastClearAt - decision.firstClearAt >= 250 &&
        decision.boardCards >= 3 &&
        decision.boardCards <= 5
    )
  );
}

/** Calibrate the Node wire callback clock against the browser's clock before observing. */
export function naturalSingleRunClockAligned(clock: {
  nodeBefore: number;
  browserNow: number;
  nodeAfter: number;
}) {
  return (
    [clock.nodeBefore, clock.browserNow, clock.nodeAfter].every(Number.isFinite) &&
    clock.nodeAfter >= clock.nodeBefore &&
    clock.nodeAfter - clock.nodeBefore <= 250 &&
    clock.browserNow >= clock.nodeBefore - 50 &&
    clock.browserNow <= clock.nodeAfter + 50
  );
}

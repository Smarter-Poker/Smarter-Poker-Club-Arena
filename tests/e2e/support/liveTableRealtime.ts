import { expect, type Page, type WebSocket } from '@playwright/test';

type WireMessage = Record<string, unknown>;

export interface EngineFrame {
  at: number;
  direction: 'sent' | 'received';
  socketId: number;
  message: WireMessage;
}

export interface GameplayEventFact {
  at: number;
  type: string;
  handNumber: number | null;
  dealerSeat: number | null;
  frame: EngineFrame;
}

export interface CausalHandCycle {
  handNumber: number;
  completedAt: number;
  nextHandNumber: number;
  nextHandStartedAt: number;
  nextDealerSeat: number;
  observedTypes: string[];
  maxObservedSilenceMs: number;
}

export interface LiveTablePresentationEvidence {
  at: number;
  kind: 'deal-animation' | 'dealer-button-baseline' | 'dealer-button-moved';
  handText: string;
  cardCount?: number;
  position?: string;
}

interface EngineSocketRecord {
  id: number;
  url: string;
  discoveredAt: number;
  closedAt: number | null;
  socketError: string | null;
  socket: WebSocket;
}

interface FrameQuery {
  direction?: EngineFrame['direction'];
  tableId?: string;
  type?: string;
  since?: number;
}

const GAMEPLAY_EVENT_TYPES = new Set([
  'hand_started',
  'blinds_posted',
  'player_action',
  'turn_change',
  'community_cards_dealt',
  'showdown',
  'showdown_cards_revealed',
  'pot_distributed',
  'pot_win',
  'hand_complete',
]);

const IN_HAND_PROGRESS_TYPES = new Set([
  'player_action',
  'turn_change',
  'community_cards_dealt',
  'showdown',
  'showdown_cards_revealed',
  'pot_distributed',
  'pot_win',
]);

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function decodedFrame(payload: unknown): WireMessage | null {
  let raw: string;
  if (typeof payload === 'string') raw = payload;
  else if (Buffer.isBuffer(payload)) raw = payload.toString('utf8');
  else raw = String(payload);

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as WireMessage)
      : null;
  } catch {
    return null;
  }
}

function isEngineGameTransport(rawUrl: string): boolean {
  try {
    const pathname = new URL(rawUrl).pathname.replace(/\/+$/, '');
    return pathname === '/ws/multi' || /^\/ws\/table\/[0-9a-f-]{8,}$/i.test(pathname);
  } catch {
    return false;
  }
}

function tableIdOf(message: WireMessage): string | null {
  return typeof message.tableId === 'string' ? message.tableId : null;
}

function eventPayload(message: WireMessage): WireMessage | null {
  const payload = message.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as WireMessage)
    : null;
}

function eventTimestamp(message: WireMessage): number | null {
  const payload = eventPayload(message);
  const value = payload?.timestamp ?? message.ts;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function gameplayEventKey(frame: EngineFrame): string | null {
  if (frame.direction !== 'received' || frame.message.type !== 'EVENT') return null;
  const payload = eventPayload(frame.message);
  const eventType = typeof payload?.type === 'string' ? payload.type : null;
  /* TableStateHub marks every retained reveal handed to a new subscriber.
     It is useful recovery evidence, but it is not a new live action. */
  if (!eventType || payload?.replayed === true || !GAMEPLAY_EVENT_TYPES.has(eventType)) return null;

  const seq = frame.message.seq;
  if (typeof seq === 'number' && Number.isFinite(seq)) return `seq:${seq}`;

  /* Legacy frames can omit the event sequence. Keep duplicate delivery from
     looking like two actions by keying the immutable event facts instead. */
  return [
    eventType,
    eventTimestamp(frame.message) ?? 'no-ts',
    payload?.hand_number ?? '',
    payload?.seat ?? '',
    payload?.action ?? '',
  ].join(':');
}

function gameplayEventFact(frame: EngineFrame): GameplayEventFact | null {
  if (!gameplayEventKey(frame)) return null;
  const payload = eventPayload(frame.message);
  return {
    at: frame.at,
    type: String(payload?.type || ''),
    handNumber: finiteNumber(payload?.hand_number),
    dealerSeat: finiteNumber(payload?.dealer_seat),
    frame,
  };
}

function completedHandCycle(
  events: GameplayEventFact[],
  maxObservedSilenceMs: number
): CausalHandCycle | null {
  for (const completion of events) {
    if (completion.type !== 'hand_complete' || completion.handNumber === null) continue;
    const handNumber = completion.handNumber;
    const inHand = events.filter(
      (event) =>
        event.handNumber === handNumber &&
        event.at <= completion.at &&
        IN_HAND_PROGRESS_TYPES.has(event.type)
    );
    if (inHand.length === 0) continue;

    const nextStart = events.find(
      (event) =>
        event.type === 'hand_started' &&
        event.at > completion.at &&
        event.handNumber !== null &&
        event.handNumber > handNumber &&
        event.dealerSeat !== null
    );
    if (!nextStart || nextStart.handNumber === null || nextStart.dealerSeat === null) continue;

    return {
      handNumber,
      completedAt: completion.at,
      nextHandNumber: nextStart.handNumber,
      nextHandStartedAt: nextStart.at,
      nextDealerSeat: nextStart.dealerSeat,
      observedTypes: [...new Set(inHand.map((event) => event.type))],
      maxObservedSilenceMs,
    };
  }
  return null;
}

/**
 * A protocol-level journal for the physical game WebSocket only. It ignores
 * the separate /ws/channel connection, which is allowed to coexist with the
 * one shared /ws/multi game transport.
 */
export class EngineSocketJournal {
  readonly frames: EngineFrame[] = [];
  private readonly sockets: EngineSocketRecord[] = [];
  private nextSocketId = 1;

  constructor(page: Page) {
    page.on('websocket', (socket) => {
      if (!isEngineGameTransport(socket.url())) return;

      const record: EngineSocketRecord = {
        id: this.nextSocketId++,
        url: socket.url(),
        discoveredAt: Date.now(),
        closedAt: null,
        socketError: null,
        socket,
      };
      this.sockets.push(record);

      socket.on('framesent', ({ payload }) => this.recordFrame(record.id, 'sent', payload));
      socket.on('framereceived', ({ payload }) => this.recordFrame(record.id, 'received', payload));
      socket.on('socketerror', (error) => {
        record.socketError = String(error);
      });
      socket.on('close', () => {
        record.closedAt = Date.now();
      });
    });
  }

  private recordFrame(
    socketId: number,
    direction: EngineFrame['direction'],
    payload: unknown
  ): void {
    const message = decodedFrame(payload);
    if (!message) return;
    this.frames.push({ at: Date.now(), direction, socketId, message });
  }

  matchingFrames(query: FrameQuery): EngineFrame[] {
    return this.frames.filter((frame) => {
      if (query.direction && frame.direction !== query.direction) return false;
      if (query.tableId && tableIdOf(frame.message) !== query.tableId) return false;
      if (query.type && frame.message.type !== query.type) return false;
      if (query.since !== undefined && frame.at < query.since) return false;
      return true;
    });
  }

  async waitForFrame(
    query: FrameQuery,
    timeout: number,
    failureMessage: string
  ): Promise<EngineFrame> {
    await expect
      .poll(() => this.matchingFrames(query).length, {
        timeout,
        intervals: [50, 100, 250, 500],
        message: failureMessage,
      })
      .toBeGreaterThan(0);
    return this.matchingFrames(query).at(-1)!;
  }

  gameplayEvents(tableId: string, since: number): EngineFrame[] {
    const unique = new Map<string, EngineFrame>();
    for (const frame of this.matchingFrames({ direction: 'received', tableId, since })) {
      const key = gameplayEventKey(frame);
      if (!key) continue;
      unique.set(key, frame);
    }
    return [...unique.values()];
  }

  async waitForGameplayEvents(
    tableId: string,
    since: number,
    count: number,
    timeout: number,
    failureMessage: string
  ): Promise<EngineFrame[]> {
    await expect
      .poll(() => this.gameplayEvents(tableId, since).length, {
        timeout,
        intervals: [100, 250, 500],
        message: failureMessage,
      })
      .toBeGreaterThanOrEqual(count);
    return this.gameplayEvents(tableId, since);
  }

  gameplayEventFacts(tableId: string, since: number): GameplayEventFact[] {
    return this.gameplayEvents(tableId, since)
      .map(gameplayEventFact)
      .filter((event): event is GameplayEventFact => event !== null)
      .sort((a, b) => a.at - b.at);
  }

  /**
   * Prove a live table rather than a live socket. A pair such as
   * hand_started + blinds_posted is not enough: both arrive at the opening of
   * one hand and can be followed by a frozen felt forever. This waits for a
   * real action/street/award in hand H, HAND_COMPLETE(H), and then
   * HAND_STARTED(H+1). While it waits, every gap between gameplay events is
   * bounded, so a table that freezes and later resumes cannot hide the freeze
   * by eventually satisfying the final pattern.
   */
  async waitForCausalHandCycle(
    tableId: string,
    since: number,
    timeout: number,
    maxSilenceMs: number,
    failureMessage: string
  ): Promise<CausalHandCycle> {
    const deadline = Date.now() + timeout;
    while (Date.now() <= deadline) {
      const events = this.gameplayEventFacts(tableId, since);
      let previousAt = since;
      let maxObservedSilenceMs = 0;
      for (const event of events) {
        maxObservedSilenceMs = Math.max(maxObservedSilenceMs, event.at - previousAt);
        previousAt = event.at;
      }

      const liveSilenceMs = Date.now() - previousAt;
      maxObservedSilenceMs = Math.max(maxObservedSilenceMs, liveSilenceMs);
      if (liveSilenceMs > maxSilenceMs) {
        const last = events.at(-1);
        throw new Error(
          `${failureMessage}: no live poker event for ${liveSilenceMs}ms` +
            (last
              ? ` after ${last.type} for hand ${last.handNumber ?? 'unknown'}`
              : ' after the observation began')
        );
      }

      const cycle = completedHandCycle(events, maxObservedSilenceMs);
      if (cycle) return cycle;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    const observed = this.gameplayEventFacts(tableId, since).map(
      (event) => `${event.type}:${event.handNumber ?? '?'}`
    );
    throw new Error(
      `${failureMessage}: causal hand boundary not observed (${observed.join(', ')})`
    );
  }

  openTransportCount(): number {
    return this.sockets.filter(({ socket }) => !socket.isClosed()).length;
  }

  openTransportUrls(): string[] {
    return this.sockets.filter(({ socket }) => !socket.isClosed()).map(({ url }) => url);
  }

  transportIdsOpenAt(at: number): number[] {
    return this.sockets
      .filter(
        ({ discoveredAt, closedAt }) => discoveredAt <= at && (closedAt === null || closedAt > at)
      )
      .map(({ id }) => id);
  }

  areTransportsClosed(socketIds: readonly number[]): boolean {
    return socketIds.every((id) =>
      this.sockets.find((socket) => socket.id === id)?.socket.isClosed()
    );
  }

  /** Sanitized diagnostic summary: no auth subprotocol and no state payloads. */
  summary(tableId: string): Record<string, unknown> {
    const relevant = this.frames.filter((frame) => tableIdOf(frame.message) === tableId);
    return {
      tableId,
      sockets: this.sockets.map(({ id, url, discoveredAt, closedAt, socketError, socket }) => ({
        id,
        path: new URL(url).pathname,
        discoveredAt,
        closedAt,
        isClosed: socket.isClosed(),
        socketError,
      })),
      sent: relevant
        .filter((frame) => frame.direction === 'sent')
        .map((frame) => ({ at: frame.at, socketId: frame.socketId, type: frame.message.type })),
      received: relevant
        .filter((frame) => frame.direction === 'received')
        .map((frame) => ({
          at: frame.at,
          socketId: frame.socketId,
          type: frame.message.type,
          seq: frame.message.seq,
          eventType: eventPayload(frame.message)?.type,
          eventTimestamp: eventTimestamp(frame.message),
        })),
    };
  }
}

/**
 * The deal layer is intentionally short-lived, and the dealer puck moves by
 * mutating its inline position. A locator inspected after HAND_STARTED can miss
 * both. Install one in-page observer before waiting for the next hand and keep
 * only presentation facts-never cards, names, auth, or table state.
 */
export async function installLiveTablePresentationJournal(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Evidence = {
      at: number;
      kind: 'deal-animation' | 'dealer-button-baseline' | 'dealer-button-moved';
      handText: string;
      cardCount?: number;
      position?: string;
    };
    type EvidenceState = {
      records: Evidence[];
      lastDealerPosition: string | null;
      seenDeals: WeakSet<Element>;
      observer: MutationObserver;
    };
    const browserWindow = window as typeof window & {
      __spLiveTablePresentation?: EvidenceState;
    };
    browserWindow.__spLiveTablePresentation?.observer.disconnect();

    const handText = () =>
      document.querySelector('.header-hand-number, .table-brand__hand')?.textContent?.trim() || '';
    const state = {
      records: [] as Evidence[],
      lastDealerPosition: null as string | null,
      seenDeals: new WeakSet<Element>(),
      observer: null as unknown as MutationObserver,
    };

    const sample = () => {
      for (const deal of document.querySelectorAll('.deal-animation')) {
        if (state.seenDeals.has(deal)) continue;
        state.seenDeals.add(deal);
        state.records.push({
          at: Date.now(),
          kind: 'deal-animation',
          handText: handText(),
          cardCount: deal.querySelectorAll('.deal-animation__card').length,
        });
      }

      const dealer = document.querySelector<HTMLElement>('.dealer-button');
      if (!dealer) return;
      const position = `${dealer.style.left}|${dealer.style.top}`;
      if (!position || position === '|') return;
      if (state.lastDealerPosition === null) {
        state.lastDealerPosition = position;
        state.records.push({
          at: Date.now(),
          kind: 'dealer-button-baseline',
          handText: handText(),
          position,
        });
      } else if (position !== state.lastDealerPosition) {
        state.lastDealerPosition = position;
        state.records.push({
          at: Date.now(),
          kind: 'dealer-button-moved',
          handText: handText(),
          position,
        });
      }
    };

    state.observer = new MutationObserver(sample);
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
    browserWindow.__spLiveTablePresentation = state;
    sample();
  });
}

export async function liveTablePresentationEvidence(
  page: Page
): Promise<LiveTablePresentationEvidence[]> {
  return page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __spLiveTablePresentation?: { records: LiveTablePresentationEvidence[] };
    };
    return [...(browserWindow.__spLiveTablePresentation?.records || [])];
  });
}

/**
 * The banner is intentionally delayed by the app's 1.2-second grace period.
 * Seeing it at all inside this guard therefore means the grace was exhausted;
 * do not wait for it to disappear and call the connection healthy afterward.
 */
export async function whileConnectionBannerStaysHidden<T>(
  page: Page,
  operation: Promise<T>,
  phase: string
): Promise<T> {
  const banner = page.getByTestId('table-connection-banner');
  let stopped = false;
  const monitor = (async (): Promise<never> => {
    while (!stopped) {
      if (await banner.isVisible().catch(() => false)) {
        const text = (await banner.textContent().catch(() => null))?.trim() || 'connection banner';
        throw new Error(`${phase}: ${text} became visible after its grace period`);
      }
      await page.waitForTimeout(100);
    }
    return await new Promise<never>(() => {});
  })();

  try {
    const result = await Promise.race([operation, monitor]);
    // Close the final 100ms polling interval: an operation and the banner can
    // settle in the same turn, with Promise.race choosing the operation first.
    if (await banner.isVisible().catch(() => false)) {
      const text = (await banner.textContent().catch(() => null))?.trim() || 'connection banner';
      throw new Error(`${phase}: ${text} became visible as the guarded operation completed`);
    }
    return result;
  } finally {
    stopped = true;
    void monitor.catch(() => {
      /* Promise.race already surfaced a monitor failure. */
    });
  }
}

import {
  devices,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { ensureAcceptedTerms } from './support/ensureAcceptedTerms';
import { ensurePlayableProfile } from './support/ensurePlayableProfile';
import {
  CLEANUP_FREEZE_ALLOWANCE_MS,
  cleanupTemporaryCustomizationAccount,
  createTemporaryCustomizationAccount,
  readServiceRows,
  requireCustomizationCertificationEnvironment,
  withCauses,
  type CustomizationCertificationEnvironment,
  type TemporaryCustomizationAccount,
} from './support/temporaryCustomizationAccount';

/**
 * Production proof for the routed gameplay surface, not Table Studio's preview.
 *
 * The deployed TablePage, real Supabase authentication, durable account rows,
 * Postgres Changes and private authenticated appearance broadcasts all remain
 * live. Only the hand socket and seat projection are deterministic doubles, so
 * this certificate never buys in, moves chips, takes an active seat or waits
 * for a particular production board before it can inspect the graphics.
 */

const CERTIFICATION_ENABLED = process.env.GAMEPLAY_CUSTOMIZATION_CERTIFICATION === '1';
const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const VILLAIN_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const HERO_AVATAR = '/avatars/table/free_samurai@2x.webp';
const VILLAIN_AVATAR = '/avatars/table/free_rival@2x.webp';
const RESPONSE_TIMEOUT = 60_000;

const BASELINE = {
  game_type: 'ALL',
  theme_id: 'default-dark',
  table_id: 'classic_green',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'classic_red',
  face_deck_id: 'house-classic',
} as const;

type RuntimeProfile = {
  avatar: string;
  frame: string | null;
  aura: string | null;
};

type RealtimeEvidence = {
  ownerPrivateJoin: boolean;
  ownerPrivateSignal: boolean;
  tablePrivateJoin: boolean;
  tablePrivateSignal: boolean;
  accountThemeSignal: boolean;
};

type TableAuthorizationAnchor = {
  id: string;
  club_id: string;
  union_id: string | null;
  arena:
    | { id: string; asset: string; is_platform: boolean; union_id: string | null }
    | Array<{ id: string; asset: string; is_platform: boolean; union_id: string | null }>;
};

class OneShotRequestGate {
  private armed = false;
  private seenResolve: (() => void) | null = null;
  private releaseResolve: (() => void) | null = null;
  private seen: Promise<void> = Promise.resolve();
  private released: Promise<void> = Promise.resolve();

  arm() {
    if (this.armed) throw new Error('The previous persistence gate is still armed.');
    this.armed = true;
    this.seen = new Promise<void>((resolve) => {
      this.seenResolve = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.releaseResolve = resolve;
    });
  }

  async holdIfArmed(route: Route): Promise<boolean> {
    if (!this.armed) return false;
    this.armed = false;
    this.seenResolve?.();
    await this.released;
    await route.continue();
    return true;
  }

  async waitForRequest() {
    await this.seen;
  }

  release() {
    this.releaseResolve?.();
    this.seenResolve = null;
    this.releaseResolve = null;
  }
}

const jsonHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,apikey,content-type,prefer,x-client-info',
  'access-control-expose-headers': 'content-range',
  'content-type': 'application/json',
  'content-range': '0-0/1',
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, headers: jsonHeaders, body: JSON.stringify(body) });
}

function wantsObject(route: Route) {
  return (route.request().headers().accept || '').includes('application/vnd.pgrst.object');
}

function profileRow(userId: string, runtime: RuntimeProfile) {
  return {
    id: userId,
    username: 'RuntimeHero',
    display_name: 'Runtime Hero',
    full_name: null,
    table_alias: null,
    use_alias: false,
    use_real_name: false,
    avatar_url: runtime.avatar,
    arena_avatar_url: runtime.avatar,
    equipped_frame: runtime.frame,
    equipped_aura: runtime.aura,
    is_vip: false,
    vip_expires_at: null,
    tier: 'member',
    role: 'member',
  };
}

function villainProfile() {
  return {
    ...profileRow(VILLAIN_ID, { avatar: VILLAIN_AVATAR, frame: null, aura: null }),
    username: 'RuntimeRival',
    display_name: 'Runtime Rival',
  };
}

async function installEngineProjection(
  context: BrowserContext,
  tableId: string,
  userId: string,
  runtime: RuntimeProfile
) {
  await context.addInitScript(
    ({ selectedTableId, heroId, rivalId, heroAvatar, rivalAvatar }) => {
      const NativeWebSocket = window.WebSocket;
      const snapshot = () => ({
        type: 'SNAPSHOT',
        tableId: selectedTableId,
        seq: 1,
        state: {
          table_id: selectedTableId,
          hand_number: 7,
          pot: 3,
          community_cards: ['As', 'Kd', '7h'],
          community_cards2: [],
          community_cards3: [],
          current_bet: 2,
          current_player: rivalId,
          dealer_seat: 2,
          stage: 'flop',
          min_raise: 4,
          last_raise: 2,
          betting_structure: 'no_limit',
          turn_start_time_ms: Date.now(),
          turn_duration_ms: 30_000,
          turn_deadline_ms: Date.now() + 30_000,
          server_time_ms: Date.now(),
          time_bank_active: false,
          max_seats: 6,
          pots: [],
          action_history: [],
          disconnect_states: {},
          players: [
            {
              seat: 1,
              user_id: heroId,
              username: 'RuntimeHero',
              stack: 500,
              bet: 1,
              position: 'SB',
              avatar_url: heroAvatar,
            },
            {
              seat: 2,
              user_id: rivalId,
              username: 'RuntimeRival',
              stack: 500,
              bet: 2,
              position: 'BB',
              avatar_url: rivalAvatar,
            },
          ],
        },
      });

      class EngineWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly CONNECTING = 0;
        readonly OPEN = 1;
        readonly CLOSING = 2;
        readonly CLOSED = 3;
        readonly url: string;
        readonly protocol: string;
        readonly extensions = '';
        bufferedAmount = 0;
        binaryType: BinaryType = 'blob';
        readyState = EngineWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        private heartbeat: number | null = null;

        constructor(url: string | URL, protocols?: string | string[]) {
          super();
          this.url = String(url);
          this.protocol = Array.isArray(protocols) ? protocols[0] || '' : protocols || '';
          window.setTimeout(() => {
            if (this.readyState !== EngineWebSocket.CONNECTING) return;
            this.readyState = EngineWebSocket.OPEN;
            this.emit(new Event('open'));
            if (this.url.includes('/ws/table/')) window.setTimeout(() => this.push(snapshot()), 0);
            this.heartbeat = window.setInterval(
              () => this.push({ type: 'PING', ts: Date.now() }),
              5_000
            );
          }, 0);
        }

        private emit(event: Event) {
          super.dispatchEvent(event);
          const handler = this[`on${event.type}` as 'onopen' | 'onmessage' | 'onerror' | 'onclose'];
          if (typeof handler === 'function') (handler as (event: Event) => void).call(this, event);
        }

        private push(value: unknown) {
          if (this.readyState !== EngineWebSocket.OPEN) return;
          this.emit(new MessageEvent('message', { data: JSON.stringify(value) }));
        }

        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (typeof data !== 'string') return;
          try {
            const message = JSON.parse(data) as { type?: string; tableId?: string };
            if (
              message.type === 'SUBSCRIBE' &&
              message.tableId === selectedTableId &&
              this.url.includes('/ws/multi')
            ) {
              window.setTimeout(() => {
                this.push({ type: 'SUBSCRIBED', tableId: selectedTableId });
                window.setTimeout(() => this.push(snapshot()), 0);
              }, 0);
            } else if (message.type === 'RESYNC') {
              window.setTimeout(() => this.push(snapshot()), 0);
            }
          } catch {
            // The real Supabase socket never reaches this engine-only double.
          }
        }

        close(code = 1000, reason = '') {
          if (this.readyState === EngineWebSocket.CLOSED) return;
          this.readyState = EngineWebSocket.CLOSED;
          if (this.heartbeat != null) window.clearInterval(this.heartbeat);
          this.emit(new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
        }
      }

      const RoutedWebSocket = new Proxy(NativeWebSocket, {
        construct(Target, args) {
          const url = String(args[0] || '');
          if (url.includes('/ws/table/') || url.includes('/ws/multi')) {
            return new EngineWebSocket(
              args[0] as string | URL,
              args[1] as string | string[] | undefined
            );
          }
          return Reflect.construct(Target, args);
        },
      });
      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: RoutedWebSocket,
      });
    },
    {
      selectedTableId: tableId,
      heroId: userId,
      rivalId: VILLAIN_ID,
      heroAvatar: runtime.avatar,
      rivalAvatar: VILLAIN_AVATAR,
    }
  );
}

async function installRuntimeDataProjection(
  context: BrowserContext,
  tableRow: Record<string, unknown>,
  userId: string,
  runtime: RuntimeProfile,
  themeGate: OneShotRequestGate,
  profileGate: OneShotRequestGate
) {
  const tableId = String(tableRow.id);

  await context.route('**/rest/v1/tables*', async (route) => {
    const request = route.request();
    const decoded = decodeURIComponent(request.url());
    if ((request.method() === 'GET' || request.method() === 'HEAD') && decoded.includes(tableId)) {
      await fulfillJson(route, wantsObject(route) ? tableRow : [tableRow]);
      return;
    }
    await route.continue();
  });

  await context.route('**/rest/v1/table_seats*', async (route) => {
    const request = route.request();
    const decoded = decodeURIComponent(request.url());
    if ((request.method() === 'GET' || request.method() === 'HEAD') && decoded.includes(tableId)) {
      const rows = [
        {
          id: '10000000-0000-4000-8000-000000000001',
          table_id: tableId,
          seat_number: 1,
          user_id: userId,
          stack: 500,
          status: 'active',
          horse_id: null,
          is_sitting_out: false,
          leave_pending: false,
          time_bank_remaining: 30,
          time_bank_uses_remaining: 3,
          joined_at: '2026-10-05T00:00:00.000Z',
          left_at: null,
          profiles: profileRow(userId, runtime),
          tables: tableRow,
        },
        {
          id: '10000000-0000-4000-8000-000000000002',
          table_id: tableId,
          seat_number: 2,
          user_id: VILLAIN_ID,
          stack: 500,
          status: 'active',
          horse_id: null,
          is_sitting_out: false,
          leave_pending: false,
          time_bank_remaining: 30,
          time_bank_uses_remaining: 3,
          joined_at: '2026-10-05T00:00:00.000Z',
          left_at: null,
          profiles: villainProfile(),
          tables: tableRow,
        },
      ];
      const filtered = decoded.includes(userId)
        ? rows.filter((row) => row.user_id === userId)
        : rows;
      await fulfillJson(route, wantsObject(route) ? filtered[0] || null : filtered);
      return;
    }
    await route.continue();
  });

  await context.route('**/rest/v1/rpc/fn_patch_table_appearance*', async (route) => {
    if (route.request().method() === 'POST' && (await themeGate.holdIfArmed(route))) return;
    await route.continue();
  });

  await context.route('**/rest/v1/profiles*', async (route) => {
    const request = route.request();
    const method = request.method();
    const decoded = decodeURIComponent(request.url());
    if (method !== 'GET' && method !== 'HEAD') {
      if (decoded.includes(userId) && (await profileGate.holdIfArmed(route))) return;
      await route.continue();
      return;
    }
    if (!decoded.includes(VILLAIN_ID)) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as unknown;
    const rows = Array.isArray(body) ? body : body ? [body] : [];
    if (!rows.some((row) => (row as { id?: string }).id === VILLAIN_ID))
      rows.push(villainProfile());
    await route.fulfill({ response, json: wantsObject(route) ? rows[0] || null : rows });
  });

  await context.route('**/rest/v1/rpc/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/fn_maintenance_break_state')) return fulfillJson(route, []);
    if (path.endsWith('/fn_cash_effective_buyin')) {
      return fulfillJson(route, { min: 40, floor_applied: false });
    }
    if (path.endsWith('/fn_time_bank_allowance')) {
      return fulfillJson(route, { uses_remaining: 3, duration_seconds: 30 });
    }
    await route.continue();
  });
}

function observeRealtime(page: Page, userId: string, tableId: string): RealtimeEvidence {
  const evidence: RealtimeEvidence = {
    ownerPrivateJoin: false,
    ownerPrivateSignal: false,
    tablePrivateJoin: false,
    tablePrivateSignal: false,
    accountThemeSignal: false,
  };
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      const body = String(payload);
      if (body.includes(`profile-appearance:${userId}`)) evidence.ownerPrivateJoin = true;
      if (body.includes(`table-appearance:${tableId}`)) evidence.tablePrivateJoin = true;
    });
    socket.on('framereceived', ({ payload }) => {
      const body = String(payload);
      if (
        body.includes(`profile-appearance:${userId}`) &&
        body.includes('appearance_changed') &&
        body.includes(userId)
      ) {
        evidence.ownerPrivateSignal = true;
      }
      if (
        body.includes(`table-appearance:${tableId}`) &&
        body.includes('appearance_changed') &&
        body.includes(userId)
      ) {
        evidence.tablePrivateSignal = true;
      }
      if (body.includes('user_theme_settings') && body.includes(userId)) {
        evidence.accountThemeSignal = true;
      }
    });
  });
  return evidence;
}

async function publishTableAppearanceSignal(
  environment: CustomizationCertificationEnvironment,
  account: TemporaryCustomizationAccount,
  tableId: string
): Promise<void> {
  // The fixture deliberately owns no real seat. Publish the same bounded
  // invalidation as the database trigger through Realtime's service endpoint;
  // the browser still has to join the private topic under its real user JWT,
  // receive the signal, and reconcile the permitted profile projection.
  const headers: Record<string, string> = {
    apikey: environment.serviceRoleKey,
    'content-type': 'application/json',
  };
  if (!environment.serviceRoleKey.startsWith('sb_secret_')) {
    headers.Authorization = `Bearer ${environment.serviceRoleKey}`;
  }
  const endpoint = new URL('/realtime/v1/api/broadcast', environment.supabaseUrl).toString();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: [
        {
          topic: `table-appearance:${tableId}`,
          event: 'appearance_changed',
          payload: { user_id: account.id },
          private: true,
        },
      ],
    }),
  });
  if (response.status !== 202) {
    const detail = await response.text();
    throw new Error(
      `Private table appearance broadcast failed (${response.status}): ${detail.slice(0, 300)}`
    );
  }
}

async function signIn(page: Page, baseURL: string, account: TemporaryCustomizationAccount) {
  const protectedURL = new URL('notifications', baseURL).toString();
  await page.goto(protectedURL, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT });
  await page.waitForURL((url) => url.pathname.includes('/auth'), { timeout: 20_000 });
  const email = page.locator('input[type="email"]').first();
  const password = page.locator('input[type="password"]').first();
  await expect(email).toBeVisible({ timeout: 30_000 });
  await email.fill(account.email);
  await password.fill(account.password);
  const titled = page.locator('button[type="submit"][title="Sign In"]').first();
  const submit = (await titled.count())
    ? titled
    : page.locator('form button[type="submit"], button[type="submit"]').first();
  await submit.click();
  await page.waitForURL((url) => !url.pathname.includes('/auth'), { timeout: 45_000 });
  await page.evaluate(() => localStorage.setItem('club_arena_welcome_accepted', 'true'));
  await ensureAcceptedTerms(page);
  await ensurePlayableProfile(page);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          try {
            const session = JSON.parse(localStorage.getItem('smarter-poker-auth') || 'null');
            return session?.user?.id || session?.currentSession?.user?.id || '';
          } catch {
            return '';
          }
        }),
      { timeout: 30_000 }
    )
    .toBe(account.id);
}

async function tapReady(control: Locator) {
  await expect(control).toBeVisible({ timeout: 30_000 });
  await expect(control).toBeEnabled({ timeout: 30_000 });
  await control.evaluate((element: HTMLElement) => element.click());
}

async function openTableSettings(page: Page) {
  await tapReady(page.getByRole('button', { name: 'Table Menu' }));
  await tapReady(page.getByRole('menuitem', { name: 'Table Settings', exact: true }));
  const settings = page.locator('.settings-panel');
  await expect(settings).toBeVisible({ timeout: 30_000 });
  return settings;
}

async function openStudio(settings: Locator) {
  await tapReady(settings.getByRole('button', { name: 'Open Studio' }));
  const studio = settings.page().getByRole('dialog', { name: 'Make The Table Yours' });
  await expect(studio).toBeVisible({ timeout: 30_000 });
  await expect(studio.locator('.theme-modal__grid')).toHaveAttribute('aria-busy', 'false', {
    timeout: RESPONSE_TIMEOUT,
  });
  await expect(studio.getByText('Table Art Live')).toBeVisible({ timeout: RESPONSE_TIMEOUT });
  return studio;
}

async function chooseAppearance(options: {
  studio: Locator;
  gate: OneShotRequestGate;
  writerRoot: Locator;
  readerRoot: Locator;
  tab: string;
  asset: string;
  attribute: string;
  value: string;
  verifyImmediate?: () => Promise<void>;
}) {
  const { studio, gate, writerRoot, readerRoot, tab, asset, attribute, value, verifyImmediate } =
    options;
  await tapReady(studio.getByRole('tab', { name: tab, exact: true }));
  const tile = studio.getByRole('button', { name: asset, exact: true });
  await expect(tile).toBeEnabled({ timeout: 30_000 });
  const persisted = studio
    .page()
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/rest/v1/rpc/fn_patch_table_appearance'),
      { timeout: RESPONSE_TIMEOUT }
    );
  gate.arm();
  await tapReady(tile);
  await gate.waitForRequest();
  await expect(writerRoot).toHaveAttribute(attribute, value);
  await verifyImmediate?.();
  gate.release();
  const response = await persisted;
  if (!response.ok()) throw new Error(`${tab} persistence failed with HTTP ${response.status()}.`);
  await expect(readerRoot).toHaveAttribute(attribute, value, { timeout: RESPONSE_TIMEOUT });
}

async function readTheme(
  environment: CustomizationCertificationEnvironment,
  userId: string
): Promise<Record<string, unknown> | null> {
  const rows = await readServiceRows<Record<string, unknown>>(
    environment,
    'user_theme_settings',
    new URLSearchParams({
      select: 'user_id,game_type,theme_id,table_id,button_id,background_id,cards_id,face_deck_id',
      user_id: `eq.${userId}`,
      game_type: 'eq.ALL',
    })
  );
  return rows[0] ?? null;
}

async function readCosmetics(
  environment: CustomizationCertificationEnvironment,
  userId: string
): Promise<{ equipped_frame: string | null; equipped_aura: string | null } | null> {
  const rows = await readServiceRows<{
    equipped_frame: string | null;
    equipped_aura: string | null;
  }>(
    environment,
    'profiles',
    new URLSearchParams({
      select: 'equipped_frame,equipped_aura',
      id: `eq.${userId}`,
    })
  );
  return rows[0] ?? null;
}

test.describe('production routed gameplay customization', () => {
  const JOURNEY_TIMEOUT_MS = 600_000;
  const CASE_TIMEOUT_MS = JOURNEY_TIMEOUT_MS + CLEANUP_FREEZE_ALLOWANCE_MS;
  test.describe.configure({ mode: 'serial', timeout: CASE_TIMEOUT_MS });
  test.skip(
    !CERTIFICATION_ENABLED,
    'Set GAMEPLAY_CUSTOMIZATION_CERTIFICATION=1 in the trusted post-deploy job.'
  );

  test('mobile table art, cards and avatar styles repaint now, persist, and reconcile live', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(CASE_TIMEOUT_MS);
    if (!baseURL) throw new Error('A deployed BASE_URL is required.');

    const environment = requireCustomizationCertificationEnvironment();
    let account: TemporaryCustomizationAccount | undefined;
    let writerContext: BrowserContext | undefined;
    let readerContext: BrowserContext | undefined;
    let journeyFailure: unknown;
    const cleanupFailures: unknown[] = [];

    try {
      account = await createTemporaryCustomizationAccount(environment, 'gameplay-runtime', 0);
      const joined = await account.client.rpc('fn_join_club', { p_club_id: CLUB_ID });
      if (joined.error) throw joined.error;
      if (joined.data && typeof joined.data === 'object' && 'error' in joined.data) {
        throw new Error(String(joined.data.error));
      }

      // Do not create a settings row here. The first routed paint must prove
      // the maintained fresh-account defaults, especially White D.
      const freshTheme = await readTheme(environment, account.id);
      if (freshTheme?.button_id && freshTheme.button_id !== BASELINE.button_id) {
        throw new Error(`Fresh-account dealer default was ${String(freshTheme.button_id)}.`);
      }
      const baselineProfile = await account.client
        .from('profiles')
        .update({
          arena_avatar_url: HERO_AVATAR,
          use_avatar_as_profile_pic: true,
          equipped_frame: null,
          equipped_aura: null,
        })
        .eq('id', account.id);
      if (baselineProfile.error) throw baselineProfile.error;

      // Private `table-appearance:<id>` authorization requires an existing,
      // readable tables row. Use one retained row from the joined club only as
      // that authorization anchor, then project deterministic cash metadata,
      // seats and hand state in-browser. No production game is woken, seated,
      // mutated or required to be live for this certificate.
      const anchors = await readServiceRows<TableAuthorizationAnchor>(
        environment,
        'tables',
        new URLSearchParams({
          select:
            'id,club_id,union_id,arena:clubs!fk_tables_club_id(id,asset,is_platform,union_id)',
          club_id: `eq.${CLUB_ID}`,
          is_deleted: 'eq.false',
          deleted_at: 'is.null',
          // Prefer the oldest retained row: short-lived Spin rows are recycled
          // aggressively, while this id must survive until the private channel
          // has joined and received its signal.
          order: 'created_at.asc,id.asc',
          limit: '1',
        })
      );
      const anchor = anchors[0];
      if (!anchor || !/^[0-9a-f-]{36}$/i.test(anchor.id)) {
        throw new Error('The certification club has no readable table authorization anchor.');
      }
      const tableId = anchor.id;
      const arena = Array.isArray(anchor.arena) ? anchor.arena[0] : anchor.arena;
      if (!arena || arena.id !== anchor.club_id) {
        throw new Error('The table authorization anchor has no valid arena identity.');
      }
      const tableRow: Record<string, unknown> = {
        id: tableId,
        club_id: anchor.club_id,
        union_id: anchor.union_id,
        arena,
        name: 'Customization Certification Table',
        game_variant: 'nlh',
        game_type: 'cash',
        tournament_id: null,
        stakes: '1/2',
        small_blind: 1,
        big_blind: 2,
        min_buy_in: 40,
        max_buy_in: 400,
        max_players: 6,
        current_players: 2,
        status: 'running',
        settings: {},
        is_deleted: false,
        is_private: true,
        straddle_enabled: false,
        bomb_pot_enabled: false,
        bomb_pot_frequency: null,
        bomb_pot_ante_multiplier: null,
        bomb_pot_double_board: false,
        bomb_pot_board_count: null,
        bomb_pot_trigger_mode: null,
        bomb_pot_interval_seconds: null,
        bomb_pot_variant: null,
        bomb_pot_announce_seconds: null,
        bomb_pot_ante_fixed: null,
        bomb_pot_min_players: null,
        bomb_pot_button_policy: null,
        cluster_id: null,
        nit_game: false,
        maintain_percent_min: null,
        maintain_hands: null,
        created_at: '2026-10-05T00:00:00.000Z',
      };

      const runtime: RuntimeProfile = { avatar: HERO_AVATAR, frame: null, aura: null };
      const writerThemeGate = new OneShotRequestGate();
      const writerProfileGate = new OneShotRequestGate();
      const readerThemeGate = new OneShotRequestGate();
      const readerProfileGate = new OneShotRequestGate();

      writerContext = await browser.newContext({
        ...devices['iPhone 13'],
        baseURL,
        storageState: { cookies: [], origins: [] },
      });
      readerContext = await browser.newContext({
        ...devices['iPhone 13'],
        baseURL,
        storageState: { cookies: [], origins: [] },
      });
      for (const [context, themeGate, profileGate] of [
        [writerContext, writerThemeGate, writerProfileGate],
        [readerContext, readerThemeGate, readerProfileGate],
      ] as const) {
        await installEngineProjection(context, tableId, account.id, runtime);
        await installRuntimeDataProjection(
          context,
          tableRow,
          account.id,
          runtime,
          themeGate,
          profileGate
        );
      }

      const writer = await writerContext.newPage();
      const reader = await readerContext.newPage();
      const writerRealtime = observeRealtime(writer, account.id, tableId);
      const readerRealtime = observeRealtime(reader, account.id, tableId);
      await signIn(writer, baseURL, account);
      await signIn(reader, baseURL, account);

      await Promise.all([
        writer.goto(`table/${tableId}`, {
          waitUntil: 'domcontentloaded',
          timeout: RESPONSE_TIMEOUT,
        }),
        reader.goto(`table/${tableId}`, {
          waitUntil: 'domcontentloaded',
          timeout: RESPONSE_TIMEOUT,
        }),
      ]);

      const writerRoot = writer.locator('.multi-table-page__table-slot--active .table-page');
      const readerRoot = reader.locator('.multi-table-page__table-slot--active .table-page');
      const writerTableArt = writerRoot.locator('.table-art');
      const writerDealer = writerRoot.locator('.dealer-button');
      const writerCardBack = writerRoot.locator('.seat__cards--opponent .card-back').first();
      const writerFaceCard = writerRoot.locator('.community-cards .card-image').first();
      const writerHero = writerRoot.locator('.seat-wrapper--hero .seat__avatar');
      const readerHero = readerRoot.locator('.seat-wrapper--hero .seat__avatar');

      await expect(writerRoot).toBeVisible({ timeout: 30_000 });
      await expect(readerRoot).toBeVisible({ timeout: 30_000 });
      await expect(writerTableArt).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(
          () =>
            writerTableArt.evaluate(
              (image) =>
                image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
            ),
          { timeout: RESPONSE_TIMEOUT }
        )
        .toBe(true);
      await expect(writerRoot).toHaveAttribute('data-felt-theme', BASELINE.table_id);
      await expect(writerRoot).toHaveAttribute('data-background-theme', BASELINE.background_id);
      await expect(writerRoot).toHaveAttribute('data-button-theme', 'classic-white');
      await expect(writerRoot).toHaveAttribute('data-cards-theme', BASELINE.cards_id);
      await expect(writerRoot).toHaveAttribute('data-face-deck', BASELINE.face_deck_id);
      await expect(writerRoot).toHaveAttribute('data-player-appearance-sync', 'live', {
        timeout: RESPONSE_TIMEOUT,
      });
      await expect(readerRoot).toHaveAttribute('data-player-appearance-sync', 'live', {
        timeout: RESPONSE_TIMEOUT,
      });
      await expect(writerCardBack).toBeVisible();
      await expect(writerFaceCard).toBeVisible();

      const firstTableArt = await writerTableArt.getAttribute('src');
      const firstRoomPaint = await writerRoot.evaluate(
        (element) => getComputedStyle(element).backgroundImage
      );
      const firstDealerPaint = await writerDealer.evaluate(
        (element) => getComputedStyle(element).backgroundImage
      );
      const firstCardPaint = await writerCardBack.evaluate((element) => {
        const css = getComputedStyle(element);
        return [css.backgroundImage, css.backgroundColor, css.borderColor].join('|');
      });
      const firstFacePaint = await writerFaceCard.evaluate((element) => {
        const css = getComputedStyle(element);
        return [
          css.getPropertyValue('--face-deck-edge'),
          css.getPropertyValue('--face-deck-inner'),
          css.getPropertyValue('--face-deck-glint'),
        ].join('|');
      });

      const settings = await openTableSettings(writer);
      const studio = await openStudio(settings);
      await tapReady(studio.getByRole('tab', { name: 'Buttons', exact: true }));
      await expect(studio.getByRole('button', { name: 'White D', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await chooseAppearance({
        studio,
        gate: writerThemeGate,
        writerRoot,
        readerRoot,
        tab: 'Tables',
        asset: 'Carbon Red',
        attribute: 'data-felt-theme',
        value: 'carbon_red',
        verifyImmediate: async () => {
          await expect.poll(() => writerTableArt.getAttribute('src')).not.toBe(firstTableArt);
        },
      });

      await chooseAppearance({
        studio,
        gate: writerThemeGate,
        writerRoot,
        readerRoot,
        tab: 'Scenes',
        asset: 'Emerald Room',
        attribute: 'data-background-theme',
        value: 'emerald_room',
        verifyImmediate: async () => {
          await expect
            .poll(() => writerRoot.evaluate((element) => getComputedStyle(element).backgroundImage))
            .not.toBe(firstRoomPaint);
          expect(
            await writerRoot.evaluate((element) => getComputedStyle(element).backgroundSize)
          ).not.toContain('100% 100%');
        },
      });

      await chooseAppearance({
        studio,
        gate: writerThemeGate,
        writerRoot,
        readerRoot,
        tab: 'Buttons',
        asset: 'Red D',
        attribute: 'data-button-theme',
        value: 'red-d-gear',
        verifyImmediate: async () => {
          await expect
            .poll(() =>
              writerDealer.evaluate((element) => getComputedStyle(element).backgroundImage)
            )
            .not.toBe(firstDealerPaint);
        },
      });

      await chooseAppearance({
        studio,
        gate: writerThemeGate,
        writerRoot,
        readerRoot,
        tab: 'Cards',
        asset: 'Royal',
        attribute: 'data-cards-theme',
        value: 'royal',
        verifyImmediate: async () => {
          await expect(writerCardBack).toHaveClass(/card-back--royal/);
          await expect
            .poll(() =>
              writerCardBack.evaluate((element) => {
                const css = getComputedStyle(element);
                return [css.backgroundImage, css.backgroundColor, css.borderColor].join('|');
              })
            )
            .not.toBe(firstCardPaint);
        },
      });

      await chooseAppearance({
        studio,
        gate: writerThemeGate,
        writerRoot,
        readerRoot,
        tab: 'Decks',
        asset: 'Broadcast Pro',
        attribute: 'data-face-deck',
        value: 'broadcast-pro',
        verifyImmediate: async () => {
          await expect(writerFaceCard).toHaveAttribute('data-face-deck', 'broadcast-pro');
          await expect
            .poll(() =>
              writerFaceCard.evaluate((element) => {
                const css = getComputedStyle(element);
                return [
                  css.getPropertyValue('--face-deck-edge'),
                  css.getPropertyValue('--face-deck-inner'),
                  css.getPropertyValue('--face-deck-glint'),
                ].join('|');
              })
            )
            .not.toBe(firstFacePaint);
        },
      });

      await expect
        .poll(() => readTheme(environment, account!.id), { timeout: RESPONSE_TIMEOUT })
        .toMatchObject({
          user_id: account.id,
          game_type: 'ALL',
          table_id: 'carbon_red',
          background_id: 'emerald_room',
          button_id: 'red-d-gear',
          cards_id: 'royal',
          face_deck_id: 'broadcast-pro',
        });
      await expect
        .poll(() => readerRealtime.accountThemeSignal, { timeout: RESPONSE_TIMEOUT })
        .toBe(true);

      await tapReady(studio.getByRole('button', { name: 'Close Table Studio' }));
      await tapReady(settings.getByRole('button', { name: 'Change Avatar' }));
      const gallery = writer.getByRole('dialog', { name: 'Avatar Gallery' });
      await expect(gallery).toBeVisible({ timeout: 30_000 });
      await tapReady(gallery.getByRole('tab', { name: /^Style \(/ }));

      const frameResponse = writer.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname.endsWith('/rest/v1/profiles'),
        { timeout: RESPONSE_TIMEOUT }
      );
      writerProfileGate.arm();
      await tapReady(gallery.getByRole('button', { name: 'Slate Frame, Owned', exact: true }));
      await writerProfileGate.waitForRequest();
      await expect(writerHero.locator('.sp-cosmetic--frame.frame-slate')).toBeVisible();
      await expect(gallery.locator('.ag-preview .sp-cosmetic--frame.frame-slate')).toHaveCount(2);
      writerProfileGate.release();
      if (!(await frameResponse).ok()) throw new Error('Frame persistence was refused.');
      await expect
        .poll(() => readCosmetics(environment, account!.id), { timeout: RESPONSE_TIMEOUT })
        .toMatchObject({ equipped_frame: 'frame-slate', equipped_aura: null });

      const auraResponse = writer.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname.endsWith('/rest/v1/profiles'),
        { timeout: RESPONSE_TIMEOUT }
      );
      writerProfileGate.arm();
      await tapReady(gallery.getByRole('button', { name: 'Mist Aura, Owned', exact: true }));
      await writerProfileGate.waitForRequest();
      await expect(writerHero.locator('.sp-cosmetic--aura.aura-mist')).toBeVisible();
      await expect(gallery.locator('.ag-preview .sp-cosmetic--aura.aura-mist')).toHaveCount(2);
      writerProfileGate.release();
      if (!(await auraResponse).ok()) throw new Error('Aura persistence was refused.');
      await expect
        .poll(() => readCosmetics(environment, account!.id), { timeout: RESPONSE_TIMEOUT })
        .toMatchObject({ equipped_frame: 'frame-slate', equipped_aura: 'aura-mist' });

      await expect
        .poll(
          () =>
            readerRealtime.ownerPrivateJoin &&
            readerRealtime.tablePrivateJoin &&
            readerRealtime.ownerPrivateSignal &&
            writerRealtime.ownerPrivateSignal,
          { timeout: RESPONSE_TIMEOUT }
        )
        .toBe(true);
      await publishTableAppearanceSignal(environment, account, tableId);
      await expect
        .poll(() => readerRealtime.tablePrivateSignal && writerRealtime.tablePrivateSignal, {
          timeout: RESPONSE_TIMEOUT,
        })
        .toBe(true);
      await expect(readerHero.locator('.sp-cosmetic--frame.frame-slate')).toBeVisible({
        timeout: RESPONSE_TIMEOUT,
      });
      await expect(readerHero.locator('.sp-cosmetic--aura.aura-mist')).toBeVisible({
        timeout: RESPONSE_TIMEOUT,
      });

      await tapReady(gallery.getByRole('button', { name: 'Done', exact: true }));
      await writer.reload({ waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT });
      const reloadedRoot = writer.locator('.multi-table-page__table-slot--active .table-page');
      await expect(reloadedRoot).toHaveAttribute('data-felt-theme', 'carbon_red', {
        timeout: RESPONSE_TIMEOUT,
      });
      await expect(reloadedRoot).toHaveAttribute('data-background-theme', 'emerald_room');
      await expect(reloadedRoot).toHaveAttribute('data-button-theme', 'red-d-gear');
      await expect(reloadedRoot).toHaveAttribute('data-cards-theme', 'royal');
      await expect(reloadedRoot).toHaveAttribute('data-face-deck', 'broadcast-pro');
      await expect(
        reloadedRoot.locator('.seat-wrapper--hero .sp-cosmetic--frame.frame-slate')
      ).toBeVisible({ timeout: RESPONSE_TIMEOUT });
      await expect(
        reloadedRoot.locator('.seat-wrapper--hero .sp-cosmetic--aura.aura-mist')
      ).toBeVisible({ timeout: RESPONSE_TIMEOUT });
      await expect(writer.locator('.studio-game-preview')).toHaveCount(0);

      console.log('[gameplay-customization] White D was the fresh-account default');
      console.log('[gameplay-customization] routed mobile gameplay repainted before persistence');
      console.log(
        '[gameplay-customization] account settings crossed an authenticated realtime channel'
      );
      console.log(
        '[gameplay-customization] private authenticated table signal reconciled the second table'
      );
      console.log('[gameplay-customization] every selected graphic survived a cold route reload');
    } catch (error) {
      journeyFailure = error;
    } finally {
      await writerContext?.close().catch((error) => cleanupFailures.push(error));
      await readerContext?.close().catch((error) => cleanupFailures.push(error));
      if (account) {
        await cleanupTemporaryCustomizationAccount(environment, account).catch((error) =>
          cleanupFailures.push(error)
        );
      }
    }

    if (journeyFailure && cleanupFailures.length) {
      throw new AggregateError(
        [journeyFailure, ...cleanupFailures],
        withCauses('Gameplay customization journey and cleanup both failed:', [
          journeyFailure,
          ...cleanupFailures,
        ])
      );
    }
    if (journeyFailure) throw journeyFailure;
    if (cleanupFailures.length) {
      throw new AggregateError(
        cleanupFailures,
        withCauses('Gameplay customization cleanup failed:', cleanupFailures)
      );
    }
  });
});

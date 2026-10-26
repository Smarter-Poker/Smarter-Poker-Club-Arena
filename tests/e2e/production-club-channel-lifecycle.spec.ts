import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { openChannelWithUnavailableRetry } from './support/channelHandshake';
import {
  CLEANUP_FREEZE_ALLOWANCE_MS,
  cleanupTemporaryCustomizationAccount,
  createTemporaryCustomizationAccount,
  readServiceRows,
  requireCustomizationCertificationEnvironment,
} from './support/temporaryCustomizationAccount';

// Arguments include ephemeral JWTs. Never retain an automatic trace/video.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
const CLUB_CACHE_TTL_MS = 60_000; // ChannelWebSocketServer's actual user|club cache.
const CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
type Member = {
  user_id: string;
  role: string;
  status: string;
  is_active: boolean;
  membership_lifecycle_status: string;
  chip_balance: number;
  promo_balance: number;
  held_chips: number;
  locked_chips: number;
  credit_limit: number;
  credit_used: number;
};

test('exact serving engine refuses absent and departed financial club channels', async ({
  page,
}, info) => {
  test.setTimeout(300_000 + CLEANUP_FREEZE_ALLOWANCE_MS);
  const expected = process.env.EXPECTED_ENGINE_SHA || '';
  expect(expected, 'An exact protected engine revision is required').toMatch(/^[a-f0-9]{40}$/);
  const environment = requireCustomizationCertificationEnvironment();
  const record = process.env.E2E_TEST_ACCOUNT_FILE;
  if (!record) throw new Error('The maintained reserved staff account record is required.');
  const staff = JSON.parse(await readFile(record, 'utf8'));
  if (
    !/^ca-customization-cert-postdeploy-.*@example\.invalid$/.test(staff.email || '') ||
    !staff.id
  )
    throw new Error('This verifier refuses an identity outside its owning post-deploy fixture.');
  const staffClient = createClient(environment.supabaseUrl, environment.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const staffLogin = await staffClient.auth.signInWithPassword({
    email: staff.email,
    password: staff.password,
  });
  if (staffLogin.error || staffLogin.data.user?.id !== staff.id || !staffLogin.data.session)
    throw new Error('Reserved staff authentication failed.');
  async function engineIdentity() {
    const response = await page.request.get(
      `https://engine.smarter.poker/health?club-channel-proof=${Date.now()}`
    );
    expect(response.ok()).toBe(true);
    const health = await response.json();
    expect(health.releaseSha).toBe(expected);
    expect(health.liveness).toBe('ok');
    expect(health.maintenance?.active).not.toBe(true);
  }
  async function members(user: string) {
    return readServiceRows<Member>(
      environment,
      'club_members',
      new URLSearchParams({
        select:
          'user_id,role,status,is_active,membership_lifecycle_status,chip_balance,promo_balance,held_chips,locked_chips,credit_limit,credit_used',
        club_id: `eq.${CLUB}`,
        user_id: `eq.${user}`,
      })
    );
  }
  function zero(row: Member) {
    for (const field of [
      'chip_balance',
      'promo_balance',
      'held_chips',
      'locked_chips',
      'credit_limit',
      'credit_used',
    ] as const) {
      expect(row[field], `Missing ${field} is not zero`).not.toBeNull();
      expect(row[field], `Missing ${field} is not zero`).not.toBeUndefined();
      expect(Number(row[field]), `Unexpected ${field}; never move or erase a fixture balance`).toBe(
        0
      );
    }
  }
  await engineIdentity();
  const staffRows = await members(staff.id);
  expect(staffRows).toHaveLength(1);
  zero(staffRows[0]);
  expect(['admin', 'owner', 'co_owner']).toContain(staffRows[0].role);
  expect(staffRows[0].is_active).toBe(true);
  expect(staffRows[0].membership_lifecycle_status).toBe('active');
  const account = await createTemporaryCustomizationAccount(environment, 'channellife', 0);
  const targetSession = (await account.client.auth.getSession()).data.session;
  if (!targetSession) {
    await cleanupTemporaryCustomizationAccount(environment, account);
    throw new Error('Reserved target session is missing.');
  }
  const observed: object[] = [];
  try {
    // Browser transport only: no application session or preexisting app socket.
    await page.goto('about:blank');
    async function open(token: string) {
      return openChannelWithUnavailableRetry(
        async () => {
          const cdp = await page.context().newCDPSession(page);
          let status: number | null = null;
          let requestId: string | null = null;
          await cdp.send('Network.enable');
          // Retain only numeric status. Never copy headers, URL protocols or JWTs.
          cdp.on('Network.webSocketCreated', (event) => {
            if (event.url === 'wss://engine.smarter.poker/ws/channel?v=1')
              requestId = event.requestId;
          });
          cdp.on('Network.webSocketHandshakeResponseReceived', (event) => {
            if (event.requestId === requestId) status = event.response.status;
          });
          try {
            const result = await page.evaluate(
              async ({ token, club }) => {
                const scope = window as unknown as {
                  proofSockets: {
                    socket: WebSocket;
                    sync: boolean;
                    pong: number;
                    closed: boolean;
                  }[];
                };
                scope.proofSockets ||= [];
                const state = {
                  socket: new WebSocket('wss://engine.smarter.poker/ws/channel?v=1', [
                    'bearer',
                    token,
                  ]),
                  sync: false,
                  pong: 0,
                  closed: false,
                };
                const index = scope.proofSockets.push(state) - 1;
                state.socket.onmessage = ({ data }) => {
                  const frame = JSON.parse(String(data));
                  if (frame.type === 'PING' || frame.type === 'CHANNEL_PING')
                    state.socket.send(JSON.stringify({ type: 'CHANNEL_PONG' }));
                  if (frame.type === 'CHANNEL_PONG') state.pong++;
                  if (frame.type === 'CLUB_PRESENCE_UPDATE' && frame.clubId === club)
                    state.sync = true; // Any private club frame is a leak for a refused subject.
                };
                state.socket.onclose = () => {
                  state.closed = true;
                };
                const opened = await new Promise<boolean>((resolve, reject) => {
                  const closeDeadline = setTimeout(
                    () => reject(new Error('Channel socket close timed out')),
                    17_000
                  );
                  const timeout = setTimeout(() => state.socket.close(), 15_000);
                  state.socket.onopen = () => {
                    clearTimeout(timeout);
                    clearTimeout(closeDeadline);
                    resolve(true);
                  };
                  // Failed handshakes close after error; await that close before retry.
                  state.socket.onerror = () => state.socket.close();
                  state.socket.onclose = (event) => {
                    clearTimeout(timeout);
                    clearTimeout(closeDeadline);
                    state.closed = true;
                    (state as typeof state & { closeCode?: number }).closeCode = event.code;
                    resolve(false);
                  };
                });
                if (!opened)
                  return {
                    opened: false,
                    index,
                    closeCode: (state as typeof state & { closeCode?: number }).closeCode ?? null,
                  };
                state.socket.send(JSON.stringify({ type: 'JOIN_CLUB', clubId: club }));
                state.socket.send(
                  JSON.stringify({ type: 'UPDATE_PRESENCE', clubId: club, status: 'online' })
                );
                state.socket.send(JSON.stringify({ type: 'CHANNEL_PING' }));
                return { opened: true, index, closeCode: null };
              },
              { token, club: CLUB }
            );
            return { ...result, status };
          } finally {
            await cdp.detach();
          }
        },
        (diagnostic) => observed.push({ label: 'channel-handshake', ...diagnostic })
      );
    }
    async function state(index: number) {
      return page.evaluate((index) => {
        const s = (window as any).proofSockets[index];
        return { sync: s.sync, pong: s.pong, closed: s.closed };
      }, index);
    }
    async function close(index: number) {
      await page.evaluate(async (index) => {
        const socket = (window as any).proofSockets[index].socket as WebSocket;
        if (socket.readyState === WebSocket.CLOSED) return;
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error('Channel close timed out')), 5_000);
          socket.addEventListener(
            'close',
            () => {
              clearTimeout(deadline);
              resolve();
            },
            { once: true }
          );
          socket.close();
        });
      }, index);
    }
    async function positiveControl() {
      const i = await open(staffLogin.data.session!.access_token);
      await expect.poll(async () => (await state(i)).sync, { timeout: 15_000 }).toBe(true);
      await expect.poll(async () => (await state(i)).pong, { timeout: 15_000 }).toBeGreaterThan(0);
      await close(i);
    }
    async function negative(label: string) {
      await engineIdentity();
      await positiveControl();
      const i = await open(targetSession.access_token);
      await expect.poll(async () => (await state(i)).pong, { timeout: 15_000 }).toBeGreaterThan(0);
      // This is bounded negative observation, not a protocol denial receipt.
      const until = Date.now() + 5_000;
      while (Date.now() < until) {
        const s = await state(i);
        expect(s.sync).toBe(false);
        expect(s.closed).toBe(false);
        await page.waitForTimeout(100);
      }
      observed.push({ label, ...(await state(i)), negativeObservationMs: 5_000 });
      await close(i);
      await positiveControl();
      await engineIdentity();
    }
    expect(await members(account.id)).toHaveLength(0);
    await negative('absent');
    let cachedAt = Date.now();
    const joined = await account.client.rpc('fn_join_club', { p_club_id: CLUB });
    if (joined.error) throw new Error('Native reserved target join failed.');
    const active = await members(account.id);
    expect(active).toHaveLength(1);
    zero(active[0]);
    expect(['active', 'approved']).toContain(active[0].status);
    expect(active[0].is_active).toBe(true);
    expect(active[0].membership_lifecycle_status).toBe('active');
    // A fresh socket does not invalidate the shared negative membership cache.
    await page.waitForTimeout(Math.max(0, cachedAt + CLUB_CACHE_TTL_MS + 1_000 - Date.now()));
    const activeSocket = await open(targetSession.access_token);
    await expect.poll(async () => (await state(activeSocket)).sync, { timeout: 15_000 }).toBe(true);
    cachedAt = Date.now();
    observed.push({ label: 'active', ...(await state(activeSocket)) });
    await close(activeSocket);
    const departed = await staffClient.rpc('fn_remove_settled_club_member', {
      p_club_id: CLUB,
      p_user_id: account.id,
    });
    if (departed.error || departed.data?.success !== true)
      throw new Error('Native zero-balance staff departure refused.');
    const rows = await members(account.id);
    expect(rows).toHaveLength(1);
    zero(rows[0]);
    expect(rows[0].status).toBe('suspended');
    expect(rows[0].is_active).toBe(false);
    expect(rows[0].membership_lifecycle_status).toBe('departed');
    await page.waitForTimeout(Math.max(0, cachedAt + CLUB_CACHE_TTL_MS + 1_000 - Date.now()));
    await negative('departed');
    expect(await members(account.id)).toEqual(rows);
    await engineIdentity();
    await info.attach('club-channel-lifecycle', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          engine: expected,
          club: CLUB,
          subject: account.id,
          observed,
          limit:
            'No denial ACK exists; negative observation uses exact identity, native state, expired cache, PONG and real positive control.',
        })
      ),
    });
  } finally {
    try {
      await info.attach('channel-handshakes', {
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify(
            observed.filter((entry) => (entry as { label?: string }).label === 'channel-handshake')
          )
        ),
      });
    } finally {
      await cleanup();
    }
  }
  async function cleanup() {
    const failures: unknown[] = [];
    try {
      await page.evaluate(() => {
        for (const s of (window as any).proofSockets || []) s.socket.close();
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanupTemporaryCustomizationAccount(environment, account);
    } catch (error) {
      failures.push(error);
    }
    try {
      const { error } = await staffClient.auth.signOut({ scope: 'local' });
      if (error) failures.push(error);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, failures.map((e) => String(e)).join(' | '));
  }
});

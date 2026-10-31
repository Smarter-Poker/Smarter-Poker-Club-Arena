import { expect, test } from '@playwright/test';
import { PRIVATE_RECORD_CLIENT_TITLE } from '../../scripts/ci/private-record-client-proof.mjs';
import { installPrivateRecordEngineInterruption } from './support/privateRecordEngineInterruption';

const API = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const GATEWAY = 'wss://ca-static.smarter.poker/private-record/ws/channel';
const ENGINE = 'wss://engine.smarter.poker/ws/channel';
const images = ['/avatars/table/free_ninja@2x.webp', '/avatars/table/free_shark@2x.webp'];

test(PRIVATE_RECORD_CLIENT_TITLE, async ({ page, context }, testInfo) => {
  test.setTimeout(420_000);
  expect(
    process.env.E2E_PRIVATE_RECORD_CLIENT_PROOF,
    'Explicit admitted provider proof required'
  ).toBe('1');
  expect(process.env.SP_EMAIL).toMatch(/^ca-customization-cert-postdeploy-.*@example\.invalid$/);
  expect(process.env.LIVE_SHA).toMatch(/^[0-9a-f]{40}$/);
  expect(process.env.EXPECTED_GATEWAY_REVISION).toMatch(/^[0-9a-f]{40}$/);
  const proof: Record<string, unknown> = {
    clientSha: process.env.LIVE_SHA,
    gatewaySha: process.env.EXPECTED_GATEWAY_REVISION,
    actualPublishedClient: true,
    cosmeticWrites: 0,
    syntheticFrames: 0,
    paidRetirementQualified: false,
  };
  type Frame = { endpoint: 'engine' | 'gateway'; topic: string; type: string; ready?: boolean };
  const frames: Frame[] = [];
  const paid: { topic: string; event: string; direction: string; socket: number }[] = [];
  const paidOpen = new Set<number>();
  const gatewayOpen = new Set<number>();
  let socketId = 0;
  let observationsOverflow = false;
  let originalProfile:
    | { id: string; alias: string; avatar_url: string | null; arena_avatar_url: string | null }
    | undefined;
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    const endpoint = `${url.protocol}//${url.host}${url.pathname}`;
    const id = ++socketId;
    if (
      url.hostname === 'kuklfnapbkmacvwxktbh.supabase.co' &&
      url.pathname.startsWith('/realtime/')
    ) {
      paidOpen.add(id);
      socket.on('close', () => paidOpen.delete(id));
      const leaving = new Map<string, string>();
      const joining = new Map<string, string>();
      const observe = (direction: string, payload: string | Buffer) => {
        try {
          const raw = JSON.parse(String(payload));
          const frame = Array.isArray(raw)
            ? { ref: raw[1], topic: raw[2], event: raw[3], payload: raw[4] }
            : raw;
          if (
            typeof frame.topic !== 'string' ||
            !/^(?:realtime:)?(?:member-record:|club-roster:)/.test(frame.topic)
          )
            return;
          if (paid.length >= 512) {
            observationsOverflow = true;
            return;
          }
          if (direction === 'sent' && frame.event === 'phx_leave' && frame.ref != null)
            leaving.set(String(frame.ref), frame.topic);
          if (direction === 'sent' && frame.event === 'phx_join' && frame.ref != null)
            joining.set(String(frame.ref), frame.topic);
          const confirmedJoin =
            direction === 'received' &&
            frame.event === 'phx_reply' &&
            frame.payload?.status === 'ok' &&
            joining.get(String(frame.ref)) === frame.topic;
          const confirmedLeave =
            direction === 'received' &&
            frame.event === 'phx_reply' &&
            frame.payload?.status === 'ok' &&
            leaving.get(String(frame.ref)) === frame.topic;
          paid.push({
            topic: frame.topic.replace(/^realtime:/, ''),
            event: confirmedJoin
              ? 'confirmed_join'
              : confirmedLeave
                ? 'confirmed_leave'
                : frame.event === 'broadcast'
                  ? frame.payload?.event
                  : frame.event,
            direction,
            socket: id,
          });
        } catch {
          /* No fabricated protocol evidence. */
        }
      };
      socket.on('framesent', ({ payload }) => observe('sent', payload));
      socket.on('framereceived', ({ payload }) => observe('received', payload));
      return;
    }
    if (endpoint !== ENGINE && endpoint !== GATEWAY) return;
    if (endpoint === GATEWAY) {
      gatewayOpen.add(id);
      socket.on('close', () => gatewayOpen.delete(id));
    }
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (frames.length >= 512) observationsOverflow = true;
        if (
          ['PRIVATE_RECORD_STATUS', 'PRIVATE_RECORD_CHANGED'].includes(frame.type) &&
          typeof frame.topic === 'string' &&
          frames.length < 512
        )
          frames.push({
            endpoint: endpoint === ENGINE ? 'engine' : 'gateway',
            topic: frame.topic,
            type: frame.type,
            ...(typeof frame.ready === 'boolean' ? { ready: frame.ready } : {}),
          });
      } catch {
        /* Non-record frames have no qualification authority. */
      }
    });
  });
  const fault = await installPrivateRecordEngineInterruption(context);
  const gatewayFault = await installPrivateRecordEngineInterruption(context, 'gateway');
  const pin = async () => {
    for (const origin of [
      'https://ca-static.smarter.poker',
      'https://smarter.poker/hub/club-arena',
    ]) {
      const response = await page.request.get(
        `${origin}/build-info.json?record-proof=${Date.now()}`,
        { headers: { 'Cache-Control': 'no-cache' } }
      );
      expect(response.ok()).toBe(true);
      expect((await response.json()).ca_sha).toBe(process.env.LIVE_SHA);
    }
    const health = await page.request.get('https://ca-static.smarter.poker/private-record/health', {
      headers: { 'Cache-Control': 'no-cache' },
    });
    expect(health.ok()).toBe(true);
    expect(await health.json()).toMatchObject({
      service: 'private-record-gateway',
      revision: process.env.EXPECTED_GATEWAY_REVISION,
      sourceReady: true,
      processReachable: true,
    });
  };
  try {
    await pin();
    await page.goto('lobby', { waitUntil: 'domcontentloaded' });
    const userId = await page.evaluate(
      async ({ api, key, email }) => {
        const session = JSON.parse(localStorage.getItem('smarter-poker-auth') || '{}');
        if (
          !session.access_token ||
          session.user?.email !== email ||
          !/^ca-customization-cert-postdeploy-.*@example\.invalid$/.test(email || '')
        )
          throw Error('Reserved browser identity missing');
        const response = await fetch(`${api}/auth/v1/user`, {
          headers: { apikey: key, Authorization: `Bearer ${session.access_token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw Error('Actual session verification unavailable');
        const actor = await response.json();
        if (actor.id !== session.user.id || actor.email !== email)
          throw Error('Actual session identity mismatch');
        return actor.id as string;
      },
      { api: API, key: KEY, email: process.env.SP_EMAIL }
    );
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    originalProfile = await page.evaluate(
      async ({ api, key, id }) => {
        const session = JSON.parse(localStorage.getItem('smarter-poker-auth') || '{}');
        if (session.user?.id !== id || !session.access_token) throw Error('Reserved actor changed');
        const response = await fetch(
          `${api}/rest/v1/profiles?id=eq.${id}&select=id,alias,avatar_url,arena_avatar_url`,
          {
            headers: { apikey: key, Authorization: `Bearer ${session.access_token}` },
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (!response.ok) throw Error('Own profile snapshot unavailable');
        const rows = await response.json();
        if (rows.length !== 1 || rows[0].id !== id || !rows[0].alias)
          throw Error('Own profile identity missing');
        return rows[0];
      },
      { api: API, key: KEY, id: userId }
    );
    proof.genuineSession = true;
    const topic = `member-record:${CLUB}:${userId}`;
    await page.goto(`clubs/kings-club/members/${userId}`, { waitUntil: 'domcontentloaded' });
    const avatar = page.locator('.mm-avatar img');
    await expect(avatar).toHaveCount(1, { timeout: 45_000 });
    await expect
      .poll(
        () =>
          frames.some(
            (f) =>
              f.endpoint === 'engine' &&
              f.topic === topic &&
              f.type === 'PRIVATE_RECORD_STATUS' &&
              f.ready === true
          ),
        { timeout: 45_000 }
      )
      .toBe(true);
    proof.engineReadyBefore = true;
    const initial = await avatar.getAttribute('src');
    const selected = initial?.includes('free_ninja') ? [...images].reverse() : images;
    const afterFault = frames.length;
    await fault.block();
    proof.isolatedEngineChannelFault = true;
    await expect
      .poll(
        () =>
          frames
            .slice(afterFault)
            .some(
              (f) =>
                f.endpoint === 'gateway' &&
                f.topic === topic &&
                f.type === 'PRIVATE_RECORD_STATUS' &&
                f.ready === true
            ),
        {
          timeout: 60_000,
          message:
            'Published client did not reach its independent gateway; an empty fallback build cannot qualify',
        }
      )
      .toBe(true);
    proof.gatewayReadyAfterFault = true;
    const paidActive = () => {
      const active = new Set<number>();
      for (const f of paid) {
        if (f.topic !== topic) continue;
        if (f.direction === 'sent' && f.event === 'phx_join') active.add(f.socket);
        if (f.direction === 'received' && f.event === 'confirmed_leave') active.delete(f.socket);
      }
      return [...active].filter((id) => paidOpen.has(id)).length;
    };
    await expect.poll(paidActive, { timeout: 15_000 }).toBe(0);
    const paidActiveAtStart = paidActive();
    const paidWindowStart = paid.length;
    const changeOwnAvatar = async (image: string, endpoint: 'engine' | 'gateway') => {
      const from = frames.length;
      const refreshed = page.waitForResponse(
        async (response) => {
          if (!response.url().includes('/rest/v1/rpc/ca_club_member_detail') || !response.ok())
            return false;
          if (response.request().postDataJSON()?.p_user_id !== userId) return false;
          try {
            const body = await response.json();
            return (
              body?.identity?.user_id === userId && String(body.identity.avatar_url).includes(image)
            );
          } catch {
            return false;
          }
        },
        { timeout: 45_000 }
      );
      void refreshed.catch(() => {});
      await page.evaluate(
        async ({ api, key, id, email, image }) => {
          const session = JSON.parse(localStorage.getItem('smarter-poker-auth') || '{}');
          if (!session.access_token || session.user?.id !== id || session.user?.email !== email)
            throw Error('Reserved cosmetic actor changed');
          const response = await fetch(`${api}/rest/v1/profiles?id=eq.${id}`, {
            method: 'PATCH',
            headers: {
              apikey: key,
              Authorization: `Bearer ${session.access_token}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ avatar_url: image, arena_avatar_url: image }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw Error('Own reserved cosmetic update refused');
        },
        { api: API, key: KEY, id: userId, email: process.env.SP_EMAIL, image }
      );
      proof.cosmeticWrites = Number(proof.cosmeticWrites) + 1;
      await expect
        .poll(
          () =>
            frames
              .slice(from)
              .some(
                (f) =>
                  f.endpoint === endpoint &&
                  f.topic === topic &&
                  f.type === 'PRIVATE_RECORD_CHANGED'
              ),
          { timeout: 30_000 }
        )
        .toBe(true);
      await refreshed;
      await expect.poll(() => avatar.getAttribute('src'), { timeout: 45_000 }).toContain(image);
      await expect(avatar).toBeVisible();
      await expect
        .poll(
          () =>
            avatar.evaluate(
              (element) =>
                element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
            ),
          { timeout: 30_000 }
        )
        .toBe(true);
    };
    await changeOwnAvatar(selected[0], 'gateway');
    proof.gatewayRecordChanged = true;
    proof.readerReadback = true;
    proof.visibleAvatarReadback = true;
    expect(paidActive()).toBe(0);
    const paidDuringGateway = paid.slice(paidWindowStart).filter((f) => f.topic === topic);
    expect(
      paidDuringGateway.filter((f) => f.event === 'phx_join' || f.event === 'record_changed')
    ).toHaveLength(0);
    proof.paidIsolation = {
      activeAtStart: paidActiveAtStart,
      activeAtEnd: paidActive(),
      joins: paidDuringGateway.filter((f) => f.event === 'phx_join').length,
      matchingChangedFrames: paidDuringGateway.filter((f) => f.event === 'record_changed').length,
      observedFrames: paidDuringGateway.length,
    };
    const restored = frames.length;
    fault.restore();
    await expect
      .poll(
        () =>
          frames
            .slice(restored)
            .some(
              (f) =>
                f.endpoint === 'engine' &&
                f.topic === topic &&
                f.type === 'PRIVATE_RECORD_STATUS' &&
                f.ready === true
            ),
        { timeout: 60_000 }
      )
      .toBe(true);
    proof.engineReadyAfterRestore = true;
    await expect.poll(() => gatewayOpen.size, { timeout: 15_000 }).toBeGreaterThan(0);
    const gatewayOpenBeforeSecondWrite = gatewayOpen.size;
    const gatewayAfterRecovery = frames.length;
    const paidAfterRecovery = paid.length;
    await changeOwnAvatar(selected[1], 'gateway');
    proof.gatewayRecordChangedAfterRestore = true;
    proof.secondVisibleAvatarReadback = true;
    const gatewaySignals = frames
      .slice(gatewayAfterRecovery)
      .filter((f) => f.endpoint === 'gateway' && f.topic === topic);
    expect(gatewaySignals.some((frame) => frame.type === 'PRIVATE_RECORD_CHANGED')).toBe(true);
    expect(gatewayOpen.size).toBeGreaterThan(0);
    expect(paidActive()).toBe(0);
    expect(
      paid
        .slice(paidAfterRecovery)
        .filter(
          (f) => f.topic === topic && (f.event === 'phx_join' || f.event === 'record_changed')
        )
    ).toHaveLength(0);
    expect(observationsOverflow).toBe(false);
    proof.gatewayRetention = {
      openSocketsBeforeSecondWrite: gatewayOpenBeforeSecondWrite,
      openSocketsAfterSecondWrite: gatewayOpen.size,
      matchingChangesAfterRecovery: gatewaySignals.filter(
        (frame) => frame.type === 'PRIVATE_RECORD_CHANGED'
      ).length,
    };
    // The same reserved account now exercises the actual roster consumer. No second runner.
    const rosterTopic = `club-roster:${CLUB}`;
    await fault.block();
    const rosterStart = frames.length;
    await page.goto('clubs/kings-club/members?view=all', { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: 'Search Club Members' }).fill(originalProfile!.alias);
    const rosterAvatar = page
      .getByRole('listitem')
      .filter({ has: page.locator('.member-alias').filter({ hasText: originalProfile!.alias }) })
      .locator('.member-avatar img');
    await expect(rosterAvatar).toHaveCount(1, { timeout: 45_000 });
    await expect
      .poll(
        () =>
          frames
            .slice(rosterStart)
            .some((f) => f.endpoint === 'gateway' && f.topic === rosterTopic && f.ready === true),
        { timeout: 60_000 }
      )
      .toBe(true);
    const paidForTopic = (target: string) => {
      const active = new Set<number>();
      for (const f of paid) {
        if (f.topic !== target) continue;
        if (f.direction === 'sent' && f.event === 'phx_join') active.add(f.socket);
        if (f.direction === 'received' && f.event === 'confirmed_leave') active.delete(f.socket);
      }
      return [...active].filter((id) => paidOpen.has(id)).length;
    };
    await expect.poll(() => paidForTopic(rosterTopic), { timeout: 15_000 }).toBe(0);
    const changeAndRead = async (
      target: string,
      image: string,
      endpoint: 'gateway' | 'paid',
      roster: boolean
    ) => {
      const frameFrom = frames.length;
      const paidFrom = paid.length;
      const responseRead = page.waitForResponse(
        async (response) => {
          if (
            !response.ok() ||
            !response
              .url()
              .includes(`/rest/v1/rpc/${roster ? 'ca_club_members_page' : 'ca_club_member_detail'}`)
          )
            return false;
          const args = response.request().postDataJSON();
          if (args?.p_club_id !== CLUB || (!roster && args?.p_user_id !== userId)) return false;
          try {
            const body = await response.json();
            const row = roster
              ? body?.items?.find((item: any) => item.user_id === userId)
              : body?.identity;
            return row?.user_id === userId && String(row.avatar_url).includes(image);
          } catch {
            return false;
          }
        },
        { timeout: 45_000 }
      );
      void responseRead.catch(() => {});
      await page.evaluate(
        async ({ api, key, id, email, image }) => {
          const session = JSON.parse(localStorage.getItem('smarter-poker-auth') || '{}');
          if (session.user?.id !== id || session.user?.email !== email || !session.access_token)
            throw Error('Reserved cosmetic actor changed');
          const response = await fetch(`${api}/rest/v1/profiles?id=eq.${id}`, {
            method: 'PATCH',
            headers: {
              apikey: key,
              Authorization: `Bearer ${session.access_token}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ avatar_url: image, arena_avatar_url: image }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw Error('Own reserved cosmetic update refused');
        },
        { api: API, key: KEY, id: userId, email: process.env.SP_EMAIL, image }
      );
      proof.cosmeticWrites = Number(proof.cosmeticWrites) + 1;
      await expect
        .poll(
          () =>
            endpoint === 'paid'
              ? paid
                  .slice(paidFrom)
                  .some(
                    (f) =>
                      f.topic === target &&
                      f.direction === 'received' &&
                      f.event === 'record_changed'
                  )
              : frames
                  .slice(frameFrom)
                  .some(
                    (f) =>
                      f.endpoint === 'gateway' &&
                      f.topic === target &&
                      f.type === 'PRIVATE_RECORD_CHANGED'
                  ),
          { timeout: 30_000 }
        )
        .toBe(true);
      await responseRead;
      const visible = roster ? rosterAvatar : avatar;
      await expect.poll(() => visible.getAttribute('src'), { timeout: 45_000 }).toContain(image);
      await expect(visible).toBeVisible();
      await expect
        .poll(
          () =>
            visible.evaluate(
              (element) =>
                element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
            ),
          { timeout: 30_000 }
        )
        .toBe(true);
    };
    await changeAndRead(rosterTopic, selected[0], 'gateway', true);
    expect(paidForTopic(rosterTopic)).toBe(0);
    proof.rosterGatewayVerified = true;
    let bothFaultFrom = frames.length;
    const rosterPaidFrom = paid.length;
    await gatewayFault.block();
    proof.bothPreferredPathsInterrupted = true;
    await expect
      .poll(
        () =>
          paid
            .slice(rosterPaidFrom)
            .some(
              (f) =>
                f.topic === rosterTopic &&
                f.direction === 'received' &&
                f.event === 'confirmed_join'
            ),
        { timeout: 60_000 }
      )
      .toBe(true);
    bothFaultFrom = frames.length;
    await changeAndRead(rosterTopic, selected[1], 'paid', true);
    proof.rosterPaidVerified = true;
    const memberPaidFrom = paid.length;
    await page.goto(`clubs/kings-club/members/${userId}`, { waitUntil: 'domcontentloaded' });
    await expect(avatar).toHaveCount(1, { timeout: 45_000 });
    await expect
      .poll(
        () =>
          paid
            .slice(memberPaidFrom)
            .some(
              (f) => f.topic === topic && f.direction === 'received' && f.event === 'confirmed_join'
            ),
        { timeout: 60_000 }
      )
      .toBe(true);
    await changeAndRead(topic, selected[0], 'paid', false);
    proof.memberPaidVerified = true;
    expect(
      frames
        .slice(bothFaultFrom)
        .filter((f) => f.ready === true || f.type === 'PRIVATE_RECORD_CHANGED')
    ).toHaveLength(0);
    proof.paidFallback = Object.fromEntries(
      [
        ['member', topic, memberPaidFrom],
        ['roster', rosterTopic, rosterPaidFrom],
      ].map(([name, target, from]) => [
        name,
        {
          confirmedJoins: paid
            .slice(Number(from))
            .filter(
              (f) =>
                f.topic === target && f.direction === 'received' && f.event === 'confirmed_join'
            ).length,
          receivedChanges: paid
            .slice(Number(from))
            .filter(
              (f) =>
                f.topic === target && f.direction === 'received' && f.event === 'record_changed'
            ).length,
        },
      ])
    );
    const finalRecoveryFrom = frames.length;
    fault.restore();
    gatewayFault.restore();
    await expect
      .poll(
        () =>
          frames
            .slice(finalRecoveryFrom)
            .some(
              (f) => f.topic === topic && f.type === 'PRIVATE_RECORD_STATUS' && f.ready === true
            ),
        { timeout: 60_000 }
      )
      .toBe(true);
    await expect.poll(() => paidForTopic(topic), { timeout: 15_000 }).toBe(0);
    proof.preferredReadyAfterPaid = true;
    proof.observationsOverflow = observationsOverflow;
    expect(observationsOverflow).toBe(false);
    await pin();
  } finally {
    fault.restore();
    gatewayFault.restore();
    proof.faultRestored = true;
    proof.allFaultsRestored = true;
    try {
      if (originalProfile) {
        const restored = await page.evaluate(
          async ({ api, key, email, profile }) => {
            const session = JSON.parse(localStorage.getItem('smarter-poker-auth') || '{}');
            if (
              session.user?.id !== profile.id ||
              session.user?.email !== email ||
              !session.access_token
            )
              throw Error('Reserved restore actor changed');
            const headers = {
              apikey: key,
              Authorization: `Bearer ${session.access_token}`,
              'Content-Type': 'application/json',
            };
            const response = await fetch(`${api}/rest/v1/profiles?id=eq.${profile.id}`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({
                avatar_url: profile.avatar_url,
                arena_avatar_url: profile.arena_avatar_url,
              }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) throw Error('Reserved cosmetic restoration refused');
            const read = await fetch(
              `${api}/rest/v1/profiles?id=eq.${profile.id}&select=id,avatar_url,arena_avatar_url`,
              { headers, signal: AbortSignal.timeout(10_000) }
            );
            if (!read.ok) throw Error('Reserved cosmetic restoration readback refused');
            const rows = await read.json();
            return (
              rows.length === 1 &&
              rows[0].id === profile.id &&
              rows[0].avatar_url === profile.avatar_url &&
              rows[0].arena_avatar_url === profile.arena_avatar_url
            );
          },
          { api: API, key: KEY, email: process.env.SP_EMAIL, profile: originalProfile }
        );
        expect(restored).toBe(true);
        proof.cosmeticRestoreVerified = true;
      }
    } finally {
      await testInfo.attach('published-private-record-failover', {
        body: JSON.stringify(proof),
        contentType: 'application/json',
      });
    }
  }
});

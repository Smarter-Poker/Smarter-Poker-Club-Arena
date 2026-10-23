/** Production UI proof using only the assignment job's existing reserved identities. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';

const PRODUCTION_BASE = 'https://smarter.poker/hub/club-arena/';
const CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
export function validateAssignmentBrowserIdentity(account, session, clubId) {
  assert.match(account?.id || '', /^[a-f0-9-]{36}$/);
  assert.equal(clubId, CLUB, 'Only the existing certification club is permitted');
  assert.match(account?.email || '', /^ca-customization-cert-postdeploy-.+@example\.invalid$/);
  assert.equal(
    session?.user?.id,
    account.id,
    'Browser session must belong to the exact reserved account'
  );
  assert.equal(
    session?.user?.email,
    account.email,
    'Browser session email must match the reserved account'
  );
  assert.ok(
    session?.access_token && session?.refresh_token,
    'Browser requires the complete real GoTrue session'
  );
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // The proof may fail before the consumer gets to this promise.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded(promise, description, timeout = 45_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function wireFrame(frame) {
  try {
    const raw = JSON.parse(
      typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
    );
    return Array.isArray(raw) ? { topic: raw[2], event: raw[3], payload: raw[4] } : raw;
  } catch {
    return null;
  }
}

export async function startAssignmentBrowserProof({
  account,
  session,
  clubId,
  playerId,
  playerAlias,
  evidenceDir,
}) {
  validateAssignmentBrowserIdentity(account, session, clubId);
  assert.ok(
    typeof playerAlias === 'string' && playerAlias.trim(),
    'The actual roster alias is required'
  );
  assert.match(playerId, /^[a-f0-9-]{36}$/);
  assert.ok(evidenceDir);
  const { chromium } = await import('playwright');
  // These are the maintained server-backed first-run gates, not DOM bypasses.
  // The owning workflow uses Node20. Compile the existing type-only TS gate
  // modules in memory with the repository's locked esbuild; never copy their logic.
  const { transform } = await import('esbuild');
  async function gate(name) {
    const source = await readFile(
      new URL(`../../tests/e2e/support/${name}.ts`, import.meta.url),
      'utf8'
    );
    const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node20' });
    return (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')))[
      name
    ];
  }
  const ensureAcceptedTerms = await gate('ensureAcceptedTerms');
  const ensurePlayableProfile = await gate('ensurePlayableProfile');
  await mkdir(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const contexts = [];
  const base = new URL(PRODUCTION_BASE);
  async function open(viewer, viewerSession) {
    validateAssignmentBrowserIdentity(viewer, viewerSession, clubId);
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      storageState: {
        cookies: [],
        origins: [
          {
            origin: base.origin,
            localStorage: [
              { name: 'smarter-poker-auth', value: JSON.stringify(viewerSession) },
              { name: 'club_arena_welcome_accepted', value: 'true' },
              { name: `sp_firstrun_notif_v2_${viewer.id}`, value: String(Date.now()) },
            ],
          },
        ],
      },
    });
    contexts.push(context);
    return { context, page: await context.newPage() };
  }
  try {
    const { page } = await open(account, session);
    let joined = deferred();
    const scopeChanged = deferred(),
      rosterChanged = deferred();
    let scopeSeen = false,
      armed = false,
      navigationCount = 0;
    const requestsAfterScope = new WeakSet();
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        navigationCount++;
        joined = deferred();
      }
    });
    page.on('websocket', (socket) =>
      socket.on('framereceived', (frame) => {
        const message = wireFrame(frame);
        if (!String(message?.topic || '').endsWith(`profile-account:${account.id}`)) return;
        if (message.event === 'phx_reply' && message.payload?.status === 'ok') joined.resolve();
        const payload = message.payload?.payload;
        if (
          armed &&
          message.event === 'broadcast' &&
          message.payload?.event === 'account_changed' &&
          payload?.user_id === account.id &&
          payload?.club_id === clubId &&
          payload?.reason === 'member_scope_changed'
        ) {
          scopeSeen = true;
          scopeChanged.resolve();
        }
      })
    );
    page.on('request', (request) => {
      if (
        scopeSeen &&
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith('/rpc/ca_club_members_page')
      )
        requestsAfterScope.add(request);
    });
    page.on('response', (response) => {
      if (!requestsAfterScope.has(response.request())) return;
      void (async () => {
        assert.ok(response.ok(), `Post-event roster read failed (${response.status()})`);
        const result = await response.json();
        assert.ok(Array.isArray(result.items), 'Post-event roster returned no verified items');
        assert.ok(
          result.items.every((row) => row.user_id !== playerId),
          'Transferred player remained in the old agent server response'
        );
        rosterChanged.resolve();
      })().catch(rosterChanged.reject);
    });
    await page.goto(new URL(`clubs/${clubId}/members`, base).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await ensureAcceptedTerms(page);
    await ensurePlayableProfile(page);
    const row = page.getByRole('button', { name: new RegExp(`^Open ${escaped(playerAlias)}, `) });
    await row.waitFor({ state: 'visible', timeout: 60_000 });
    await bounded(joined.promise, 'The old agent never joined its owned private account channel');
    const initialNavigation = navigationCount;
    await page.screenshot({
      path: join(evidenceDir, 'agent-transfer-source-before.png'),
      fullPage: true,
    });
    armed = true;
    return {
      async saveFromPlayerRecord(actor, actorSession, destinationId, beforeWrite) {
        assert.match(destinationId, /^[a-f0-9-]{36}$/);
        const { page: actorPage } = await open(actor, actorSession);
        await actorPage.goto(new URL(`clubs/${clubId}/members/${playerId}`, base).toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        await ensureAcceptedTerms(actorPage);
        await ensurePlayableProfile(actorPage);
        const control = actorPage.getByLabel('Assign To Agent', { exact: true });
        const select = control.getByLabel('Destination Agent', { exact: true });
        await select.selectOption(destinationId, { timeout: 60_000 });
        assert.equal(await control.getByRole('button', { name: /Review|Confirm Move/ }).count(), 0);
        await actorPage.screenshot({
          path: join(evidenceDir, 'player-agent-save-before.png'),
          fullPage: true,
        });
        let applied;
        // Record the actual UI-owned request before forwarding it. Never replace
        // the operation id or manufacture the response returned by production.
        await actorPage.route('**/rest/v1/rpc/fn_apply_reviewed_club_assignment', async (route) => {
          const body = route.request().postDataJSON();
          assert.equal(body.p_club_id, clubId);
          assert.deepEqual(body.p_member_user_ids, [playerId]);
          assert.equal(body.p_agent_user_id, destinationId);
          assert.match(body.p_op_id, /^[a-f0-9-]{36}$/);
          assert.match(body.p_review_token, /^[a-f0-9]{32}$/);
          assert.equal(applied, undefined, 'Save issued more than one assignment write');
          applied = body;
          await beforeWrite(body);
          await route.continue();
        });
        const response = actorPage.waitForResponse(
          (response) =>
            response.url().endsWith('/rpc/fn_apply_reviewed_club_assignment') &&
            response.request().method() === 'POST',
          { timeout: 45_000 }
        );
        // A missing button must still let the owning fixture cleanup finish.
        response.catch(() => {});
        await control.getByRole('button', { name: 'Save', exact: true }).click();
        const result = await response;
        assert.ok(result.ok(), `Save refused (${result.status()})`);
        const receipt = await result.json();
        assert.equal(receipt.success, true);
        assert.equal(receipt.operation_id, applied.p_op_id);
        assert.equal(receipt.moved, 1);
        // The saved agent disappears from destinations once the upline re-reads.
        await actorPage.waitForFunction(
          (id) => {
            const select = document.querySelector('#mm-assign-target');
            return (
              select &&
              !select.disabled &&
              select.value === '' &&
              !select.querySelector(`option[value="${id}"]`)
            );
          },
          destinationId,
          { timeout: 30_000 }
        );
        await actorPage.screenshot({
          path: join(evidenceDir, 'player-agent-save-after.png'),
          fullPage: true,
        });
        return applied;
      },
      async verifyAfterTransfer() {
        await bounded(
          scopeChanged.promise,
          'The old agent received no matching private scope broadcast'
        );
        await bounded(
          rosterChanged.promise,
          'The open roster did not request a new authorized page after the scope event'
        );
        await page
          .getByRole('list', { name: 'Club Member Directory' })
          .waitFor({ state: 'visible', timeout: 30_000 });
        await row.waitFor({ state: 'hidden', timeout: 30_000 });
        assert.equal(
          navigationCount,
          initialNavigation,
          'Open-screen proof navigated or reloaded after the transfer'
        );
        await page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="Club Member Directory"]')
              ?.getAttribute('aria-busy') === 'false',
          undefined,
          { timeout: 30_000 }
        );
        await page.screenshot({
          path: join(evidenceDir, 'agent-transfer-source-after.png'),
          fullPage: true,
        });
        // The direct finance route must render its actual capability refusal.
        await page.goto(new URL(`clubs/${clubId}/finance`, base).toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        await page
          .getByText('This Tool Is Restricted', { exact: true })
          .waitFor({ state: 'visible', timeout: 30_000 });
        await page
          .getByText(/Your Current Club Role Does Not Include Finance Access/i)
          .waitFor({ state: 'visible', timeout: 30_000 });
        await page.screenshot({
          path: join(evidenceDir, 'agent-transfer-bank-denied.png'),
          fullPage: true,
        });
      },
      async verifyDestination(destination, destinationSession) {
        const { page: destinationPage } = await open(destination, destinationSession);
        await destinationPage.goto(new URL(`clubs/${clubId}/members`, base).toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        await ensureAcceptedTerms(destinationPage);
        await ensurePlayableProfile(destinationPage);
        await destinationPage
          .getByRole('button', { name: new RegExp(`^Open ${escaped(playerAlias)}, `) })
          .waitFor({ state: 'visible', timeout: 60_000 });
        await destinationPage.screenshot({
          path: join(evidenceDir, 'agent-transfer-destination-after.png'),
          fullPage: true,
        });
      },
      async close() {
        await Promise.allSettled(contexts.map((context) => context.close()));
        await browser.close();
      },
    };
  } catch (error) {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await browser.close();
    throw error;
  }
}

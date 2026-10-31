import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyBrowserActionHistory } from './component-observation-protocol.mjs';
import { createObservationClient } from './component-observation-client.mjs';
import { prepareOracleHome } from './component-semantic-home.mjs';
import { waitForExactEngineReady } from './component-semantic-readiness.mjs';
import { browserStorage } from '../fixture/auth-fixture.mjs';
import { financialActorDescriptor } from '../fixture/runtime-files.mjs';
import { requireSchemaSourceContract } from './component-source-contract.mjs';
import {
  installNaturalMultiRunWitness,
  completedNaturalRuns,
  naturalMultiRunTiming,
  naturalMultiRunEngineIdentity,
} from '../../../tests/e2e/support/naturalMultiRunMobile.ts';

export const ritPlayerUICases = Object.freeze([
  'exact-schema-and-stable-component-identities',
  'browser-raise-call-allin-fold-saved-once',
  'actual-three-run-choice-and-acceptance',
  'three-board-winning-card-timing-and-chip-landings',
  'settled-choice-clearing-and-cold-reload',
]);

const BASE = 'https://smarter.poker/hub/club-arena/';
const sorted = (values) => [...values].sort();

/** Only public key names identify the fixture project; owner session values
 * are never inspected or copied into a played actor's browser. */
export function ritActorBrowserStorage(fixture, user, now = Date.now()) {
  const origins = fixture.storage_state?.origins;
  assert.ok(Array.isArray(origins) && origins.length === 1);
  assert.equal(origins[0].origin, 'https://smarter.poker');
  const namespaces = origins[0].localStorage
    .map(({ name }) => /^sb-([a-z0-9]{20})-auth-token$/.exec(name)?.[1])
    .filter(Boolean);
  assert.equal(namespaces.length, 1, 'RIT_PUBLIC_PROJECT_NAMESPACE_REQUIRED');
  assert.match(user.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(user.session.user.id, user.id);
  const token = user.session.access_token;
  assert.equal(typeof token, 'string');
  assert.equal(token.split('.').length, 3);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims.sub, user.id);
  assert.equal(claims.role, 'authenticated');
  const seconds = Math.floor(now / 1000);
  assert.ok(Number.isSafeInteger(seconds));
  assert.ok(Number.isSafeInteger(claims.exp) && claims.exp > seconds);
  return browserStorage(
    {
      access_token: token,
      user: { id: user.id },
      token_type: 'bearer',
      expires_at: claims.exp,
      expires_in: claims.exp - seconds,
      refresh_token: '',
    },
    `${namespaces[0]}.supabase.co`
  );
}

/** Validate genuine wire observations before discarding cards and private state.
 * Missing, replayed, different-hand and mandatory results cannot pass this UI
 * consent proof. The existing presentation helpers own all timing bounds.
 */
export function verifyRitPlayerEvidence({
  tableId,
  actorIds,
  offer,
  decision,
  accepted,
  result,
  witness,
}) {
  assert.equal(offer.table_id, tableId);
  assert.equal(offer.maxRuns, 3);
  assert.deepEqual(sorted(offer.allPlayerIds), sorted(actorIds));
  assert.ok(actorIds.includes(offer.chooserPlayerId));
  assert.equal(typeof offer.offer_id, 'string');
  assert.ok(offer.offer_id.length > 0);
  assert.ok(Number.isSafeInteger(offer.hand_number));
  for (const event of [offer, decision, accepted, result]) {
    assert.notEqual(event.replayed, true);
    assert.equal(event.table_id, tableId);
    assert.equal(event.hand_number, offer.hand_number);
    assert.equal(event.offer_id, offer.offer_id);
  }
  assert.equal(decision.type, 'rit_chooser_decided');
  assert.equal(decision.actor, offer.chooserPlayerId);
  assert.equal(decision.requested_runs, 3);
  assert.equal(decision.chosenRuns, 3);
  assert.equal(accepted.type, 'rit_all_accepted');
  assert.equal(accepted.runs, 3);
  assert.equal(accepted.agreed_runs, 3);
  assert.deepEqual(sorted(accepted.accepted_ids), sorted(actorIds));
  assert.equal(result.type, 'rit_result');
  assert.equal(result.runs, 3);
  assert.equal(result.agreed_runs, 3);
  assert.equal(result.runs_dealt, 3);
  assert.equal(result.outcome_reason, 'all_accepted');
  assert.equal(result.chooser_id, offer.chooserPlayerId);
  assert.equal(result.boards.length, 3);
  assert.ok(result.boards.every((board) => board.length === 5));
  const packet = {
    hand: result.hand_number,
    runs: 3,
    at: result.receivedAt,
    recipients: Object.entries(result.distribution)
      .filter(([, amount]) => Number(amount) > 0)
      .map(([id]) => id),
  };
  assert.ok(packet.recipients.every((id) => actorIds.includes(id)));
  assert.deepEqual(witness.violations, []);
  assert.equal(witness.visibility.hiddenSamples, 0);
  assert.ok(witness.visibility.visibleSamples > 0);
  assert.equal(completedNaturalRuns([packet], witness).length, 1);
  const timing = naturalMultiRunTiming(packet, witness);
  assert.equal(timing.ready, true);
  assert.deepEqual(timing.violations, []);
  return {
    table_id: tableId,
    hand: packet.hand,
    runs: 3,
    offer_id: offer.offer_id,
    chooser_id: offer.chooserPlayerId,
    actor_ids: [...actorIds],
    capability: {
      maxRuns: offer.maxRuns,
      requested_runs: decision.requested_runs,
      accepted_ids: [...accepted.accepted_ids],
      agreed_runs: result.agreed_runs,
      runs_dealt: result.runs_dealt,
      outcome_reason: result.outcome_reason,
    },
    timing,
    witness,
  };
}

export function verifyRitIdentity(before, after) {
  assert.deepEqual(after.clients, before.clients);
  assert.equal(after.engine.releaseSha, before.engine.releaseSha);
  assert.equal(after.engine.instanceId, before.engine.instanceId);
  assert.equal(typeof before.engine.instanceId, 'string');
  assert.ok(before.engine.instanceId.length > 0);
  assert.ok(Number.isFinite(before.engine.uptime) && before.engine.uptime >= 0);
  assert.ok(Number.isFinite(after.engine.uptime) && after.engine.uptime >= before.engine.uptime);
}

export function isRitActorTurn(live, captured, userId) {
  const player = live?.players?.find((p) => p.user_id === userId);
  return (
    !!captured &&
    Number.isSafeInteger(captured.hand_number) &&
    captured.hand_number > 0 &&
    Number.isFinite(captured.turn_start_time_ms) &&
    captured.turn_start_time_ms > 0 &&
    live?.hand_number === captured.hand_number &&
    live?.turn_start_time_ms === captured.turn_start_time_ms &&
    live?.current_player === userId &&
    !!player &&
    player.stack > 0 &&
    !player.is_folded &&
    !player.is_all_in
  );
}

/** Existing outer qualifier supplies an INTERNAL-network Chromium and full
 * admitted schema. No account creation, API playing input, deck control, clock
 * advancement or production fallback is implemented here. The financial
 * scenario already disables autonomous actors; these pages are the sole input.
 */
// One real heads-up hand: small blind raises/calls through preflop, big blind
// shoves the flop and the other player explicitly folds. The engine owns every
// turn, card, amount validation, settlement and durable history write.
async function proveFourBrowserActions({ actors, tableId, observations, deadline }) {
  const actions = [],
    requests = [],
    listeners = [];
  const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
  let handNumber;
  let inputFailure = false;
  const events = () =>
    actors[0].wire.readActions({ tableId, handNumber }).map((e) => ({
      type: 'player_action',
      table_id: e.tableId,
      hand_number: e.hand_number,
      user_id: e.user_id,
      action: e.action,
      amount: e.amount,
      seat: e.seat,
      stage: e.stage,
      replayed: e.replayed,
    }));
  const spent = new Set();
  for (const actor of actors) {
    const receive = (request) => {
      const url = new URL(request.url());
      if (
        request.method() === 'POST' &&
        url.hostname === 'engine.smarter.poker' &&
        url.pathname === '/action'
      ) {
        try {
          const body = request.postDataJSON();
          if (requests.length >= 4) inputFailure = true;
          if (requests.length < 5) requests.push({ actor: actor.user.id, body });
        } catch {
          inputFailure = true;
        }
      }
    };
    actor.page.on('request', receive);
    listeners.push([actor.page, receive]);
  }
  try {
    for (const action of ['raise', 'call', 'all_in', 'fold']) {
      assert.equal(inputFailure, false, 'BROWSER_ACTION_REQUEST_UNKNOWN_OR_REPLAYED');
      let actor, state, player;
      while (Date.now() < deadline) {
        for (const a of actors) {
          const s = a.wire.state(tableId),
            p = s?.players?.find((p) => p.user_id === a.user.id);
          if (
            !s ||
            !p ||
            s.current_player !== a.user.id ||
            p.is_folded ||
            p.is_all_in ||
            p.stack <= 0 ||
            spent.has(s.action_context)
          )
            continue;
          if (handNumber === undefined) {
            if (s.stage !== 'preflop') continue;
            handNumber = s.hand_number;
          }
          assert.equal(s.hand_number, handNumber, 'BROWSER_ACTION_HAND_CHANGED');
          if (s.stage !== (actions.length < 2 ? 'preflop' : 'flop')) continue;
          actor = a;
          state = s;
          player = p;
          break;
        }
        if (actor) break;
        await pause();
      }
      assert.ok(actor, 'BROWSER_ACTION_CURRENT_TURN_REQUIRED');
      const current = () => {
        const s = actor.wire.state(tableId);
        return (
          s?.hand_number === handNumber &&
          s.current_player === actor.user.id &&
          s.action_context === state.action_context &&
          s.turn_start_time_ms === state.turn_start_time_ms
        );
      };
      await actor.page.bringToFront();
      const click = async (selector) => {
        const control = actor.page.locator(`.action-panel ${selector}`);
        await control.waitFor({ state: 'visible', timeout: 3000 });
        assert.ok(await control.isEnabled());
        assert.ok(current(), 'BROWSER_ACTION_STALE_TURN');
        await control.click({ timeout: 3000 });
      };
      if (action === 'raise') await click('.action-btn--raise');
      if (
        action === 'all_in' &&
        !(await actor.page.locator('.action-panel .action-btn--allin').isVisible())
      )
        await click('.action-btn--raise');
      const selector =
        action === 'raise'
          ? '.raise-confirm'
          : action === 'all_in'
            ? (await actor.page.locator('.action-panel .action-btn--allin').isVisible())
              ? '.action-btn--allin'
              : '.raise-preset--allin'
            : `.action-btn--${action}`;
      const responsePromise = actor.page
        .waitForResponse(
          (response) => {
            const request = response.request(),
              url = new URL(response.url());
            return (
              request.method() === 'POST' &&
              url.hostname === 'engine.smarter.poker' &&
              url.pathname === '/action'
            );
          },
          { timeout: 10000 }
        )
        .then(
          (value) => ({ value }),
          () => ({ error: true })
        );
      await click(selector);
      const responseResult = await responsePromise;
      assert.ok(responseResult.value, 'BROWSER_ACTION_HTTP_OUTCOME_UNKNOWN');
      const response = responseResult.value,
        body = response.request().postDataJSON();
      assert.equal(body.tableId, tableId);
      assert.equal(body.action, action);
      assert.equal(body.actionContext, state.action_context);
      assert.equal(response.status(), 200);
      const reply = await response.json();
      assert.equal(reply.success, true);
      const matching = requests.filter(
        (r) => r.actor === actor.user.id && r.body.idempotencyKey === body.idempotencyKey
      );
      assert.equal(matching.length, 1);
      const amount =
        action === 'raise'
          ? body.amount
          : action === 'call'
            ? state.current_bet - player.bet
            : action === 'all_in'
              ? player.stack + player.bet
              : 0;
      spent.add(state.action_context);
      actions.push({
        action,
        table_id: tableId,
        user_id: actor.user.id,
        seat: player.seat,
        hand_number: handNumber,
        street: state.stage,
        amount,
        before_stack: player.stack,
        before_bet: player.bet,
        before_current_bet: state.current_bet,
        action_context: body.actionContext,
        idempotency_key: body.idempotencyKey,
        status: response.status(),
        success: reply.success,
        requests: matching.length,
      });
      while (
        !events().some(
          (e) =>
            e.type === 'player_action' &&
            e.hand_number === handNumber &&
            e.user_id === actor.user.id &&
            e.action === action
        )
      ) {
        assert.ok(Date.now() < deadline, 'BROWSER_ACTION_EVENT_MISSING');
        await pause();
      }
    }
    let next;
    while (Date.now() < deadline) {
      next = actors.map((a) => a.wire.state(tableId)?.hand_number).find((n) => n > handNumber);
      if (next) break;
      await pause();
    }
    assert.ok(next, 'BROWSER_ACTION_HAND_NOT_COMPLETED');
    assert.equal(inputFailure, false, 'BROWSER_ACTION_REQUEST_UNKNOWN_OR_REPLAYED');
    assert.equal(requests.length, 4, 'BROWSER_ACTION_EXTRA_OR_REPLAYED_REQUEST');
    const hand = { hand_number: handNumber, next_hand_number: next };
    const until = Math.min(deadline, Date.now() + 15000);
    while (!(await observations.handPresence(hand)).count) {
      assert.ok(Date.now() < until, 'BROWSER_ACTION_HISTORY_NOT_SAVED');
      await pause();
    }
    return verifyBrowserActionHistory({
      tableId,
      hand,
      facts: await observations.handFacts(hand),
      actions,
      events: events(),
    });
  } finally {
    for (const [page, listener] of listeners) page.off('request', listener);
  }
}

export async function qualifyRitPlayerUI({
  tuple,
  schema,
  runtimeImage,
  control,
  fixture,
  observations,
  browser,
}) {
  requireSchemaSourceContract(fixture.source_contract);
  assert.equal(fixture.version, 1);
  assert.equal(fixture.scope, 'isolated-club-arena-fixture');
  assert.equal(fixture.base_url, BASE);
  assert.equal(fixture.engine_health_url, 'https://engine.smarter.poker/health');
  assert.equal(observations.binding.control_sha, control.control_sha);
  assert.equal(observations.binding.table_id, fixture.table_id);
  assert.equal(observations.binding.spectator_user_id, fixture.spectator_user_id);
  const scenario = fixture.financial_scenario;
  assert.deepEqual(
    scenario,
    financialActorDescriptor(
      {
        club_id: scenario?.club_id,
        table_id: fixture.table_id,
        actor_user_ids: scenario?.users?.map((u) => u.id),
      },
      scenario?.users
    )
  );
  const actorIds = scenario.users.map((u) => u.id);
  assert.ok(!actorIds.includes(fixture.spectator_user_id));
  const { EngineSocketJournal } = await import('../../../tests/e2e/support/liveTableRealtime.ts');
  // Shared browser controls are maintained with the tournament UI qualifier.
  const { submitLegalAllInThroughUI } =
    await import('../fixture/representative/player-browser-input.mjs');
  const { collectPlayerUIWire } =
    await import('../fixture/representative/tournament-player-ui-wire.mjs');
  const catalogue = async () =>
    assert.equal((await observations.catalogue()).catalogue_digest, schema.catalogue_digest);
  await catalogue();
  const contexts = [],
    wires = [];
  let pageFailed = false,
    proof,
    before,
    after,
    inputFailed = false,
    engineReadiness;
  const inputReplies = new Set(),
    outstandingInputs = new Set();
  const wait = () => new Promise((resolve) => setTimeout(resolve, 50));
  try {
    const observerContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 375, height: 812 },
      storageState: fixture.storage_state,
    });
    contexts.push(observerContext);
    engineReadiness = await waitForExactEngineReady({
      request: observerContext.request,
      healthUrl: fixture.engine_health_url,
      sourceSha: tuple['club-arena-engine'].source_sha,
    });
    const identity = async () => {
      const clients = [];
      for (const origin of ['https://ca-static.smarter.poker/', BASE]) {
        const response = await observerContext.request.get(`${origin}build-info.json`, {
          timeout: 10000,
        });
        assert.equal(response.status(), 200);
        const sha = (await response.json()).ca_sha;
        assert.equal(sha, tuple['club-arena-web'].source_sha);
        clients.push(sha);
      }
      const response = await observerContext.request.get(fixture.engine_health_url, {
        timeout: 10000,
      });
      assert.equal(response.status(), 200);
      const h = await response.json();
      naturalMultiRunEngineIdentity(h, tuple['club-arena-engine'].source_sha);
      assert.equal(h.running, true);
      return {
        clients,
        engine: { releaseSha: h.releaseSha, instanceId: h.instanceId, uptime: h.uptime },
      };
    };
    before = await identity();
    verifyRitIdentity(before, before);
    const actors = [];
    for (const user of scenario.users) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        storageState: ritActorBrowserStorage(fixture, user),
      });
      contexts.push(context);
      const actorPage = await context.newPage(),
        wire = collectPlayerUIWire(actorPage, user.id);
      wires.push(wire);
      actorPage.on('pageerror', () => {
        pageFailed = true;
      });
      actorPage.on('request', (request) => {
        const url = new URL(request.url());
        if (
          request.method() === 'POST' &&
          url.hostname === 'engine.smarter.poker' &&
          ['/action', '/rit'].includes(url.pathname)
        ) {
          outstandingInputs.add(request);
          if (outstandingInputs.size > 8) inputFailed = true;
        }
      });
      actorPage.on('response', (response) => {
        const request = response.request(),
          url = new URL(response.url());
        if (
          request.method() !== 'POST' ||
          url.hostname !== 'engine.smarter.poker' ||
          !['/action', '/rit'].includes(url.pathname)
        )
          return;
        const pending = (async () => {
          assert.equal(response.status(), 200, 'RIT_UI_INPUT_REFUSED');
          assert.equal((await response.json()).success, true, 'RIT_UI_INPUT_UNKNOWN');
        })()
          .catch(() => {
            inputFailed = true;
          })
          .finally(() => {
            outstandingInputs.delete(request);
            inputReplies.delete(pending);
          });
        inputReplies.add(pending);
      });
      actorPage.on('requestfailed', (request) => {
        const url = new URL(request.url());
        if (
          request.method() === 'POST' &&
          url.hostname === 'engine.smarter.poker' &&
          ['/action', '/rit'].includes(url.pathname)
        ) {
          outstandingInputs.delete(request);
          inputFailed = true;
        }
      });
      await actorPage.goto(`${BASE}table/${fixture.table_id}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      actors.push({ user, page: actorPage, wire });
    }
    const deadline = Date.now() + 210000;
    const actionHistory = await proveFourBrowserActions({
      actors,
      tableId: fixture.table_id,
      observations,
      deadline,
    });
    // Arm the RIT timing witness only after this separate ordinary hand. Actor
    // foreground input cannot become hidden samples in the later RIT witness.
    // Open and foreground the observer LAST. Actor setup must not contribute
    // hidden samples to the actual presentation witness.
    const page = await observerContext.newPage();
    await installNaturalMultiRunWitness(page);
    const journal = new EngineSocketJournal(page);
    page.on('pageerror', () => {
      pageFailed = true;
    });
    await page.bringToFront();
    await page.goto(`${BASE}table/${fixture.table_id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const acted = new Set(),
      consented = new Set();
    let offer, decision, accepted, result;
    const events = () =>
      journal
        .matchingFrames({ direction: 'received', tableId: fixture.table_id, type: 'EVENT' })
        .map((f) => ({ ...f.message.payload, receivedAt: f.at }));
    while (Date.now() < deadline && !proof) {
      assert.equal(pageFailed, false, 'RIT_UI_BROWSER_EXCEPTION');
      assert.equal(inputFailed, false, 'RIT_UI_INPUT_REFUSED_OR_UNKNOWN');
      await page.bringToFront();
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
      const actual = events();
      offer ??= actual.find((e) => e.type === 'rit_offer' && e.replayed !== true);
      if (offer) {
        assert.equal(offer.maxRuns, 3, 'RIT_UI_THREE_RUN_CAPABILITY_MISSING');
        assert.deepEqual(sorted(offer.allPlayerIds), sorted(actorIds));
        decision ??= actual.find(
          (e) => e.type === 'rit_chooser_decided' && e.offer_id === offer.offer_id
        );
        accepted ??= actual.find(
          (e) => e.type === 'rit_all_accepted' && e.offer_id === offer.offer_id
        );
        result ??= actual.find((e) => e.type === 'rit_result' && e.offer_id === offer.offer_id);
        for (const actor of actors) {
          if (consented.has(actor.user.id)) continue;
          // A visible responder button does not acknowledge the chosen count.
          if (actor.user.id !== offer.chooserPlayerId) {
            if (!decision) continue;
            assert.equal(decision.table_id, fixture.table_id);
            assert.equal(decision.hand_number, offer.hand_number);
            assert.equal(decision.actor, offer.chooserPlayerId);
            assert.equal(decision.requested_runs, 3);
            assert.equal(decision.chosenRuns, 3);
          }
          const dialog = actor.page.getByRole('dialog', {
            name: 'Run It Multiple Times',
            exact: true,
          });
          const button = dialog.getByRole('button', {
            name: actor.user.id === offer.chooserPlayerId ? 'Run It 3 Times' : 'Accept',
            exact: true,
          });
          if ((await button.isVisible()) && (await button.isEnabled())) {
            await button.click({ timeout: 3000 });
            consented.add(actor.user.id);
          }
        }
      } else {
        for (const actor of actors) {
          const state = actor.wire.state(fixture.table_id);
          const current = () =>
            isRitActorTurn(actor.wire.state(fixture.table_id), state, actor.user.id);
          if (!state || !current()) continue;
          const turn = `${state.hand_number}:${state.turn_start_time_ms}:${actor.user.id}`;
          if (acted.has(turn)) continue;
          if (await submitLegalAllInThroughUI({ page: actor.page, isCurrentTurn: current }))
            acted.add(turn);
        }
      }
      if (result && decision && accepted && consented.size === 2) {
        await page.bringToFront();
        assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
        const witness = await page.evaluate(() => window.__naturalMultiRunWitness.read());
        const packet = {
          hand: result.hand_number,
          runs: 3,
          at: result.receivedAt,
          recipients: Object.entries(result.distribution)
            .filter(([, n]) => Number(n) > 0)
            .map(([id]) => id),
        };
        if (
          completedNaturalRuns([packet], witness).length &&
          naturalMultiRunTiming(packet, witness).ready
        )
          proof = verifyRitPlayerEvidence({
            tableId: fixture.table_id,
            actorIds,
            offer,
            decision,
            accepted,
            result,
            witness,
          });
      }
      await wait();
    }
    assert.ok(proof, 'RIT_UI_ACTUAL_THREE_RUN_TIMING_NOT_OBSERVED');
    // The unchanged timing helper already proved the full result ended and
    // every winner's chips landed. A busted actor need not rebuy to certify it.
    assert.equal(await page.locator('.rit-felt-banner').count(), 0);
    const oldSocket = journal
      .matchingFrames({ direction: 'received', tableId: fixture.table_id, type: 'SNAPSHOT' })
      .at(-1)?.socketId;
    assert.ok(oldSocket);
    const reloadAt = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const reloaded = await journal.waitForFrame(
      { direction: 'received', tableId: fixture.table_id, type: 'SNAPSHOT', since: reloadAt },
      15000,
      'RIT_UI_RELOAD_SNAPSHOT_MISSING'
    );
    assert.notEqual(reloaded.socketId, oldSocket);
    assert.equal(await page.getByTestId('table-connection-banner').isVisible(), false);
    assert.equal(await page.locator('.rit-felt-banner').count(), 0);
    assert.equal(pageFailed, false);
    await Promise.all(inputReplies);
    assert.equal(outstandingInputs.size, 0, 'RIT_UI_INPUT_STILL_UNKNOWN');
    assert.equal(inputFailed, false, 'RIT_UI_INPUT_REFUSED_OR_UNKNOWN');
    after = await identity();
    verifyRitIdentity(before, after);
    await catalogue();
    await page.evaluate(() => window.__naturalMultiRunWitness.stop());
  } finally {
    for (const wire of wires) wire.close();
    const closed = await Promise.allSettled(contexts.map((context) => context.close()));
    assert.ok(
      closed.every((r) => r.status === 'fulfilled'),
      'RIT_UI_CONTEXT_CLEANUP_INCOMPLETE'
    );
  }
  return {
    version: 1,
    scope: 'isolated-rit-player-ui-observations',
    product_certificate: false,
    tuple,
    runtime_image: runtimeImage,
    schema_fixture_sha256: schema.fixture_sha256,
    schema_catalogue_digest: schema.catalogue_digest,
    success: true,
    executed: ritPlayerUICases.length,
    failed: 0,
    skipped: 0,
    retries: 0,
    engine_readiness: engineReadiness,
    cases: ritPlayerUICases.map((name) => ({ name, passed: true })),
    proof: {
      ...proof,
      actionHistory,
      browser: 'chromium',
      viewport: { width: 375, height: 812 },
      before,
      after,
    },
    cleanup: { complete: false, owner: 'outer-native-driver' },
  };
}

if (process.argv[1]?.endsWith('/rit-player-ui-suite.mjs')) {
  let observations, browser;
  try {
    assert.equal(process.env.HOME, '/tmp/qualification');
    assert.equal(process.env.TMPDIR, '/tmp');
    assert.equal(process.env.XDG_CACHE_HOME, '/tmp/qualification/cache');
    await prepareOracleHome();
    const plan = JSON.parse(await readFile('/inputs/plan.json', 'utf8'));
    const fixture = JSON.parse(
      await readFile('/run/club-arena-qualification/fixture.json', 'utf8')
    );
    const control = JSON.parse(await readFile('/inputs/observation-control.json', 'utf8'));
    observations = createObservationClient(fixture.observation_bridge, control);
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const result = await qualifyRitPlayerUI({
      tuple: plan.tuples[Number(process.argv[2])],
      schema: plan.schema,
      runtimeImage: process.argv[3],
      control,
      fixture,
      observations,
      browser,
    });
    // The controller joins actual outer cleanup before accepting this marker.
    await browser.close();
    browser = null;
    observations.close();
    observations = null;
    process.stdout.write(`RIT_PLAYER_UI_RESULT:${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('RELEASE_RIT_PLAYER_UI_FAILED\n');
    process.exitCode = 1;
  } finally {
    await browser?.close();
    observations?.close();
  }
}

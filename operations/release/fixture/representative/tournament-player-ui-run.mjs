import assert from 'node:assert/strict';
import { browserStorage } from '../auth-fixture.mjs';
import { collectPlayerUIWire } from './tournament-player-ui-wire.mjs';
import {
  playerUIRun,
  provePreActionThroughUI,
  provePaidRebuyThroughUI,
  proveFinishReportThroughUI,
} from './tournament-player-ui.mjs';

const BASE = 'https://smarter.poker/hub/club-arena/';
const terminal = (status) =>
  ['COMPLETED', 'FINISHED', 'ENDED'].includes(String(status).toUpperCase());

/** One foreground run on already canonically funded isolated cohorts. Every
 * playing input is an actual button click in that actor's authenticated page.
 * The existing outer native driver owns browser/process/network cleanup.
 * Contexts and private socket evidence are always closed here, also on error.
 */
export async function runTournamentPlayerUI({ browser, ingress, observations }) {
  const run = playerUIRun(ingress),
    deadline = Date.now() + 230000,
    contexts = [],
    wires = [];
  let pageFailed = false;
  assert.match(ingress.supabase_host, /^[a-z0-9]{20}\.supabase\.co$/);
  const wait = async (ms) =>
    new Promise((resolve) => setTimeout(resolve, Math.min(ms, Math.max(1, deadline - Date.now()))));
  try {
    for (let ci = 0; ci < ingress.cohorts.length; ci++) {
      const cohort = ingress.cohorts[ci],
        actors = [],
        acted = new Set();
      const native = async ({ tournamentId, userId, token }) => {
        assert.equal(tournamentId, cohort.tournament_id);
        const ai = cohort.users.findIndex((u) => u.id === userId);
        assert.ok(ai >= 0);
        const facts = await observations.tournamentPlayerFacts({
          cohort_index: ci,
          actor_index: ai,
          token,
        });
        assert.equal(facts.tournamentId, tournamentId);
        assert.equal(facts.userId, userId);
        return facts;
      };
      // Real engine discovery/seating, never a bootstrap success flag.
      for (let ai = 0; ai < cohort.users.length; ai++) {
        const user = cohort.users[ai];
        let facts;
        while (Date.now() < deadline) {
          facts = await native({
            tournamentId: cohort.tournament_id,
            userId: user.id,
            token: null,
          });
          if (facts.activeSeatCount === 1 && facts.stack > 0 && facts.playerStatus === 'playing')
            break;
          await wait(3000);
        }
        assert.ok(facts?.activeSeatCount === 1 && facts.stack > 0, 'PLAYER_UI_ACTOR_NOT_ADMITTED');
        const context = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width: 1280, height: 900 },
          storageState: browserStorage(user.session, ingress.supabase_host),
        });
        contexts.push(context);
        const page = await context.newPage(),
          wire = collectPlayerUIWire(page, user.id);
        wires.push(wire);
        page.on('pageerror', () => {
          pageFailed = true;
        });
        await page.goto(`${BASE}table/${facts.tableId}`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        actors.push({ user, page, wire, tableId: facts.tableId });
      }
      let phase = 'call_any',
        pending = null,
        pendingActor = null,
        lastNative = 0,
        finished = false;
      while (Date.now() < deadline && !finished) {
        assert.equal(pageFailed, false, 'PLAYER_UI_BROWSER_EXCEPTION');
        if (pending?.error) throw pending.error;
        if (pending?.done) {
          run.record(cohort.format, phase, pending.value);
          phase =
            phase === 'call_any'
              ? 'call_amount'
              : phase === 'call_amount'
                ? cohort.format === 'MTT'
                  ? 'paid_rebuy_return'
                  : 'finish_report'
                : 'finish_report';
          pending = null;
          pendingActor = null;
        }
        if (!pending && (phase === 'call_any' || phase === 'call_amount')) {
          for (const a of actors) {
            const s = a.wire.state(a.tableId),
              p = s?.players?.find((p) => p.user_id === a.user.id);
            if (
              !s ||
              s.current_player === a.user.id ||
              !p ||
              p.is_folded ||
              p.is_all_in ||
              p.stack <= 0
            )
              continue;
            const button = a.page.locator('.pre-action-bar').getByRole('button', {
              name: phase === 'call_any' ? 'Call Any' : /^Call [0-9]/,
              exact: phase === 'call_any',
            });
            if (!(await button.isVisible())) continue;
            pending = { done: false };
            const owned = pending;
            pendingActor = a;
            provePreActionThroughUI({
              page: a.page,
              choice: phase,
              tableId: a.tableId,
              userId: a.user.id,
              handNumber: s.hand_number,
              journal: a.wire,
              readArm: a.wire.readArm,
              readCalls: a.wire.readCalls,
              deadline,
              onClicked: () => {
                owned.clicked = true;
              },
            }).then(
              (value) => {
                owned.value = value;
                owned.done = true;
              },
              (error) => {
                owned.error = error;
              }
            );
            break;
          }
        }
        if (
          pending &&
          (((phase === 'call_any' || phase === 'call_amount') && !pending.clicked) ||
            phase === 'paid_rebuy_return')
        ) {
          await wait(50);
          continue;
        }
        for (const a of actors) {
          const dialog = a.page.getByRole('dialog', { name: 'Rebuy Available', exact: true });
          if (await dialog.isVisible()) {
            if (phase === 'paid_rebuy_return' && !pending) {
              pending = { done: false };
              const owned = pending;
              pendingActor = a;
              provePaidRebuyThroughUI({
                page: a.page,
                tournamentId: cohort.tournament_id,
                userId: a.user.id,
                readNative: native,
                deadline,
              }).then(
                (value) => {
                  owned.value = value;
                  owned.done = true;
                },
                (error) => {
                  owned.error = error;
                }
              );
            } else if (phase === 'finish_report' && !pending) {
              await dialog
                .getByRole('button', { name: 'Decline Rebuy', exact: true })
                .click({ timeout: 3000 });
            }
          }
          if (a === pendingActor) continue;
          const s = a.wire.state(a.tableId),
            p = s?.players?.find((p) => p.user_id === a.user.id);
          if (
            !s ||
            s.current_player !== a.user.id ||
            !p ||
            p.is_folded ||
            p.is_all_in ||
            p.stack <= 0
          )
            continue;
          const turn = `${a.tableId}:${s.hand_number}:${s.turn_start_time_ms}:${a.user.id}`;
          if (acted.has(turn)) continue;
          // Positive native and current dealer chairs agree before each input.
          assert.equal(p.user_id, a.user.id);
          const allIn = phase === 'paid_rebuy_return' || phase === 'finish_report';
          const control = a.page.locator(
            allIn
              ? '.action-btn--allin'
              : phase === 'call_amount' && !pending
                ? '.action-btn--raise'
                : '.action-btn--call'
          );
          if (await control.isVisible()) {
            acted.add(turn);
            await a.page.bringToFront();
            await control.click({ timeout: 3000 });
            if (!allIn && phase === 'call_amount' && !pending)
              await a.page.locator('.raise-confirm').click({ timeout: 3000 });
          } else {
            const check = a.page.getByRole('button', { name: 'Check', exact: true });
            if (await check.isVisible()) {
              acted.add(turn);
              await a.page.bringToFront();
              await check.click({ timeout: 3000 });
            }
          }
        }
        if (phase === 'finish_report' && Date.now() - lastNative >= 3000) {
          lastNative = Date.now();
          const facts = await native({
            tournamentId: cohort.tournament_id,
            userId: cohort.users[0].id,
            token: null,
          });
          if (terminal(facts.tournamentStatus)) {
            run.record(
              cohort.format,
              'finish_report',
              await proveFinishReportThroughUI({
                page: actors[0].page,
                cohort,
                readNative: native,
                deadline,
              })
            );
            finished = true;
          }
        }
        await wait(100);
      }
      assert.ok(finished, 'PLAYER_UI_FINITE_RUN_EXHAUSTED');
      assert.equal(pageFailed, false, 'PLAYER_UI_BROWSER_EXCEPTION');
      for (const a of actors) a.wire.close();
      for (const a of actors) await a.page.context().close();
    }
    return run.finish();
  } finally {
    for (const wire of wires) wire.close();
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
}

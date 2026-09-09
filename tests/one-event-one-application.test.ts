/**
 * ONE EVENT, ONE APPLICATION - AND A MESSAGE NEVER ARRIVES BEFORE THE STATE
 * THAT GIVES IT MEANING (2026-09-09).
 *
 * Two classes, one sweep, because they produce the same symptom: something a
 * player sees or is charged happens a number of times that is not one.
 *
 *   COUNTED TWICE. `handsPlayedRef` had two unconditional writers - the
 *   dealtIn-gated HAND_COMPLETED subscriber and a second, ungated increment
 *   on the hand-number effect - so every session reported double the hands
 *   and HALF the VPIP (its numerator is latched once per hand; its
 *   denominator was not). The jackpot fanfare played again on every reconnect
 *   inside the 60s replay window. The deal swish played on every hole-card
 *   re-push. An idempotency key was minted per ATTEMPT rather than per
 *   purchase in four places, which is a double charge on the one case a key
 *   exists for.
 *
 *   ARRIVED TOO EARLY. The showdown hold counted `showCards` from a snapshot
 *   the engine deliberately sends AFTER the event, so it was always 2 and the
 *   felt reset up to 800ms before the engine finished announcing. TURN_CHANGE
 *   - the frame that lands LAST - wrote the acting seat with none of the
 *   fence the snapshot beside it uses. The snapshot effect depended on a
 *   field it writes, so a resync re-applied the pre-gap snapshot over the
 *   recovery. Deferred chip flights closed over the seat ring as it stood
 *   seconds earlier, before the hero's own seat was known.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBlockAfter, sliceEnclosingBlock } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const PAGE = read('src/pages/TablePage.tsx');

describe('a hand is counted once', () => {
  it('TablePage no longer increments the session hand counters itself', () => {
    // useTableSession owns them, off HAND_COMPLETED, dealtIn-gated.
    expect(strip(PAGE)).not.toMatch(/handsPlayedRef\.current\+\+/);
    expect(strip(PAGE)).not.toMatch(/handsWonRef\.current\+\+/);
    const hook = strip(read('src/hooks/useTableSession.ts'));
    expect(hook).toMatch(/handsPlayedRef\.current \+= 1/);
  });

  it('a pot is added to the hero outcome once, inside the hand fence', () => {
    const arm = sliceEnclosingBlock(PAGE, 'heroHandOutcomeRef.current.won = true;', 0, 2);
    expect(arm).toMatch(/heroPotsCountedRef\.current\.has\(potKey\)/);
    expect(arm).toMatch(/heroHandOutcomeRef\.current\.handNumber === liveHandNumber/);
    // and the fence itself reads the hand number the EVENT carries
    expect(PAGE).toMatch(/const eventHandNumber = Number\(\(evt\.data as any\)\.hand_number\)/);
  });
});

describe('a cue plays once per thing that happened', () => {
  it('the jackpot fanfare is gated by the hit identity, like every other BBJ arm', () => {
    const at = PAGE.indexOf("case 'BBJ_HIT': {");
    expect(at).toBeGreaterThan(-1);
    const arm = PAGE.slice(at, PAGE.indexOf("case 'BBJ_PAYOUT_COMPLETE'", at));
    expect(arm).toMatch(/shouldAnnounceBbjHit\(/);
    expect(arm).toMatch(/kind: 'celebration'/);
    // The retained `bbj_hit` frame is redelivered on every connect.
    expect(arm).toMatch(/if \(announceHit\) \{/);
  });

  it('the deal swish plays for a deal, not for a re-push of the same cards', () => {
    expect(PAGE).toMatch(/heroDealSoundHandRef\.current !== dealtHandNumber/);
  });

  it('the ante flight does not stack a second chip click on the blinds', () => {
    const at = PAGE.indexOf("case 'ANTES_POSTED': {");
    expect(at).toBeGreaterThan(-1);
    const arm = PAGE.slice(at, PAGE.indexOf("case 'TURN_CHANGE'", at));
    expect(arm).not.toMatch(/soundService\.playChips\(\)/);
  });
});

describe('a money key identifies the purchase, not the attempt', () => {
  it('the auto top-up discriminates on the hand, never on a recomputed float', () => {
    expect(PAGE).toMatch(/autoTopUpKeyRef\.current\.hand !== topUpHand/);
    expect(PAGE).not.toMatch(/autoTopUpKeyRef\.current\.amount !== topUpAmount/);
  });

  it('the VIP purchase holds its key across an ambiguous failure', () => {
    const src = strip(read('src/pages/marketplace/MembershipTab.tsx'));
    expect(src).toMatch(/intentPlanRef\.current !== key \|\| !intentKeyRef\.current/);
    expect(src).toMatch(/spent = \(err as \{ definitive\?: boolean \}\)\?\.definitive === true/);
  });

  it('the store purchase rotates its key only on a TERMINAL refusal', () => {
    const src = strip(read('src/pages/marketplace/StoreTab.tsx'));
    expect(src).toMatch(/if \(\(err as \{ definitive\?: boolean \}\)\?\.definitive\) \{/);
  });

  it('all three transports say which refusals are terminal, with the same list', () => {
    for (const f of [
      'src/services/UnionApiService.ts',
      'src/services/clubArenaApi.ts',
      'src/pages/marketplace/marketplaceShared.ts',
    ]) {
      expect(read(f), f).toMatch(/\[400, 401, 403, 404, 405, 422\]\.includes\(/);
    }
  });

  it('the agent dashboard sends an op id, scoped to the action AND the request', () => {
    const src = strip(read('src/pages/AgentDashboardPage.tsx'));
    expect(src).toMatch(/cashoutOpIdFor\('approve', cashoutId\)/);
    expect(src).toMatch(/cashoutOpIdFor\('reject', cashoutId\)/);
    // A key shared between approve and reject COLLIDES on the unique index.
    expect(src).toMatch(/`\$\{action\}:\$\{cashoutId\}`/);
  });

  it('spin activation takes the key from its caller', () => {
    expect(strip(read('src/services/SpinActivationService.ts'))).toMatch(
      /'X-Idempotency-Key': idempotencyKey \|\| uuid\(\)/
    );
  });
});

describe('a frame is read against the state that belongs to it', () => {
  it('the showdown hold counts the hands the EVENT reports', () => {
    expect(PAGE).toMatch(/hands: Math\.max\(2, sdResultsForCount\.length\)/);
    expect(strip(PAGE)).not.toMatch(/filter\(\(p\) => p && p\.showCards\)\.length/);
  });

  it('TURN_CHANGE carries the same fence the snapshot uses', () => {
    const arm = sliceBlockAfter(PAGE, "case 'TURN_CHANGE': {");
    expect(arm).toMatch(/const f = heroActedFenceRef\.current;/);
    expect(arm).toMatch(/newSeat === prev\.heroSeat/);
  });

  it('the snapshot effect does not depend on a field it writes', () => {
    expect(PAGE).toMatch(
      /mapEngineSnapshot\(engineSnapshot, userId, tableStateRef\.current\.maxPlayers\)/
    );
    expect(PAGE).not.toMatch(
      /\}, \[engineSnapshot, USE_ENGINE_WS, userId, tableState\.maxPlayers\]\)/
    );
  });

  it('a deferred chip flight reads the seat ring late', () => {
    expect(PAGE).toMatch(/seatPositionsRef\.current\[post\.seat - 1\]/);
    expect(PAGE).toMatch(/seatPositionsRef\.current\[seatIdx\]/);
  });

  it('a hero-seat read has a fallback for the window before the seat is known', () => {
    expect(PAGE).toMatch(/const resolveHeroSeat = useCallback\(\(\): number =>/);
    expect(PAGE).toMatch(/actionSeat === resolveHeroSeat\(\)/);
  });

  it('a fresh holding is not refused for colliding with the PREVIOUS hand board', () => {
    const src = strip(read('src/lib/tableCardDisplay.ts'));
    expect(src).toMatch(/const boardIsOlder = rowHand > 0 && liveHand > 0 && rowHand > liveHand;/);
    expect(src).toMatch(/if \(!boardIsOlder && heroCardsCollideWithBoard\(/);
  });

  it('the insurance payout is broadcast, so the stack it lands on moves', () => {
    const src = read('server/src/engine/ServerTableEngineSettlement.ts');
    expect(sliceEnclosingBlock(src, 'applyStackDeltas(insuranceDeltas)')).toMatch(
      /broadcastCurrentState\(\)/
    );
  });
});

describe('what an alert reads has to exist', () => {
  it('the counters an alert rule reads are on the always-on registry', () => {
    const src = read('server/src/observability/engineInstruments.ts');
    for (const c of [
      'showdownHandsTotal',
      'muckedHandsTotal',
      'bbjHitsDetectedTotal',
      'bbjPayoutsPaidTotal',
      'rpcErrorsTotal',
    ]) {
      expect(src, c).toMatch(new RegExp(`export const ${c}[^=]*= alwaysOnRegistry\\.counter\\(`));
    }
    // and they register at zero, or "no jackpot" and "no instrument" read alike
    expect(src).toMatch(/bbjHitsDetectedTotal\.inc\(0\)/);
  });

  it('the hands-dealt SLO reads the series the engine actually publishes', () => {
    const slo = read('infra/monitoring/slo-rules.yml');
    expect(slo).toMatch(/rate\(poker_hands_dealt_total\[5m\]\)/);
    expect(slo).not.toMatch(/rate\(poker_hands_total\[5m\]\)/);
  });

  it('the reconciler now checks that every rule reads a real series', () => {
    const chk = read('scripts/ci/check-alert-rules-match.mjs');
    expect(chk).toMatch(/label\/__name__\/values/);
    expect(chk).toMatch(/RULES THAT READ A SERIES PROMETHEUS HAS NEVER SEEN/);
  });
});

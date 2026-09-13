import type { Card } from '../types.js';
import { evaluateOmahaEquity, type OmahaEquityRequest } from './OmahaEquityOracle.js';
import { OMAHA_RULES, omahaHandComponents, type OmahaVariant } from './OmahaReference.js';

export const OMAHA_EVIDENCE_VERSION = 'omaha-evidence-round1-v1';
export interface OmahaEvidenceScenario {
  name: string;
  request: OmahaEquityRequest;
}
export interface OmahaEvidenceInput {
  version: typeof OMAHA_EVIDENCE_VERSION;
  scenarios: OmahaEvidenceScenario[];
}
const cards = (text: string): Card[] =>
  text.split(' ').map((s) => ({
    rank: s[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[
      s[1] as 'c' | 'd' | 'h' | 's'
    ],
  }));

/** Small repeatable starter matrix. Custom ranges use the same public request shape. */
export function defaultOmahaEvidence(): OmahaEvidenceInput {
  const base: OmahaEquityRequest = {
    variant: 'plo8',
    heroId: 'hero',
    dealerSeat: 1,
    chipUnit: 0.01,
    boards: [cards('3c 4d 8h Kc Qh')],
    mode: 'exact_river',
    samples: 256,
    seed: 9091101,
    players: [
      {
        id: 'hero',
        seat: 1,
        contributed: 100,
        range: { combos: [{ cards: cards('As 2s Jh Td'), weight: 1 }] },
      },
      {
        id: 'opponent',
        seat: 2,
        contributed: 100,
        range: {
          combos: [
            { cards: cards('Kh Kd Qc Qd'), weight: 3 },
            { cards: cards('Ah 2h 9s 9d'), weight: 1 },
          ],
        },
      },
    ],
  };
  const scenarios: OmahaEvidenceScenario[] = (Object.keys(OMAHA_RULES) as OmahaVariant[]).map(
    (variant) => {
      const request = structuredClone(base);
      request.variant = variant;
      const extras = OMAHA_RULES[variant].holes - 4;
      if (extras) {
        for (const combo of (request.players[0].range as { combos: { cards: Card[] }[] }).combos)
          combo.cards.push(...cards('5s 6s').slice(0, extras));
        for (const combo of (request.players[1].range as { combos: { cards: Card[] }[] }).combos)
          combo.cards.push(...cards('5h 6h').slice(0, extras));
      }
      return { name: `${variant}-weighted-river`, request };
    }
  );
  const dead = structuredClone(base);
  dead.deadCards = cards('Kd');
  scenarios.push({ name: 'plo8-dead-card-conditioning', request: dead });
  const side = structuredClone(base);
  side.players[1].contributed = 200;
  side.players[1].range = { combos: [{ cards: cards('Kh Kd Qc Qd'), weight: 1 }] };
  side.players.push({
    id: 'low',
    seat: 3,
    contributed: 250,
    range: { combos: [{ cards: cards('Ah 2h 9s 9d'), weight: 1 }] },
  });
  scenarios.push({ name: 'plo8-quartering-side-pot-refund', request: side });
  const shared = structuredClone(base);
  shared.variant = 'flo8';
  shared.mode = 'sampled';
  shared.boards = [cards('3c 4d 8h Kc'), cards('3c 4d 8h Qh')];
  shared.sharedPrefixLength = 3;
  shared.players[1].range = { uniform: true };
  scenarios.push({ name: 'flo8-shared-flop-runouts', request: shared });
  for (const count of [2, 3]) {
    const bomb = structuredClone(base);
    bomb.mode = 'sampled';
    bomb.variant = 'plo4';
    bomb.chipUnit = 1;
    bomb.players[1].range = { uniform: true };
    bomb.players[0].contributed = 1;
    bomb.players[1].contributed = 2;
    bomb.players.push({ id: 'third', seat: 3, contributed: 2, range: { uniform: true } });
    bomb.boards = [cards('3c 4d 8h'), cards('5c 6d 9h'), cards('7c Qd Kh')].slice(0, count);
    scenarios.push({ name: `plo4-${count}-board-bomb-pot`, request: bomb });
  }
  return { version: OMAHA_EVIDENCE_VERSION, scenarios };
}

export async function runOmahaEvidence(input: OmahaEvidenceInput, shouldContinue = () => true) {
  if (
    input.version !== OMAHA_EVIDENCE_VERSION ||
    !Array.isArray(input.scenarios) ||
    input.scenarios.length < 1 ||
    input.scenarios.length > 16 ||
    input.scenarios.some((s) => !/^[a-z0-9][a-z0-9-]{0,79}$/.test(s.name)) ||
    new Set(input.scenarios.map((s) => s.name)).size !== input.scenarios.length
  )
    throw new Error('Expected one to sixteen uniquely named Omaha evidence scenarios');
  const scenarios = [];
  for (const scenario of input.scenarios) {
    const result = await evaluateOmahaEquity(scenario.request, shouldContinue);
    const hero = scenario.request.players.find((p) => p.id === scenario.request.heroId)!;
    const fixedHole =
      'combos' in hero.range && hero.range.combos.length === 1 ? hero.range.combos[0].cards : null;
    const components =
      fixedHole && scenario.request.boards.every((b) => b.length >= 3)
        ? scenario.request.boards.map((b) => omahaHandComponents(fixedHole, b))
        : null;
    scenarios.push({ name: scenario.name, request: scenario.request, components, result });
    if (result.reason === 'cancelled') break;
  }
  return {
    version: OMAHA_EVIDENCE_VERSION,
    complete:
      scenarios.length === input.scenarios.length && scenarios.every((s) => s.result.complete),
    scope: 'offline-reference-only',
    requestedScenarios: input.scenarios.length,
    completedScenarios: scenarios.filter((s) => s.result.complete).length,
    maxConservationError: Math.max(...scenarios.map((s) => s.result.maxConservationError)),
    scenarios,
  };
}

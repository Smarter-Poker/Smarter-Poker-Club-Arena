import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetHorseSpins,
  __setHorseSpinDoors,
  horseDiamondSpinsStatus,
  horseSpinPass,
  type HorseSpinDoors,
  type OpenWork,
  type SpinMember,
} from './HorseDiamondSpinsDriver.js';
import { bankrollPolicyFor } from './HorseBankroll.js';

function horseOf(t: 'nit' | 'standard' | 'gambler'): string {
  for (let i = 0; i < 10_000; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    if (bankrollPolicyFor(id).temperament === t) return id;
  }
  throw new Error(`no ${t}`);
}
const HORSE = horseOf('gambler'); // target 200 chips at a 0.10 game
const CLUB = 'a0000000-0000-0000-0000-000000000001';

type Outcome = {
  chips?: number;
  award?: 'plinko' | 'crash' | 'mines' | 'crossing';
  card?: boolean;
};

/** A wheel that behaves like the person's: one prize at a time, a queue the
 *  next spin is refused behind, payouts into the club wallet. */
class FakeWheel implements HorseSpinDoors {
  clock = 1_000_000;
  isFrozen = false;
  member: SpinMember = { userId: HORSE, clubId: CLUB, chips: 0, diamonds: 100_000 };
  recent = new Set<string>();
  outcomes: Outcome[] = [];
  work: OpenWork = { cards: [], awards: [], crashRounds: [], choiceRounds: [] };
  calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  refuseNext: string | null = null;
  private n = 0;

  frozen() {
    return this.isFrozen;
  }
  async loadOpenGames() {
    return [{ big_blind: '0.10', min_buy_in: '4.00', max_buy_in: '20.00' }];
  }
  async loadMembers(maxChips: number) {
    return this.member.chips < maxChips ? [{ ...this.member }] : [];
  }
  async loadMember() {
    return { ...this.member };
  }
  async loadRecentSpins() {
    return new Set(this.recent);
  }
  async loadOpenWork() {
    return JSON.parse(JSON.stringify(this.work)) as OpenWork;
  }
  now() {
    return this.clock;
  }
  seed() {
    return `seed-${++this.n}`;
  }
  async act(horseId: string, action: string, args: Record<string, unknown>) {
    expect(horseId).toBe(HORSE);
    this.calls.push({ action, args });
    if (this.refuseNext && (action === 'wheel_spin' || action === 'bonus_start')) {
      const error = this.refuseNext;
      this.refuseNext = null;
      return { ok: false, error };
    }
    const id = () => `id-${++this.n}`;
    switch (action) {
      case 'wheel_commit':
      case 'game_commit':
        return { ok: true, commit_id: id() };
      case 'wheel_spin': {
        const entry = Number(args.entry_diamonds);
        if (this.work.awards.length || this.work.cards.length)
          return { ok: false, error: 'Finish Your Bonus Game Before Another Spin' };
        this.member.diamonds -= entry;
        this.recent.add(`${HORSE}:${CLUB}`);
        const o = this.outcomes.shift() ?? { chips: 1 };
        if (o.chips) this.member.chips += (o.chips * entry) / 100;
        if (o.award)
          this.work.awards.push({
            id: id(),
            userId: HORSE,
            clubId: CLUB,
            game: o.award,
            baseDiamonds: entry,
            createdAt: new Date(this.clock).toISOString(),
          });
        if (o.card) this.work.cards.push({ id: id(), userId: HORSE, clubId: CLUB });
        return { ok: true, outcome: o };
      }
      case 'cards_pick':
        this.work.cards = [];
        return { ok: true };
      case 'choice_state':
        return { ok: true, max_steps: 10 };
      case 'bonus_start': {
        const a = this.work.awards.shift()!;
        if (a.game === 'plinko') this.member.chips += a.baseDiamonds / 100;
        if (a.game === 'crash')
          this.work.crashRounds.push({ id: id(), userId: HORSE, clubId: CLUB });
        if (a.game === 'mines' || a.game === 'crossing')
          this.work.choiceRounds.push({
            id: id(),
            userId: HORSE,
            clubId: CLUB,
            game: a.game,
            picked: [],
            maxSteps: Number(args.max_steps),
          });
        return { ok: true };
      }
      case 'crash_settle':
        this.work.crashRounds = [];
        this.member.chips += 2;
        return { ok: true, status: 'cashed' };
      case 'choice_act': {
        const r = this.work.choiceRounds[0];
        if (args.action === 'pick') r.picked.push(Number(args.cell));
        else {
          this.work.choiceRounds = [];
          this.member.chips += 1.5;
        }
        return { ok: true };
      }
    }
    throw new Error(`unexpected ${action}`);
  }
  /** Let every pause run out, then take a pass. */
  async pass() {
    this.clock += 31_000;
    await horseSpinPass();
  }
}

let wheel: FakeWheel;
beforeEach(() => {
  __resetHorseSpins();
  wheel = new FakeWheel();
  __setHorseSpinDoors(wheel);
});
afterEach(() => __setHorseSpinDoors(null));

describe('a horse with no chips spins its Diamonds into chips', () => {
  it('commits a seed, spins the wheel and is paid into its club wallet', async () => {
    await wheel.pass();
    expect(wheel.calls.map((c) => c.action)).toEqual(['wheel_commit', 'wheel_spin']);
    expect(wheel.calls[1].args).toMatchObject({
      club_id: CLUB,
      mode: 'paid',
      entry_diamonds: 2500,
    });
    expect(wheel.member.diamonds).toBe(97_500);
    expect(wheel.member.chips).toBe(25);
  });

  it('plays each prize it lands before it spins again, in the person’s order', async () => {
    wheel.outcomes = [
      { award: 'plinko' },
      { card: true },
      { award: 'crash' },
      { award: 'crossing' },
    ];
    for (let i = 0; i < 12; i++) await wheel.pass();
    const actions = wheel.calls.map((c) => c.action).filter((a) => !a.endsWith('_commit'));
    const firstSpins = actions.indexOf('wheel_spin');
    expect(actions.slice(firstSpins, firstSpins + 2)).toEqual(['wheel_spin', 'bonus_start']);
    expect(actions).toContain('cards_pick');
    expect(actions).toContain('crash_settle');
    expect(actions).toContain('choice_act');
    // Never a spin while a prize is unplayed: the fake wheel would refuse it.
    expect(horseDiamondSpinsStatus().refusals).toEqual({});
    const plinko = wheel.calls.find((c) => c.action === 'bonus_start')!;
    expect(plinko.args).toMatchObject({ double: false, denom: expect.any(Number) });
    const card = wheel.calls.find((c) => c.action === 'cards_pick')!;
    expect([1, 2, 3]).toContain(card.args.card);
  });

  it('stops once its wallet reaches the bar the fleet seats it at', async () => {
    wheel.outcomes = Array.from({ length: 40 }, () => ({ chips: 1 }));
    for (let i = 0; i < 40; i++) await wheel.pass();
    const spins = wheel.calls.filter((c) => c.action === 'wheel_spin').length;
    expect(wheel.member.chips).toBeGreaterThanOrEqual(200);
    expect(wheel.member.chips).toBeLessThan(200 + 25);
    const before = wheel.calls.length;
    for (let i = 0; i < 5; i++) await wheel.pass();
    expect(wheel.calls.length).toBe(before);
    expect(spins).toBeGreaterThan(0);
  });

  it('keeps its Diamond Arena reserve', async () => {
    wheel.member.diamonds = 10_000 + 2_000;
    wheel.outcomes = Array.from({ length: 40 }, () => ({ chips: 0.01 }));
    for (let i = 0; i < 40; i++) await wheel.pass();
    expect(wheel.member.diamonds).toBeGreaterThanOrEqual(10_000);
  });
});

describe('a horse that has chips is left alone', () => {
  it('does not spin above one buy-in unless it is already mid-session', async () => {
    wheel.member.chips = 50; // above the 4.00 minimum, below its 200 target
    await wheel.pass();
    expect(wheel.calls).toEqual([]);
    wheel.recent.add(`${HORSE}:${CLUB}`); // it spun here inside the window
    wheel.clock += 60_000; // past the roster refresh
    await wheel.pass();
    expect(wheel.calls.map((c) => c.action)).toContain('wheel_spin');
  });
});

describe('the freeze and refusals', () => {
  it('does nothing at all while the platform is frozen', async () => {
    wheel.isFrozen = true;
    for (let i = 0; i < 3; i++) await wheel.pass();
    expect(wheel.calls).toEqual([]);
  });

  it('backs off a refusal the wheel gives by design', async () => {
    wheel.refuseNext = 'The Host Must Fund Every Prize Before A Spin';
    await wheel.pass();
    expect(horseDiamondSpinsStatus().refusals).toEqual({
      'The Host Must Fund Every Prize Before A Spin': 1,
    });
    const before = wheel.calls.length;
    await wheel.pass(); // 31s later: still inside the 30-minute back-off
    expect(wheel.calls.length).toBe(before);
  });
});

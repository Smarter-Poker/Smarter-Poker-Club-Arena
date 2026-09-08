import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindTournamentDataAuthority,
  bindTournamentDataAuthorityMethods,
  currentTournamentDataAuthority,
  DATA_ACTOR_HEADER,
  DATA_ACTOR_PROTOCOL_HEADER,
  dataActorHeaders,
  runWithTournamentDataAuthority,
  SERVICE_DATA_ACTOR,
  TOURNAMENT_ID_HEADER,
  TOURNAMENT_LEASE_GENERATION_HEADER,
  TOURNAMENT_MANAGER_DATA_ACTOR,
} from './dataActorContext.js';

const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const T2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const G1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const G2 = 'bbbbbbbb-0000-4000-8000-000000000002';

const actorShape = () => {
  const headers = dataActorHeaders();
  return {
    actor: headers.get(DATA_ACTOR_HEADER),
    protocol: headers.get(DATA_ACTOR_PROTOCOL_HEADER),
    tournamentId: headers.get(TOURNAMENT_ID_HEADER),
    leaseGeneration: headers.get(TOURNAMENT_LEASE_GENERATION_HEADER),
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('tournament data actor context', () => {
  it('stamps ordinary service authority and removes caller-forged manager headers', () => {
    const headers = dataActorHeaders({
      authorization: 'Bearer service-key',
      [DATA_ACTOR_HEADER]: TOURNAMENT_MANAGER_DATA_ACTOR,
      [DATA_ACTOR_PROTOCOL_HEADER]: '2',
      [TOURNAMENT_ID_HEADER]: T1,
      [TOURNAMENT_LEASE_GENERATION_HEADER]: G1,
    });

    expect(headers.get('authorization')).toBe('Bearer service-key');
    expect(headers.get(DATA_ACTOR_HEADER)).toBe(SERVICE_DATA_ACTOR);
    expect(headers.get(DATA_ACTOR_PROTOCOL_HEADER)).toBe('1');
    expect(headers.has(TOURNAMENT_ID_HEADER)).toBe(false);
    expect(headers.has(TOURNAMENT_LEASE_GENERATION_HEADER)).toBe(false);
  });

  it('stamps the exact immutable protocol-2 manager authority', async () => {
    expect(currentTournamentDataAuthority()).toBeNull();

    const inside = await runWithTournamentDataAuthority(
      { tournamentId: T1.toUpperCase(), leaseGeneration: G1.toUpperCase() },
      async () => ({ authority: currentTournamentDataAuthority(), headers: actorShape() })
    );

    expect(inside).toEqual({
      authority: { tournamentId: T1, leaseGeneration: G1 },
      headers: {
        actor: TOURNAMENT_MANAGER_DATA_ACTOR,
        protocol: '2',
        tournamentId: T1,
        leaseGeneration: G1,
      },
    });
    expect(currentTournamentDataAuthority()).toBeNull();
    expect(actorShape().actor).toBe(SERVICE_DATA_ACTOR);
  });

  it('keeps concurrent manager timers isolated and never bleeds into service work', async () => {
    const timerRead = (delayMs: number) =>
      new Promise<ReturnType<typeof actorShape>>((resolve) => {
        setTimeout(() => resolve(actorShape()), delayMs);
      });

    const serviceTimer = timerRead(4);
    const [first, second, service] = await Promise.all([
      runWithTournamentDataAuthority({ tournamentId: T1, leaseGeneration: G1 }, () => timerRead(8)),
      runWithTournamentDataAuthority({ tournamentId: T2, leaseGeneration: G2 }, () => timerRead(2)),
      serviceTimer,
    ]);

    expect(first).toMatchObject({
      actor: TOURNAMENT_MANAGER_DATA_ACTOR,
      tournamentId: T1,
      leaseGeneration: G1,
    });
    expect(second).toMatchObject({
      actor: TOURNAMENT_MANAGER_DATA_ACTOR,
      tournamentId: T2,
      leaseGeneration: G2,
    });
    expect(service).toEqual({
      actor: SERVICE_DATA_ACTOR,
      protocol: '1',
      tournamentId: null,
      leaseGeneration: null,
    });
    expect(actorShape().actor).toBe(SERVICE_DATA_ACTOR);
  });

  it('allows same-authority nesting but refuses authority exchange', () => {
    expect(
      runWithTournamentDataAuthority({ tournamentId: T1, leaseGeneration: G1 }, () =>
        runWithTournamentDataAuthority({ tournamentId: T1, leaseGeneration: G1 }, actorShape)
      )
    ).toMatchObject({ tournamentId: T1, leaseGeneration: G1 });

    expect(() =>
      runWithTournamentDataAuthority({ tournamentId: T1, leaseGeneration: G1 }, () =>
        runWithTournamentDataAuthority({ tournamentId: T2, leaseGeneration: G2 }, actorShape)
      )
    ).toThrow(/cannot be rebound/);
  });

  it('rejects malformed authority before any work runs', () => {
    const work = vi.fn();
    expect(() =>
      runWithTournamentDataAuthority({ tournamentId: 'not-a-uuid', leaseGeneration: G1 }, work)
    ).toThrow(/invalid tournamentId/);
    expect(work).not.toHaveBeenCalled();
  });

  it('binds an external callback without losing this or arguments', () => {
    const receiver = {
      prefix: 'kept',
      read(this: { prefix: string }, suffix: string) {
        return { value: `${this.prefix}:${suffix}`, actor: actorShape() };
      },
    };
    const bound = bindTournamentDataAuthority(
      { tournamentId: T1, leaseGeneration: G1 },
      receiver.read
    );

    expect(bound.call(receiver, 'argument')).toEqual({
      value: 'kept:argument',
      actor: {
        actor: TOURNAMENT_MANAGER_DATA_ACTOR,
        protocol: '2',
        tournamentId: T1,
        leaseGeneration: G1,
      },
    });
    expect(actorShape().actor).toBe(SERVICE_DATA_ACTOR);
  });

  it('binds a whole manager-shaped object once at its publication boundary', async () => {
    class ManagerShape {
      constructor(readonly prefix: string) {}

      async externalEntry(suffix: string) {
        return this.timerWork(`${this.prefix}:${suffix}`);
      }

      protected timerWork(value: string) {
        return new Promise<{ value: string; actor: ReturnType<typeof actorShape> }>((resolve) => {
          setTimeout(() => resolve({ value, actor: actorShape() }), 1);
        });
      }
    }

    const manager = bindTournamentDataAuthorityMethods(
      { tournamentId: T1, leaseGeneration: G1 },
      new ManagerShape('manager')
    );
    expect(
      bindTournamentDataAuthorityMethods({ tournamentId: T1, leaseGeneration: G1 }, manager)
    ).toBe(manager);

    await expect(manager.externalEntry('callback')).resolves.toEqual({
      value: 'manager:callback',
      actor: {
        actor: TOURNAMENT_MANAGER_DATA_ACTOR,
        protocol: '2',
        tournamentId: T1,
        leaseGeneration: G1,
      },
    });
    expect(() =>
      bindTournamentDataAuthorityMethods({ tournamentId: T2, leaseGeneration: G2 }, manager)
    ).toThrow(/cannot be rebound/);
    expect(actorShape().actor).toBe(SERVICE_DATA_ACTOR);
  });
});

import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';

/**
 * The server uses one service-role Supabase client.  The database still needs
 * to know whether a request came from ordinary service work or from one exact
 * tournament-manager lease generation.  AsyncLocalStorage makes that
 * authority follow every promise and timer spawned by the manager without
 * trusting hundreds of individual call sites to remember a header.
 */
export const DATA_ACTOR_HEADER = 'x-smarter-data-actor';
export const DATA_ACTOR_PROTOCOL_HEADER = 'x-smarter-data-protocol';
export const TOURNAMENT_ID_HEADER = 'x-smarter-tournament-id';
export const TOURNAMENT_LEASE_GENERATION_HEADER = 'x-smarter-tournament-lease-generation';

export const SERVICE_DATA_ACTOR = 'service';
export const TOURNAMENT_MANAGER_DATA_ACTOR = 'tournament-manager';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TournamentDataAuthority {
  tournamentId: string;
  leaseGeneration: string;
}

interface TournamentManagerActorContext {
  readonly actor: typeof TOURNAMENT_MANAGER_DATA_ACTOR;
  readonly tournamentId: string;
  readonly leaseGeneration: string;
}

const tournamentManagerActor = new AsyncLocalStorage<TournamentManagerActorContext>();
const boundAuthority = Symbol('smarter.tournament-data-authority');

/**
 * THE PROCESS'S OWN SCOPE (2026-09-11). Captured here, in the same module
 * evaluation that creates the manager store above, so it provably carries no
 * tournament authority: nothing can have entered that store yet.
 *
 * A process-wide timer that is started LAZILY - by the first table engine, the
 * first settled hand - inherits the async context of whatever started it, and
 * AsyncLocalStorage rides on that context. When that was a tournament manager,
 * every later tick, for every table on the box, ran inside that one
 * tournament's authority: on the 01:55 restart the deadline scheduler's single
 * interval did exactly that, and 561 tournament tables zombie-looped on
 * "Tournament data authority cannot be rebound inside another manager
 * context" while cash callbacks quietly sent that tournament's headers.
 *
 * Bind such a timer's callback here and it runs as the process, whoever
 * happened to start it; each bound engine or manager method still enters its
 * own authority, exactly as it does from a socket.
 */
const processRootScope = new AsyncResource('smarter.process-root');

/**
 * Run `work`, whenever it is called, outside every tournament authority.
 *
 * WHEREVER IT IS CALLED FROM, TOO (2026-09-11). Binding to processRootScope
 * alone did not keep that promise on Node 22, which production runs. There,
 * AsyncLocalStorage.run() writes its store onto the resource that is executing
 * at that moment, and inside a root-bound callback that resource is
 * processRootScope itself. So while a tournament's bound method ran
 * synchronously inside such a callback - the scheduler tick calling a table of
 * tournament B - processRootScope carried B, and a root-bound function invoked
 * from there ran as B, and so did every timer and request it started. The
 * store is therefore cleared inside the wrapper as well, which is correct
 * under both of Node's AsyncLocalStorage implementations. exit() would not be:
 * on Node 22 it lets B back in as soon as a nested run() returns.
 */
export function bindToProcessRoot<Args extends unknown[], Result>(
  work: (...args: Args) => Result
): (...args: Args) => Result {
  return processRootScope.bind((...args: Args) =>
    tournamentManagerActor.run(undefined as unknown as TournamentManagerActorContext, () =>
      work(...args)
    )
  ) as (...args: Args) => Result;
}

type Materialized<Result> = Result extends PromiseLike<infer Value> ? Promise<Value> : Result;

function normalizeUuid(value: string, field: string): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`Tournament data authority has an invalid ${field}`);
  }
  return normalized;
}

function normalizeAuthority(authority: TournamentDataAuthority): TournamentManagerActorContext {
  return Object.freeze({
    actor: TOURNAMENT_MANAGER_DATA_ACTOR,
    tournamentId: normalizeUuid(authority.tournamentId, 'tournamentId'),
    leaseGeneration: normalizeUuid(authority.leaseGeneration, 'leaseGeneration'),
  });
}

/**
 * Enter one immutable manager authority boundary.  Re-entering the same
 * boundary is harmless; trying to exchange it for another tournament or
 * generation inside already-authorized work fails closed.
 */
function invokeAndMaterialize<Result>(work: () => Result): Materialized<Result> {
  const result = work();
  /* PostgREST builders are lazy PromiseLike values: their HTTP request starts
     only when `.then` is consumed. Assimilate every thenable while the actor
     context is still active, otherwise a caller returning the builder directly
     could defer the actual fetch until after AsyncLocalStorage.run returned. */
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof (result as unknown as PromiseLike<unknown>).then === 'function'
  ) {
    return Promise.resolve(result as unknown as PromiseLike<unknown>) as Materialized<Result>;
  }
  return result as Materialized<Result>;
}

export function runWithTournamentDataAuthority<Result>(
  authority: TournamentDataAuthority,
  work: () => Result
): Materialized<Result> {
  return runWithNormalizedTournamentDataAuthority(normalizeAuthority(authority), work);
}

function runWithNormalizedTournamentDataAuthority<Result>(
  normalized: TournamentManagerActorContext,
  work: () => Result
): Materialized<Result> {
  const current = tournamentManagerActor.getStore();
  if (current) {
    if (
      current.tournamentId !== normalized.tournamentId ||
      current.leaseGeneration !== normalized.leaseGeneration
    ) {
      throw new Error('Tournament data authority cannot be rebound inside another manager context');
    }
    return invokeAndMaterialize(work);
  }
  return tournamentManagerActor.run(normalized, () => invokeAndMaterialize(work));
}

/**
 * Bind callbacks that can be invoked from GameServer/WebSocket code outside a
 * manager-created async chain.  `this`, arguments, and return type are kept.
 */
export function bindTournamentDataAuthority<This, Args extends unknown[], Result>(
  authority: TournamentDataAuthority,
  work: (this: This, ...args: Args) => Result
): (this: This, ...args: Args) => Materialized<Result> {
  const normalized = normalizeAuthority(authority);
  return function boundTournamentDataAuthority(this: This, ...args: Args): Materialized<Result> {
    return runWithNormalizedTournamentDataAuthority(normalized, () => work.apply(this, args));
  };
}

/**
 * Bind every current instance/prototype method at the object-owner boundary.
 * This is intended for a newly constructed TournamentManager or tournament
 * ServerTableEngine before the raw object is published to any map/callback.
 * Future class methods are covered automatically because the binder walks the
 * complete prototype chain; a later attempt to exchange authority is refused.
 */
export function bindTournamentDataAuthorityMethods<ObjectType extends object>(
  authority: TournamentDataAuthority,
  target: ObjectType
): ObjectType {
  const normalized = normalizeAuthority(authority);
  const existing = (
    target as ObjectType & {
      [boundAuthority]?: TournamentManagerActorContext;
    }
  )[boundAuthority];
  if (existing) {
    if (
      existing.tournamentId !== normalized.tournamentId ||
      existing.leaseGeneration !== normalized.leaseGeneration
    ) {
      throw new Error('Tournament data authority methods cannot be rebound');
    }
    return target;
  }

  const methods = new Map<PropertyKey, PropertyDescriptor>();
  let owner: object | null = target;
  while (owner && owner !== Object.prototype) {
    for (const key of Reflect.ownKeys(owner)) {
      if (key === 'constructor' || key === boundAuthority || methods.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor && typeof descriptor.value === 'function') methods.set(key, descriptor);
    }
    owner = Object.getPrototypeOf(owner);
  }

  for (const [key, descriptor] of methods) {
    const original = descriptor.value as (this: ObjectType, ...args: unknown[]) => unknown;
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      writable: true,
      value: bindTournamentDataAuthority(normalized, original),
    });
  }
  Object.defineProperty(target, boundAuthority, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: normalized,
  });
  return target;
}

/**
 * Stamp, rather than append, the authority headers.  A caller cannot smuggle a
 * manager id/generation through the shared service client: absent an active
 * manager context, those fields are removed and the request is explicitly
 * marked as ordinary service work.
 */
export function dataActorHeaders(headersInit?: ConstructorParameters<typeof Headers>[0]): Headers {
  const headers = new Headers(headersInit);
  headers.delete(DATA_ACTOR_HEADER);
  headers.delete(DATA_ACTOR_PROTOCOL_HEADER);
  headers.delete(TOURNAMENT_ID_HEADER);
  headers.delete(TOURNAMENT_LEASE_GENERATION_HEADER);

  const current = tournamentManagerActor.getStore();
  if (!current) {
    headers.set(DATA_ACTOR_HEADER, SERVICE_DATA_ACTOR);
    headers.set(DATA_ACTOR_PROTOCOL_HEADER, '1');
    return headers;
  }

  headers.set(DATA_ACTOR_HEADER, TOURNAMENT_MANAGER_DATA_ACTOR);
  headers.set(DATA_ACTOR_PROTOCOL_HEADER, '2');
  headers.set(TOURNAMENT_ID_HEADER, current.tournamentId);
  headers.set(TOURNAMENT_LEASE_GENERATION_HEADER, current.leaseGeneration);
  return headers;
}

/** Test/diagnostic read only.  Mutation still requires the run/bind helpers. */
export function currentTournamentDataAuthority(): Readonly<TournamentDataAuthority> | null {
  const current = tournamentManagerActor.getStore();
  return current
    ? Object.freeze({
        tournamentId: current.tournamentId,
        leaseGeneration: current.leaseGeneration,
      })
    : null;
}

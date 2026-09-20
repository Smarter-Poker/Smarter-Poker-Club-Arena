export type TournamentPurchaseRequest = {
  p_tournament_id: string;
  p_user_id: string;
  p_rebuy_type: 'rebuy' | 'reentry' | 'addon';
  p_cost: number;
  p_chips: number;
  p_current_level: number;
  p_client_token: string | null;
};
type Scope = { tournamentId: string; userId: string; kind: 'rebuy' | 'addon'; token?: string };
type Intent = { version: 1; state: 'pending' | 'resolved'; request: TournamentPurchaseRequest };
const running = new Map<string, Promise<number>>();
const prefix = 'ca:tournament-purchase:v1:';

/** Fresh build/validation failed before any recoverable intent was published. */
export class TournamentPurchaseNotSubmittedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The Tournament Purchase Was Not Submitted.');
    this.name = 'TournamentPurchaseNotSubmittedError';
  }
}

function read(raw: string | null, scope: Scope): Intent | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as Intent;
  const r = value?.request;
  if (
    value?.version !== 1 ||
    !['pending', 'resolved'].includes(value.state) ||
    !r ||
    r.p_tournament_id !== scope.tournamentId ||
    r.p_user_id !== scope.userId ||
    !(scope.kind === 'addon'
      ? r.p_rebuy_type === 'addon'
      : ['rebuy', 'reentry'].includes(r.p_rebuy_type)) ||
    !Number.isFinite(r.p_cost) ||
    r.p_cost < 0 ||
    !Number.isFinite(r.p_chips) ||
    r.p_chips <= 0 ||
    !Number.isInteger(r.p_current_level) ||
    r.p_current_level < 0 ||
    !(scope.kind === 'addon'
      ? r.p_client_token === null
      : typeof r.p_client_token === 'string' && r.p_client_token.trim().length > 0)
  )
    throw new Error('The Saved Tournament Purchase Could Not Be Verified.');
  return value;
}
function same(a: Intent | null, b: Intent): boolean {
  return a !== null && JSON.stringify(a.request) === JSON.stringify(b.request);
}

/** Persist the exact receipt-bound payload before I/O, including the original level. */
export function withTournamentPurchaseIntent(
  scope: Scope,
  build: () => Promise<TournamentPurchaseRequest>,
  submit: (request: TournamentPurchaseRequest) => Promise<number>
): Promise<number> {
  const key = prefix + scope.userId + ':' + scope.tournamentId + ':' + scope.kind;
  const active = running.get(key);
  if (active) return active;
  const work = (async () => {
    if (!globalThis.navigator?.locks || !globalThis.crypto?.randomUUID) {
      throw new Error('This Browser Cannot Safely Save The Tournament Purchase.');
    }
    const storage = globalThis.localStorage;
    const session = globalThis.sessionStorage;
    const invokedRaw = storage.getItem(key);
    return navigator.locks.request(key, async () => {
      const currentRaw = storage.getItem(key);
      const current = read(currentRaw, scope);
      const own = read(session.getItem(key), scope);
      const invoked = read(invokedRaw, scope);
      // This tab's uncertain response wins even if another tab has since
      // acknowledged it and begun a later purchase.
      let intent =
        own?.state === 'pending'
          ? own
          : invoked?.state === 'pending'
            ? invoked
            : current?.state === 'pending'
              ? current
              : null;
      if (
        !intent &&
        current &&
        (scope.kind === 'addon' ||
          currentRaw !== invokedRaw ||
          (scope.token !== undefined && current.request.p_client_token === scope.token.trim()))
      ) {
        intent = current;
      }
      const fresh = intent === null;
      if (!intent) {
        try {
          const request = await build();
          request.p_client_token =
            scope.kind === 'addon' ? null : scope.token?.trim() || crypto.randomUUID();
          intent = read(JSON.stringify({ version: 1, state: 'pending', request }), scope)!;
        } catch (error) {
          throw new TournamentPurchaseNotSubmittedError(error);
        }
      }
      intent = { ...intent, state: 'pending' };
      const pending = JSON.stringify(intent);
      // Session storage retains this tab's original request if shared storage
      // advances while its response is unknown. Both writes precede the RPC.
      // Once published, another queued tab may submit it even if this tab's
      // readback fails. Persistence failures must therefore remain unknown.
      session.setItem(key, pending);
      if (session.getItem(key) !== pending)
        throw new Error('The Tournament Purchase Could Not Be Saved.');
      if (!current || fresh || same(current, intent)) {
        storage.setItem(key, pending);
        if (storage.getItem(key) !== pending)
          throw new Error('The Tournament Purchase Could Not Be Saved.');
      }
      const stack = await submit({ ...intent.request });
      // submit validates the database receipt before returning. Storage cleanup
      // failure cannot turn a confirmed charge into a new operation.
      try {
        const resolved = JSON.stringify({ ...intent, state: 'resolved' });
        session.setItem(key, resolved);
        if (same(read(storage.getItem(key), scope), intent)) storage.setItem(key, resolved);
      } catch {
        return stack;
      }
      return stack;
    });
  })();
  running.set(key, work);
  const cleanup = () => {
    if (running.get(key) === work) running.delete(key);
  };
  void work.then(cleanup, cleanup);
  return work;
}

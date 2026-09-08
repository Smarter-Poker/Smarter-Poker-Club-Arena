import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), token: vi.fn(), probe: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { refreshSession: mocks.refresh } } }));
vi.mock('../src/lib/authToken', () => ({ getFreshAccessToken: mocks.token }));
vi.mock('../src/lib/sessionRevoked', () => ({ handleEngineAuthRejection: mocks.probe }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { submitAction } from '../src/services/GameServerAPI';
import { AUTH_STORAGE_KEY } from '../src/lib/authUtils';

function jwt(sub = 'player-a', session_id = 'login-a', revision = 1) {
  return `e30.${btoa(JSON.stringify({ sub, session_id, revision, exp: 4102444800 }))}.signature`;
}
function login(token: string) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ access_token: token }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const denied = () => new Response('{}', { status: 401 });
const accepted = () => new Response('{"success":true}', { status: 200 });
const session = (access_token: string) => ({ data: { session: { access_token } }, error: null });
let fetchMock: ReturnType<typeof vi.fn>;
let table = 0;
const act = () => submitAction(`retry-session-${++table}`, 'player-a', 'raise', 100);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  login(jwt());
  mocks.token.mockResolvedValue(jwt());
  mocks.refresh.mockReset().mockResolvedValue(session(jwt('player-a', 'login-a', 2)));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('engine HTTP retry belongs to the original login', () => {
  it('refreshes the same login and preserves the action and idempotency key', async () => {
    fetchMock.mockResolvedValueOnce(denied()).mockResolvedValueOnce(accepted());
    expect((await act()).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1];
    const retry = fetchMock.mock.calls[1][1];
    expect(retry.body).toBe(first.body);
    expect(JSON.parse(retry.body).idempotencyKey).toBeTruthy();
    expect(retry.headers.Authorization).toBe(`Bearer ${jwt('player-a', 'login-a', 2)}`);
  });

  it('does not refresh the replacement account after a late 401', async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const result = act();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    login(jwt('player-b', 'login-b'));
    pending.resolve(denied());
    expect((await result).success).toBe(false);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another account', jwt('player-b', 'login-b')],
    ['a new login for the same account', jwt('player-a', 'login-new')],
  ])('never replays under %s if refresh crosses the switch', async (_label, replacement) => {
    const pending = deferred<ReturnType<typeof session>>();
    mocks.refresh.mockReturnValueOnce(pending.promise);
    fetchMock.mockResolvedValueOnce(denied());
    const result = act();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    login(replacement);
    pending.resolve(session(replacement));
    expect((await result).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('rejects a mismatched refresh token even if local storage still shows the old login', async () => {
    mocks.refresh.mockResolvedValueOnce(session(jwt('player-b', 'login-b')));
    fetchMock.mockResolvedValueOnce(denied());
    expect((await act()).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not probe or replay after logout during refresh', async () => {
    const pending = deferred<{ data: { session: null }; error: null }>();
    mocks.refresh.mockReturnValueOnce(pending.promise);
    fetchMock.mockResolvedValueOnce(denied());
    const result = act();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    localStorage.removeItem(AUTH_STORAGE_KEY);
    pending.resolve({ data: { session: null }, error: null });
    expect((await result).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('does not retry ambiguous server failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    expect((await act()).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

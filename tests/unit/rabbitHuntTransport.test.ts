import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/authToken', () => ({
  getFreshAccessToken: async () =>
    JSON.parse(localStorage.getItem('smarter-poker-auth')!).access_token,
}));
import { requestRabbitHunt, readRabbitHuntReceipt } from '../../src/services/GameServerAPI';
const response = { success: true, cards: [{ rank: 'A', suit: 's' }], diamonds_spent: 5 };
let fetchMock: ReturnType<typeof vi.fn>;
let sequence = 0;
beforeEach(() => {
  const token = `e30.${btoa(JSON.stringify({ sub: 'rabbit-test', session_id: 'login-' + ++sequence, exp: 4102444800 }))}.sig`;
  localStorage.setItem('smarter-poker-auth', JSON.stringify({ access_token: token }));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('the connected Rabbit Hunt transport', () => {
  it('shares a delayed request and restores a receipt without a second HTTP purchase', async () => {
    let finish!: (v: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const one = requestRabbitHunt('t', 42);
    const two = requestRabbitHunt('t', 42);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const read = readRabbitHuntReceipt('t', 42);
    finish({ status: 200, json: async () => response });
    expect(await one).toMatchObject({ diamonds_spent: 5 });
    expect(await two).toMatchObject({ source: 'already_revealed', diamonds_spent: 0 });
    expect(await read).toMatchObject({ source: 'already_revealed', diamonds_spent: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('bounds a silent transport and leaves recovery on the exact clicked hand', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('deadline', 'AbortError'))
          )
        )
    );
    const buying = requestRabbitHunt('t', 42);
    await vi.advanceTimersByTimeAsync(13000);
    expect(await buying).toMatchObject({ success: false, retryable: true });
    fetchMock.mockResolvedValue({
      status: 200,
      json: async () => ({ ...response, diamonds_spent: 0, source: 'already_revealed' }),
    });
    expect(await requestRabbitHunt('t', 42)).toMatchObject({
      success: true,
      source: 'already_revealed',
    });
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      { tableId: 't', handNumber: 42 },
      { tableId: 't', handNumber: 42 },
    ]);
  });
  it('does not carry old private results into a different login', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => response });
    await requestRabbitHunt('t', 42);
    localStorage.removeItem('smarter-poker-auth');
    expect(await readRabbitHuntReceipt('t', 42)).toBeNull();
  });
});

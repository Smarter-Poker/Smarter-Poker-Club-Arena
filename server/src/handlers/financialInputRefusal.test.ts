import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { authenticateRequest } from '../http/auth.js';
import { handleAddchips } from './addchips.js';
import { handleInsurance, handleInsurancePreview } from './insurance.js';

const actor = '11111111-1111-4111-8111-111111111111';

function request(body: unknown, url = '/', raw = false): IncomingMessage {
  return Object.assign(Readable.from([raw ? body : JSON.stringify(body)]), {
    url,
    headers: { host: 'localhost' },
  }) as IncomingMessage;
}

function response() {
  const state = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    writeHead(status: number) {
      state.status = status;
    },
    end(body: string) {
      state.body = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  return { state, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequest).mockResolvedValue({ userId: actor } as Awaited<
    ReturnType<typeof authenticateRequest>
  >);
});

describe('top-up operation identity at the actual HTTP handler', () => {
  const invalid = [
    null,
    false,
    12,
    {},
    [],
    '',
    'short',
    '1234567',
    'a'.repeat(65),
    '1234/678',
    ' 12345678',
  ];

  it.each(invalid.map((opId) => ({ opId })))(
    'refuses supplied invalid opId $opId before any engine access',
    async ({ opId }) => {
      const addChips = vi.fn().mockResolvedValue({ success: true });
      const getTableEngine = vi.fn(() => ({ addChips }));
      const { res, state } = response();
      await handleAddchips(request({ tableId: 'table-1', amount: 25, opId }), res, {
        gameServer: { getTableEngine },
      });
      expect(state.status).toBe(400);
      expect(state.body.success).toBe(false);
      expect(getTableEngine).not.toHaveBeenCalled();
      expect(addChips).not.toHaveBeenCalled();
    }
  );

  it.each(['12345678', 'AbC-1234', 'z'.repeat(64)])(
    'forwards valid identity %s unchanged on retries',
    async (opId) => {
      const receipt = { success: true, balance: 75, opId };
      const addChips = vi.fn().mockResolvedValue(receipt);
      for (let i = 0; i < 2; i++) {
        const { res, state } = response();
        await handleAddchips(
          request({ tableId: 'table-1', amount: 25, opId, userId: 'untrusted' }),
          res,
          {
            gameServer: { getTableEngine: () => ({ addChips }) },
          }
        );
        expect(state.status).toBe(200);
        expect(state.body).toEqual(receipt);
      }
      expect(addChips.mock.calls).toEqual([
        [actor, 25, opId],
        [actor, 25, opId],
      ]);
    }
  );

  it('preserves omitted operation identity compatibility', async () => {
    const addChips = vi.fn().mockResolvedValue({ success: true });
    const { res, state } = response();
    await handleAddchips(request({ tableId: 'table-1', amount: 25 }), res, {
      gameServer: { getTableEngine: () => ({ addChips }) },
    });
    expect(state.status).toBe(200);
    expect(addChips).toHaveBeenCalledWith(actor, 25, undefined);
  });

  it('preserves amount validation before financial dispatch', async () => {
    const getTableEngine = vi.fn();
    const { res, state } = response();
    await handleAddchips(request({ tableId: 'table-1', amount: 25.001, opId: '12345678' }), res, {
      gameServer: { getTableEngine },
    });
    expect(state.status).toBe(400);
    expect(getTableEngine).not.toHaveBeenCalled();
  });
});

describe('insurance acceptance at the actual HTTP handler', () => {
  it.each([null, '25', '', false, {}, []].map((coveragePercent) => ({ coveragePercent })))(
    'refuses malformed supplied accept coverage $coveragePercent',
    async ({ coveragePercent }) => {
      const respondToInsurance = vi.fn(() => ({ success: true }));
      const getTableEngine = vi.fn(() => ({ respondToInsurance, previewInsurance: vi.fn() }));
      const { res, state } = response();
      await handleInsurance(
        request({ tableId: 'table-1', response: 'accept', coveragePercent }),
        res,
        { gameServer: { getTableEngine } }
      );
      expect(state.status).toBe(400);
      expect(state.body.success).toBe(false);
      expect(getTableEngine).not.toHaveBeenCalled();
      expect(respondToInsurance).not.toHaveBeenCalled();
    }
  );

  it('refuses finite JSON syntax whose numeric value overflows', async () => {
    const respondToInsurance = vi.fn(() => ({ success: true }));
    const getTableEngine = vi.fn(() => ({ respondToInsurance, previewInsurance: vi.fn() }));
    const { res, state } = response();
    await handleInsurance(
      request('{"tableId":"table-1","response":"accept","coveragePercent":1e309}', '/', true),
      res,
      { gameServer: { getTableEngine } }
    );
    expect(state.status).toBe(400);
    expect(getTableEngine).not.toHaveBeenCalled();
    expect(respondToInsurance).not.toHaveBeenCalled();
  });

  it.each([{ coveragePercent: 25 }, {}])(
    'preserves numeric and omitted acceptance %j',
    async (fields) => {
      const respondToInsurance = vi.fn(() => ({ success: true }));
      const { res, state } = response();
      await handleInsurance(request({ tableId: 'table-1', response: 'accept', ...fields }), res, {
        gameServer: { getTableEngine: () => ({ respondToInsurance, previewInsurance: vi.fn() }) },
      });
      expect(state.status).toBe(200);
      expect(respondToInsurance).toHaveBeenCalledWith(
        actor,
        'accept',
        fields.coveragePercent ?? 100,
        false
      );
    }
  );

  it.each(['decline', 'cashout'])(
    'preserves %s behavior even with irrelevant malformed coverage',
    async (action) => {
      const respondToInsurance = vi.fn(() => ({ success: true }));
      const { res, state } = response();
      await handleInsurance(
        request({
          tableId: 'table-1',
          response: action,
          coveragePercent: '25',
          declineForHand: true,
        }),
        res,
        {
          gameServer: { getTableEngine: () => ({ respondToInsurance, previewInsurance: vi.fn() }) },
        }
      );
      expect(state.status).toBe(200);
      expect(respondToInsurance).toHaveBeenCalledWith(actor, action, 100, true);
    }
  );

  it('preserves the current engine eligibility refusal', async () => {
    const receipt = { success: false, error: 'No pending offer' };
    const { res, state } = response();
    await handleInsurance(
      request({ tableId: 'table-1', response: 'accept', coveragePercent: 25 }),
      res,
      {
        gameServer: {
          getTableEngine: () => ({ respondToInsurance: () => receipt, previewInsurance: vi.fn() }),
        },
      }
    );
    expect(state.status).toBe(400);
    expect(state.body).toEqual(receipt);
  });
});

describe('insurance preview numeric parsing', () => {
  it.each(['abc', 'Infinity', '1e309'])('refuses nonfinite query value %s', async (value) => {
    const previewInsurance = vi.fn(() => ({ premium: 3 }));
    const getTableEngine = vi.fn(() => ({ respondToInsurance: vi.fn(), previewInsurance }));
    const { res, state } = response();
    await handleInsurancePreview(
      request({}, '/insurance-preview?tableId=table-1&coveragePercent=' + value),
      res,
      { gameServer: { getTableEngine } }
    );
    expect(state.status).toBe(400);
    expect(getTableEngine).not.toHaveBeenCalled();
    expect(previewInsurance).not.toHaveBeenCalled();
  });

  it.each([
    ['25', 25],
    ['', 100],
  ])('preserves parsed query value %s', async (value, expected) => {
    const previewInsurance = vi.fn(() => ({ premium: 3 }));
    const { res, state } = response();
    await handleInsurancePreview(
      request({}, '/insurance-preview?tableId=table-1&coveragePercent=' + value),
      res,
      {
        gameServer: { getTableEngine: () => ({ respondToInsurance: vi.fn(), previewInsurance }) },
      }
    );
    expect(state.status).toBe(200);
    expect(previewInsurance).toHaveBeenCalledWith(actor, expected);
  });
});

it('requires authenticated identity before reading a financial request', async () => {
  vi.mocked(authenticateRequest).mockResolvedValue(null);
  for (const handler of [handleAddchips, handleInsurance, handleInsurancePreview]) {
    const getTableEngine = vi.fn();
    const { res, state } = response();
    await handler(request({}), res, { gameServer: { getTableEngine } });
    expect(state.status).toBe(401);
    expect(getTableEngine).not.toHaveBeenCalled();
  }
});

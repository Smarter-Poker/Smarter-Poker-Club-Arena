import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), command: vi.fn(), status: vi.fn() }));
vi.mock('../http/auth.js', () => ({ authenticateRequest: mocks.auth }));
vi.mock('../maintenance/OperatorCommands.js', () => ({
  operatorCommand: mocks.command,
  operatorCommandStatus: mocks.status,
}));
import { handlePlatformControl } from './platformControl.js';
const id = '11111111-1111-4111-8111-111111111111';
async function request(body: unknown, method = 'POST') {
  const req = Readable.from([JSON.stringify(body)]) as any;
  Object.assign(req, { method, url: '/admin/platform-control', headers: {} });
  const result = { status: 0, body: '' };
  const res = {
    setHeader: vi.fn(),
    writeHead: (status: number) => {
      result.status = status;
    },
    end: (body: string) => {
      result.body = body;
    },
  } as any;
  const apply = vi.fn(async () => ({ observed: 1 }));
  await handlePlatformControl(req, res, { gameServer: { applyOperatorFloorCommand: apply } });
  return { ...result, apply };
}
describe('global engine commands prove authentication before reaching any owner', () => {
  it('refuses unauthenticated commands', async () => {
    mocks.auth.mockResolvedValueOnce(null);
    const r = await request({});
    expect(r.status).toBe(401);
    expect(r.apply).not.toHaveBeenCalled();
  });
  it('rejects malformed or oversized identities without dispatch', async () => {
    mocks.auth.mockResolvedValueOnce({ userId: id });
    const r = await request({ domain: 'floor', action: 'pause', operationId: id, reason: 'short' });
    expect(r.status).toBe(400);
    expect(r.apply).not.toHaveBeenCalled();
  });
  it('retains unknown on lost owning receipt', async () => {
    mocks.auth.mockResolvedValueOnce({ userId: id });
    mocks.command.mockRejectedValueOnce(Error('response lost'));
    const r = await request({
      domain: 'floor',
      action: 'pause',
      operationId: id,
      reason: 'Investigating table integrity',
    });
    expect(r.status).toBe(503);
    expect(r.apply).not.toHaveBeenCalled();
  });
  it('reports denied named scope without invoking the runtime owner', async () => {
    mocks.auth.mockResolvedValueOnce({ userId: id });
    mocks.command.mockRejectedValueOnce(Error('engine_operator_forbidden'));
    const r = await request({
      domain: 'floor',
      action: 'park',
      operationId: id,
      reason: 'Investigating table integrity',
    });
    expect(r.status).toBe(403);
    expect(r.apply).not.toHaveBeenCalled();
  });
  it('explicitly refuses unsafe maintenance phase without changing the owner', async () => {
    mocks.auth.mockResolvedValueOnce({ userId: id });
    mocks.command.mockRejectedValueOnce(
      Error('engine_operator_refused:maintenance_already_applied')
    );
    const r = await request({
      domain: 'maintenance',
      action: 'cancel',
      operationId: id,
      reason: 'Cancel the unapplied maintenance',
    });
    expect(r.status).toBe(409);
    expect(r.apply).not.toHaveBeenCalled();
  });
  it('dispatches only the persisted command and returns its readback', async () => {
    mocks.auth.mockResolvedValueOnce({ userId: id });
    const receipt = { id, domain: 'floor', action: 'pause', status: 'accepted' };
    mocks.command.mockResolvedValueOnce(receipt);
    mocks.status.mockResolvedValueOnce(receipt);
    const r = await request({
      domain: 'floor',
      action: 'pause',
      operationId: id,
      reason: 'Investigating table integrity',
    });
    expect(r.status).toBe(200);
    expect(r.apply).toHaveBeenCalledWith(receipt);
    expect(JSON.parse(r.body).command).toEqual(receipt);
  });
});

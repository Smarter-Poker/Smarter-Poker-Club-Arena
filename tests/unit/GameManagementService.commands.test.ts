import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  emit: vi.fn(),
  reportError: vi.fn(),
  commandId: '11111111-2222-4333-8444-555555555555',
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mocks.emit },
}));
vi.mock('../../src/utils/uuid', () => ({
  uuid: () => mocks.commandId,
}));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

import { gameManagementService } from '../../src/services/GameManagementService';

const success = {
  ok: true,
  command_id: mocks.commandId,
  command_status: 'succeeded',
  version_before: 4,
  version_after: 5,
  replayed: false,
};

describe('GameManagementService command execution', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.emit.mockReset();
    mocks.reportError.mockReset();
  });

  it('passes the reviewed version and returns the durable command receipt', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: success, error: null });

    const receipt = await gameManagementService.update(
      'table',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      { name: 'Friday Night' },
      4
    );

    expect(mocks.rpc).toHaveBeenCalledWith('fn_execute_managed_game_command', {
      p_command_id: mocks.commandId,
      p_kind: 'table',
      p_game_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      p_action: 'update',
      p_expected_version: 4,
      p_payload: expect.objectContaining({ name: 'Friday Night' }),
    });
    expect(receipt).toMatchObject({
      commandId: mocks.commandId,
      action: 'update',
      status: 'succeeded',
      versionBefore: 4,
      versionAfter: 5,
    });
    expect(mocks.emit).toHaveBeenCalledWith('TABLE_UPDATED', {
      tableId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
  });

  it('recovers a committed command when its original response is lost', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'Network disconnected' } })
      .mockResolvedValueOnce({
        data: { ok: true, found: true, receipt: { ...success, completed_at: '2026-09-01' } },
        error: null,
      });

    const receipt = await gameManagementService.close(
      'tournament',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      4
    );

    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'fn_get_managed_game_command_receipt', {
      p_command_id: mocks.commandId,
    });
    expect(mocks.reportError).toHaveBeenCalledWith(
      { message: 'Network disconnected' },
      'GameManagementService.executeCommand',
      expect.objectContaining({ commandId: mocks.commandId, attempt: 1 })
    );
    expect(receipt.replayed).toBe(true);
    expect(mocks.emit).toHaveBeenCalledWith('TOURNAMENT_CANCELLED', {
      tournamentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
  });

  it('retries an unconfirmed request once with the identical command UUID', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'Gateway unavailable' } })
      .mockResolvedValueOnce({ data: { ok: true, found: false }, error: null })
      .mockResolvedValueOnce({ data: { ...success, replayed: true }, error: null });

    await gameManagementService.close('table', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 4);

    const executions = mocks.rpc.mock.calls.filter(
      ([name]) => name === 'fn_execute_managed_game_command'
    );
    expect(executions).toHaveLength(2);
    expect(executions[0][1].p_command_id).toBe(mocks.commandId);
    expect(executions[1][1].p_command_id).toBe(mocks.commandId);
  });

  it('does not treat a malformed successful response as receipt evidence', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, found: false }, error: null })
      .mockResolvedValueOnce({ data: success, error: null });

    const receipt = await gameManagementService.update(
      'table',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      { name: 'Verified Name' },
      4
    );

    expect(receipt.status).toBe('succeeded');
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'GameManagementService.executeCommand',
      expect.objectContaining({ commandId: mocks.commandId, attempt: 1 })
    );
    expect(
      mocks.rpc.mock.calls.filter(([name]) => name === 'fn_execute_managed_game_command')
    ).toHaveLength(2);
  });

  it('reconciles when the RPC promise rejects instead of returning an error object', async () => {
    mocks.rpc.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce({
      data: { ok: true, found: true, receipt: { ...success, completed_at: '2026-09-01' } },
      error: null,
    });

    const receipt = await gameManagementService.close(
      'tournament',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      4
    );

    expect(receipt).toMatchObject({ status: 'succeeded', replayed: true });
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });

  it('does not accept an incomplete processing receipt as a finished command', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'Response lost' } })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          found: true,
          receipt: {
            ok: true,
            command_id: mocks.commandId,
            command_status: 'processing',
            version_before: 4,
            version_after: 4,
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: success, error: null });

    await expect(
      gameManagementService.close('table', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 4)
    ).resolves.toMatchObject({ status: 'succeeded' });
    expect(
      mocks.rpc.mock.calls.filter(([name]) => name === 'fn_execute_managed_game_command')
    ).toHaveLength(2);
  });

  it('surfaces stale-version rejection and emits no false success event', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: false,
        reason: 'stale_contract_version',
        command_id: mocks.commandId,
        command_status: 'rejected',
        version_before: 5,
        version_after: 5,
      },
      error: null,
    });
    await expect(
      gameManagementService.update(
        'table',
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        { name: 'Stale Name' },
        4
      )
    ).rejects.toThrow('This game changed after you opened it');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('maps the latest governed receipt for each management row', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        receipts: [
          {
            game_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            command_id: mocks.commandId,
            command_action: 'close',
            status: 'succeeded',
            contract_version_before: 7,
            contract_version_after: 7,
            reconciliation_state: 'confirmed',
            created_at: '2026-09-01T12:00:00Z',
            completed_at: '2026-09-01T12:00:01Z',
          },
        ],
      },
      error: null,
    });

    await expect(
      gameManagementService.getCommandReceipts('table', ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'])
    ).resolves.toEqual([
      expect.objectContaining({
        commandId: mocks.commandId,
        action: 'close',
        status: 'succeeded',
        versionBefore: 7,
        versionAfter: 7,
        reconciliationState: 'confirmed',
      }),
    ]);
  });

  it('maps an unknown receipt status as processing instead of a false success', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        receipts: [
          {
            game_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            command_id: mocks.commandId,
            command_action: 'update',
            status: 'legacy_unknown',
            contract_version_before: 4,
            contract_version_after: 4,
            reconciliation_state: 'confirmed',
          },
        ],
      },
      error: null,
    });

    await expect(
      gameManagementService.getCommandReceipts('table', ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'])
    ).resolves.toEqual([expect.objectContaining({ status: 'processing' })]);
  });

  it('maps the scoped management health snapshot', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          latest_event_sequence: 44,
          last_event_at: '2026-09-01T12:00:00Z',
          events_last_hour: 8,
          commands_last_24h: 5,
          rejected_last_24h: 1,
          integrity_alerts: 0,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          scheduled_pending: 2,
          scheduled_rejected_24h: 1,
          event_rows: 80,
          retention_days: 30,
        },
        error: null,
      });

    await expect(gameManagementService.getHealth('union', 'union-1')).resolves.toEqual({
      latestEventSequence: 44,
      lastEventAt: '2026-09-01T12:00:00Z',
      eventsLastHour: 8,
      commandsLast24h: 5,
      rejectedLast24h: 1,
      integrityAlerts: 0,
      scheduledPending: 2,
      scheduledRejected24h: 1,
      eventRows: 80,
      retentionDays: 30,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('fn_get_game_management_health', {
      p_scope: 'union',
      p_scope_id: 'union-1',
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  fetchClubDataExport,
  isClubDataExportAbort,
  type ClubDataExportProgress,
  type ClubDataExportRpc,
} from '../../src/utils/clubDataExport';

interface Row {
  id: string;
}

function isRow(value: unknown): value is Row {
  return Boolean(
    value && typeof value === 'object' && typeof (value as Record<string, unknown>).id === 'string'
  );
}

function result(data: unknown, error: unknown = null) {
  return Promise.resolve({ data, error });
}

describe('complete Club Data exports', () => {
  it('downloads every announced row in order and then deletes the server copy', async () => {
    const progress: ClubDataExportProgress[] = [];
    const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
      if (name === 'ca_club_game_export_start') {
        return result({ export_id: 'export-1', total_rows: 3, status: 'ready' });
      }
      if (name === 'ca_club_data_export_page' && args.p_offset === 0) {
        return result({
          rows: [{ id: 'a' }, { id: 'b' }],
          total_rows: 3,
          next_offset: 2,
          has_more: true,
        });
      }
      if (name === 'ca_club_data_export_page') {
        return result({ rows: [{ id: 'c' }], total_rows: 3, next_offset: 3, has_more: false });
      }
      return result(true);
    }) as ClubDataExportRpc;

    const rows = await fetchClubDataExport<Row>({
      rpc,
      startRpc: 'ca_club_game_export_start',
      startArgs: { p_club_id: 'club-1' },
      requestId: 'request-1',
      signal: new AbortController().signal,
      validateRow: isRow,
      rowKey: (row) => row.id,
      onProgress: (value) => progress.push(value),
      pageSize: 2,
    });

    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(progress).toEqual([
      { stage: 'preparing', loaded: 0, total: null },
      { stage: 'downloading', loaded: 0, total: 3 },
      { stage: 'downloading', loaded: 2, total: 3 },
      { stage: 'downloading', loaded: 3, total: 3 },
    ]);
    expect(rpc).toHaveBeenLastCalledWith('ca_club_data_export_cancel', {
      p_export_id: 'export-1',
    });
  });

  it('returns a complete export without waiting for best-effort cleanup', async () => {
    const cleanup = new Promise<never>(() => undefined);
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_club_game_export_start') {
        return result({ export_id: 'export-cleanup-stall', total_rows: 1, status: 'ready' });
      }
      if (name === 'ca_club_data_export_page') {
        return result({
          rows: [{ id: 'complete' }],
          total_rows: 1,
          next_offset: 1,
          has_more: false,
        });
      }
      return cleanup;
    }) as ClubDataExportRpc;

    await expect(
      fetchClubDataExport<Row>({
        rpc,
        startRpc: 'ca_club_game_export_start',
        startArgs: {},
        requestId: 'request-cleanup-stall',
        signal: new AbortController().signal,
        validateRow: isRow,
        rowKey: (row) => row.id,
      })
    ).resolves.toEqual([{ id: 'complete' }]);
    expect(rpc).toHaveBeenLastCalledWith('ca_club_data_export_cancel', {
      p_export_id: 'export-cleanup-stall',
    });
  });

  it('rejects a duplicate instead of silently writing a misleading partial file', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_club_game_export_start') {
        return result({ export_id: 'export-2', total_rows: 2, status: 'ready' });
      }
      if (name === 'ca_club_data_export_page') {
        return result({
          rows: [{ id: 'same' }, { id: 'same' }],
          total_rows: 2,
          next_offset: 2,
          has_more: false,
        });
      }
      return result(true);
    }) as ClubDataExportRpc;

    await expect(
      fetchClubDataExport<Row>({
        rpc,
        startRpc: 'ca_club_game_export_start',
        startArgs: {},
        requestId: 'request-2',
        signal: new AbortController().signal,
        validateRow: isRow,
        rowKey: (row) => row.id,
      })
    ).rejects.toThrow('duplicate');
    expect(rpc).toHaveBeenLastCalledWith('ca_club_data_export_cancel', {
      p_export_id: 'export-2',
    });
  });

  it('rejects a short final page as an invalid continuation', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_club_player_export_start') {
        return result({ export_id: 'export-3', total_rows: 2, status: 'ready' });
      }
      if (name === 'ca_club_data_export_page') {
        return result({ rows: [{ id: 'only' }], total_rows: 2, next_offset: 1, has_more: false });
      }
      return result(true);
    }) as ClubDataExportRpc;

    await expect(
      fetchClubDataExport<Row>({
        rpc,
        startRpc: 'ca_club_player_export_start',
        startArgs: {},
        requestId: 'request-3',
        signal: new AbortController().signal,
        validateRow: isRow,
        rowKey: (row) => row.id,
      })
    ).rejects.toThrow('invalid continuation');
  });

  it('rejects a non-advancing continuation before requesting the same page again', async () => {
    let pageRequests = 0;
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_club_player_export_start') {
        return result({ export_id: 'export-stalled', total_rows: 2, status: 'ready' });
      }
      if (name === 'ca_club_data_export_page') {
        pageRequests += 1;
        if (pageRequests > 1) throw new Error('requested the stalled page twice');
        return result({ rows: [], total_rows: 2, next_offset: 0, has_more: true });
      }
      return result(true);
    }) as ClubDataExportRpc;

    await expect(
      fetchClubDataExport<Row>({
        rpc,
        startRpc: 'ca_club_player_export_start',
        startArgs: {},
        requestId: 'request-stalled',
        signal: new AbortController().signal,
        validateRow: isRow,
        rowKey: (row) => row.id,
      })
    ).rejects.toThrow('invalid continuation');
    expect(pageRequests).toBe(1);
  });

  it('rejects malformed rows before deriving keys and still retires the server copy', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_club_player_export_start') {
        return result({ export_id: 'export-malformed', total_rows: 2, status: 'ready' });
      }
      if (name === 'ca_club_data_export_page') {
        return result({
          rows: [{ id: 'valid' }, { id: null }],
          total_rows: 2,
          next_offset: 2,
          has_more: false,
        });
      }
      return result(true);
    }) as ClubDataExportRpc;
    const rowKey = vi.fn((row: Row) => row.id);

    await expect(
      fetchClubDataExport<Row>({
        rpc,
        startRpc: 'ca_club_player_export_start',
        startArgs: {},
        requestId: 'request-malformed',
        signal: new AbortController().signal,
        validateRow: isRow,
        rowKey,
      })
    ).rejects.toThrow('malformed row');

    expect(rowKey).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenLastCalledWith('ca_club_data_export_cancel', {
      p_export_id: 'export-malformed',
    });
  });

  it('honours cancellation before starting a request', async () => {
    const controller = new AbortController();
    controller.abort();
    const rpc = vi.fn(() => result(null)) as ClubDataExportRpc;

    const promise = fetchClubDataExport<Row>({
      rpc,
      startRpc: 'ca_club_game_export_start',
      startArgs: {},
      requestId: 'request-4',
      signal: controller.signal,
      validateRow: isRow,
      rowKey: (row) => row.id,
    });

    await expect(promise).rejects.toSatisfy(isClubDataExportAbort);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('retires a server job whose preparation receipt arrives after cancellation', async () => {
    let resolveStart!: (value: { data: unknown; error: unknown }) => void;
    const lateStart = new Promise<{ data: unknown; error: unknown }>((resolve) => {
      resolveStart = resolve;
    });
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_club_game_export_start') return lateStart;
      return result(true);
    }) as ClubDataExportRpc;
    const controller = new AbortController();

    const promise = fetchClubDataExport<Row>({
      rpc,
      startRpc: 'ca_club_game_export_start',
      startArgs: {},
      requestId: 'request-late-cancel',
      signal: controller.signal,
      validateRow: isRow,
      rowKey: (row) => row.id,
    });
    controller.abort();
    resolveStart({
      data: { export_id: 'export-late', status: 'ready', total_rows: 1 },
      error: null,
    });

    await expect(promise).rejects.toSatisfy(isClubDataExportAbort);
    expect(rpc).toHaveBeenLastCalledWith('ca_club_data_export_cancel', {
      p_export_id: 'export-late',
    });
  });

  it('preserves the database authorization code for caller handling', async () => {
    const rpc = vi.fn(() =>
      result(null, { code: '42501', message: 'permission denied for export' })
    ) as ClubDataExportRpc;

    await expect(
      fetchClubDataExport<Row>({
        rpc,
        startRpc: 'ca_club_game_export_start',
        startArgs: {},
        requestId: 'request-auth',
        signal: new AbortController().signal,
        validateRow: isRow,
        rowKey: (row) => row.id,
      })
    ).rejects.toMatchObject({ code: '42501', message: 'permission denied for export' });
  });
});

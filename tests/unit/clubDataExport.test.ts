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
        rowKey: (row) => row.id,
      })
    ).rejects.toThrow('duplicate');
    expect(rpc).toHaveBeenLastCalledWith('ca_club_data_export_cancel', {
      p_export_id: 'export-2',
    });
  });

  it('rejects a short final page rather than treating it as a complete export', async () => {
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
        rowKey: (row) => row.id,
      })
    ).rejects.toThrow('delivered 1 of 2');
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
      rowKey: (row) => row.id,
    });

    await expect(promise).rejects.toSatisfy(isClubDataExportAbort);
  });
});

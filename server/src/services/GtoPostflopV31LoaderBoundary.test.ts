// PREPARED ONLY. Select in services/ of the complete candidate source root.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn() }));
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: transport.rpc } }));
vi.mock('./errorReporter.js', () => ({ reportError: transport.report }));
import {
  loadGtoPostflopV31,
  loadGtoPostflopV31Evaluation,
  stopGtoPostflopV31Loader,
} from './GtoPostflopV31Loader.js';
import {
  _clearGtoPostflopV31,
  gtoPostflopV31Count,
  gtoPostflopV31Dataset,
  gtoPostflopV31EvaluationCount,
  gtoStreetAdviceV31,
  replaceGtoPostflopV31,
  replaceGtoPostflopV31Evaluation,
} from '../engine/GtoPostflopV31.js';
import { CELL, evaluationCell, pagedCells } from './V31LoaderFixture.js';

beforeEach(() => {
  transport.rpc.mockReset();
  transport.report.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  _clearGtoPostflopV31();
  expect(replaceGtoPostflopV31([structuredClone(CELL)])).toBe(1);
});
afterEach(() => {
  stopGtoPostflopV31Loader();
  _clearGtoPostflopV31();
  vi.restoreAllMocks();
});

function liveUnchanged() {
  expect(gtoPostflopV31Count()).toBe(1);
  expect(gtoPostflopV31Dataset()).toEqual({ id: CELL.dataset_id, checksum: CELL.dataset_checksum });
}

describe('actual V31 loader transport boundaries', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
    ['empty-looking object', { length: 0 }],
    ['empty string', ''],
    ['false', false],
  ])('preserves the real active snapshot on non-array %s', async (_label, data) => {
    transport.rpc.mockResolvedValueOnce({ data, error: null });
    await expect(loadGtoPostflopV31()).resolves.toBe(0);
    liveUnchanged();
    expect(transport.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'v31_cell_page_not_array' }),
      'GtoPostflopV31Loader.load'
    );
    expect(transport.rpc).toHaveBeenCalledTimes(1);
  });

  it('an actual empty array clears only the live store', async () => {
    const candidate = evaluationCell();
    expect(replaceGtoPostflopV31Evaluation([candidate])).toBe(1);
    transport.rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(loadGtoPostflopV31()).resolves.toBe(0);
    expect(gtoPostflopV31Count()).toBe(0);
    expect(gtoPostflopV31Dataset()).toBeNull();
    expect(gtoPostflopV31EvaluationCount(candidate.dataset_checksum)).toBe(1);
    expect(transport.report).not.toHaveBeenCalled();
  });

  it('loads an actual valid replacement through the full store validator', async () => {
    const row = {
      ...structuredClone(CELL),
      dataset_id: evaluationCell().dataset_id,
      dataset_checksum: '8'.repeat(64),
    };
    transport.rpc.mockResolvedValueOnce({ data: [row], error: null });
    await expect(loadGtoPostflopV31()).resolves.toBe(1);
    expect(gtoPostflopV31Dataset()).toEqual({ id: row.dataset_id, checksum: row.dataset_checksum });
    expect(transport.rpc).toHaveBeenCalledWith('fn_gto_v31_active_cells', {
      p_offset: 0,
      p_limit: 500,
    });
    expect(transport.report).not.toHaveBeenCalled();
  });

  it('does not turn an error with empty data into an empty success', async () => {
    transport.rpc.mockResolvedValueOnce({ data: [], error: { message: 'synthetic_rpc_failure' } });
    await expect(loadGtoPostflopV31()).resolves.toBe(0);
    liveUnchanged();
    expect(transport.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'synthetic_rpc_failure' }),
      'GtoPostflopV31Loader.load'
    );
  });

  it('retains the original rejection and stored snapshot', async () => {
    const failure = new Error('synthetic_transport_rejection');
    transport.rpc.mockRejectedValueOnce(failure);
    await expect(loadGtoPostflopV31()).resolves.toBe(0);
    liveUnchanged();
    expect(transport.report).toHaveBeenCalledWith(failure, 'GtoPostflopV31Loader.load');
  });

  it.each([[null], [false], ['row'], [[]]])(
    'rejects malformed row %j before store replacement',
    async (row) => {
      transport.rpc.mockResolvedValueOnce({ data: [row], error: null });
      await expect(loadGtoPostflopV31()).resolves.toBe(0);
      liveUnchanged();
      expect(transport.report).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'v31_cell_page_row_invalid' }),
        'GtoPostflopV31Loader.load'
      );
    }
  );

  it('rejects an oversized page before another request or swap', async () => {
    transport.rpc.mockResolvedValueOnce({ data: pagedCells(501), error: null });
    await expect(loadGtoPostflopV31()).resolves.toBe(0);
    liveUnchanged();
    expect(transport.rpc).toHaveBeenCalledTimes(1);
    expect(transport.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'v31_cell_page_overflow' }),
      'GtoPostflopV31Loader.load'
    );
  });

  it('still rejects a structurally valid page with an invalid policy row', async () => {
    const row = { ...structuredClone(CELL), invalid_rows: 1 };
    transport.rpc.mockResolvedValueOnce({ data: [row], error: null });
    await expect(loadGtoPostflopV31()).resolves.toBe(0);
    liveUnchanged();
    expect(transport.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'v31_uncertified_or_malformed_cell' }),
      'GtoPostflopV31Loader.load'
    );
  });

  it('loads a complete two-page dataset without replacing between pages', async () => {
    const rows = pagedCells(501);
    transport.rpc
      .mockResolvedValueOnce({ data: rows.slice(0, 500), error: null })
      .mockImplementationOnce(async () => {
        liveUnchanged();
        return { data: rows.slice(500), error: null };
      });
    await expect(loadGtoPostflopV31()).resolves.toBe(501);
    expect(gtoPostflopV31Count()).toBe(501);
    expect(transport.rpc).toHaveBeenNthCalledWith(2, 'fn_gto_v31_active_cells', {
      p_offset: 500,
      p_limit: 500,
    });
  });

  it('refuses a null terminal page even after an otherwise complete first page', async () => {
    transport.rpc
      .mockResolvedValueOnce({ data: pagedCells(500), error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    await expect(loadGtoPostflopV31()).resolves.toBe(0);
    liveUnchanged();
    expect(transport.rpc).toHaveBeenCalledTimes(2);
    expect(transport.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'v31_cell_page_not_array' }),
      'GtoPostflopV31Loader.load'
    );
  });

  it('accepts a real empty terminal page after exactly 500 complete rows', async () => {
    transport.rpc
      .mockResolvedValueOnce({ data: pagedCells(500), error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    await expect(loadGtoPostflopV31()).resolves.toBe(500);
    expect(gtoPostflopV31Count()).toBe(500);
    expect(transport.report).not.toHaveBeenCalled();
  });

  it('still refuses incomplete successful pagination through the actual validator', async () => {
    transport.rpc
      .mockResolvedValueOnce({ data: pagedCells(501).slice(0, 500), error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    await expect(loadGtoPostflopV31()).resolves.toBe(0);
    liveUnchanged();
    expect(transport.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'v31_incomplete_dataset:expected=501:actual=500' }),
      'GtoPostflopV31Loader.load'
    );
  });

  it('admits only the requested evaluation identity and preserves live policy', async () => {
    const row = evaluationCell();
    transport.rpc.mockResolvedValueOnce({ data: [row], error: null });
    await expect(loadGtoPostflopV31Evaluation(row.dataset_id)).resolves.toEqual({
      checksum: row.dataset_checksum,
      cells: 1,
    });
    expect(gtoPostflopV31EvaluationCount(row.dataset_checksum)).toBe(1);
    liveUnchanged();
    expect(transport.rpc).toHaveBeenCalledWith('fn_gto_v31_evaluation_cells', {
      p_dataset_id: row.dataset_id,
      p_offset: 0,
      p_limit: 500,
    });
  });

  it('refuses a valid but different evaluation dataset without overwriting prior cells', async () => {
    const requested = evaluationCell();
    expect(replaceGtoPostflopV31Evaluation([requested])).toBe(1);
    const readStored = () =>
      gtoStreetAdviceV31({
        street: 'turn',
        family: 'cash',
        objective: 'cash_ev',
        utilityContext: 'cash_ev',
        tableSize: 2,
        potType: 'limped',
        heroPosition: 'SB',
        opponentPosition: 'BB',
        stackBB: 80,
        board: [
          { rank: 'Q', suit: 'hearts' },
          { rank: '9', suit: 'diamonds' },
          { rank: '7', suit: 'clubs' },
          { rank: '2', suit: 'hearts' },
        ],
        hand: 'AKs',
        holeCards: [
          { rank: 'A', suit: 'spades' },
          { rank: 'K', suit: 'spades' },
        ],
        nodeRole: 'barrel',
        facingKind: 'none',
        facingSizeBucket: 'none',
        datasetChecksum: requested.dataset_checksum,
      });
    const retained = structuredClone(readStored());
    expect(retained.hit).toBe(true);
    const foreign = {
      ...evaluationCell(CELL.dataset_id),
      hand_matrix: {
        'AKs:22': { c: 1, b262: 0 },
        'AKs:00': { c: 0, b262: 1 },
      },
    };
    transport.rpc.mockResolvedValueOnce({ data: [foreign], error: null });
    await expect(loadGtoPostflopV31Evaluation(requested.dataset_id)).rejects.toThrow(
      'v31_evaluation_dataset_mismatch'
    );
    expect(gtoPostflopV31EvaluationCount(requested.dataset_checksum)).toBe(1);
    liveUnchanged();
    expect(readStored()).toEqual(retained);
  });

  it.each([[null], [[]], [{}], [1]])(
    'refuses a non-string evaluation request %j without RPC',
    async (value) => {
      await expect(loadGtoPostflopV31Evaluation(value as unknown as string)).rejects.toThrow(
        'invalid V31 evaluation dataset id'
      );
      expect(transport.rpc).not.toHaveBeenCalled();
      liveUnchanged();
    }
  );

  it('refuses a singleton UUID array without coercing it into a request', async () => {
    await expect(
      loadGtoPostflopV31Evaluation([evaluationCell().dataset_id] as unknown as string)
    ).rejects.toThrow('invalid V31 evaluation dataset id');
    expect(transport.rpc).not.toHaveBeenCalled();
    liveUnchanged();
  });

  it.each([null, { length: 0 }, ''])('refuses non-array evaluation data %j', async (data) => {
    const row = evaluationCell();
    transport.rpc.mockResolvedValueOnce({ data, error: null });
    await expect(loadGtoPostflopV31Evaluation(row.dataset_id)).rejects.toThrow(
      'v31_cell_page_not_array'
    );
    expect(gtoPostflopV31EvaluationCount(row.dataset_checksum)).toBe(0);
    liveUnchanged();
  });

  it('requires nonempty evaluation cells even with an authoritative empty response', async () => {
    const row = evaluationCell();
    transport.rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(loadGtoPostflopV31Evaluation(row.dataset_id)).rejects.toThrow(
      'V31 evaluation dataset returned no cells'
    );
    expect(gtoPostflopV31EvaluationCount(row.dataset_checksum)).toBe(0);
    liveUnchanged();
  });

  it('checks evaluation identity on the second page before admitting any cells', async () => {
    const rows = pagedCells(501, true);
    transport.rpc
      .mockResolvedValueOnce({ data: rows.slice(0, 500), error: null })
      .mockResolvedValueOnce({
        data: [{ ...rows[500], dataset_id: CELL.dataset_id }],
        error: null,
      });
    await expect(loadGtoPostflopV31Evaluation(rows[0].dataset_id)).rejects.toThrow(
      'v31_evaluation_dataset_mismatch'
    );
    expect(gtoPostflopV31EvaluationCount(rows[0].dataset_checksum)).toBe(0);
    liveUnchanged();
    expect(transport.rpc).toHaveBeenCalledTimes(2);
  });
});

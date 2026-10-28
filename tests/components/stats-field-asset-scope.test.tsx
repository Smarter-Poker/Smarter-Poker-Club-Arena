import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BenchmarkPanel from '../../src/components/stats/BenchmarkPanel';

const reads = vi.hoisted(() => ({ distribution: vi.fn() }));
vi.mock('../../src/services/StatsFactsService', () => ({
  default: { getDistribution: reads.distribution },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const row = (cohort: string, size: number) => ({
  cohort,
  metric: 'bb100',
  p10: -50,
  p25: -25,
  p50: 0,
  p75: 10,
  p90: 20,
  sample_size: size,
});

describe('comparison asset provenance', () => {
  it('reads the selected asset and never paints old ranks during an asset change', async () => {
    let complete!: (value: any) => void;
    reads.distribution
      .mockResolvedValueOnce({ rows: [row('field:chips', 91)] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          })
      );
    const view = render(<BenchmarkPanel scope="chips" values={{ bb100: 10 }} />);
    expect(await screen.findByText('Compared With 91 Players.')).toBeInTheDocument();
    expect(reads.distribution).toHaveBeenLastCalledWith('field:chips');
    view.rerender(<BenchmarkPanel scope="diamonds" values={{ bb100: 10 }} />);
    expect(screen.queryByText('Compared With 91 Players.')).not.toBeInTheDocument();
    await waitFor(() => expect(reads.distribution).toHaveBeenLastCalledWith('field:diamonds'));
    complete({ rows: [row('field:diamonds', 37)] });
    expect(await screen.findByText('Compared With 37 Players.')).toBeInTheDocument();
  });

  it('reports absent asset cohorts explicitly without inventing a rank', async () => {
    reads.distribution.mockResolvedValue({ rows: [] });
    render(<BenchmarkPanel scope="diamonds" values={{ bb100: 10 }} />);
    expect(
      await screen.findByText('Comparable Field Data Is Not Yet Available For This Asset.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Top 10%/)).not.toBeInTheDocument();
  });
});

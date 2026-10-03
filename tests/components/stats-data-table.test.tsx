import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import StatsDataTable from '../../src/components/stats/StatsDataTable';

describe('Stats chart data tables', () => {
  it('opens from a keyboard-native disclosure and exposes the same rows as a semantic table', () => {
    render(
      <StatsDataTable
        caption="Daily Cash Results"
        rows={[{ date: 'Oct 3', profit: 125 }]}
        rowKey={(row) => row.date}
        columns={[
          { key: 'date', label: 'Date', render: (row) => row.date },
          { key: 'profit', label: 'Profit', render: (row) => row.profit },
        ]}
      />
    );
    const disclosure = screen.getByText('Show Data Table');
    expect(disclosure.tagName).toBe('SUMMARY');
    fireEvent.click(disclosure);
    const table = screen.getByRole('table', { name: 'Daily Cash Results' });
    expect(within(table).getByRole('columnheader', { name: 'Profit' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Oct 3' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: '125' })).toBeInTheDocument();
  });

  it('wires every audited chart to a same-data table and keeps the phone overflow contained', () => {
    const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8');
    for (const file of [
      'src/components/stats/StatsCharts.tsx',
      'src/components/stats/PositionWinRates.tsx',
      'src/components/stats/EVLuckChart.tsx',
    ]) {
      expect(read(file), file).toContain('<StatsDataTable');
    }
    expect(read('src/components/stats/PositionalRadar.tsx')).toContain(
      '<caption className="sr-only">Positional Shape Data</caption>'
    );
    const css = read('src/components/stats/StatsDataTable.css');
    expect(css).toMatch(/overflow-x:\s*auto/);
    expect(css).toMatch(/@media \(max-width: 390px\)/);
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).not.toContain(':hover');
  });
});

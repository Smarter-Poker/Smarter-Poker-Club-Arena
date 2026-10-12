import type { ReactNode } from 'react';
import './StatsDataTable.css';

export interface StatsDataColumn<Row> {
  key: string;
  label: string;
  render: (row: Row) => ReactNode;
}

interface Props<Row> {
  caption: string;
  columns: Array<StatsDataColumn<Row>>;
  rows: Row[];
  rowKey: (row: Row, index: number) => string;
}

export default function StatsDataTable<Row>({ caption, columns, rows, rowKey }: Props<Row>) {
  if (rows.length === 0) return null;
  return (
    <details className="stats-data-table">
      <summary>Show Data Table</summary>
      <div className="stats-data-table__scroll" tabIndex={0} aria-label={`${caption} Table`}>
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th scope="col" key={column.key}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={rowKey(row, index)}>
                {columns.map((column, columnIndex) =>
                  columnIndex === 0 ? (
                    <th scope="row" key={column.key}>
                      {column.render(row)}
                    </th>
                  ) : (
                    <td key={column.key}>{column.render(row)}</td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

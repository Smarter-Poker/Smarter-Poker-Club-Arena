const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/AdvancedFilters.tsx', 'utf8');

code = code.replace(
  "export function AdvancedFilters({",
  `export function AdvancedFilters({
  sortKey,
  onSortChange,
  sortOptions,`
);

code = code.replace(
  "onApply: (v: FilterStore) => void;",
  `onApply: (v: FilterStore) => void;
  sortKey?: string;
  onSortChange?: (k: any) => void;
  sortOptions?: { key: string; label: string }[];`
);

const sortSection = `
              {sortOptions && onSortChange && (
                <section className="afx-section">
                  <h3>Sort By</h3>
                  <div className="afx-chips">
                    {sortOptions.map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        className={\`afx-chip \${sortKey === opt.key ? 'is-on' : ''}\`}
                        aria-pressed={sortKey === opt.key}
                        onClick={() => onSortChange(opt.key)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </section>
              )}
`;

code = code.replace(
  /<div className="afx-body">/g,
  `<div className="afx-body">\n${sortSection}`
);

fs.writeFileSync('src/components/lobby/AdvancedFilters.tsx', code);

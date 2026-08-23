const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/AdvancedFilters.tsx', 'utf8');

code = code.replace(
  "export default function AdvancedFilters({",
  `export default function AdvancedFilters({
  sortKey,
  onSortChange,
  sortOptions,`
);

code = code.replace(
  "onApply: (store: FilterStore) => void;",
  `onApply: (store: FilterStore) => void;
  sortKey?: string;
  onSortChange?: (k: any) => void;
  sortOptions?: { key: string; label: string }[];`
);

// If the previous patch failed, this will add it. If it succeeded, it might have added it twice? 
// Let's check if the `sortSection` is there.
if (!code.includes("<h3>Sort By</h3>")) {
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
}

fs.writeFileSync('src/components/lobby/AdvancedFilters.tsx', code);

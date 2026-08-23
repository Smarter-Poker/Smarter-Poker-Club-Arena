const fs = require('fs');
let code = fs.readFileSync('src/pages/ClubHomePage.tsx', 'utf8');

// Replace onApply with the new props
code = code.replace(
  "onApply={setAdvFilters}",
  "onApply={setAdvFilters}\n          sortKey={sortKey}\n          onSortChange={setSortKey}\n          sortOptions={SORT_OPTIONS}"
);

// We want the Filters button to be shown EVEN ON ALL because it now contains Sort.
code = code.replace(
  /\{\s*gameType !== 'ALL' && \(\s*<button[\s\S]*?className={`game-bar__filter-btn[\s\S]*?<\/button>\s*\)\s*\}/,
  `<button
            className={\`game-bar__filter-btn \${(() => {
              if (gameType === 'ALL') return sortKey !== 'recommended' ? 'is-set' : '';
              const fSpec = FILTER_SPECS[gameType as Exclude<FilterGameType, 'ALL'>];
              const fVal = advFilters[gameType as FilterGameType];
              const isFilt = fSpec && fVal && isFilterActive(fSpec, fVal);
              return isFilt || (sortKey !== 'recommended') ? 'is-set' : '';
            })()}\`}
            aria-label="Filters and Sort"
            title="Filters and Sort"
            onClick={() => {
              haptic.light();
              setSortOpen(false);
              setFiltersOpen(true);
            }}
          >
            <IconSort />
            <span>Filters</span>
          </button>`
);

// Remove the sort block
code = code.replace(/<div className="game-bar__sort">[\s\S]*?<\/ul>\s*<\/>\s*\)\}\s*<\/div>/, '');

fs.writeFileSync('src/pages/ClubHomePage.tsx', code);

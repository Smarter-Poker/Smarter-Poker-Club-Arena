const fs = require('fs');
let code = fs.readFileSync('src/pages/CashierTradePage.tsx', 'utf8');

// Add visibleCount state
code = code.replace(
  'const [selected, setSelected] = useState<Set<string>>(new Set());',
  'const [selected, setSelected] = useState<Set<string>>(new Set());\n  const [visibleCount, setVisibleCount] = useState(25);'
);

// Reset visibleCount on search/filter changes
code = code.replace(
  /const list = useMemo\(\(\) => \{/,
  'useEffect(() => { setVisibleCount(25); }, [search, filterRole, sortMode]);\n\n  const list = useMemo(() => {'
);

// Modify the rendering
code = code.replace(
  /list\.map\(\(r\) => \(/,
  'list.slice(0, visibleCount).map((r) => ('
);

// Add Load More button
code = code.replace(
  /(\{\/\*\n\s*Gated on !loading\..*?\n\s*\*\/\}\n\s*\{!loading &&\n\s*!loadError &&\n\s*list\.slice\(0, visibleCount\)\.map\(\(r\) => \([\s\S]*?<\/div>\n\s*\)\)} )/g,
  `$1\n            {!loading && !loadError && visibleCount < list.length && (\n              <button className={styles.loadMoreBtn} onClick={() => setVisibleCount(c => c + 25)}>Load More</button>\n            )}`
);

// Replace "Available Chips" text
code = code.replace(
  /<span className=\{styles\.stripLabel\}>Available Chips<\/span>/g,
  '<span className={styles.stripLabel}>{effectiveVariant === \'union\' ? \'Union Bank\' : \'Club Bank\'}</span>'
);

fs.writeFileSync('src/pages/CashierTradePage.tsx', code);

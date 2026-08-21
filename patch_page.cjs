const fs = require('fs');
let code = fs.readFileSync('src/pages/LeaderboardPage.tsx', 'utf8');

if (!code.includes('const [searchQuery, setSearchQuery] = useState')) {
  code = code.replace(
    `  const [finalizeLoading, setFinalizeLoading] = useState(false);`,
    `  const [finalizeLoading, setFinalizeLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');`
  );
  
  code = code.replace(
    `const top3 = entries.slice(0, 3);
  const rest = entries.slice(3);`,
    `const filteredEntries = entries.filter((e) => 
    !searchQuery || e.username.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const top3 = filteredEntries.slice(0, 3);
  const rest = filteredEntries.slice(3);`
  );

  code = code.replace(
    `        <div className="filter-group scope-toggle">`,
    `        {/* Search Bar */}
        <div className="filter-group">
          <input
            type="text"
            className="lb-search-input"
            placeholder="Search players..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: '6px 12px',
              borderRadius: '8px',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              background: 'rgba(0, 0, 0, 0.3)',
              color: '#fff',
              fontSize: '14px',
              width: '180px'
            }}
          />
        </div>
        
        {/* Scope Toggle */}`
  );
  fs.writeFileSync('src/pages/LeaderboardPage.tsx', code);
}

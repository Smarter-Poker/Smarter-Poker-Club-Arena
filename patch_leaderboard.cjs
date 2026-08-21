const fs = require('fs');
const file = '/tmp/CA_LATEST/src/pages/LeaderboardPage.tsx';
let content = fs.readFileSync(file, 'utf8');

// 1. Add searchQuery state
content = content.replace(
  `const [metric, setMetric] = useState<LeaderboardMetric>('profit');`,
  `const [metric, setMetric] = useState<LeaderboardMetric>('profit');\n  const [searchQuery, setSearchQuery] = useState('');`
);

// 2. Add search bar to JSX
content = content.replace(
  `<div\n          className="export-container"`,
  `        <div className="filter-group lb-search-bar" style={{ padding: '0 1.5rem', marginBottom: '1rem' }}>
          <input 
            type="text" 
            placeholder="Search players..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 16px',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(0,0,0,0.4)',
              color: 'white',
              fontSize: '14px',
              outline: 'none',
              transition: 'all 0.2s ease',
            }}
          />
        </div>

        <div\n          className="export-container"`
);

// 3. Update top3 / rest logic
content = content.replace(
  `  const top3 = entries.slice(0, 3);\n  const rest = entries.slice(3);`,
  `  const filteredEntries = entries.filter((e) =>\n    e.username?.toLowerCase().includes(searchQuery.toLowerCase())\n  );\n  const isSearching = searchQuery.trim().length > 0;\n  const top3 = isSearching ? [] : filteredEntries.slice(0, 3);\n  const rest = isSearching ? filteredEntries : filteredEntries.slice(3);\n\n  const filteredTournamentStats = tournamentStats.filter((s) =>\n    s.username?.toLowerCase().includes(searchQuery.toLowerCase())\n  );`
);

// 4. Update top3 map to motion.div
content = content.replace(
  `top3.map((entry, index) => (
                <div
                  key={entry.userId}
                  className={\`leaderboard-entry \${entry.userId === user?.id ? 'current-user' : ''}\`}
                  onClick={() => navigate(\`/profile/\${entry.userId}\`)}
                  style={{ ...rankingRowAnimationStyle(index), cursor: 'pointer' }}
                >`,
  `top3.map((entry, index) => (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05, duration: 0.3 }}
                  key={entry.userId}
                  className={\`leaderboard-entry \${entry.userId === user?.id ? 'current-user' : ''}\`}
                  onClick={() => navigate(\`/profile/\${entry.userId}\`)}
                  style={{ cursor: 'pointer' }}
                >`
);
// replace closing div
content = content.replace(
  `                  <div className={\`entry-value \${entry.value >= 0 ? 'positive' : 'negative'}\`}>
                    {formatValue(entry.value, metric)}
                    {renderChangeBadge(entry.change)}
                  </div>
                </div>
              ))}

            {/* ── REMAINING RANKINGS (4th+) ── */}`,
  `                  <div className={\`entry-value \${entry.value >= 0 ? 'positive' : 'negative'}\`}>
                    {formatValue(entry.value, metric)}
                    {renderChangeBadge(entry.change)}
                  </div>
                </motion.div>
              ))}

            {/* ── REMAINING RANKINGS (4th+) ── */}`
);

// 5. Update rest map to motion.div
content = content.replace(
  `            {rest.map((entry, index) => (
              <div
                key={entry.userId}
                className={\`leaderboard-entry \${entry.userId === user?.id ? 'current-user' : ''}\`}
                onClick={() => navigate(\`/profile/\${entry.userId}\`)}
                onKeyDown={rowKeyActivate(entry.userId)}
                role="button"
                tabIndex={0}
                aria-label={\`\${getRankLabel(entry.rank)} \${entry.username}, \${formatValue(entry.value, metric)}\`}
                style={{ ...rankingRowAnimationStyle(index), cursor: 'pointer' }}
              >`,
  `            {rest.map((entry, index) => (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: (isSearching ? index : index + 3) * 0.05, duration: 0.3 }}
                key={entry.userId}
                className={\`leaderboard-entry \${entry.userId === user?.id ? 'current-user' : ''}\`}
                onClick={() => navigate(\`/profile/\${entry.userId}\`)}
                onKeyDown={rowKeyActivate(entry.userId)}
                role="button"
                tabIndex={0}
                aria-label={\`\${getRankLabel(entry.rank)} \${entry.username}, \${formatValue(entry.value, metric)}\`}
                style={{ cursor: 'pointer' }}
              >`
);

content = content.replace(
  `                  {renderRowContext(entry)}
                </div>
                <div className={\`entry-value \${entry.value >= 0 ? 'positive' : 'negative'}\`}>
                  {formatValue(entry.value, metric)}
                  {renderChangeBadge(entry.change)}
                </div>
              </div>
            ))}`,
  `                  {renderRowContext(entry)}
                </div>
                <div className={\`entry-value \${entry.value >= 0 ? 'positive' : 'negative'}\`}>
                  {formatValue(entry.value, metric)}
                  {renderChangeBadge(entry.change)}
                </div>
              </motion.div>
            ))}`
);

// 6. Update tournament map to motion.div
content = content.replace(
  `        ) : activeTab === 'tournaments' && tournamentStats.length > 0 ? (
          <>
            {tournamentStats.map((stat, index) => (
              <div
                key={stat.userId}
                className="leaderboard-entry tournament-entry"
                onClick={() => navigate(\`/profile/\${stat.userId}\`)}
                style={{ ...rankingRowAnimationStyle(index), cursor: 'pointer' }}
              >`,
  `        ) : activeTab === 'tournaments' && filteredTournamentStats.length > 0 ? (
          <>
            {filteredTournamentStats.map((stat, index) => (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05, duration: 0.3 }}
                key={stat.userId}
                className="leaderboard-entry tournament-entry"
                onClick={() => navigate(\`/profile/\${stat.userId}\`)}
                style={{ cursor: 'pointer' }}
              >`
);

content = content.replace(
  `                  <span className="t-stat">
                    <span>Final Tables</span>
                    <strong>{stat.finalTables}</strong>
                  </span>
                </div>
              </div>
            ))}`,
  `                  <span className="t-stat">
                    <span>Final Tables</span>
                    <strong>{stat.finalTables}</strong>
                  </span>
                </div>
              </motion.div>
            ))}`
);

fs.writeFileSync(file, content, 'utf8');

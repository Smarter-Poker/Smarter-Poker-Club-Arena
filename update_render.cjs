const fs = require('fs');

const file = 'src/pages/ClubHomePage.tsx';
let code = fs.readFileSync(file, 'utf8');

const replacement = `
      {/* ═══════════════════════════════════════════════════════════════════════════════
                GAMES GRID - Tables & Create New Table Button
            ═══════════════════════════════════════════════════════════════════════════════ */}
      <div className="club-home__games">
        {GAME_TYPE_TABS.filter(tab => tab.key !== 'ALL').map((tab) => {
          // If we are filtering by a specific game type, only show that section
          if (gameType !== 'ALL' && gameType !== tab.key) return null;

          // Find items for this section
          const sectionTournaments = filteredTournaments.filter(t => {
            const tName = (t.name || '').toLowerCase();
            const isSpin = tName.includes('spin');
            const isSNG = !isSpin && (tName.includes('sng') || t.max_players <= 10);
            
            if (tab.key === 'SPIN') return isSpin;
            if (tab.key === 'SNG') return isSNG;
            if (tab.key === 'MTT') return !isSpin && !isSNG;
            return false;
          });

          const sectionTables = filteredTables.filter(t => {
            const kind = cashKind(t);
            return kind === tab.key;
          });

          // Only render section if it has items OR if we are explicitly on this tab
          // Wait, if we are on ALL, maybe only render if it has items OR if user is owner so they can create?
          const canCreate = (isOwner || userRole === 'admin') && !isInUnion;
          
          if (!canCreate && sectionTournaments.length === 0 && sectionTables.length === 0) {
             // Don't render empty sections on ALL tab for players
             if (gameType === 'ALL') return null;
          }
          
          // Actually, if we are on 'ALL', it might be cleaner to just render the section if there's games or if they can create.
          // Let's render the header and the create button for the section.

          return (
            <div key={tab.key} className="game-section" style={{ marginBottom: '24px' }}>
              {(gameType === 'ALL') && (
                <h2 style={{ color: '#fff', fontSize: '1.2rem', marginBottom: '12px', paddingLeft: '4px' }}>{tab.label}</h2>
              )}
              
              {canCreate && (
                <div
                  className="create-table-card"
                  style={{ cursor: 'pointer', marginBottom: '12px' }}
                  onClick={() => {
                    if (['MTT', 'SNG', 'SPIN'].includes(tab.key)) {
                      setShowCreateTournament(true);
                    } else {
                      navigate(\`/clubs/\${clubId}/create-table\`);
                    }
                  }}
                >
                  <div className="create-table-card__table">
                    <div className="new-badge">NEW</div>
                    <div className="plus-icon">+</div>
                  </div>
                  <span className="create-table-card__label">CREATE NEW TABLE +</span>
                </div>
              )}

              {sectionTournaments.map((tournament, idx) => {
                const tName = (tournament.name || '').toLowerCase();
                const isSNG = tName.includes('sng') || tournament.max_players <= 10;
                const isSpin = tName.includes('spin');

                return (
                  <div
                    key={tournament.id}
                    style={{
                      animation: \`slideInUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) \${cardDelay(idx)} both\`,
                      marginBottom: '12px'
                    }}
                  >
                    {isSpin && <SpinCard tournament={tournament} onQuickJoin={spinQuickJoin} />}
                    {isSNG && !isSpin && (
                      <SNGCard tournament={tournament} onQuickJoin={(t) => spinQuickJoin(t, 'sng')} />
                    )}
                    {!isSpin && !isSNG && <TournamentCard tournament={tournament} />}
                  </div>
                );
              })}

              {sectionTables.map((table, idx) => {
                const staggerIdx = sectionTournaments.length + idx;
                return (
                  <div
                    key={table.id}
                    style={{
                      animation: \`slideInUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) \${cardDelay(staggerIdx)} both\`,
                      marginBottom: '12px'
                    }}
                  >
                    <CashGameCard
                      table={table}
                      isAdmin={isOwner || userRole === 'admin'}
                      waitlisted={waitlistedTableIds.has(table.id)}
                      onWaitlist={async () => {
                        const success = await waitlistService.joinWaitlist(table.id);
                        if (success) {
                          setWaitlistedTableIds((prev) => {
                            const next = new Set(prev);
                            next.add(table.id);
                            return next;
                          });
                          toast.success('Joined Waitlist');
                        }
                      }}
                      onCancelWaitlist={async () => {
                        const success = await waitlistService.leaveWaitlist(table.id);
                        if (success) {
                          setWaitlistedTableIds((prev) => {
                            const next = new Set(prev);
                            next.delete(table.id);
                            return next;
                          });
                          toast.success('Left Waitlist');
                        }
                      }}
                      onQuickJoin={cashQuickJoin}
                      onDelete={() => setDeleteTableConfirm({ show: true, tableId: table.id, tableName: table.name })}
                    />
                  </div>
                );
              })}
              
              {sectionTournaments.length === 0 && sectionTables.length === 0 && !canCreate && gameType !== 'ALL' && (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#9aa5b6' }}>
                  No games currently active
                </div>
              )}
            </div>
          );
        })}
      </div>`;

// Replace the games grid
const startIdx = code.indexOf('{/* ═══════════════════════════════════════════════════════════════════════════════\n                GAMES GRID');
const endIdx = code.indexOf('      {/* Delete Confirmation Modal */}');

if (startIdx !== -1 && endIdx !== -1) {
  code = code.substring(0, startIdx) + replacement + '\n' + code.substring(endIdx);
  fs.writeFileSync(file, code);
  console.log('Done replacement');
} else {
  console.log('Could not find replace bounds');
}

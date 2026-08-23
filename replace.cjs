const fs = require('fs');

const file = 'src/pages/ClubHomePage.tsx';
let code = fs.readFileSync(file, 'utf8');

const startPattern = '{/* CREATE NEW TABLE - Only visible to owners/admins of STANDALONE clubs (not in a union) */}';
const endPattern = '{/* ═══════════════════════════════════════════════════════════════\n            EMPTY STATE';

const startIdx = code.indexOf(startPattern);
const endIdx = code.indexOf(endPattern);

if (startIdx === -1 || endIdx === -1) {
  console.log("Could not find patterns", startIdx, endIdx);
  process.exit(1);
}

const replacement = `
        {GAME_TYPE_TABS.filter(tab => tab.key !== 'ALL').map((tab) => {
          if (gameType !== 'ALL' && gameType !== tab.key) return null;

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

          const canCreate = (isOwner || userRole === 'admin') && !isInUnion;
          
          if (!canCreate && sectionTournaments.length === 0 && sectionTables.length === 0) {
             if (gameType === 'ALL') return null;
          }

          return (
            <div key={tab.key} className="game-section" style={{ marginBottom: '24px', width: '100%' }}>
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
                      marginBottom: '8px'
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
                      marginBottom: '8px'
                    }}
                  >
                    <CashGameCard
                      table={table}
                      isAdmin={isOwner || userRole === 'admin'}
                      waitlisted={waitlistedTableIds.has(table.id)}
                      onWaitlistToggle={currentUserId ? handleWaitlistToggle : undefined}
                      onDelete={(id) => {
                        setDeleteTableConfirm({ show: true, tableId: id, tableName: table.name });
                      }}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}

        `;

code = code.substring(0, startIdx) + replacement + code.substring(endIdx);
fs.writeFileSync(file, code);

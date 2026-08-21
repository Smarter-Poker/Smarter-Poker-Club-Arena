const fs = require('fs');
const file = 'src/pages/LeaderboardPage.tsx';
let code = fs.readFileSync(file, 'utf8');

const targetPeriod = `{/* Period Selector */}
        <div className="filter-group lb-chip-bar">
          {PERIOD_OPTIONS.map((opt) => (`;

const replacementPeriod = `{/* Period Selector */}
        <div className="filter-group lb-chip-bar flex items-center">
          <button 
            className="lb-filter-chip" 
            style={{ padding: '4px 10px', fontSize: '12px' }} 
            onClick={() => setPeriodOffset(p => p - 1)}
          >
            &larr; Past
          </button>
          
          {PERIOD_OPTIONS.map((opt) => (`;

code = code.replace(targetPeriod, replacementPeriod);

const targetPeriodEnd = `          ))}
        </div>`;

const replacementPeriodEnd = `          ))}

          <button 
            className="lb-filter-chip" 
            style={{ padding: '4px 10px', fontSize: '12px', opacity: periodOffset >= 0 ? 0.3 : 1 }} 
            onClick={() => setPeriodOffset(p => p < 0 ? p + 1 : 0)} 
            disabled={periodOffset >= 0}
          >
            Future &rarr;
          </button>
        </div>

        {/* Prize Settings & Finalize (Owner Only) */}
        {isOwner && scope === 'my-clubs' && activeTab === 'rankings' && (
          <div className="filter-group" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button 
              className="lb-filter-chip" 
              style={{ background: 'rgba(255,255,255,0.1)', color: 'white' }} 
              onClick={() => setShowSettings(true)}
            >
              ⚙️ Payout Settings
            </button>
            {periodOffset < 0 && !isPaidOut && (
              <button 
                className="lb-filter-chip"
                style={{ background: '#22c55e', color: 'black', fontWeight: 'bold' }}
                onClick={handleFinalize}
                disabled={finalizeLoading}
              >
                {finalizeLoading ? 'Processing...' : 'Finalize & Payout'}
              </button>
            )}
            {periodOffset < 0 && isPaidOut && (
              <span style={{ color: '#4ade80', fontWeight: 'bold', fontSize: '0.85rem' }}>✓ Paid Out</span>
            )}
          </div>
        )}`;

code = code.replace(targetPeriodEnd, replacementPeriodEnd);
fs.writeFileSync(file, code);

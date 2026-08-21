const fs = require('fs');
let code = fs.readFileSync('src/pages/LeaderboardPage.tsx', 'utf8');

// Hide Period Selector when not on rankings
code = code.replace(
  `{/* Period Selector */}
        <div className="filter-group lb-chip-bar flex items-center">`,
  `{/* Period Selector */}
        {activeTab === 'rankings' && (
        <div className="filter-group lb-chip-bar flex items-center">`
);

// Close Period Selector
code = code.replace(
  `          <button 
            className="lb-filter-chip" 
            style={{ padding: '4px 10px', fontSize: '12px', opacity: periodOffset >= 0 ? 0.3 : 1 }} 
            onClick={() => setPeriodOffset(p => p < 0 ? p + 1 : 0)} 
            disabled={periodOffset >= 0}
          >
            Future &rarr;
          </button>
        </div>`,
  `          <button 
            className="lb-filter-chip" 
            style={{ padding: '4px 10px', fontSize: '12px', opacity: periodOffset >= 0 ? 0.3 : 1 }} 
            onClick={() => setPeriodOffset(p => p < 0 ? p + 1 : 0)} 
            disabled={periodOffset >= 0}
          >
            Future &rarr;
          </button>
        </div>
        )}`
);

// Hide Metric Selector when not on rankings
code = code.replace(
  `{/* Metric Selector */}
        <div className="filter-group lb-chip-bar lb-chip-scroll">`,
  `{/* Metric Selector */}
        {activeTab === 'rankings' && (
        <div className="filter-group lb-chip-bar lb-chip-scroll">`
);

// Close Metric Selector
code = code.replace(
  `              {opt.icon} {opt.label}
            </button>
          ))}
        </div>`,
  `              {opt.icon} {opt.label}
            </button>
          ))}
        </div>
        )}`
);

fs.writeFileSync('src/pages/LeaderboardPage.tsx', code);

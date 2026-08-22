const fs = require('fs');
const file = 'src/pages/ClubHomePage.tsx';
let code = fs.readFileSync(file, 'utf8');

const startIdx = code.indexOf("<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>");
if (startIdx !== -1) {
  const endIdx = code.indexOf('</button>', startIdx) + 9;
  const oldBlock = code.substring(startIdx, endIdx);
  
  // Extract the button markup
  const buttonStart = oldBlock.indexOf('<button');
  const buttonCode = oldBlock.substring(buttonStart);
  
  const replaceStr = `
              <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: '6px', flexDirection: 'column' }}>
                {clubLevel && (
                  <div className="lobby-club__level">
                    <span
                      className="club-level-badge"
                      style={{ background: clubLevel.gradient }}
                      title={\`Level \${clubLevel.level} - \${clubLevel.tierLabel}\`}
                    >
                      <span className="club-level-badge__number">Level {clubLevel.level}</span>
                      <span className="club-level-badge__tier">{clubLevel.tierLabel}</span>
                    </span>
                  </div>
                )}
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                  {club.online_count >= 0 && (
                    <div style={{ fontSize: '0.8rem', color: '#9aa5b6' }}>
                      {club.online_count.toLocaleString()} players currently playing
                    </div>
                  )}

                  ${buttonCode}
                </div>
`;
  
  // Replace from startIdx to endIdx + the closing divs
  const finalEndIdx = code.indexOf('</div>', endIdx) + 6;
  const finalEndIdx2 = code.indexOf('</div>', finalEndIdx) + 6;
  // wait, the previous code had:
  //               </div>
  //             </div>
  // so replacing the whole thing.
  
  const originalFullBlock = code.substring(startIdx, finalEndIdx2);
  
  code = code.replace(originalFullBlock, replaceStr.trim() + '\n              </div>');
  fs.writeFileSync(file, code);
  console.log("Replaced successfully");
} else {
  console.log("Could not find start index");
}

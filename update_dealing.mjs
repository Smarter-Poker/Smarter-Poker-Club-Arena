import fs from 'fs';
const p = '/Users/smarter.poker/Documents/.agent-trees/club-arena/rebuy-pause/server/src/engine/ServerTableEngineDealing.ts';
let code = fs.readFileSync(p, 'utf8');

const target = `            if (needsRebuyPause) {
              console.log(\`[ServerTableEngine:\${this.tableId}] Pausing 5s for busted players to buy back in: \${justBustedHumans.map(p => p.username).join(', ')}\`);
              this.setLoopPhase('rebuy_pause');
              await this.sleep(5000);
            }`;

const replacement = `            if (needsRebuyPause) {
              console.log(\`[ServerTableEngine:\${this.tableId}] Pausing 5s for busted players to buy back in: \${justBustedHumans.map(p => p.username).join(', ')}\`);
              this.setLoopPhase('rebuy_pause');
              this.rejectedRebuys.clear();
              let waited = 0;
              while (waited < 5000) {
                // If every eligible busted human has either:
                // 1) Rebought (their stack is > 0 in this.seatedPlayers)
                // 2) Left the table (no longer in this.seatedPlayers)
                // 3) Explicitly rejected the rebuy (in this.rejectedRebuys)
                // then we can safely abort the pause early!
                const pending = justBustedHumans.filter(p => {
                  const currentP = this.seatedPlayers.find(sp => sp.user_id === p.user_id);
                  if (!currentP) return false; // Left table
                  if (currentP.stack > 0) return false; // Rebought
                  if (this.rejectedRebuys.has(p.user_id)) return false; // Rejected
                  return true;
                });
                if (pending.length === 0) {
                  console.log(\`[ServerTableEngine:\${this.tableId}] Busted players decided early. Aborting 5s rebuy pause at \${waited}ms.\`);
                  break;
                }
                await this.sleep(100);
                waited += 100;
              }
              this.rejectedRebuys.clear();
            }`;

if (code.includes('await this.sleep(5000);')) {
  code = code.replace(target, replacement);
  fs.writeFileSync(p, code);
  console.log("Updated Dealing");
} else {
  console.log("Not found");
}

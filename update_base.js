const fs = require('fs');
const p = '/Users/smarter.poker/Documents/.agent-trees/club-arena/rebuy-pause/server/src/engine/ServerTableEngineBase.ts';
let code = fs.readFileSync(p, 'utf8');
if (!code.includes('rejectedRebuys = new Set<string>()')) {
  code = code.replace(
    'protected seatedPlayers: SeatedPlayer[] = [];',
    'protected seatedPlayers: SeatedPlayer[] = [];\n  /** Tracks busted users who explicitly rejected a rebuy in the current hand (Dan 2026-08-24). */\n  protected rejectedRebuys = new Set<string>();\n\n  public rejectRebuy(userId: string): void {\n    this.rejectedRebuys.add(userId);\n  }'
  );
  fs.writeFileSync(p, code);
}

import fs from 'fs';
const p = '/Users/smarter.poker/Documents/.agent-trees/club-arena/rebuy-pause/src/services/GameServerAPI.ts';
let code = fs.readFileSync(p, 'utf8');

if (!code.includes('notifyServerRejectRebuy')) {
  const replacement = `/**
 * POST /reject_rebuy — Notify the game server that a player rejected the rebuy modal.
 */
export async function notifyServerRejectRebuy(tableId: string): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();
    const resp = await fetch(\`\${GAME_SERVER_URL}/reject_rebuy\`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId }),
    });
    if (!resp.ok) return { success: false, error: \`Server error (\${resp.status})\` };
    return (await resp.json()) as ActionResult;
  } catch (err: unknown) {
    console.warn('[GameServerAPI] notifyServerRejectRebuy failed:', err);
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * POST /post-bb`;

  code = code.replace('/**\n * POST /post-bb', replacement);
  fs.writeFileSync(p, code);
  console.log("Updated API");
}

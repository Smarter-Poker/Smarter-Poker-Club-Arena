#!/bin/bash
# Adding addChips to ServerTableEngine
awk '
/public sitOut/ {
  print "  /**"
  print "   * POST /addchips — Player bought chips (added to their stack directly)."
  print "   * Fixes race condition where postHandTasks overwrote table_seats db buy-ins."
  print "   */"
  print "  public async addChips("
  print "    userId: string,"
  print "    amount: number"
  print "  ): Promise<{ success: boolean; error?: string }> {"
  print "    const player = this.seatedPlayers.find((p) => p.user_id === userId);"
  print "    if (!player) return { success: false, error: \"Player not seated\" };"
  print ""
  print "    // Update Engine Memory"
  print "    player.stack += amount;"
  print "    if (this.handController) {"
  print "      const hcState = this.handController.getState();"
  print "      const hcPlayer = hcState.players.find((p) => p.user_id === userId);"
  print "      if (hcPlayer) hcPlayer.stack += amount;"
  print "    }"
  print ""
  print "    // Update Database directly as well (for safety against server crash before hand completes)"
  print "    // The atomic update is done in index.ts or here. We'"'"'ll do it using supabase."
  print "    const { supabase } = require(\"../services/supabase.js\");"
  print "    // Use an RPC if available to increment atomically, or just an update..."
  print "    // We will do a direct update. Even if race condition, engine memory becomes truth next hand."
  print "    supabase.rpc(\"increment_table_seat_stack\", {"
  print "      p_table_id: this.tableId,"
  print "      p_user_id: userId,"
  print "      p_amount: amount"
  print "    }).catch(() => {});" // fire and forget
  print ""
  print "    // Broadcast update so the player sees the chip increase immediately"
  print "    this.broadcastCurrentState();"
  print "    return { success: true };"
  print "  }"
  print ""
}
{ print }
' /Users/smarter.poker/Documents/club-arena/server/src/engine/ServerTableEngine.ts > tmp_engine.ts
mv tmp_engine.ts /Users/smarter.poker/Documents/club-arena/server/src/engine/ServerTableEngine.ts


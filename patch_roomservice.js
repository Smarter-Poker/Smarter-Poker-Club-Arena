const fs = require('fs');
const file = '/Users/smarter.poker/Documents/club-arena/src/services/RoomService.ts';
let code = fs.readFileSync(file, 'utf8');

// Replace joinRoom with registerChannel, and remove supabase.channel call!
code = code.replace(/async joinRoom\([^]*?this\.channels\.set\(tableId, channel\);\n    \} else \{\n      \/\/ Already in room, update presence\n      await channel\.track\(\{(?:.|\n)*?\} as PlayerPresence\);\n    \}\n  \}/m, `/**
   * Register an existing channel (from TableWebSocket) to deduplicate subscriptions.
   */
  registerChannel(tableId: string, channel: RealtimeChannel): void {
    if (this.channels.has(tableId)) return;

    // Handle broadcasts
    channel.on('broadcast', { event: 'game_event' }, (payload) => {
      this.handleMessage(tableId, payload.payload as RoomMessage);
    });

    // Handle presence sync
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      this.updatePresence(tableId, state);
    });

    // Handle joins
    channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
      this.notifyHandlers(tableId, {
        type: 'PLAYER_JOINED',
        payload: { userId: key, presences: newPresences },
        sender: 'system',
        timestamp: Date.now(),
      });
    });

    // Handle leaves
    channel.on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
      this.notifyHandlers(tableId, {
        type: 'PLAYER_LEFT',
        payload: { userId: key, presences: leftPresences },
        sender: 'system',
        timestamp: Date.now(),
      });
    });

    this.channels.set(tableId, channel);
  }`);

// Update leaveRoom to NOT untrack or removeChannel (since TableWebSocket owns it)
code = code.replace(/async leaveRoom\(tableId: string\): Promise<void> \{[^]*?this\.channels\.delete\(tableId\);/m, `async leaveRoom(tableId: string): Promise<void> {  
    // We do NOT call untrack() or removeChannel() here because TableWebSocket owns the channel instance.
    // We just clean up local references.
    this.channels.delete(tableId);`);

fs.writeFileSync(file, code);

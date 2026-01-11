export class ArenaKernel {
    constructor(bus) {
        this.bus = bus;
    }

    boot() {
        console.log("🔴 RED [ARENA_SHELL]: Booting Smarter.Poker OS...");
        this.bus.subscribe('GAME_START', (data) => {
            console.log("🔴 RED [ARENA_SHELL]: Initializing XP Tracking for Session " + data.sessionId);
        });
    }
}

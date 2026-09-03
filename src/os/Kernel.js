export class ArenaKernel {
    constructor(bus) {
        this.bus = bus;
    }

    boot() {
        console.log("🔴 RED [ARENA_SHELL]: Booting Club Arena OS...");
        this.bus.subscribe('GAME_START', (data) => {
            console.log("🔴 RED [ARENA_SHELL]: Initializing Session Tracking for " + data.sessionId);
        });
    }
}

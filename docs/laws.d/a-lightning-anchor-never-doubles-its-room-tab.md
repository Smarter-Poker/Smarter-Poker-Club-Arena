# tests/a-lightning-anchor-never-doubles-its-room-tab.law.test.ts

MultiTablePage's seat rebuild never adds a Lightning anchor table (whose table_seats row stays open while the player is in the pool) as a second tab beside that game's open room tab, which made the anchor tab appear, hand off, close and reappear on every rebuild; with no room tab open the anchor is kept, since its handoff is the way back into the room (`anchorsShownByOpenRooms`, 2026-10-24).

import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/PlayerSessionAccess.js', () => ({ playerSessionVerdict: vi.fn() }));
import { playerSessionVerdict } from '../services/PlayerSessionAccess.js';
import { EngineWebSocketServer } from './EngineWebSocketServer.js';
import { ChannelWebSocketServer } from './ChannelWebSocketServer.js';
describe.each([EngineWebSocketServer, ChannelWebSocketServer])(
  'targeted socket session invalidation',
  (Server) => {
    it('closes only revoked target sessions, preserving new sign-ins and outage ambiguity', async () => {
      vi.mocked(playerSessionVerdict).mockImplementation(async (_user, token) =>
        token === 'old' ? 'revoked' : token === 'new' ? 'alive' : 'unknown'
      );
      const sockets = ['old', 'new', 'offline', 'other'].map(() => ({ close: vi.fn() }));
      const server = Object.create(Server.prototype);
      server.connections = new Map(
        sockets.map((ws, index) => [
          ws,
          {
            userId: index === 3 ? 'other-user' : 'target',
            token: ['old', 'new', 'offline', 'old'][index],
          },
        ])
      );
      await server.revokePlayerSessions('target');
      expect(sockets[0].close).toHaveBeenCalledWith(4401, 'auth:session_not_found');
      for (const socket of sockets.slice(1)) expect(socket.close).not.toHaveBeenCalled();
    });
  }
);

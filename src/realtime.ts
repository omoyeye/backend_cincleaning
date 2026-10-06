import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const clients = new Set<WebSocket>();

export function attachRealtime(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
}

/** Notify all connected dashboards / portals to refetch from the DB. */
export function broadcastSync(scope: 'bookings' | 'notifications' | 'location' | 'all' = 'all'): void {
  const msg = JSON.stringify({ type: 'nn_sync', scope, t: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(msg);
      } catch {
        clients.delete(ws);
      }
    }
  }
}

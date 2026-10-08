import { poolConnection } from './db';

/**
 * Expo push tokens registered by the mobile app, stored in `push_tokens` so pushes keep
 * working after a server restart or deploy (previously they lived only in memory).
 */
export async function registerPushToken(userId: number, token: string, platform: string): Promise<void> {
    // A device belongs to whoever signed in on it most recently.
    await poolConnection.query(
        `INSERT INTO push_tokens (user_id, token, platform) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), last_seen_at = CURRENT_TIMESTAMP`,
        [userId, token.slice(0, 255), platform.slice(0, 20)],
    );
}

export async function unregisterPushToken(userId: number, token: string): Promise<void> {
    await poolConnection.query('DELETE FROM push_tokens WHERE user_id = ? AND token = ?', [userId, token]);
}

type ExpoTicket = { status: 'ok' | 'error'; details?: { error?: string } };

/** Best-effort push via Expo's push service; never throws. Drops tokens Expo reports as dead. */
export async function sendPushToUsers(
    userIds: number[],
    title: string,
    body: string,
    data?: Record<string, unknown>,
): Promise<void> {
    const ids = [...new Set(userIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) return;
    try {
        const [rows] = await poolConnection.query('SELECT token FROM push_tokens WHERE user_id IN (?)', [ids]);
        const tokens = (rows as Array<{ token: string }>)
            .map((r) => r.token)
            .filter((t) => /^Expo(nent)?PushToken\[/.test(t));
        // Expo accepts up to 100 messages per request.
        for (let i = 0; i < tokens.length; i += 100) {
            const batch = tokens.slice(i, i + 100);
            const messages = batch.map((to) => ({ to, title, body: body.slice(0, 500), data: data || {}, sound: 'default' }));
            const res = await fetch('https://exp.host/--/api/v2/push/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(messages),
            });
            if (!res.ok) {
                console.warn('[push] send failed', res.status);
                continue;
            }
            const json = (await res.json().catch(() => null)) as { data?: ExpoTicket[] } | null;
            const dead = (json?.data || [])
                .map((ticket, idx) => (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered' ? batch[idx] : null))
                .filter((t): t is string => Boolean(t));
            if (dead.length) await poolConnection.query('DELETE FROM push_tokens WHERE token IN (?)', [dead]);
        }
    } catch (e) {
        console.warn('[push] send error', e);
    }
}

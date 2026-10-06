/** Expo push tokens registered by the mobile app, keyed by user id (in memory: apps re-register on launch). */
const pushTokens = new Map<number, { token: string; platform: string }[]>();

export function registerPushToken(userId: number, token: string, platform: string): void {
    const existing = pushTokens.get(userId) || [];
    if (!existing.some((e) => e.token === token)) {
        existing.push({ token, platform });
        pushTokens.set(userId, existing);
    }
}

export function unregisterPushToken(userId: number, token: string): void {
    const existing = pushTokens.get(userId) || [];
    pushTokens.set(userId, existing.filter((e) => e.token !== token));
}

/** Best-effort push via Expo's push service; never throws. */
export async function sendPushToUsers(
    userIds: number[],
    title: string,
    body: string,
    data?: Record<string, unknown>,
): Promise<void> {
    const messages = [...new Set(userIds)]
        .flatMap((id) => pushTokens.get(id) || [])
        .filter((t) => /^Expo(nent)?PushToken\[/.test(t.token))
        .map((t) => ({ to: t.token, title, body: body.slice(0, 500), data: data || {}, sound: 'default' }));
    if (!messages.length) return;
    try {
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(messages),
        });
        if (!res.ok) console.warn('[push] send failed', res.status);
    } catch (e) {
        console.warn('[push] send error', e);
    }
}

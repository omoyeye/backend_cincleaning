// Booking dates and times are UK wall-clock values, so the server must read them in UK time
// whatever zone the host machine is set to. Imported first so every later Date call uses it.
process.env.TZ = 'Europe/London';

/** YYYY-MM-DD of a Date in UK time (toISOString would give the UTC day, a day early around midnight in summer). */
export function ukYmd(d: Date = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

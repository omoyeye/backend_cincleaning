// Booking dates and times are UK wall-clock values, so the server must read them in UK time
// whatever zone the host machine is set to. Imported first so every later Date call uses it.
process.env.TZ = 'Europe/London';

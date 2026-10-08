// Compares the Drizzle schema (src/schema.ts) with the connected database and lists missing tables/columns.
// Usage: npx tsx scripts/check-schema.ts
import 'dotenv/config';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { is } from 'drizzle-orm';
import { MySqlTable as MySqlTableClass } from 'drizzle-orm/mysql-core';
import * as schema from '../src/schema';
import { poolConnection } from '../src/db';

async function main() {
  const [rows] = (await poolConnection.query(
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()',
  )) as unknown as [Array<{ t: string; c: string }>];
  const existing = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!existing.has(r.t)) existing.set(r.t, new Set());
    existing.get(r.t)!.add(r.c);
  }

  let problems = 0;
  for (const value of Object.values(schema)) {
    if (!is(value, MySqlTableClass)) continue;
    const cfg = getTableConfig(value as MySqlTable);
    const cols = existing.get(cfg.name);
    if (!cols) {
      console.log(`MISSING TABLE  ${cfg.name}`);
      problems++;
      continue;
    }
    for (const col of cfg.columns) {
      if (!cols.has(col.name)) {
        console.log(`MISSING COLUMN ${cfg.name}.${col.name}`);
        problems++;
      }
    }
  }
  console.log(problems ? `\n${problems} difference(s).` : 'Schema matches the database.');
  await poolConnection.end();
}

main().catch(async (e) => {
  console.error(e);
  await poolConnection.end();
  process.exit(1);
});

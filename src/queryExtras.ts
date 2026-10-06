import { db, poolConnection } from './db';
import { extraServices } from './schema';

async function main() {
    try {
        const extras = await db.select().from(extraServices);
        console.log(JSON.stringify(extras, null, 2));
    } finally {
        await poolConnection.end();
    }
}
main();

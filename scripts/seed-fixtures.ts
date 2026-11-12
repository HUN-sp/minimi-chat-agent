// Load the memory fixtures (scripts/fixtures.ts) into the DB: instant, no API keys, no credits.
// Usage: npm run seed:fixtures            (dates relative to today, in this machine's timezone)
//        SEED_TZ=Asia/Kolkata npm run seed:fixtures
//        DB_PATH=data/test.db npm run seed:fixtures   (keep fixtures out of your main DB)

import { config, defaultTz, getNow } from '../src/config.js';
import { closeDb } from '../src/memory/db.js';
import { civilDateIn, prettyDate } from '../src/time/tz.js';
import { loadFixtures } from './fixtures.js';

const tz = process.env.SEED_TZ ?? defaultTz();
const today = civilDateIn(getNow(), tz);
const loaded = loadFixtures(today, tz);

console.log(`Loaded ${loaded.length} fixture conversations into ${config.dbPath} (tz ${tz}, today ${prettyDate(today)}):\n`);
for (const f of loaded) console.log(`  ${prettyDate(f.date).padEnd(16)} ${f.id.padEnd(12)} ${f.claims} stored values · ${f.purpose}`);
console.log('\nAsk these in the chat (npm run dev), with Debug on to see the recalled memory and the diff:\n');
for (const f of loaded)
  for (const a of f.ask) {
    console.log(`  Q: ${a.q}`);
    console.log(`     ✓ correct reply: ${a.expect}\n`);
  }
console.log('  Q: What did I ask you on 1 November?   (if nothing is stored that day)');
console.log('     ✓ correct reply: no conversation that day, lists the nearest dates; never invents one.\n');
closeDb();

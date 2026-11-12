// Seed realistic history by replaying scripted questions through the REAL pipeline
// (resolver, search, answer, extraction) with back-dated clocks, relative to today:
//   • CRM shortlist (5 tools)  — the most recent past Monday
//   • Postgres hosting         — the Tuesday a week before the most recent Tuesday
//                                (so "last Tuesday" is genuinely ambiguous and settled by topic)
//   • Gemini API pricing       — 6 days ago
// Stored prices are real current values, so a re-check honestly reports "unchanged".
// `--demo-change` then alters ONE stored price (flagged demo=1, labelled in memory) to show the
// "changed" path. Costs ≈15–25 Tavily credits.
//
// Usage: npm run seed            npm run seed -- --demo-change            npm run seed -- --only gemini

import { runTurn } from '../src/agent/loop.js';
import { defaultTz, getNow } from '../src/config.js';
import { claimsForMessages, closeDb, deleteConversation, getDb } from '../src/memory/db.js';
import { type CivilDate, addDays, civilDateIn, localTimeToUtc, prettyDate, weekday } from '../src/time/tz.js';

const demoChange = process.argv.includes('--demo-change');
const onlyIdx = process.argv.indexOf('--only'); // e.g. --only gemini (re-seed one conversation)
const only = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null;
const tz = process.env.SEED_TZ ?? defaultTz();
const today = civilDateIn(getNow(), tz);

function prevWeekday(wd: number): CivilDate {
  let back = (weekday(today) - wd + 7) % 7;
  if (back === 0) back = 7;
  return addDays(today, -back);
}

const script = [
  {
    id: 'seed-crm',
    date: prevWeekday(1),
    time: [10, 5],
    message: "We're a 20-person sales team. Shortlist 5 CRM tools for us and give me the current per-seat monthly price of each one's main sales plan.",
  },
  {
    id: 'seed-postgres',
    date: addDays(prevWeekday(2), -7),
    time: [14, 20],
    message: 'I need managed Postgres hosting for a small production app. What do Neon, Supabase and AWS RDS charge for their entry-level paid plans?',
  },
  {
    id: 'seed-gemini',
    date: addDays(today, -6),
    time: [9, 30],
    message: "What's the Gemini API price for Gemini 2.5 Flash and Gemini 2.5 Pro, input and output per 1M tokens?",
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`Seeding ${only ? 1 : script.length} conversation(s) (tz ${tz}, today ${prettyDate(today)})…\n`);
let first = true;
for (const s of script.filter((x) => !only || x.id.includes(only))) {
  if (!first) {
    console.log('  (pausing 40s to stay under the Groq free-tier tokens/minute limit)');
    await sleep(40_000);
  }
  first = false;
  deleteConversation(s.id);
  const at = localTimeToUtc(s.date, s.time[0], s.time[1], tz);
  console.log(`▶ ${prettyDate(s.date)} ${s.time.map((n) => String(n).padStart(2, '0')).join(':')}: ${s.message}`);
  const res = await runTurn({
    message: s.message,
    conversationId: s.id,
    tz,
    now: at,
    emit: (e) => {
      if (e.type === 'status') console.log(`   · ${e.text}`);
    },
  });
  const claims = claimsForMessages([res.messageId]);
  console.log(`   ✓ answered in ${res.debug.timings.totalMs} ms, ${res.debug.credits} credits, ${claims.length} assertions stored`);
  for (const c of claims) console.log(`     - [${c.kind}/${c.status}] ${c.entity}${c.plan ? ` [${c.plan}]` : ''} ${c.attribute} = ${c.value} ${c.unit ?? ''} ${c.period ?? ''}`);
  console.log();
}

if (demoChange) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT c.id, c.entity, c.plan, c.attribute, c.value FROM claims c JOIN messages m ON m.id = c.message_id
       WHERE m.conversation_id = 'seed-gemini' AND c.value LIKE '%$%' ORDER BY c.id LIMIT 1`,
    )
    .get() as { id: number; entity: string; plan: string | null; attribute: string; value: string } | undefined;
  if (row) {
    const num = Number(row.value.replace(/[^0-9.]/g, ''));
    const altered = `$${(num * 0.8).toFixed(num < 1 ? 2 : 2).replace(/\.?0+$/, '') || '0'}`;
    db.prepare('UPDATE claims SET value = ?, demo = 1 WHERE id = ?').run(altered, row.id);
    console.log(`DEMO DATA: changed stored ${row.entity}${row.plan ? ` [${row.plan}]` : ''} ${row.attribute} from ${row.value} to ${altered} (flagged demo=1).`);
  } else console.log('No Gemini price claim found to alter for --demo-change.');
}

console.log('\nDone. Try:');
console.log('  • "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?"');
console.log(`  • "What did I ask you on ${script[1].date.d} ${prettyDate(script[1].date).split(' ')[2]}? Is your answer still correct today?"`);
console.log('  • "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?"');
console.log(`  • "I asked about Gemini's API price on ${script[2].date.d} ${prettyDate(script[2].date).split(' ')[2]}. Did it change?"`);
closeDb();

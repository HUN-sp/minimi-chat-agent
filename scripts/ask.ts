// CLI: run one turn through the real pipeline and print the stream + debug summary.
// Usage: npm run ask -- "your question" [--conv <id>] [--tz Europe/London]

import { runTurn } from '../src/agent/loop.js';
import { closeDb } from '../src/memory/db.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const conv = flag('--conv');
const tz = flag('--tz');
const message = args.join(' ');
if (!message) {
  console.error('usage: npm run ask -- "question"');
  process.exit(1);
}

const res = await runTurn({
  message,
  conversationId: conv,
  tz,
  emit: (e) => {
    if (e.type === 'status') process.stdout.write(`\n  · ${e.text}\n`);
    else if (e.type === 'token') process.stdout.write(e.text);
    else if (e.type === 'reset') process.stdout.write('\n  · (draft discarded)\n');
    else if (e.type === 'final') process.stdout.write(`\n\n===== FINAL =====\n${e.text}\n\nSources: ${e.sources.filter((s) => s.cited).map((s) => `${s.id}=${s.domain}(${s.tier})`).join(', ')}\n`);
  },
});
const d = res.debug;
console.log(
  `\n----- debug -----\nconversation ${res.conversationId}\nmodel ${d.model} | rounds ${d.rounds.length} | timings ${JSON.stringify(d.timings)} | credits ${d.credits}` +
    `\nwindows ${JSON.stringify(d.windows.map((w: any) => `${w.phrase}→${w.from}..${w.to}`))} route ${JSON.stringify(d.route)}` +
    `\nsearches:\n${d.searches.map((s: any) => `  [${s.kind}] ${s.query} ${JSON.stringify({ d: s.params.include_domains, since: s.params.start_date })} → ${s.results} (${s.ms}ms${s.cacheHit ? ', cache' : ''}${s.error ? ', ERR ' + s.error : ''})`).join('\n')}` +
    `\ncitations ${JSON.stringify(d.citations)} fallbacks ${JSON.stringify(d.fallbacks)}` +
    (d.diff.length ? `\ndiff:\n${d.diff.map((r: any) => `  ${r.entity} ${r.plan ?? ''} ${r.attribute}: ${r.then.value} → ${r.now.value} = ${r.status} ${r.note ?? ''}`).join('\n')}` : ''),
);
const ex = await res.extraction;
console.log('memory written', JSON.stringify(ex), '| telemetry', JSON.stringify(d.telemetry), '| deadline', JSON.stringify(d.deadline));
closeDb();

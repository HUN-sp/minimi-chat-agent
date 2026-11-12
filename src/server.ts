// HTTP server: SSE chat endpoint, conversation list/detail, static client.

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { config, getNow } from './config.js';
import { type TurnEvent, runTurn } from './agent/loop.js';
import { getConversation, getDb, getMessageSources, getMessages, hasFts, listConversations } from './memory/db.js';

const app = new Hono();

// Fail clearly, not deep inside a turn, when the required keys are missing.
const missingKeys = [!config.agentChain.length && 'GROQ_API_KEY', !config.tavilyKey && 'TAVILY_API_KEY'].filter(Boolean) as string[];
const setupHint = `Missing ${missingKeys.join(' and ')}. Copy .env.example to .env, add the key${missingKeys.length > 1 ? 's' : ''} (both have free tiers), and restart.`;

app.post('/api/chat', async (c) => {
  if (missingKeys.length) return c.json({ error: setupHint }, 503);
  const body = await c.req.json().catch(() => ({}));
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return c.json({ error: 'message is required' }, 400);

  return streamSSE(c, async (stream) => {
    // Serialise writes: emit() is sync, writeSSE is async.
    let chain = Promise.resolve();
    const emit = (e: TurnEvent) => {
      chain = chain.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => {});
    };
    try {
      const res = await runTurn({ message, conversationId: body.conversationId, tz: body.tz, emit });
      res.extraction.then((r) => r && console.log(`[memory] message ${res.messageId}: ${JSON.stringify(r)}`));
    } catch (err) {
      console.error('[chat] turn failed:', err);
      const msg = (err as { status?: number }).status === 429 ? 'All models are rate-limited right now (free tier). Please wait a minute and try again.' : `Something went wrong: ${(err as Error).message}`;
      emit({ type: 'error', message: msg });
    }
    emit({ type: 'done' } as unknown as TurnEvent);
    await chain;
  });
});

app.get('/api/conversations', (c) => c.json(listConversations()));

app.get('/api/conversations/:id', (c) => {
  const conv = getConversation(c.req.param('id'));
  if (!conv) return c.json({ error: 'not found' }, 404);
  const messages = getMessages(conv.id).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
    debug: m.meta_json ? JSON.parse(m.meta_json) : null,
    sources:
      m.role === 'assistant'
        ? getMessageSources(m.id).map((s) => ({ id: s.citation_label, url: s.url, domain: s.domain, title: s.title, tier: s.tier, publishedAt: s.published_at, retrievedAt: s.retrieved_at, cited: !!s.cited }))
        : [],
  }));
  return c.json({ ...conv, messages });
});

app.get('/api/health', (c) =>
  c.json({ ok: true, now: getNow().toISOString(), fakeNow: process.env.FAKE_NOW ?? null, fts5: hasFts, models: config.agentChain.map((p) => p.label), search: config.tavilyKey ? 'tavily' : 'missing key' }),
);

app.use('/*', serveStatic({ root: './public' }));

getDb();
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`minimi listening on http://localhost:${info.port}  (models: ${config.agentChain.map((p) => p.label).join(' → ') || 'NONE'}, fts5: ${hasFts})`);
  if (process.env.FAKE_NOW) console.log(`FAKE_NOW=${process.env.FAKE_NOW}`);
  if (missingKeys.length) console.warn(`\n⚠  ${setupHint}\n`);
});

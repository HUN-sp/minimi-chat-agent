// SQLite memory store on the built-in node:sqlite (no native build step).
// Kept distinct, because they establish different things:
//   • messages      — what was asked and answered, when, and whether generation failed;
//   • sources +
//     observations  — what a source stated (evidence span, qualifiers, publication/fetch/effective dates);
//   • claims        — ANSWER ASSERTIONS: what the delivered answer said, each linked to the observation
//                     it used (status "supported"), or flagged unsupported / estimate / (un)cited fact;
//   • entity_sets   — the items and constraints the user named (kept even without a web search).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

let db: DatabaseSync | null = null;
export let hasFts = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,      -- ISO UTC
  updated_at TEXT NOT NULL,
  user_tz TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,            -- user | assistant
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,      -- ISO UTC
  local_date TEXT NOT NULL,      -- YYYY-MM-DD in user_tz (for "nearest dates")
  user_tz TEXT NOT NULL,
  meta_json TEXT,                -- debug trace for assistant turns
  failed INTEGER NOT NULL DEFAULT 0, -- 1 = no answer was produced (rate limit / model error)
  memory_status TEXT             -- assistant turns: complete | pending | failed | none
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT,
  published_at TEXT,             -- YYYY-MM-DD or NULL (official pricing pages are usually undated)
  retrieved_at TEXT NOT NULL,    -- ISO UTC: when it was fetched (the original fetch, also on cache hits)
  content_hash TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  tier TEXT NOT NULL,            -- official | reputable | secondary: decided at fetch, never promoted later
  tier_reason TEXT,              -- why that tier
  effective_date TEXT            -- a date the source explicitly says a change takes effect
);
CREATE TABLE IF NOT EXISTS message_sources (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  citation_label TEXT NOT NULL,  -- S1, S2…
  cited INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT
);
CREATE TABLE IF NOT EXISTS entity_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  members_json TEXT NOT NULL,
  constraints_json TEXT          -- user-stated constraints, e.g. {"team_size":"20-person sales team"}
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, -- the turn whose answer used it
  kind TEXT NOT NULL,            -- price | event
  entity TEXT NOT NULL,
  plan TEXT,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  period TEXT,
  qualifiers_json TEXT,
  span TEXT NOT NULL,            -- verbatim source text
  published_at TEXT,             -- source publication date
  observed_at TEXT NOT NULL,     -- fetch time
  effective_date TEXT,
  event_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_obs_msg ON observations(message_id);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  period TEXT,
  plan TEXT,
  as_of TEXT NOT NULL,           -- YYYY-MM-DD the value was observed
  source_id INTEGER REFERENCES sources(id),
  confidence REAL,
  demo INTEGER NOT NULL DEFAULT 0, -- 1 = deliberately altered test value
  kind TEXT NOT NULL DEFAULT 'price',       -- price | fact | event
  status TEXT NOT NULL DEFAULT 'supported', -- supported | unsupported | estimate | cited | uncited
  observation_id INTEGER REFERENCES observations(id),
  qualifiers_json TEXT,
  span TEXT                      -- the answer text that made the assertion
);
CREATE INDEX IF NOT EXISTS idx_claims_msg ON claims(message_id);
`;

export function getDb(): DatabaseSync {
  if (db) return db;
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db); // before SCHEMA: older tables need their new columns before new indexes refer to them
  db.exec(SCHEMA);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(content, tokenize='porter unicode61');`);
    hasFts = true;
  } catch {
    hasFts = false; // fall back to LIKE + entity match
  }
  return db;
}

/** Additive migrations for databases created by an older schema (CREATE IF NOT EXISTS won't add columns). */
function migrate(d: DatabaseSync): void {
  const exists = (table: string) => !!d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const has = (table: string, col: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
  const add = (table: string, col: string, def: string) => {
    if (exists(table) && !has(table, col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  add('messages', 'failed', 'INTEGER NOT NULL DEFAULT 0');
  add('messages', 'memory_status', 'TEXT');
  add('sources', 'tier_reason', 'TEXT');
  add('sources', 'effective_date', 'TEXT');
  add('entity_sets', 'constraints_json', 'TEXT');
  add('claims', 'kind', "TEXT NOT NULL DEFAULT 'price'");
  add('claims', 'status', "TEXT NOT NULL DEFAULT 'supported'");
  add('claims', 'observation_id', 'INTEGER');
  add('claims', 'qualifiers_json', 'TEXT');
  add('claims', 'span', 'TEXT');
}

export function closeDb(): void {
  db?.close();
  db = null;
}

// ---- Typed rows ----------------------------------------------------------------

export interface ConversationRow {
  id: string;
  title: string;
  started_at: string;
  updated_at: string;
  user_tz: string;
}

export interface MessageRow {
  id: number;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  local_date: string;
  user_tz: string;
  meta_json: string | null;
  failed: number;
  memory_status?: string | null;
}

export interface ClaimRow {
  id: number;
  message_id: number;
  entity: string;
  attribute: string;
  value: string;
  unit: string | null;
  period: string | null;
  plan: string | null;
  as_of: string;
  source_id: number | null;
  confidence: number | null;
  demo: number;
  kind?: string; // price | fact | event
  status?: string; // supported | unsupported | estimate | cited | uncited
  observation_id?: number | null;
  qualifiers_json?: string | null;
  span?: string | null;
  // joined
  source_url?: string | null;
  source_domain?: string | null;
  source_tier?: string | null;
  source_excerpt?: string | null; // the source as we stored it then (baseline snapshot)
  source_retrieved_at?: string | null;
  obs_span?: string | null;
}

/** A price assertion usable as a comparison baseline: what we said, tied to evidence (or an estimate). */
export function isBaseline(c: ClaimRow): boolean {
  return (c.kind ?? 'price') === 'price' && (c.status ?? 'supported') !== 'unsupported';
}

export interface SourceRow {
  id: number;
  url: string;
  canonical_url: string;
  domain: string;
  title: string | null;
  published_at: string | null;
  retrieved_at: string;
  content_hash: string;
  excerpt: string;
  tier: string;
  tier_reason?: string | null;
  effective_date?: string | null;
}

// ---- Writes --------------------------------------------------------------------

export function upsertConversation(id: string, title: string, at: string, tz: string): void {
  const d = getDb();
  const existing = d.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
  if (existing) d.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(at, id);
  else d.prepare('INSERT INTO conversations (id, title, started_at, updated_at, user_tz) VALUES (?, ?, ?, ?, ?)').run(id, title, at, at, tz);
}

export function insertMessage(m: Omit<MessageRow, 'id' | 'failed'> & { failed?: boolean }): number {
  const d = getDb();
  const r = d
    .prepare('INSERT INTO messages (conversation_id, role, content, created_at, local_date, user_tz, meta_json, failed, memory_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.conversation_id, m.role, m.content, m.created_at, m.local_date, m.user_tz, m.meta_json, m.failed ? 1 : 0, m.memory_status ?? null);
  const id = Number(r.lastInsertRowid);
  // A failed turn's placeholder text must not be found by keyword recall as if it were an answer.
  if (hasFts && !m.failed) d.prepare('INSERT INTO fts_messages (rowid, content) VALUES (?, ?)').run(id, m.content);
  return id;
}

export function setMemoryStatus(messageId: number, status: 'complete' | 'pending' | 'failed' | 'none'): void {
  getDb().prepare('UPDATE messages SET memory_status = ? WHERE id = ?').run(status, messageId);
}

export function insertEntitySet(messageId: number, label: string, members: string[], constraints?: Record<string, string> | null): void {
  getDb()
    .prepare('INSERT INTO entity_sets (message_id, label, members_json, constraints_json) VALUES (?, ?, ?, ?)')
    .run(messageId, label, JSON.stringify(members), constraints && Object.keys(constraints).length ? JSON.stringify(constraints) : null);
}

export function insertSource(s: Omit<SourceRow, 'id'>): number {
  const r = getDb()
    .prepare('INSERT INTO sources (url, canonical_url, domain, title, published_at, retrieved_at, content_hash, excerpt, tier, tier_reason, effective_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(s.url, s.canonical_url, s.domain, s.title, s.published_at, s.retrieved_at, s.content_hash, s.excerpt, s.tier, s.tier_reason ?? null, s.effective_date ?? null);
  return Number(r.lastInsertRowid);
}

export function linkSource(messageId: number, sourceId: number, label: string, cited: boolean): void {
  getDb().prepare('INSERT INTO message_sources (message_id, source_id, citation_label, cited) VALUES (?, ?, ?, ?)').run(messageId, sourceId, label, cited ? 1 : 0);
}

export function deleteConversation(id: string): void {
  const d = getDb();
  if (hasFts) d.prepare('DELETE FROM fts_messages WHERE rowid IN (SELECT id FROM messages WHERE conversation_id = ?)').run(id);
  d.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

// ---- Reads ---------------------------------------------------------------------

export function listConversations(): (ConversationRow & { messages: number })[] {
  return getDb()
    .prepare('SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messages FROM conversations c ORDER BY c.updated_at DESC')
    .all() as any;
}

export function getConversation(id: string): ConversationRow | undefined {
  return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
}

export function getMessages(conversationId: string): MessageRow[] {
  return getDb().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId) as any;
}

export function getMessageSources(messageId: number): (SourceRow & { citation_label: string; cited: number })[] {
  return getDb()
    .prepare('SELECT s.*, ms.citation_label, ms.cited FROM message_sources ms JOIN sources s ON s.id = ms.source_id WHERE ms.message_id = ? ORDER BY ms.rowid')
    .all(messageId) as any;
}

export function claimsForMessages(messageIds: number[]): ClaimRow[] {
  if (!messageIds.length) return [];
  return getDb()
    .prepare(
      `SELECT c.*, s.url AS source_url, s.domain AS source_domain, s.tier AS source_tier, s.excerpt AS source_excerpt,
              s.retrieved_at AS source_retrieved_at, o.span AS obs_span
       FROM claims c LEFT JOIN sources s ON s.id = c.source_id LEFT JOIN observations o ON o.id = c.observation_id
       WHERE c.message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY c.id`,
    )
    .all(...messageIds) as any;
}

export function entitySetsForMessages(messageIds: number[]): { message_id: number; label: string; members_json: string; constraints_json: string | null }[] {
  if (!messageIds.length) return [];
  return getDb()
    .prepare(`SELECT message_id, label, members_json, constraints_json FROM entity_sets WHERE message_id IN (${messageIds.map(() => '?').join(',')})`)
    .all(...messageIds) as any;
}

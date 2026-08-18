/**
 * DM threads and their messages.
 *
 * Message history is stored rather than re-read from LinkedIn on every pass so
 * the brain drafts replies against what was actually said, and so a thread that
 * was classified `negative` once stays flagged even if the page layout changes.
 */

import { db } from './db.js';
import type { Thread, ThreadClassification } from '../types.js';

interface ThreadRow {
  id: number;
  prospect_id: number;
  conversation_id: string;
  classification: string | null;
  classification_rationale: string | null;
  last_message_at: string | null;
  last_message_from: string | null;
  awaiting_reply: number;
  created_at: string;
  updated_at: string;
}

function hydrate(r: ThreadRow): Thread {
  return {
    id: r.id,
    prospectId: r.prospect_id,
    conversationId: r.conversation_id,
    classification: (r.classification as ThreadClassification | null) ?? null,
    classificationRationale: r.classification_rationale,
    lastMessageAt: r.last_message_at,
    lastMessageFrom: (r.last_message_from as 'them' | 'us' | null) ?? null,
    awaitingReply: Boolean(r.awaiting_reply),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function upsertThread(prospectId: number, conversationId: string): Thread {
  db()
    .prepare(
      `INSERT INTO threads (prospect_id, conversation_id) VALUES (?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET updated_at = datetime('now')`,
    )
    .run(prospectId, conversationId);
  return findByConversationId(conversationId)!;
}

export function findByConversationId(conversationId: string): Thread | null {
  const row = db()
    .prepare('SELECT * FROM threads WHERE conversation_id = ?')
    .get(conversationId) as ThreadRow | undefined;
  return row ? hydrate(row) : null;
}

export interface StoredMessage {
  sender: 'them' | 'us';
  body: string;
  sentAt: string;
}

/** Idempotent: the UNIQUE constraint means re-reading a thread is free. */
export function addMessages(threadId: number, messages: StoredMessage[]): number {
  const stmt = db().prepare(
    `INSERT OR IGNORE INTO messages (thread_id, sender, body, sent_at) VALUES (?, ?, ?, ?)`,
  );
  let inserted = 0;
  const tx = db().transaction((batch: StoredMessage[]) => {
    for (const m of batch) {
      const res = stmt.run(threadId, m.sender, m.body, m.sentAt);
      inserted += res.changes;
    }
  });
  tx(messages);

  const last = messages.at(-1);
  if (last) {
    db()
      .prepare(
        `UPDATE threads SET last_message_at = ?, last_message_from = ?,
           awaiting_reply = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(last.sentAt, last.sender, last.sender === 'them' ? 1 : 0, threadId);
  }
  return inserted;
}

export function messagesFor(threadId: number, limit = 40): StoredMessage[] {
  const rows = db()
    .prepare('SELECT sender, body, sent_at FROM messages WHERE thread_id = ? ORDER BY sent_at ASC LIMIT ?')
    .all(threadId, limit) as Array<{ sender: string; body: string; sent_at: string }>;
  return rows.map((r) => ({ sender: r.sender as 'them' | 'us', body: r.body, sentAt: r.sent_at }));
}

export function classify(
  threadId: number,
  classification: ThreadClassification,
  rationale: string,
): void {
  db()
    .prepare(
      `UPDATE threads SET classification = ?, classification_rationale = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(classification, rationale, threadId);
}

/** Threads where they spoke last and we haven't answered. */
export function awaitingReply(limit = 50): Thread[] {
  const rows = db()
    .prepare('SELECT * FROM threads WHERE awaiting_reply = 1 ORDER BY last_message_at ASC LIMIT ?')
    .all(limit) as ThreadRow[];
  return rows.map(hydrate);
}

export function markAnswered(threadId: number): void {
  db()
    .prepare(`UPDATE threads SET awaiting_reply = 0, updated_at = datetime('now') WHERE id = ?`)
    .run(threadId);
}

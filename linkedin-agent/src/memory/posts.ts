/**
 * Posts seen during mining and feed reads.
 *
 * Exists mainly so the agent never engages the same post twice — a duplicate
 * comment is the most obvious possible tell that something automated is running,
 * and it is also just embarrassing.
 */

import { db } from './db.js';

export interface SeenPost {
  id: number;
  postUrn: string;
  postUrl: string;
  authorPublicId: string | null;
  authorName: string | null;
  body: string | null;
  seenAt: string;
  engaged: boolean;
}

export interface NewPost {
  postUrn: string;
  postUrl: string;
  authorPublicId?: string | null;
  authorName?: string | null;
  body?: string | null;
}

export function recordPost(p: NewPost): void {
  db()
    .prepare(
      `INSERT INTO posts (post_urn, post_url, author_public_id, author_name, body)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(post_urn) DO NOTHING`,
    )
    .run(p.postUrn, p.postUrl, p.authorPublicId ?? null, p.authorName ?? null, p.body ?? null);
}

export function hasEngaged(postUrn: string): boolean {
  const row = db().prepare('SELECT engaged FROM posts WHERE post_urn = ?').get(postUrn) as
    | { engaged: number }
    | undefined;
  return Boolean(row?.engaged);
}

export function markEngaged(postUrn: string): void {
  db().prepare('UPDATE posts SET engaged = 1 WHERE post_urn = ?').run(postUrn);
}

/** Un-engaged posts, newest first — the candidate pool for the engagement pass. */
export function unengaged(limit = 50): SeenPost[] {
  const rows = db()
    .prepare('SELECT * FROM posts WHERE engaged = 0 ORDER BY seen_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    postUrn: r.post_urn as string,
    postUrl: r.post_url as string,
    authorPublicId: (r.author_public_id as string | null) ?? null,
    authorName: (r.author_name as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    seenAt: r.seen_at as string,
    engaged: Boolean(r.engaged),
  }));
}

import type { Database } from "bun:sqlite";

export type MessageDirection = "inbound" | "outbound";

export interface MessageEnvelope {
  key: string;
  account: string;
  direction: MessageDirection;
  fromAddress: string | null;
  toAddresses: string[];
  cc: string[] | null;
  bcc: string[] | null;
  replyTo: string[] | null;
  subject: string | null;
  // null when the provider reported no usable date for this sighting (e.g.
  // IMAP's internalDate can be legitimately absent). See upsertMessage
  // below for how a null date is handled: fallback-to-now applies only on a
  // message's first-ever insert, never overwriting an already-stored date
  // on a re-sight.
  date: string | null;
  size: number | null;
  hasAttachments: boolean;
  threadKey: string | null;
  flags: string[];
}

export interface MessageLocation {
  mailbox: string;
  uidValidity: string | null;
  uid: number | null;
  providerRef: unknown;
  lastSeenAt: string;
}

export interface Classification {
  category: string | null;
  priority: string | null;
  actionRequired: boolean | null;
  summary: string | null;
  suggestedAction: string | null;
  language: string | null;
  facts: unknown;
  model: string | null;
  error: string | null;
  jevSpamProbability: number | null;
  jevCategory: string | null;
  jevCategoryConfidence: number | null;
  jevLatencyMs: number | null;
  jevModel: string | null;
  jevError: string | null;
}

export interface EnrichmentFields {
  category: string | null;
  priority: string | null;
  actionRequired: boolean | null;
  summary: string | null;
  suggestedAction: string | null;
  language: string | null;
  facts: unknown;
  model: string | null;
  error: string | null;
}

export interface JevClassificationFields {
  jevSpamProbability: number | null;
  jevCategory: string | null;
  jevCategoryConfidence: number | null;
  jevLatencyMs: number | null;
  jevModel: string | null;
  jevError: string | null;
}

export interface ListMessagesFilters {
  accountIds?: string[];
  direction?: MessageDirection;
  category?: string;
  actionRequired?: boolean;
  threadKey?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface MessageStats {
  total: number;
  inbound: number;
  outbound: number;
  byCategory: Record<string, number>;
}

export interface ListMessagesResult {
  rows: (MessageEnvelope & { classification: Classification | null })[];
  nextCursor: string | null;
}

export interface SearchMessagesOptions {
  accountIds?: string[];
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

interface MessageRow {
  key: string;
  account: string;
  direction: MessageDirection;
  from_address: string | null;
  to_addresses: string;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  subject: string | null;
  date: string;
  size: number | null;
  has_attachments: number;
  thread_key: string | null;
  flags: string;
  created_at: string;
  updated_at: string;
}

interface MessageLocationRow {
  mailbox: string;
  uid_validity: string | null;
  uid: number | null;
  provider_ref: string;
  last_seen_at: string;
}

interface ClassificationRow {
  category: string | null;
  priority: string | null;
  action_required: number | null;
  summary: string | null;
  suggested_action: string | null;
  language: string | null;
  facts: string | null;
  model: string | null;
  error: string | null;
  jev_spam_probability: number | null;
  jev_category: string | null;
  jev_category_confidence: number | null;
  jev_latency_ms: number | null;
  jev_model: string | null;
  jev_error: string | null;
}

type MessageWithClassificationRow = MessageRow &
  Partial<ClassificationRow> & { classification_updated_at: string | null };

function parseJsonArray<T>(value: string | null): T[] {
  if (!value) return [];
  return JSON.parse(value) as T[];
}

function toEnvelope(row: MessageRow): MessageEnvelope {
  return {
    key: row.key,
    account: row.account,
    direction: row.direction,
    fromAddress: row.from_address,
    toAddresses: parseJsonArray<string>(row.to_addresses),
    cc: row.cc ? parseJsonArray<string>(row.cc) : null,
    bcc: row.bcc ? parseJsonArray<string>(row.bcc) : null,
    replyTo: row.reply_to ? parseJsonArray<string>(row.reply_to) : null,
    subject: row.subject,
    date: row.date,
    size: row.size,
    hasAttachments: Boolean(row.has_attachments),
    threadKey: row.thread_key,
    flags: parseJsonArray<string>(row.flags),
  };
}

function toLocation(row: MessageLocationRow): MessageLocation {
  return {
    mailbox: row.mailbox,
    uidValidity: row.uid_validity,
    uid: row.uid,
    providerRef: JSON.parse(row.provider_ref),
    lastSeenAt: row.last_seen_at,
  };
}

function toClassification(row: Partial<ClassificationRow>): Classification {
  return {
    category: row.category ?? null,
    priority: row.priority ?? null,
    actionRequired:
      row.action_required === null || row.action_required === undefined
        ? null
        : Boolean(row.action_required),
    summary: row.summary ?? null,
    suggestedAction: row.suggested_action ?? null,
    language: row.language ?? null,
    facts: row.facts ? JSON.parse(row.facts) : null,
    model: row.model ?? null,
    error: row.error ?? null,
    jevSpamProbability: row.jev_spam_probability ?? null,
    jevCategory: row.jev_category ?? null,
    jevCategoryConfidence: row.jev_category_confidence ?? null,
    jevLatencyMs: row.jev_latency_ms ?? null,
    jevModel: row.jev_model ?? null,
    jevError: row.jev_error ?? null,
  };
}

function encodeMessageCursor(date: string, key: string): string {
  return Buffer.from(`${date}|${key}`, "utf-8").toString("base64url");
}

function decodeMessageCursor(cursor: string): { date: string; key: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
  const separatorIndex = decoded.lastIndexOf("|");
  if (separatorIndex === -1) {
    throw new Error("Invalid cursor");
  }
  return {
    date: decoded.slice(0, separatorIndex),
    key: decoded.slice(separatorIndex + 1),
  };
}

// Turns free-text search input into quoted, prefix-matched FTS5 tokens so
// user input (including bare operators like `OR (`) can never produce an
// FTS5 syntax error. Mirrors src/db/emails.ts's sanitizeFtsQuery.
function sanitizeFtsQuery(input: string): string {
  return input
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(" ");
}

// Covers `messages`, `message_locations`, `classifications`, `body_cache` and
// `messages_fts` together — one aggregate keyed by the stable message key
// (docs/architecture.md §Lean store), the same deep-module shape as the old
// src/db/emails.ts covering `emails` + `email_enrichments` + `emails_fts`.
export function createMessagesRepo(db: Database) {
  // Recomputes the FTS row from the message + classification tables (subject,
  // addresses = from/to/cc joined, summary). Called after upsertMessage
  // (subject is already known) and after either saveEnrichment or
  // saveJevClassification (addresses were already known, summary now is too)
  // so the FTS row always reflects the latest of both — same delete-then-
  // insert approach as emails.ts's syncFtsRow.
  // Wrapped in its own db.transaction() rather than left as two separate
  // autocommit statements: saveEnrichment (the classify job) and
  // saveJevClassification (the jev_message job) can run concurrently for the
  // same key (the two-container deploy overlap this repo already designs
  // around, per src/db/jobs.ts), and two connections interleaving their own
  // DELETE+INSERT pairs could otherwise leave duplicate messages_fts rows.
  // Called from inside upsertMessageTx's own already-open db.transaction()
  // too — bun:sqlite's db.transaction() nests safely via SAVEPOINT (verified
  // directly against this repo's bun:sqlite, not assumed), so wrapping here
  // unconditionally is simpler and just as correct as threading an
  // "already inside a transaction" flag through every caller. Built lazily
  // per call, same as upsertMessageTx above, so importing this module never
  // touches db.transaction on the lazy mailDb Proxy.
  function syncFtsRow(key: string): void {
    db.transaction((key: string) => {
      const row = db
        .query<
          {
            subject: string | null;
            from_address: string | null;
            to_addresses: string;
            cc: string | null;
            summary: string | null;
          },
          [string]
        >(
          `SELECT m.subject, m.from_address, m.to_addresses, m.cc, c.summary
           FROM messages m
           LEFT JOIN classifications c ON c.key = m.key
           WHERE m.key = ?`,
        )
        .get(key);

      db.run("DELETE FROM messages_fts WHERE message_key = ?", [key]);
      if (!row) return;

      const addresses = [
        row.from_address,
        ...parseJsonArray<string>(row.to_addresses),
        ...(row.cc ? parseJsonArray<string>(row.cc) : []),
      ]
        .filter(Boolean)
        .join(" ");

      db.run(
        `INSERT INTO messages_fts (subject, addresses, summary, message_key)
         VALUES (?, ?, ?, ?)`,
        [row.subject ?? "", addresses, row.summary ?? "", key],
      );
    })(key);
  }

  // Built lazily, per call, rather than once at factory-construction time:
  // `db` here can be `mailDb`'s lazy Proxy (src/db/mail-client.ts), and
  // touching `db.transaction` eagerly at construction would defeat its
  // documented "importing this module never opens the file" contract —
  // every property access on that Proxy triggers the real open + migrations.
  // `now` is only ever consulted as the INSERT-branch fallback (via
  // COALESCE) when envelope.date is null on a message's first-ever sight —
  // messages.date is NOT NULL, so a genuinely new row still needs some
  // value. On the ON CONFLICT DO UPDATE branch, a null envelope.date must
  // NOT advance the stored date to a fresh "now" on every re-sight (a
  // provider that never reports a date for a message would otherwise make
  // it float to the top of anything sorted by date DESC, forever) — so the
  // UPDATE branch binds the raw envelope.date again and falls back to the
  // column's own current value (`messages.date`) instead of `now` when it's
  // null. `excluded.date` is deliberately not used here: it already
  // reflects the INSERT branch's COALESCE result (never actually null by
  // the time ON CONFLICT evaluates it), which can't express "keep the old
  // value".
  function upsertMessageTx(envelope: MessageEnvelope, now: string): void {
    db.transaction((envelope: MessageEnvelope, now: string) => {
      db.run(
        `INSERT INTO messages (
           key, account, direction, from_address, to_addresses, cc, bcc,
           reply_to, subject, date, size, has_attachments, thread_key, flags,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ?), ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           account = excluded.account,
           direction = excluded.direction,
           from_address = excluded.from_address,
           to_addresses = excluded.to_addresses,
           cc = excluded.cc,
           bcc = excluded.bcc,
           reply_to = excluded.reply_to,
           subject = excluded.subject,
           date = CASE WHEN ? IS NULL THEN messages.date ELSE ? END,
           size = excluded.size,
           has_attachments = excluded.has_attachments,
           thread_key = excluded.thread_key,
           flags = excluded.flags,
           updated_at = excluded.updated_at`,
        [
          envelope.key,
          envelope.account,
          envelope.direction,
          envelope.fromAddress,
          JSON.stringify(envelope.toAddresses),
          envelope.cc ? JSON.stringify(envelope.cc) : null,
          envelope.bcc ? JSON.stringify(envelope.bcc) : null,
          envelope.replyTo ? JSON.stringify(envelope.replyTo) : null,
          envelope.subject,
          envelope.date,
          now,
          envelope.size,
          envelope.hasAttachments ? 1 : 0,
          envelope.threadKey,
          JSON.stringify(envelope.flags),
          now,
          now,
          envelope.date,
          envelope.date,
        ],
      );
      syncFtsRow(envelope.key);
    })(envelope, now);
  }

  function upsertMessage(
    envelope: MessageEnvelope,
    now: string = new Date().toISOString(),
  ): void {
    upsertMessageTx(envelope, now);
  }

  function upsertLocation(key: string, location: MessageLocation): void {
    db.run(
      `INSERT INTO message_locations (key, mailbox, uid_validity, uid, provider_ref, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key, mailbox) DO UPDATE SET
         uid_validity = excluded.uid_validity,
         uid = excluded.uid,
         provider_ref = excluded.provider_ref,
         last_seen_at = excluded.last_seen_at`,
      [
        key,
        location.mailbox,
        location.uidValidity,
        location.uid,
        JSON.stringify(location.providerRef),
        location.lastSeenAt,
      ],
    );
  }

  // Removes one mailbox's location row for a key — used after a successful
  // move so the OLD mailbox's now-stale location (its uid no longer exists
  // there) doesn't linger for a later /flags or /move call to resolve.
  function removeLocation(key: string, mailbox: string): void {
    db.run("DELETE FROM message_locations WHERE key = ? AND mailbox = ?", [
      key,
      mailbox,
    ]);
  }

  function getMessage(
    key: string,
  ): (MessageEnvelope & { locations: MessageLocation[] }) | null {
    const row = db
      .query<MessageRow, [string]>("SELECT * FROM messages WHERE key = ?")
      .get(key);
    if (!row) return null;

    const locations = db
      .query<MessageLocationRow, [string]>(
        "SELECT * FROM message_locations WHERE key = ? ORDER BY last_seen_at DESC",
      )
      .all(key)
      .map(toLocation);

    return { ...toEnvelope(row), locations };
  }

  function listMessages(filters: ListMessagesFilters = {}): ListMessagesResult {
    const limit = Math.min(
      Math.max(filters.limit ?? DEFAULT_LIST_LIMIT, 1),
      MAX_LIST_LIMIT,
    );

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.accountIds && filters.accountIds.length > 0) {
      conditions.push(
        `m.account IN (${filters.accountIds.map(() => "?").join(", ")})`,
      );
      params.push(...filters.accountIds);
    }
    if (filters.direction) {
      conditions.push("m.direction = ?");
      params.push(filters.direction);
    }
    if (filters.category) {
      conditions.push("c.category = ?");
      params.push(filters.category);
    }
    if (filters.actionRequired !== undefined) {
      conditions.push("c.action_required = ?");
      params.push(filters.actionRequired ? 1 : 0);
    }
    if (filters.threadKey) {
      conditions.push("m.thread_key = ?");
      params.push(filters.threadKey);
    }
    if (filters.since) {
      conditions.push("m.date >= ?");
      params.push(filters.since);
    }
    if (filters.until) {
      conditions.push("m.date <= ?");
      params.push(filters.until);
    }
    if (filters.cursor) {
      const { date, key } = decodeMessageCursor(filters.cursor);
      conditions.push("(m.date < ? OR (m.date = ? AND m.key < ?))");
      params.push(date, date, key);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .query<MessageWithClassificationRow, (string | number)[]>(
        `SELECT m.*, c.category, c.priority, c.action_required, c.summary,
                c.suggested_action, c.language, c.facts, c.model, c.error,
                c.jev_spam_probability, c.jev_category, c.jev_category_confidence,
                c.jev_latency_ms, c.jev_model, c.jev_error,
                c.updated_at AS classification_updated_at
         FROM messages m
         LEFT JOIN classifications c ON c.key = m.key
         ${where}
         ORDER BY m.date DESC, m.key DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const data = page.map((row) => ({
      ...toEnvelope(row),
      classification: row.classification_updated_at
        ? toClassification(row)
        : null,
    }));

    const last = data[data.length - 1];
    // last.date is read back from the messages.date column, which is NOT
    // NULL — MessageEnvelope.date is string | null only on the write side
    // (an envelope not yet upserted); a row already in the table always has
    // a real date.
    const nextCursor =
      hasMore && last ? encodeMessageCursor(last.date!, last.key) : null;

    return { rows: data, nextCursor };
  }

  // Writes ONLY the LLM enrichment columns, leaving any existing jev_*
  // columns untouched (ON CONFLICT DO UPDATE SET lists just these columns).
  // Split from a single full-row saveClassification: that writer replaced
  // every column on every call, so a `classify` job and a concurrently
  // running `jev_message` job for the same key (the legacy re-enrich
  // endpoint can re-enqueue `classify` at any time, racing an in-flight
  // `jev_message` claim) could clobber each other depending on commit
  // order. Targeted column writers can never clobber each other regardless
  // of ordering — see saveJevClassification below.
  function saveEnrichment(key: string, fields: EnrichmentFields): void {
    db.run(
      `INSERT INTO classifications (
         key, category, priority, action_required, summary, suggested_action,
         language, facts, model, error, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         category = excluded.category,
         priority = excluded.priority,
         action_required = excluded.action_required,
         summary = excluded.summary,
         suggested_action = excluded.suggested_action,
         language = excluded.language,
         facts = excluded.facts,
         model = excluded.model,
         error = excluded.error,
         updated_at = excluded.updated_at`,
      [
        key,
        fields.category,
        fields.priority,
        fields.actionRequired === null ? null : fields.actionRequired ? 1 : 0,
        fields.summary,
        fields.suggestedAction,
        fields.language,
        fields.facts ? JSON.stringify(fields.facts) : null,
        fields.model,
        fields.error,
        new Date().toISOString(),
      ],
    );

    syncFtsRow(key);
  }

  // Writes ONLY the jev_* columns, leaving any existing LLM enrichment
  // columns untouched. See saveEnrichment above for why this is split out.
  function saveJevClassification(
    key: string,
    fields: JevClassificationFields,
  ): void {
    db.run(
      `INSERT INTO classifications (
         key, jev_spam_probability, jev_category, jev_category_confidence,
         jev_latency_ms, jev_model, jev_error, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         jev_spam_probability = excluded.jev_spam_probability,
         jev_category = excluded.jev_category,
         jev_category_confidence = excluded.jev_category_confidence,
         jev_latency_ms = excluded.jev_latency_ms,
         jev_model = excluded.jev_model,
         jev_error = excluded.jev_error,
         updated_at = excluded.updated_at`,
      [
        key,
        fields.jevSpamProbability,
        fields.jevCategory,
        fields.jevCategoryConfidence,
        fields.jevLatencyMs,
        fields.jevModel,
        fields.jevError,
        new Date().toISOString(),
      ],
    );

    syncFtsRow(key);
  }

  function getClassification(key: string): Classification | null {
    const row = db
      .query<ClassificationRow, [string]>(
        "SELECT * FROM classifications WHERE key = ?",
      )
      .get(key);
    return row ? toClassification(row) : null;
  }

  function getBody(
    key: string,
  ): { html: string | null; text: string | null; fetchedAt: string } | null {
    const row = db
      .query<
        { html: string | null; text: string | null; fetched_at: string },
        [string]
      >("SELECT html, text, fetched_at FROM body_cache WHERE key = ?")
      .get(key);
    return row
      ? { html: row.html, text: row.text, fetchedAt: row.fetched_at }
      : null;
  }

  function saveBody(
    key: string,
    body: { html: string | null; text: string | null },
  ): void {
    db.run(
      `INSERT INTO body_cache (key, html, text, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         html = excluded.html,
         text = excluded.text,
         fetched_at = excluded.fetched_at`,
      [key, body.html, body.text, new Date().toISOString()],
    );
  }

  // LRU eviction: rows older than maxAgeMs go first, then (if still over
  // maxRows) the oldest-fetched_at rows go until at maxRows. Returns the
  // total number of rows deleted.
  function evictStaleBodies({
    maxRows,
    maxAgeMs,
    now = new Date(),
  }: {
    maxRows: number;
    maxAgeMs: number;
    now?: Date;
  }): number {
    const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
    const { changes: ageDeleted } = db.run(
      "DELETE FROM body_cache WHERE fetched_at < ?",
      [cutoff],
    );

    const { count } = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM body_cache")
      .get()!;

    let countDeleted = 0;
    if (count > maxRows) {
      const excess = count - maxRows;
      const { changes } = db.run(
        `DELETE FROM body_cache WHERE key IN (
           SELECT key FROM body_cache ORDER BY fetched_at ASC LIMIT ?
         )`,
        [excess],
      );
      countDeleted = changes;
    }

    return ageDeleted + countDeleted;
  }

  function knownMessageKeys(keys: string[]): Set<string> {
    if (keys.length === 0) return new Set();

    const rows = db
      .query<{ key: string }, string[]>(
        `SELECT key FROM messages WHERE key IN (${keys.map(() => "?").join(", ")})`,
      )
      .all(...keys);

    return new Set(rows.map((row) => row.key));
  }

  function searchMessages(
    query: string,
    { accountIds, limit = DEFAULT_LIST_LIMIT }: SearchMessagesOptions = {},
  ): string[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

    const conditions = ["messages_fts MATCH ?"];
    const params: (string | number)[] = [ftsQuery];

    if (accountIds && accountIds.length > 0) {
      conditions.push(`m.account IN (${accountIds.map(() => "?").join(", ")})`);
      params.push(...accountIds);
    }

    const rows = db
      .query<{ message_key: string }, (string | number)[]>(
        `SELECT fts.message_key AS message_key
         FROM messages_fts fts
         JOIN messages m ON m.key = fts.message_key
         WHERE ${conditions.join(" AND ")}
         ORDER BY m.date DESC
         LIMIT ?`,
      )
      .all(...params, limit);

    return rows.map((row) => row.message_key);
  }

  // Minimal aggregate for GET /api/stats: total/inbound/outbound counts plus a
  // category breakdown over whatever has been classified so far. Replaces the
  // old src/db/emails.ts emailStats()/actionRequiredCount() pair with the
  // simplest thing this schema can answer directly — not a full day-bucketed
  // chart (the old stats shape), which nothing here has asked for yet.
  function getStats({ since }: { since?: string } = {}): MessageStats {
    const totalsWhere = since ? "WHERE date >= ?" : "";
    const totals = db
      .query<
        { total: number; inbound: number; outbound: number },
        [string] | []
      >(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(direction = 'inbound'), 0) AS inbound,
                COALESCE(SUM(direction = 'outbound'), 0) AS outbound
         FROM messages
         ${totalsWhere}`,
      )
      .get(...(since ? [since] : []))!;

    // classifications has no date column of its own — the since filter joins
    // to messages for the date, same as listMessages's category filter.
    const categoryWhere = since
      ? "WHERE c.category IS NOT NULL AND m.date >= ?"
      : "WHERE c.category IS NOT NULL";
    const categoryRows = db
      .query<{ category: string; count: number }, [string] | []>(
        `SELECT c.category AS category, COUNT(*) AS count
         FROM classifications c
         JOIN messages m ON m.key = c.key
         ${categoryWhere}
         GROUP BY c.category`,
      )
      .all(...(since ? [since] : []));

    return {
      ...totals,
      byCategory: Object.fromEntries(
        categoryRows.map((row) => [row.category, row.count]),
      ),
    };
  }

  return {
    upsertMessage,
    upsertLocation,
    removeLocation,
    getMessage,
    listMessages,
    saveEnrichment,
    saveJevClassification,
    getClassification,
    getBody,
    saveBody,
    evictStaleBodies,
    knownMessageKeys,
    searchMessages,
    getStats,
  };
}

export type MessagesRepo = ReturnType<typeof createMessagesRepo>;

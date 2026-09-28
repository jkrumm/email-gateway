import type {
  Capabilities,
  Envelope,
  Mailbox,
  MailProvider,
  Message,
  MessageRef,
  Page,
} from "../providers/port";

// An in-memory MailProvider for tests that exercise the sync/classification
// wiring without live IMAP. It carries the Gmail-shape *data* a provider can
// report — X-GM-THRID thread keys on an Envelope, special-use folders — so a
// provider with `id: "gmail"` can be faked as richly as the real adapter's
// output. It does NOT simulate CONDSTORE/skipFastPath itself: `list()` just
// plays back static pages and ignores its `options` argument — the adapter's
// own fast-path mechanics are unit-tested directly in
// src/providers/imap/provider.test.ts, and src/sync/ingest.test.ts has its
// own inline fake specifically to exercise the skipFastPath contract.
// Injected through the existing factory params; no module is mocked.
export interface FakeMailProviderOptions {
  id: MailProvider["id"];
  account: string;
  // Defaults to a full-capability list adapter (list/read/search/flag/move).
  capabilities?: Partial<Capabilities>;
  mailboxes?: Mailbox[];
  // Mailbox path -> successive pages of envelopes. The cursor is the page
  // index, so a second call with the returned cursor genuinely continues.
  pages?: Record<string, Envelope[][]>;
  // Mailbox path -> uid -> the body read() returns for that message.
  bodies?: Record<string, Record<number, Message>>;
}

export interface FakeMailProvider extends MailProvider {
  readonly listCalls: { mailbox: string; cursor: string | undefined }[];
}

function defaultCapabilities(id: MailProvider["id"]): Capabilities {
  const isResend = id === "resend";
  return {
    list: true,
    read: true,
    search: true,
    flag: !isResend,
    move: !isResend,
    send: isResend,
    idle: !isResend,
  };
}

export function createFakeMailProvider({
  id,
  account,
  capabilities,
  mailboxes = [],
  pages = {},
  bodies = {},
}: FakeMailProviderOptions): FakeMailProvider {
  const caps = { ...defaultCapabilities(id), ...capabilities };
  const listCalls: { mailbox: string; cursor: string | undefined }[] = [];

  return {
    id,
    account,
    listCalls,
    capabilities: async () => ({ ...caps }),
    listMailboxes: async () => mailboxes,
    async list(mailbox, cursor): Promise<Page<Envelope>> {
      listCalls.push({ mailbox, cursor });
      const mailboxPages = pages[mailbox] ?? [];
      const index = cursor ? Number(cursor) : 0;
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`fake: invalid list() cursor "${cursor}"`);
      }
      const items = mailboxPages[index] ?? [];
      const hasMore = index + 1 < mailboxPages.length;
      return { items, cursor: hasMore ? String(index + 1) : undefined };
    },
    async read(ref: MessageRef): Promise<Message> {
      if (ref.provider === "resend") throw new Error("fake: no resend body");
      const body = bodies[ref.mailbox]?.[ref.uid];
      if (!body) throw new Error(`fake: no body for ${ref.mailbox}:${ref.uid}`);
      return body;
    },
    async search() {
      return [];
    },
    async setFlags() {},
    async move(ref) {
      return ref;
    },
    async send() {
      throw new Error("fake: send not implemented");
    },
  };
}

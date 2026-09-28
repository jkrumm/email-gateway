import type { Resend } from "resend";

// The subset of the Resend SDK this repo's send + history-read paths use.
// Defined via Pick against the real SDK class so the response/option types
// stay in sync with whatever `resend` (or a test fake) provides. Named in the
// provider layer, so it never depends upward on the web/api layer.
export type ResendClient = {
  emails: Pick<Resend["emails"], "list" | "get"> & {
    receiving: Pick<Resend["emails"]["receiving"], "list" | "get">;
  };
};

// The resend provider's send() needs `.emails.send` too, on top of the
// read-only shape above — kept separate so ResendClient (list/get/receiving
// only, used by sync's reads) never has to fake a `send` it never calls.
export type ResendSendClient = ResendClient & {
  emails: Pick<Resend["emails"], "send">;
};

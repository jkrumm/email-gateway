import { mailDb } from "./mail-client";
import { createAccountsRepo } from "./accounts";
import { createMessagesRepo } from "./messages";
import { createMailSubmissionsRepo } from "./mail-submissions";
import { createTemplatesRepo } from "./templates";
import { createSendLogRepo } from "./send-log";
import { createThreadSummariesRepo } from "./thread-summaries";

// Singletons bound to the lazily-opened mail.sqlite database, for production
// call sites (jobs, sync, gate, send-mail). Tests build their own repos via
// create*Repo(openMailDatabase(":memory:")). Mirrors src/db/index.ts's
// pattern for the old email-gateway.sqlite store.
export const accountsRepo = createAccountsRepo(mailDb);
export const messagesRepo = createMessagesRepo(mailDb);
export const mailSubmissionsRepo = createMailSubmissionsRepo(mailDb);
export const templatesRepo = createTemplatesRepo(mailDb);
export const sendLogRepo = createSendLogRepo(mailDb);
export const threadSummariesRepo = createThreadSummariesRepo(mailDb);

export { mailDb, openMailDatabase } from "./mail-client";
export * from "./accounts";
export * from "./messages";
export * from "./mail-submissions";
export * from "./templates";
export * from "./send-log";
export * from "./thread-summaries";

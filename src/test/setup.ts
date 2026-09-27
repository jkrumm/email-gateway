// Preloaded for every `bun test` run (see bunfig.toml). Provides dummy env
// values so importing src/env.ts doesn't throw before tests get a chance to run.
process.env.SECRET_KEY ??= "test-secret-key";
process.env.RECEIVER_EMAIL ??= "receiver@example.com";
process.env.RESEND_API_KEY ??= "test-resend-api-key";
process.env.SY_SERENDIPITY_RECEIVER_EMAIL ??= "sy-receiver@example.com";
// Keep the default db singleton (src/db/client.ts) in-memory during tests so
// importing route/admin modules never touches the filesystem.
process.env.DATA_DIR ??= ":memory:";

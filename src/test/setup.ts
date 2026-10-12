// Preloaded for every `bun test` run (see bunfig.toml). Provides dummy env
// values so importing src/env.ts doesn't throw before tests get a chance to run.
process.env.SECRET_KEY ??= "test-secret-key";
process.env.RECEIVER_EMAIL ??= "receiver@example.com";
process.env.SES_REGION ??= "eu-central-1";
process.env.SES_ACCESS_KEY_ID ??= "test-ses-access-key-id";
process.env.SES_SECRET_ACCESS_KEY ??= "test-ses-secret-access-key";
process.env.SES_CONFIGURATION_SET ??= "test-ses-configuration-set";
process.env.SY_SERENDIPITY_RECEIVER_EMAIL ??= "sy-receiver@example.com";
// Keep the default db singleton (src/db/client.ts) in-memory during tests so
// importing route/admin modules never touches the filesystem.
process.env.DATA_DIR ??= ":memory:";
process.env.SY_SERENDIPITY_READ_KEY ??=
  "test-sy-serendipity-read-key-0123456789";

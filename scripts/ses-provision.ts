/**
 * Idempotent SES provisioning via the `aws` CLI (no SDK dependency).
 *
 *   bun scripts/ses-provision.ts [--create-key] <domain> [<domain>…]
 *
 * Converges: SES identities (Easy DKIM 2048) with a custom MAIL FROM on
 * `ses.<domain>`, configuration set `email-gateway`, an SNS topic wired as the
 * set's event destination (re-runs converge it to EVENT_TYPES), the account-level
 * suppression list for BOUNCE + COMPLAINT, and an IAM user scoped to SendEmail
 * on exactly those identities + the set. Prints the DNS records to add (never applies them) and
 * the SNS topic ARN. The access key is created only with `--create-key`, only
 * if the user has none, and printed exactly once on stdout's last block.
 *
 * Auth: AWS_PROFILE / AWS_REGION from the environment, default `jk-ses` /
 * `eu-central-1`. Never run against another profile.
 */

const REGION = process.env.AWS_REGION ?? "eu-central-1";
const PROFILE = process.env.AWS_PROFILE ?? "jk-ses";
const CONFIG_SET = "email-gateway";
const TOPIC_NAME = "email-gateway-ses";
const IAM_USER = "email-gateway-ses";
const MAIL_FROM_PREFIX = "ses";
export const EVENT_TYPES = [
  "SEND",
  "DELIVERY",
  "BOUNCE",
  "COMPLAINT",
  "REJECT",
  "DELIVERY_DELAY",
  "RENDERING_FAILURE",
] as const;
export const SUPPRESSED_REASONS = ["BOUNCE", "COMPLAINT"] as const;

export function suppressionArgs(): string[] {
  return [
    "sesv2",
    "put-account-suppression-attributes",
    "--suppressed-reasons",
    ...SUPPRESSED_REASONS,
  ];
}

export type DnsRecord = {
  type: "CNAME" | "MX" | "TXT";
  name: string;
  value: string;
};

export function dnsRecords(domain: string, dkimTokens: string[]): DnsRecord[] {
  const mailFrom = `${MAIL_FROM_PREFIX}.${domain}`;
  return [
    ...dkimTokens.map((t): DnsRecord => ({
      type: "CNAME",
      name: `${t}._domainkey.${domain}`,
      value: `${t}.dkim.amazonses.com`,
    })),
    {
      type: "MX",
      name: mailFrom,
      value: `10 feedback-smtp.${REGION}.amazonses.com`,
    },
    { type: "TXT", name: mailFrom, value: "v=spf1 include:amazonses.com ~all" },
  ];
}

// identity/* rather than the listed domains: in the sandbox SES also
// authorizes against the *recipient's* verified identity, and every
// identity in this account is ours, so the wildcard costs no isolation.
export function sendPolicy(account: string): object {
  const arn = (kind: string, id: string) =>
    `arn:aws:ses:${REGION}:${account}:${kind}/${id}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["ses:SendEmail", "ses:SendRawEmail"],
        Resource: [arn("identity", "*"), arn("configuration-set", CONFIG_SET)],
      },
      // Account-level actions: SES has no resource-level scoping for them.
      {
        Effect: "Allow",
        Action: [
          "ses:GetAccount",
          "ses:ListSuppressedDestinations",
          "ses:DeleteSuppressedDestination",
        ],
        Resource: "*",
      },
    ],
  };
}

export function topicPolicy(topicArn: string, account: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowSesPublish",
        Effect: "Allow",
        Principal: { Service: "ses.amazonaws.com" },
        Action: "sns:Publish",
        Resource: topicArn,
        Condition: {
          StringEquals: { "AWS:SourceAccount": account },
          StringLike: {
            "AWS:SourceArn": `arn:aws:ses:${REGION}:${account}:configuration-set/${CONFIG_SET}`,
          },
        },
      },
    ],
  };
}

type AwsResult = { ok: boolean; out: string; err: string };

async function aws(args: string[]): Promise<AwsResult> {
  const proc = Bun.spawn(
    [
      "aws",
      "--profile",
      PROFILE,
      "--region",
      REGION,
      "--output",
      "json",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { ok: (await proc.exited) === 0, out, err };
}

async function awsOk(args: string[]): Promise<any> {
  const r = await aws(args);
  if (!r.ok)
    throw new Error(`aws ${args.slice(0, 2).join(" ")}: ${r.err.trim()}`);
  return r.out.trim() ? JSON.parse(r.out) : {};
}

async function ensureIdentity(domain: string): Promise<string[]> {
  const exists = await aws([
    "sesv2",
    "get-email-identity",
    "--email-identity",
    domain,
  ]);
  if (!exists.ok) {
    await awsOk([
      "sesv2",
      "create-email-identity",
      "--email-identity",
      domain,
      "--dkim-signing-attributes",
      "NextSigningKeyLength=RSA_2048_BIT",
      "--configuration-set-name",
      CONFIG_SET,
    ]);
  }
  await awsOk([
    "sesv2",
    "put-email-identity-mail-from-attributes",
    "--email-identity",
    domain,
    "--mail-from-domain",
    `${MAIL_FROM_PREFIX}.${domain}`,
    "--behavior-on-mx-failure",
    "USE_DEFAULT_VALUE",
  ]);
  await awsOk([
    "sesv2",
    "put-email-identity-configuration-set-attributes",
    "--email-identity",
    domain,
    "--configuration-set-name",
    CONFIG_SET,
  ]);
  const id = await awsOk([
    "sesv2",
    "get-email-identity",
    "--email-identity",
    domain,
  ]);
  return id.DkimAttributes?.Tokens ?? [];
}

async function ensureConfigSet(
  topicArn: string,
): Promise<"created" | "updated"> {
  const exists = await aws([
    "sesv2",
    "get-configuration-set",
    "--configuration-set-name",
    CONFIG_SET,
  ]);
  if (!exists.ok) {
    await awsOk([
      "sesv2",
      "create-configuration-set",
      "--configuration-set-name",
      CONFIG_SET,
      "--sending-options",
      "SendingEnabled=true",
    ]);
  }
  const destination = JSON.stringify({
    Enabled: true,
    MatchingEventTypes: EVENT_TYPES,
    SnsDestination: { TopicArn: topicArn },
  });
  const have = await aws([
    "sesv2",
    "get-configuration-set-event-destinations",
    "--configuration-set-name",
    CONFIG_SET,
  ]);
  const present =
    have.ok &&
    (JSON.parse(have.out.trim() || "{}").EventDestinations ?? []).some(
      (d: { Name: string }) => d.Name === "sns",
    );
  await awsOk([
    "sesv2",
    present
      ? "update-configuration-set-event-destination"
      : "create-configuration-set-event-destination",
    "--configuration-set-name",
    CONFIG_SET,
    "--event-destination-name",
    "sns",
    "--event-destination",
    destination,
  ]);
  return present ? "updated" : "created";
}

async function ensureIamUser(
  account: string,
  domains: string[],
  createKey: boolean,
) {
  const user = await aws(["iam", "get-user", "--user-name", IAM_USER]);
  if (!user.ok) await awsOk(["iam", "create-user", "--user-name", IAM_USER]);
  await awsOk([
    "iam",
    "put-user-policy",
    "--user-name",
    IAM_USER,
    "--policy-name",
    "ses-send",
    "--policy-document",
    JSON.stringify(sendPolicy(account)),
  ]);
  const keys = await awsOk([
    "iam",
    "list-access-keys",
    "--user-name",
    IAM_USER,
  ]);
  if ((keys.AccessKeyMetadata ?? []).length > 0)
    return { existingKeys: keys.AccessKeyMetadata.length };
  if (!createKey) return { existingKeys: 0 };
  const created = await awsOk([
    "iam",
    "create-access-key",
    "--user-name",
    IAM_USER,
  ]);
  return {
    existingKeys: 0,
    key: created.AccessKey as { AccessKeyId: string; SecretAccessKey: string },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const createKey = args.includes("--create-key");
  const domains = args.filter((a) => !a.startsWith("--"));
  if (domains.length === 0) {
    console.error(
      "usage: bun scripts/ses-provision.ts [--create-key] <domain>…",
    );
    process.exit(2);
  }
  const { Account: account } = await awsOk(["sts", "get-caller-identity"]);

  const { TopicArn: topicArn } = await awsOk([
    "sns",
    "create-topic",
    "--name",
    TOPIC_NAME,
  ]);
  await awsOk([
    "sns",
    "set-topic-attributes",
    "--topic-arn",
    topicArn,
    "--attribute-name",
    "Policy",
    "--attribute-value",
    JSON.stringify(topicPolicy(topicArn, account)),
  ]);
  const destinationChange = await ensureConfigSet(topicArn);

  console.log(`topic: ${topicArn}`);
  console.log(
    `event destination sns: ${destinationChange} (${EVENT_TYPES.join(", ")})`,
  );

  // VDM (PutAccountVdmAttributes) is deliberately not provisioned: it bills a
  // per-email fee, which is an owner decision.
  await awsOk(suppressionArgs());
  console.log(
    `account suppression list: ${SUPPRESSED_REASONS.join(" + ")} (set; idempotent)`,
  );
  for (const domain of domains) {
    const tokens = await ensureIdentity(domain);
    console.log(`\n# ${domain}`);
    for (const r of dnsRecords(domain, tokens))
      console.log(`${r.type}\t${r.name}\t${r.value}`);
  }

  const iam = await ensureIamUser(account, domains, createKey);
  console.log(`\niam user ${IAM_USER}: ${iam.existingKeys} existing key(s)`);
  if (iam.key) {
    console.log("\n--- access key (shown once) ---");
    console.log(JSON.stringify(iam.key));
  }
}

if (import.meta.main) await main();

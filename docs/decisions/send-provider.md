# Send-provider decision

Wave 10, 2026-10-12. **Status: decided 2026-10-12 — Amazon SES `eu-central-1` (D5 in
[architecture](../architecture.md)), not the recommended Resend Pro.** Resend was removed from the gateway in Wave 15. Every provider fact below comes from `/research` runs on
2026-10-12 against the vendors' own docs (sources at the end); prod numbers
come from read-only `ssh vps` + `docker exec` probes the same day. Domain
names are placeholders because this repo is public.

## Findings that reframe the question

- **The cap is Resend's Free plan, not Resend.** Free allows 3 custom
  domains, Pro 10, Scale 1,000. Any paid plan can add 100 more domains for
  $20/month, and Resend states there is no fixed ceiling.
- **The team is exactly at the cap.** Resend's `GET /domains`, called from
  the prod container, lists three verified domains: `<fpp-domain>` (2024,
  `us-east-1`), `<shutterflow-domain>` (2026-09-25, `eu-west-1`) and
  `<personal-domain>` (added 2026-10-12, `eu-west-1`). A fourth is
  blocked today.
- **Shutterflow shares the team.** It sends through Resend with its own key
  (`vps/apps/shutterflow`), not through this gateway. Any move away from
  Resend covers only the gateway unless Shutterflow moves too.
- **Volume is tiny.** The new store's `send_log` holds 19 sends in 14 days:
  a daily analytics mail plus five charter requests. The old store held 34
  Resend rows for Aug 30–Sep 28, Shutterflow included. The whole team sends
  about 40–60 mails a month, so cost cannot decide this. Effort and ops do.
- **Pre-existing bug:** the route sends never set `provider_message_id`
  (`sendMail` inserts the row by Resend id only), so `reconcile_send_log`
  skips every one of them. In prod, 19 of 19 rows have no status, and 3,963
  reconcile runs updated nothing. The send-port wave below fixes it on the
  way, whichever provider wins.

## Options

Our volume is about 50 mails a month across 3 domains today, more coming.

| Option                                                    | Domain cap                                                                                        | Cost at our volume                                           | Events / status                                                                                                   | Inbound                         | EU residency                                  | Ops burden                                                                                            | Deliverability risk                                                                                  | Effort here                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **A. Resend Pro**                                         | 10, +100 per $20/mo add-on                                                                        | $20/mo (monthly only)                                        | 11 `email.*` webhooks; `GET /emails/{id}` `last_event` (already polled)                                           | Yes, GA, all plans              | Sending in `eu-west-1`; **data stored in US** | None                                                                                                  | Low, unchanged                                                                                       | **None in code.** A billing change                                                                   |
| B. Resend, several Free teams                             | 3 per team, teams unlimited                                                                       | $0                                                           | As A, per team                                                                                                    | As A                            | As A                                          | One key per team; a domain lives on one team only                                                     | Low                                                                                                  | Small: route a sender domain to its team's key. **Unverified whether this is within Resend's terms** |
| C. Postmark                                               | **Conflicting:** pricing page 5 / 10 / unlimited (Basic / Pro / Platform); support doc "no limit" | $15–18/mo (10k tier); free Developer plan is 100 mails/mo    | 6 webhooks (Delivery, Bounce, SpamComplaint, Open, Click, SubscriptionChange); Bounce + Suppression API           | Pro and Platform only           | **None, US only, no plans for EU**            | None; manual account approval (<24 h weekdays)                                                        | Low                                                                                                  | Adapter, React→HTML render, webhook route                                                            |
| D. Amazon SES, `eu-central-1`                             | 10,000 identities per region                                                                      | About $0.01/mo ($0.16 per 1,000 on Essentials); no free tier | 10 event types via configuration set → SNS / EventBridge; `GetMessageInsights` per message (VDM need unconfirmed) | Yes, in `eu-central-1`          | **Full EU**                                   | AWS account + IAM, sandbox → production request, 3 DKIM CNAMEs per domain, SNS                        | Low–medium: shared SES pool; account pause on high bounce/complaint rates                            | Largest API option: adapter, signed SNS webhook on the public door, per-domain identity setup        |
| E. SMTP2GO / AhaSend                                      | Unlimited on paid (SMTP2GO $10; AhaSend Pro €9)                                                   | $10 / €9 per month                                           | Webhooks on both (SMTP2GO event list unverified)                                                                  | AhaSend yes; SMTP2GO unverified | AhaSend EU-hosted; SMTP2GO unverified         | None                                                                                                  | Unknown; smaller vendors, no independent data found                                                  | Adapter; SMTP2GO has no official Node SDK, AhaSend's is 0.3.0                                        |
| F. Self-hosted MTA (Stalwart or Postal on the VPS)        | Unlimited                                                                                         | $0 extra                                                     | Our own                                                                                                           | Our own                         | Ours                                          | **High:** TLS, DKIM keys and rotation, PTR, blocklist monitoring, one IP as a single point of failure | **High:** a fresh IP inherits its cloud range's reputation; the homelab's residential range is worse | Large, plus Postal wants a dedicated 4 GB host                                                       |
| G. Local MTA relaying through SES, or self-hosted useSend | As D                                                                                              | As D, plus the host                                          | As D                                                                                                              | useSend has no inbound          | As D                                          | D plus one more service (useSend: Postgres + Redis + MinIO + Next.js, still beta)                     | As D: SES owns the reputation either way                                                             | More than D for no deliverability gain                                                               |

Outbound port 25 is open from both the VPS and the homelab today (connect
probe, 2026-10-12), so F is held back by reputation and ops, not by the
network. Gmail's and Microsoft's bulk-sender rules start at 5,000 mails a
day and do not apply here. The all-senders tier does: SPF or DKIM, a
matching PTR, and TLS.

## Swap or rewrite: swap

The Resend SDK reaches five files. Nothing else depends on it.

| File                                       | Resend coupling                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/utils/resend.ts`                      | The two SDK client singletons                                                          |
| `src/utils/send-mail.ts`                   | Route sends: `emails.send({ react })`, then a `send_log` row with `provider: "resend"` |
| `src/jobs/send.ts`                         | Queued sends (test-send, agent `POST /api/sends`), Resend's `idempotencyKey`           |
| `src/jobs/reconcile-send-log.ts`           | Polls `emails.get(id).last_event`                                                      |
| `src/providers/resend/{adapter,client}.ts` | The `MailProvider` adapter: `send` plus the sent/received history the sync lists       |

Already provider-neutral: the three routes, which call `sendMail()` only;
the template registry, which holds React components; `send_log`, where
`provider` is free text with no CHECK; the `jobs` queue;
`enqueueTemplateSend`; the client and the agent API. A rewrite would rebuild
the jobs, store, IMAP, client and agent API, none of which touch Resend.

The gaps a swap has to close:

1. **Sends bypass the port.** The routes and the send job call the SDK
   directly, not `MailProvider.send`.
2. **Rendering is Resend's.** Resend renders the React element server-side
   (`react:`). Other providers need HTML and text, and `@react-email/render`
   is already a dependency.
3. **Idempotency** in the send job leans on Resend's `idempotencyKey`. The
   `send_log` guard covers the retry-after-DB-error case on its own. A
   provider without idempotency keys keeps only that guard.
4. **Hardcoded `"resend"` and the FPP `DEFAULT_FROM`** in
   `src/services/template-send.ts`.
5. **Status is poll-only and Resend-only**, and it is broken for route sends,
   per the bug above.
6. **`accounts.provider` has a CHECK constraint**, but a send-only provider
   needs no `accounts` row. A migration is needed only if its history should
   appear in the mail list.

## Recommendation

**A, Resend Pro, plus one send-port wave.** It removes today's block for
$20 a month with zero code, zero DNS changes and zero risk to the three live
callers, and covers 10 domains, or 110 with the add-on. The send-port wave is
worth doing whichever provider wins: it fixes the reconcile bug and turns any
later move into one adapter plus a per-route switch.

**Pick D, SES in `eu-central-1`, instead if** EU storage of send data
matters, or owning the send side matters more than about 2–3 waves of work.
It is the only option that is EU-resident, effectively free and uncapped.
Its cost is an AWS account, a production-access review, three DKIM CNAMEs per
domain, and a public SNS endpoint, which changes D1. SES's own account-level
suppression list already catches bounces and complaints, so the gateway does
not need its own suppression table.

**Not recommended:**

- **B** depends on terms nobody has checked.
- **C** is a paid swap that is US-only and has a disputed domain cap.
- **E**: the vendors are cheap but unproven.
- **F and G** add a mail server for a 50-mail-a-month sender.

## Architecture delta

**Wave 11, send port (any option):**

- A `SendProvider` port with `send(rendered) → { providerMessageId }`, plus
  an optional `status(id)` and an optional `parseEvent(request)`. The
  React element is rendered once to HTML and text before the provider sees
  it.
- `sendMail`, the send job and `enqueueTemplateSend` go through the port.
  The provider is chosen per route from env, with Resend as the default, so
  each route cuts over on its own and rolls back with one env change.
- `send_log` rows record `provider_message_id` on every path.
  `reconcile_send_log` dispatches on `send_log.provider`.
- The `MailProvider` Resend adapter keeps the history lists for sync and
  delegates `send` to the port.

**Only if D:**

- `src/providers/ses/`: SESv2 `SendEmail`, the configuration-set header,
  and EU region config.
- `POST /webhooks/ses`: verifies the SNS signature, confirms the
  subscription, and maps events onto `send_log.status` and `last_event`.
  This is the first public route beyond the send routes and `/health`, an
  amendment to D1.
- Per-domain identities and DKIM CNAMEs, applied through `/cloudflare`. Each
  DNS change needs the owner's OK.
- Secrets: an IAM key scoped to `ses:SendEmail` in 1Password
  `vps/email-gateway`, wired through `.env.tpl`.
- Cutover in order: `/fpp-daily-analytics` (internal recipient, lowest
  risk), then `/sy-serendipity`, then `/fpp`. Resend stays configured as the
  fallback until each route's sends show `delivered` in prod.

## Sources

Resend: resend.com/pricing.md; docs/knowledge-base (account quotas,
add more domains, pricing); docs/dashboard/settings/team; docs/dashboard/
domains/regions; security/gdpr.md; docs/webhooks/event-types.md. Postmark:
postmarkapp.com/pricing(.txt); support articles "adding sender signatures",
"account approval"; developer webhooks, bounce and suppressions APIs;
eu-privacy. SES: aws.amazon.com/ses/pricing and the July 2026 pricing-plans
post; docs.aws.amazon.com/ses (quotas, creating identities, Easy DKIM,
event destinations, suppression list, production access, SMTP);
docs.aws.amazon.com/general/latest/gr/ses.html. Alternatives: smtp2go.com/
pricing + Free Plan support article; ahasend.com/pricing + llms.txt;
mailersend.com, mailtrap.io, scaleway.com TEM, mailgun.com pricing.
Self-hosting: Postal, Stalwart, Haraka, Maddy and mailcow docs and release
pages; Google sender guidelines (support.google.com/a/answer/81126); Hetzner,
DigitalOcean, Vultr and netcup port-25 docs; github.com/usesend/usesend.

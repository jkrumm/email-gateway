/**
 * Seeds `$DATA_DIR` with ~40 realistic fake emails (mixed inbound/
 * outbound, spread over the last 14 days, done enrichments — a few pending
 * or failed) and ~12 spam-filter submissions, for exercising the admin
 * dashboard locally. Refuses to run against a production database.
 *
 * Usage: DATA_DIR=/tmp/bea-demo bun run seed:demo
 */
import { emailsRepo, submissionsRepo } from "../src/db";
import type { EnrichmentResult } from "../src/db/emails";

if (process.env.NODE_ENV === "production") {
  console.error("[seed-demo] refusing to run with NODE_ENV=production");
  process.exit(1);
}

// Small deterministic PRNG (mulberry32) — reproducible runs, no dependency.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20260915);
const now = Date.now();

function daysAgo(days: number, hour: number, minute = 0): string {
  const d = new Date(now - days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textToHtml(text: string): string {
  return `<div style="font-family: -apple-system, sans-serif; padding: 20px; color: #1a1a1a;"><p>${escapeHtml(text)}</p></div>`;
}

interface EmailScenario {
  direction: "inbound" | "outbound";
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  text: string;
  source: string | null;
  enrichment: Omit<EnrichmentResult, "model"> | null;
}

const GUEST_NAMES = [
  "Marta Voss",
  "Liam Harper",
  "Sofia Rinaldi",
  "Jonas Weber",
  "Emma Clarke",
  "Noah Fischer",
];
const DESTINATIONS = [
  "Ibiza",
  "Sardinia",
  "Croatia",
  "the French Riviera",
  "Santorini",
];

function charterInquiry(): EmailScenario {
  const guest = pick(GUEST_NAMES);
  const destination = pick(DESTINATIONS);
  const guests = 2 + Math.floor(random() * 8);
  return {
    direction: "outbound",
    fromAddress: "requests@sy-serendipity.com",
    toAddresses: ["charter-desk@sy-serendipity.com"],
    subject: `SY Serendipity I - Charter Request`,
    text: `Hi, we'd love to charter SY Serendipity for a trip to ${destination}. We are a group of ${guests}. Could you send availability and pricing? Thanks, ${guest}`,
    source: "sy-serendipity-request",
    enrichment: {
      category: "inquiry",
      priority: "high",
      actionRequired: true,
      summary: `${guest} asks about chartering for ${guests} guests around ${destination}.`,
      suggestedAction: "Reply with availability and a quote",
      language: "en",
      facts: [
        { label: "Guests", value: String(guests) },
        { label: "Destination", value: destination },
      ],
    },
  };
}

function fppFeedback(positive: boolean): EmailScenario[] {
  const from = `${pick(GUEST_NAMES).split(" ")[0]!.toLowerCase()}@example.com`;
  const message = positive
    ? "Loved the new voting UI, our team ships estimates way faster now. Thanks for building this!"
    : "The room sometimes freezes when a teammate resets the votes — happened twice this sprint on Firefox.";

  return [
    {
      direction: "outbound",
      fromAddress: "no-reply@free-planning-poker.com",
      toAddresses: [from],
      subject: "We received your message",
      text: "Thanks for reaching out to Free Planning Poker — we'll get back to you shortly.",
      source: "fpp-sender",
      enrichment: {
        category: "notification",
        priority: "low",
        actionRequired: false,
        summary: "Automated confirmation sent to the visitor.",
        suggestedAction: null,
        language: "en",
        facts: [],
      },
    },
    {
      direction: "outbound",
      fromAddress: "no-reply@free-planning-poker.com",
      toAddresses: ["owner@free-planning-poker.com"],
      subject: "New Free Planning Poker Message",
      text: message,
      source: "fpp-receiver",
      enrichment: {
        category: positive ? "feedback" : "support",
        priority: positive ? "low" : "high",
        actionRequired: !positive,
        summary: positive
          ? "Positive feedback about the new voting UI."
          : "Bug report: room freezes on vote reset in Firefox.",
        suggestedAction: positive
          ? null
          : "Reproduce the freeze on Firefox and file a bug",
        language: "en",
        facts: positive ? [] : [{ label: "Browser", value: "Firefox" }],
      },
    },
  ];
}

function dailyAnalytics(): EmailScenario {
  return {
    direction: "outbound",
    fromAddress: "no-reply@free-planning-poker.com",
    toAddresses: ["owner@free-planning-poker.com"],
    subject: "FPP Daily Analytics",
    text: "Yesterday: 214 page views, 58 unique users, 19 rooms created, 340 votes cast.",
    source: "fpp-daily-analytics",
    enrichment: {
      category: "notification",
      priority: "low",
      actionRequired: false,
      summary:
        "Daily analytics summary — traffic in line with the weekly average.",
      suggestedAction: null,
      language: "en",
      facts: [
        { label: "Unique users", value: "58" },
        { label: "Rooms created", value: "19" },
      ],
    },
  };
}

function invoice(): EmailScenario {
  return {
    direction: "inbound",
    fromAddress: "billing@vercel.com",
    toAddresses: ["owner@example.com"],
    subject: "Your Vercel invoice is ready",
    text: "Your invoice for this billing period is attached. Amount due: $20.00, due in 14 days.",
    source: null,
    enrichment: {
      category: "invoice",
      priority: "normal",
      actionRequired: true,
      summary: "Vercel invoice for $20.00, due in 14 days.",
      suggestedAction: "Confirm payment method on file",
      language: "en",
      facts: [{ label: "Amount", value: "$20.00" }],
    },
  };
}

function newsletter(): EmailScenario {
  return {
    direction: "inbound",
    fromAddress: "digest@indiehackers.com",
    toAddresses: ["owner@example.com"],
    subject: "This week in Indie Hacking",
    text: "This week: bootstrapping a SaaS to $10k MRR, pricing page teardown, and more.",
    source: null,
    enrichment: {
      category: "newsletter",
      priority: "low",
      actionRequired: false,
      summary: "Weekly Indie Hackers digest.",
      suggestedAction: null,
      language: "en",
      facts: [],
    },
  };
}

function seoPitch(): EmailScenario {
  return {
    direction: "inbound",
    fromAddress: `outreach${Math.floor(random() * 999)}@linkbuild-pro.net`,
    toAddresses: ["owner@example.com"],
    subject: "Quick note about your website's SEO",
    text: "Hi, I noticed your website could use better backlinks. We offer guaranteed page-1 rankings starting at $99/month...",
    source: null,
    enrichment: {
      category: "marketing",
      priority: "low",
      actionRequired: false,
      summary: "Unsolicited SEO/link-building pitch.",
      suggestedAction: null,
      language: "en",
      facts: [],
    },
  };
}

function personalReply(): EmailScenario {
  const guest = pick(GUEST_NAMES);
  return {
    direction: "inbound",
    fromAddress: `${guest.split(" ")[0]!.toLowerCase()}@example.com`,
    toAddresses: ["charter-desk@sy-serendipity.com"],
    subject: "Re: SY Serendipity I - Charter Request",
    text: "Thanks for the quick reply! That week works for us, please send the contract.",
    source: null,
    enrichment: {
      category: "customer",
      priority: "high",
      actionRequired: true,
      summary: `${guest} confirms the proposed week and asks for the contract.`,
      suggestedAction: "Send the charter contract",
      language: "en",
      facts: [],
    },
  };
}

const scenarios: { day: number; email: EmailScenario }[] = [];
for (let day = 13; day >= 0; day--) {
  if (day % 2 === 0) scenarios.push({ day, email: charterInquiry() });
  if (day % 3 === 0) {
    for (const email of fppFeedback(day % 2 === 0))
      scenarios.push({ day, email });
  }
  scenarios.push({ day, email: dailyAnalytics() });
  if (day % 4 === 0) scenarios.push({ day, email: invoice() });
  if (day % 2 === 1) scenarios.push({ day, email: newsletter() });
  if (day % 3 === 1) scenarios.push({ day, email: seoPitch() });
  if (day % 5 === 0) scenarios.push({ day, email: personalReply() });
}

let seeded = 0;
const runId = Date.now();
scenarios.forEach(({ day, email: scenario }, index) => {
  const id = `demo_${runId}_${index}`;
  const createdAt = daysAgo(
    day,
    8 + Math.floor(random() * 11),
    Math.floor(random() * 60),
  );

  emailsRepo.upsertEmail({
    id,
    direction: scenario.direction,
    fromAddress: scenario.fromAddress,
    toAddresses: scenario.toAddresses,
    subject: scenario.subject,
    createdAt,
    text: scenario.text,
    html: textToHtml(scenario.text),
    source: scenario.source,
  });

  // Leave a handful pending/failed regardless of scenario, so the dashboard
  // shows every enrichment status.
  if (index % 11 === 0) {
    emailsRepo.markEnrichmentFailed(id, "Enrichment not configured");
  } else if (index % 7 === 0) {
    // upsertEmail already leaves a fresh row as "pending" — nothing to do.
  } else if (scenario.enrichment) {
    emailsRepo.saveEnrichment(id, {
      ...scenario.enrichment,
      model: "demo-seed-model",
    });
  }

  seeded++;
});

console.log(`[seed-demo] seeded ${seeded} emails`);

const submissionScenarios: {
  source: "fpp" | "sy-serendipity";
  verdict: "legit" | "spam" | "marketing";
  confidence: number;
  reason: string;
  delivered: boolean;
  submission: Record<string, string | number | null>;
}[] = [
  {
    source: "fpp",
    verdict: "legit",
    confidence: 0.95,
    reason: "Genuine feedback about product usability",
    delivered: true,
    submission: {
      name: "Emma Clarke",
      email: "emma@example.com",
      subject: "Feature idea",
      message: "Could you add dark mode?",
    },
  },
  {
    source: "fpp",
    verdict: "legit",
    confidence: 0.91,
    reason: "Genuine bug report",
    delivered: true,
    submission: {
      name: "Noah Fischer",
      email: "noah@example.com",
      subject: "Bug",
      message: "Timer resets unexpectedly",
    },
  },
  {
    source: "sy-serendipity",
    verdict: "legit",
    confidence: 0.97,
    reason: "Genuine charter inquiry",
    delivered: true,
    submission: {
      firstName: "Sofia",
      lastName: "Rinaldi",
      email: "sofia@example.com",
      destination: "Ibiza",
    },
  },
  {
    source: "fpp",
    verdict: "marketing",
    confidence: 0.82,
    reason: "Unsolicited SEO outreach pitch",
    delivered: true,
    submission: {
      name: "Growth Agency",
      email: "hi@growth-agency.io",
      subject: "Boost your rankings",
      message: "We noticed your site could rank higher...",
    },
  },
  {
    source: "fpp",
    verdict: "marketing",
    confidence: 0.76,
    reason: "Below the delivery threshold, subject prefixed instead",
    delivered: true,
    submission: {
      name: "Dev Outsourcing Co",
      email: "sales@devoutsourcing.biz",
      subject: "Partnership opportunity",
      message: "We build software for startups like yours...",
    },
  },
  {
    source: "fpp",
    verdict: "marketing",
    confidence: 0.88,
    reason: "Unsolicited link-building pitch, suppressed",
    delivered: false,
    submission: {
      name: "LinkBuild Pro",
      email: "outreach@linkbuild-pro.net",
      subject: "Quick SEO note",
      message: "Guaranteed page-1 rankings starting at $99/mo",
    },
  },
  {
    source: "fpp",
    verdict: "spam",
    confidence: 0.93,
    reason: "Generic spam content, suppressed",
    delivered: false,
    submission: {
      name: "asdkj",
      email: "x@spammy.example",
      subject: "asdasd",
      message: "buy cheap watches now!!!",
    },
  },
  {
    source: "sy-serendipity",
    verdict: "spam",
    confidence: 0.97,
    reason: "Gibberish submission, suppressed",
    delivered: false,
    submission: {
      firstName: "xx",
      lastName: "yy",
      email: "bot@spammy.example",
      message: "asldkj asldkj asldkj",
    },
  },
  {
    source: "fpp",
    verdict: "spam",
    confidence: 0.85,
    reason: "Phishing attempt, suppressed",
    delivered: false,
    submission: {
      name: "Support",
      email: "verify@phishy.example",
      subject: "Verify your account",
      message: "Click here to verify your account immediately",
    },
  },
  {
    source: "sy-serendipity",
    verdict: "legit",
    confidence: 0.89,
    reason: "Genuine charter inquiry, decided after deadline",
    delivered: true,
    submission: {
      firstName: "Liam",
      lastName: "Harper",
      email: "liam@example.com",
      destination: "Croatia",
    },
  },
  {
    source: "fpp",
    verdict: "legit",
    confidence: 0.6,
    reason: "Below confidence threshold, delivered with spam-warning subject",
    delivered: true,
    submission: {
      name: "Jonas Weber",
      email: "jonas@example.com",
      subject: "Question",
      message: "How do I export my votes?",
    },
  },
  {
    source: "fpp",
    verdict: "marketing",
    confidence: 0.71,
    reason: "Below the delivery threshold, subject prefixed instead",
    delivered: true,
    submission: {
      name: "WebDesign Studio",
      email: "hello@webdesignstudio.biz",
      subject: "Free website audit",
      message: "We'd love to redesign your site...",
    },
  },
];

for (const submission of submissionScenarios) {
  submissionsRepo.recordSubmission({
    ...submission,
    model: "demo-seed-model",
  });
}

console.log(`[seed-demo] seeded ${submissionScenarios.length} submissions`);
console.log(`[seed-demo] done — data dir: ${process.env.DATA_DIR ?? "./data"}`);

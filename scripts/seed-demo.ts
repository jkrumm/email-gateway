/**
 * Seeds `$DATA_DIR` with ~12 spam-filter submissions, for exercising the
 * client Submissions page locally. Refuses to run against a production
 * database. The old SSR admin's Overview/Inbox/detail pages (and the old
 * `emails` store this script used to seed for them) are gone as of Wave 4's
 * lean-store cutover — nothing reads fake emails anymore.
 *
 * Usage: DATA_DIR=/tmp/bea-demo bun run seed:demo
 */
import { mailSubmissionsRepo } from "../src/db/mail-index";

if (process.env.NODE_ENV === "production") {
  console.error("[seed-demo] refusing to run with NODE_ENV=production");
  process.exit(1);
}

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
  mailSubmissionsRepo.insertSubmission({
    ...submission,
    model: "demo-seed-model",
  });
}

console.log(`[seed-demo] seeded ${submissionScenarios.length} submissions`);
console.log(`[seed-demo] done — data dir: ${process.env.DATA_DIR ?? "./data"}`);

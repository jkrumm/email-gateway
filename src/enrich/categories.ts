export const CATEGORIES = [
  'inquiry',
  'customer',
  'support',
  'feedback',
  'invoice',
  'notification',
  'newsletter',
  'marketing',
  'spam',
  'personal',
  'other',
] as const

type Category = (typeof CATEGORIES)[number]

// Mirrors the category list in the LLM enrichment system prompt.
export const CATEGORY_CRITERIA = {
  inquiry: 'A charter/booking/product enquiry from a prospective customer.',
  customer: 'Ongoing conversation with an existing customer or guest.',
  support: 'A bug report, help request, or technical question.',
  feedback: 'Feedback, suggestions, or reviews.',
  invoice: 'Billing, receipts, or payments.',
  notification:
    'Automated/system/transactional mail, including our own daily analytics and confirmation emails we send to visitors.',
  newsletter: 'A subscribed newsletter.',
  marketing:
    'Unsolicited marketing/outreach pitches (SEO, link-building, web-design offers, lead-gen, dev outsourcing, "I noticed your website...").',
  spam: 'Generic spam, phishing, or gibberish.',
  personal: 'Personal correspondence unrelated to either site.',
  other: "Anything that doesn't fit above.",
} satisfies Record<Category, string>

// Shared by the two LLM prompt builders (src/enrich/enrich-email.ts,
// src/llm/draft-reply.ts): both need a message's plain text when only its
// HTML part is available, capped at the same prompt-length bound.
const MAX_PROMPT_TEXT_LENGTH = 12_000;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function plainText(message: {
  text: string | null;
  html: string | null;
}): string {
  const raw = message.text ?? (message.html ? stripHtml(message.html) : "");
  return raw.length > MAX_PROMPT_TEXT_LENGTH
    ? raw.slice(0, MAX_PROMPT_TEXT_LENGTH)
    : raw;
}

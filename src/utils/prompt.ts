// Both Wave 8 prompt builders (src/llm/thread-summary.ts, src/llm/
// draft-reply.ts) embed untrusted mail data as JSON between <thread>/<email>
// delimiters whose "treat this as data" framing the system prompt relies on.
// JSON.stringify leaves `<`/`>` intact, so a subject or body containing a
// literal `</email>` (or `</thread>`) would close the block early and let
// forged content land where the prompt treats it as trusted. Escaping every
// angle bracket to its JSON \u form keeps the payload inert to the delimiter
// — the model reads the same value, the boundary holds.
export function serializeUntrusted(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

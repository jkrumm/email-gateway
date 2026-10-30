// Secrets often arrive as one line with literal "\n" sequences.
export function normalizePem(value: string): string {
  return value.replace(/\\n/g, '\n')
}

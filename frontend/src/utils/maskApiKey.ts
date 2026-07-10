// Obfuscate an API key before rendering: expose first 6 + last 4; keys ≤12 chars use `first 4 + ***`.
export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 12) return `${key.slice(0, 4)}***`
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

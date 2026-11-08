/** Read-back comparison only: never infer success from files/tags/add. */
export interface TagComparison {
  landed: string[]
  missing: string[]
  atCap: string[]
}
export interface TagVerification extends TagComparison {
  id: string
  name: string
  nativeCount?: number
  error?: string
  skipped?: string
}
export function compareDropboxTags(desired: readonly string[], actual: readonly string[], nativeCount = actual.length, cap = 20): TagComparison {
  const have = new Set(actual)
  const want = [...new Set(desired)]
  const missing = want.filter((t) => !have.has(t))
  return { landed: want.filter((t) => have.has(t)), missing, atCap: nativeCount >= cap ? [...missing] : [] }
}
export function tagVerificationError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return /missing_scope|403|app folder|not support/i.test(message)
    ? `Dropbox search tags need the files.metadata.write permission and Full Dropbox access — enable it, then Disconnect and Connect again (Settings → Dropbox). ${message}`
    : `Could not verify Dropbox tags: ${message}`
}

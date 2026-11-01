const PANCAKE_PUBLIC_API_BASE = "https://pages.fm/api/public_api/v2"
const VERIFY_TIMEOUT_MS = 10_000

export class PancakeCredentialVerificationError extends Error {
  constructor() {
    super("Pancake token could not access this Page")
    this.name = "PancakeCredentialVerificationError"
  }
}

/** Minimal authenticated read used before a Page token is persisted. */
export async function verifyPancakePageToken(input: {
  pageId: string
  token: string
}): Promise<void> {
  const url = new URL(
    `${PANCAKE_PUBLIC_API_BASE}/pages/${encodeURIComponent(input.pageId)}/conversations`,
  )
  url.searchParams.set("page_access_token", input.token)
  url.searchParams.set("fields", "id")

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new PancakeCredentialVerificationError()
    }
    const payload = (await response.json()) as { success?: unknown }
    if (payload.success === false) {
      throw new PancakeCredentialVerificationError()
    }
  } catch (error) {
    if (error instanceof PancakeCredentialVerificationError) {
      throw error
    }
    // Fetch errors can embed their request URL. Drop the cause so a query-token
    // can never escape through an action error or log serializer.
    throw new PancakeCredentialVerificationError()
  }
}

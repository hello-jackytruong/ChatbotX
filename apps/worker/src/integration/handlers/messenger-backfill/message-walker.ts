import { extractContactInfo } from "@chatbotx.io/business"
import {
  listMessages,
  type MessengerHistoryMessage,
} from "@chatbotx.io/integration-messenger/apis/sync"
import type { BucUsage } from "@chatbotx.io/integration-messenger/apis/usage"
import type { HistoricalMessage } from "../coexist/bulk-historical-import"
import {
  normalizeMessengerHistoryMessage,
  withInlineRetry,
} from "../coexist/messenger-helpers"
import {
  classifyMessengerBackfillError,
  nextSmallerMessagePageLimit,
} from "./error-policy"
import { type BackfillRange, classifyMessageTimestamp } from "./range"

type DiscoveredContact = { phoneNumber?: string; email?: string }

export type MessengerBackfillWalkInterruption = "cancelled" | "yielded"

export type MessengerBackfillWalkResult = {
  hadInRange: boolean
  discovered: DiscoveredContact
  status: "completed" | MessengerBackfillWalkInterruption
}

const UNKNOWN_PROVIDER_MAX_ATTEMPTS = 3
const UNKNOWN_PROVIDER_RETRY_BASE_MS = 1000

export type MessengerBackfillMessagePage = {
  messages: HistoricalMessage[]
  discovered: DiscoveredContact
  hasInRange: boolean
  nextCursor?: string
}

export const walkMessengerConversationRange = async (input: {
  conversationId: string
  accessToken: string
  version?: string
  pageId: string
  defaultCountry: string | null
  range: BackfillRange
  includeMessages: boolean
  initialCursor?: string
  applyBucThrottle: (usage: BucUsage | null | undefined) => void
  respectPause: () => Promise<void>
  onPage: (page: MessengerBackfillMessagePage) => Promise<void>
  getInterruption?: () => Promise<MessengerBackfillWalkInterruption | null>
}): Promise<MessengerBackfillWalkResult> => {
  let cursor = input.initialCursor
  let pageLimit = 499
  let hadInRange = false
  const discovered: DiscoveredContact = {}
  let unknownProviderAttempts = 0

  while (true) {
    const beforeFetch = await input.getInterruption?.()
    if (beforeFetch) {
      return { hadInRange, discovered, status: beforeFetch }
    }
    await input.respectPause()

    let page: Awaited<ReturnType<typeof listMessages>>
    try {
      page = await withInlineRetry(() =>
        listMessages({
          conversationId: input.conversationId,
          accessToken: input.accessToken,
          version: input.version,
          after: cursor,
          limit: pageLimit,
        }),
      )
    } catch (error) {
      const classification = classifyMessengerBackfillError(error)
      if (classification === "unknown") {
        unknownProviderAttempts += 1
        if (unknownProviderAttempts < UNKNOWN_PROVIDER_MAX_ATTEMPTS) {
          await wait(
            UNKNOWN_PROVIDER_RETRY_BASE_MS * 2 ** (unknownProviderAttempts - 1),
          )
          continue
        }
        throw error
      }
      if (classification !== "data-too-large") {
        throw error
      }
      const smaller = nextSmallerMessagePageLimit(pageLimit)
      if (smaller === null) {
        throw error
      }
      pageLimit = smaller
      continue
    }

    unknownProviderAttempts = 0
    input.applyBucThrottle(page.bucUsage)
    const messages: HistoricalMessage[] = []
    let hasInRange = false
    let stopPaging = false

    for (const raw of page.data as MessengerHistoryMessage[]) {
      const position = classifyMessageTimestamp(raw.created_time, input.range)
      if (position === "newer" || position === "invalid") {
        continue
      }
      if (position === "older") {
        stopPaging = true
        break
      }

      hasInRange = true
      hadInRange = true
      discoverContactFields(raw, discovered, input.defaultCountry)
      if (input.includeMessages) {
        const normalized = normalizeMessengerHistoryMessage(raw, input.pageId)
        if (normalized) {
          messages.push(normalized)
        }
      }
    }

    const beforeCommit = await input.getInterruption?.()
    if (beforeCommit) {
      return { hadInRange, discovered, status: beforeCommit }
    }

    await input.onPage({
      messages,
      discovered,
      hasInRange,
      nextCursor: page.after,
    })

    const interruption = await input.getInterruption?.()
    if (interruption === "cancelled") {
      return { hadInRange, discovered, status: interruption }
    }

    cursor = page.after
    if (stopPaging || !cursor) {
      break
    }
    if (interruption === "yielded") {
      return { hadInRange, discovered, status: interruption }
    }
  }

  return { hadInRange, discovered, status: "completed" }
}

const wait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs))

const discoverContactFields = (
  raw: MessengerHistoryMessage,
  discovered: DiscoveredContact,
  defaultCountry: string | null,
): void => {
  if (!raw.message || (discovered.phoneNumber && discovered.email)) {
    return
  }
  const extracted = extractContactInfo(raw.message, defaultCountry, {
    skipPhone: Boolean(discovered.phoneNumber),
    skipEmail: Boolean(discovered.email),
  })
  discovered.phoneNumber ??= extracted.phoneNumber
  discovered.email ??= extracted.email
}

import type { IncomingContact } from "@chatbotx.io/sdk"
import { normalizeGender } from "@chatbotx.io/sdk"

const PANCAKE_API_BASE = "https://pages.fm/api/public_api/v2"
const PANCAKE_AVATAR_BASE = "https://pages.fm/api/v1"
const PROFILE_TIMEOUT_MS = 3000
const WHITESPACE_PATTERN = /\s+/

type JsonObject = Record<string, unknown>

export type PancakeMessengerProfile = IncomingContact & {
  avatarUrl?: string
  provider: "pancake"
}

const asObject = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined

const recordsFromPayload = (payload: unknown): JsonObject[] => {
  const root = asObject(payload)
  if (!root) {
    return []
  }
  const conversations = asObject(root.conversations)
  const candidates = [root.data, root.conversations, conversations?.data]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const records: JsonObject[] = []
      for (const item of candidate) {
        const record = asObject(item)
        if (record) {
          records.push(record)
        }
      }
      return records
    }
  }
  return []
}

const identityNodes = (record: JsonObject): JsonObject[] => {
  const nodes = [record.conv_from, record.customer, record.from]
  if (Array.isArray(record.customers)) {
    nodes.push(...record.customers)
  }
  const objects: JsonObject[] = []
  for (const value of nodes) {
    const object = asObject(value)
    if (object) {
      objects.push(object)
    }
  }
  return objects
}

const nodeMatchesPsid = (node: JsonObject, psid: string): boolean =>
  [node.id, node.fb_id, node.psid].some((value) => asString(value) === psid)

const recordMatchesPage = (record: JsonObject, pageId: string): boolean => {
  const explicit =
    asString(record.page_id) ?? asString(asObject(record.page)?.id)
  return !explicit || explicit === pageId
}

const splitName = (name: string | undefined) => {
  if (!name) {
    return {}
  }
  const [firstName, ...rest] = name.split(WHITESPACE_PATTERN)
  return { firstName, lastName: rest.join(" ") || undefined }
}

export const mapPancakeConversationProfile = (input: {
  payload: unknown
  pageId: string
  psid: string
  includeAvatar?: boolean
}): PancakeMessengerProfile | null => {
  const matches = recordsFromPayload(input.payload).flatMap((record) => {
    if (!recordMatchesPage(record, input.pageId)) {
      return []
    }
    const matchedNodes = identityNodes(record).filter((node) =>
      nodeMatchesPsid(node, input.psid),
    )
    const node = matchedNodes[0]
    return matchedNodes.length === 1 && node ? [{ record, node }] : []
  })
  if (matches.length !== 1) {
    return null
  }

  const match = matches[0]
  if (!match) {
    return null
  }
  const { node } = match
  const fallbackName = splitName(
    asString(node.name) ?? asString(node.full_name),
  )
  const firstName =
    asString(node.first_name) ??
    asString(node.firstName) ??
    fallbackName.firstName
  const lastName =
    asString(node.last_name) ?? asString(node.lastName) ?? fallbackName.lastName
  const gender = normalizeGender(asString(node.gender))
  if (!(firstName || lastName || gender || input.includeAvatar)) {
    return null
  }

  return {
    sourceId: input.psid,
    firstName,
    lastName,
    gender,
    provider: "pancake",
    ...(input.includeAvatar
      ? {
          avatarUrl: `${PANCAKE_AVATAR_BASE}/pages/${encodeURIComponent(input.pageId)}/avatar/${encodeURIComponent(input.psid)}`,
        }
      : {}),
  }
}

export async function fetchPancakeMessengerProfile(input: {
  pageId: string
  psid: string
  token: string
  includeAvatar?: boolean
}): Promise<PancakeMessengerProfile | null> {
  const url = new URL(
    `${PANCAKE_API_BASE}/pages/${encodeURIComponent(input.pageId)}/conversations`,
  )
  url.searchParams.set("page_access_token", input.token)
  url.searchParams.set("customer_id", input.psid)
  url.searchParams.set("page_size", "20")

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    })
    if (!response.ok) {
      return null
    }
    return mapPancakeConversationProfile({
      payload: await response.json(),
      pageId: input.pageId,
      psid: input.psid,
      includeAvatar: input.includeAvatar,
    })
  } catch {
    return null
  }
}

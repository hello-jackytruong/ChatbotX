import type { IncomingContact } from "@chatbotx.io/sdk"
import { normalizeGender } from "@chatbotx.io/sdk"

const PANCAKE_API_BASE = "https://pages.fm/api/public_api/v2"
const PANCAKE_AVATAR_BASE = "https://pages.fm/api/v1"
const PROFILE_TIMEOUT_MS = 3000
const BACKFILL_TIMEOUT_MS = 10_000
const PANCAKE_CONVERSATION_PAGE_SIZE = 60
const PANCAKE_PAGE_INTERVAL_MS = 250
const WHITESPACE_PATTERN = /\s+/
const PANCAKE_CONVERSATION_FIELDS =
  "id,page_id,updated_at,from{id,name},customers{id,fb_id,name},page_customer{id,customer_id,name,psid,gender}"

type JsonObject = Record<string, unknown>

export type PancakeMessengerProfile = IncomingContact & {
  avatarUrl?: string
  provider: "pancake"
}

export class PancakeProfileRequestError extends Error {
  constructor() {
    super("Pancake conversations could not be read")
    this.name = "PancakeProfileRequestError"
  }
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
  const candidates = [root.conversations, root.data, conversations?.data]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.flatMap((item) => {
        const record = asObject(item)
        return record ? [record] : []
      })
    }
  }
  return []
}

const recordMatchesPage = (record: JsonObject, pageId: string): boolean => {
  const explicit =
    asString(record.page_id) ?? asString(asObject(record.page)?.id)
  return explicit === pageId
}

const splitName = (name: string | undefined) => {
  if (!name) {
    return {}
  }
  const [firstName, ...rest] = name.split(WHITESPACE_PATTERN)
  return { firstName, lastName: rest.join(" ") || undefined }
}

const nodePsid = (
  node: JsonObject | undefined,
  options: { allowId: boolean },
): string | undefined =>
  asString(node?.psid) ??
  asString(node?.fb_id) ??
  (options.allowId ? asString(node?.id) : undefined)

const matchingIdentityNodes = (record: JsonObject, psid: string) => {
  const pageCustomer = asObject(record.page_customer)
  const from = asObject(record.from)
  const convFrom = asObject(record.conv_from)
  const customer = asObject(record.customer)
  const customers = Array.isArray(record.customers)
    ? record.customers.flatMap((value) => {
        const node = asObject(value)
        return node ? [node] : []
      })
    : []
  const candidates = [
    { node: pageCustomer, allowId: false },
    { node: from, allowId: true },
    { node: convFrom, allowId: true },
    { node: customer, allowId: false },
    ...customers.map((node) => ({ node, allowId: false })),
  ]
  const identities = candidates
    .map(({ node, allowId }) => nodePsid(node, { allowId }))
    .filter((value): value is string => Boolean(value))
  const distinctIdentities = new Set(identities)
  if (!(distinctIdentities.size === 1 && distinctIdentities.has(psid))) {
    return null
  }
  return candidates.flatMap(({ node, allowId }) =>
    node && nodePsid(node, { allowId }) === psid ? [node] : [],
  )
}

const profileFromRecord = (input: {
  record: JsonObject
  pageId: string
  psid: string
  includeAvatar?: boolean
}): PancakeMessengerProfile | null => {
  if (!recordMatchesPage(input.record, input.pageId)) {
    return null
  }
  const nodes = matchingIdentityNodes(input.record, input.psid)
  if (!nodes) {
    return null
  }
  const pageCustomer = asObject(input.record.page_customer)
  const namedNode =
    nodes.find((node) => asString(node.name) || asString(node.full_name)) ??
    pageCustomer
  const fallbackName = splitName(
    asString(pageCustomer?.name) ??
      asString(pageCustomer?.full_name) ??
      asString(namedNode?.name) ??
      asString(namedNode?.full_name),
  )
  const firstName =
    asString(pageCustomer?.first_name) ??
    asString(namedNode?.first_name) ??
    asString(namedNode?.firstName) ??
    fallbackName.firstName
  const lastName =
    asString(pageCustomer?.last_name) ??
    asString(namedNode?.last_name) ??
    asString(namedNode?.lastName) ??
    fallbackName.lastName
  const gender = normalizeGender(
    asString(pageCustomer?.gender) ??
      nodes.map((node) => asString(node.gender)).find(Boolean),
  )
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

const recordTimestamp = (record: JsonObject): number => {
  const raw = asString(record.updated_at) ?? asString(record.inserted_at)
  const parsed = raw ? Date.parse(raw) : Number.NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

export const mapPancakeConversationProfile = (input: {
  payload: unknown
  pageId: string
  psid: string
  includeAvatar?: boolean
}): PancakeMessengerProfile | null => {
  let selected:
    | { profile: PancakeMessengerProfile; updatedAt: number }
    | undefined
  for (const record of recordsFromPayload(input.payload)) {
    const profile = profileFromRecord({ ...input, record })
    if (!profile) {
      continue
    }
    const updatedAt = recordTimestamp(record)
    if (!selected || updatedAt > selected.updatedAt) {
      selected = { profile, updatedAt }
    }
  }
  return selected?.profile ?? null
}

export const mapPancakeConversationProfiles = (input: {
  payload: unknown
  pageId: string
  includeAvatar?: boolean
}): PancakeMessengerProfile[] => {
  const selected = new Map<
    string,
    { profile: PancakeMessengerProfile; updatedAt: number }
  >()
  for (const record of recordsFromPayload(input.payload)) {
    const pageCustomer = asObject(record.page_customer)
    const from = asObject(record.from)
    const customers = Array.isArray(record.customers)
      ? record.customers.flatMap((value) => {
          const node = asObject(value)
          return node ? [node] : []
        })
      : []
    const psids = new Set(
      [
        nodePsid(pageCustomer, { allowId: false }),
        nodePsid(from, { allowId: true }),
        ...customers.map((node) => nodePsid(node, { allowId: false })),
      ].filter((value): value is string => Boolean(value)),
    )
    if (psids.size !== 1) {
      continue
    }
    const psid = [...psids][0]
    if (!psid) {
      continue
    }
    const profile = profileFromRecord({ ...input, psid, record })
    if (!profile) {
      continue
    }
    const updatedAt = recordTimestamp(record)
    const current = selected.get(psid)
    if (!current || updatedAt > current.updatedAt) {
      selected.set(psid, { profile, updatedAt })
    }
  }
  return [...selected.values()].map(({ profile }) => profile)
}

const fetchConversationPage = async (input: {
  pageId: string
  token: string
  lastConversationId?: string
  timeoutMs: number
}): Promise<{ payload: unknown; records: JsonObject[] }> => {
  const url = new URL(
    `${PANCAKE_API_BASE}/pages/${encodeURIComponent(input.pageId)}/conversations`,
  )
  url.searchParams.set("page_access_token", input.token)
  url.searchParams.set("fields", PANCAKE_CONVERSATION_FIELDS)
  if (input.lastConversationId) {
    url.searchParams.set("last_conversation_id", input.lastConversationId)
  }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(input.timeoutMs),
    })
    if (!response.ok) {
      throw new PancakeProfileRequestError()
    }
    const payload: unknown = await response.json()
    const root = asObject(payload)
    const conversations = asObject(root?.conversations)
    const hasConversationList =
      Array.isArray(root?.conversations) ||
      Array.isArray(root?.data) ||
      Array.isArray(conversations?.data)
    if (root?.success === false || !hasConversationList) {
      throw new PancakeProfileRequestError()
    }
    return { payload, records: recordsFromPayload(payload) }
  } catch (error) {
    if (error instanceof PancakeProfileRequestError) {
      throw error
    }
    throw new PancakeProfileRequestError()
  }
}

export async function fetchPancakeMessengerProfile(input: {
  pageId: string
  psid: string
  token: string
  includeAvatar?: boolean
}): Promise<PancakeMessengerProfile | null> {
  try {
    const { payload } = await fetchConversationPage({
      pageId: input.pageId,
      token: input.token,
      timeoutMs: PROFILE_TIMEOUT_MS,
    })
    return mapPancakeConversationProfile({
      payload,
      pageId: input.pageId,
      psid: input.psid,
      includeAvatar: input.includeAvatar,
    })
  } catch {
    return null
  }
}

export async function fetchPancakeMessengerProfiles(input: {
  pageId: string
  token: string
  includeAvatar?: boolean
}): Promise<PancakeMessengerProfile[]> {
  const profiles = new Map<string, PancakeMessengerProfile>()
  const seenCursors = new Set<string>()
  let lastConversationId: string | undefined
  while (true) {
    const page = await fetchConversationPage({
      pageId: input.pageId,
      token: input.token,
      lastConversationId,
      timeoutMs: BACKFILL_TIMEOUT_MS,
    })
    for (const profile of mapPancakeConversationProfiles({
      payload: page.payload,
      pageId: input.pageId,
      includeAvatar: input.includeAvatar,
    })) {
      if (!profiles.has(profile.sourceId)) {
        profiles.set(profile.sourceId, profile)
      }
    }
    if (page.records.length < PANCAKE_CONVERSATION_PAGE_SIZE) {
      break
    }
    const cursor = asString(page.records.at(-1)?.id)
    if (!cursor || seenCursors.has(cursor)) {
      throw new PancakeProfileRequestError()
    }
    seenCursors.add(cursor)
    lastConversationId = cursor
    await new Promise((resolve) =>
      setTimeout(resolve, PANCAKE_PAGE_INTERVAL_MS),
    )
  }
  return [...profiles.values()]
}

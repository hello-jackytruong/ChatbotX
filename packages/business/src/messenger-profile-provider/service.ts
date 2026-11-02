import type { IncomingContact } from "@chatbotx.io/sdk"
import { messengerPancakeCredentialService } from "../messenger-pancake-credential/service"
import {
  fetchPancakeMessengerProfile,
  fetchPancakeMessengerProfiles,
  type PancakeMessengerProfile,
} from "./client"

export const messengerProfilePolicies = [
  "pancake",
  "meta",
  "pancakeThenMeta",
] as const
export type MessengerProfilePolicy = (typeof messengerProfilePolicies)[number]

export type ResolvedMessengerProfile =
  | PancakeMessengerProfile
  | (IncomingContact & { provider: "meta" })

export const toIncomingContact = (
  profile: ResolvedMessengerProfile,
): IncomingContact => {
  const { provider: _provider, ...resolved } = profile
  if ("avatarUrl" in resolved) {
    const { avatarUrl: _avatarUrl, ...contact } = resolved
    return contact
  }
  return resolved
}

const safeMetaProfile = async (
  sourceId: string,
  getMetaProfile: () => Promise<IncomingContact | null>,
): Promise<ResolvedMessengerProfile | null> => {
  try {
    const profile = await getMetaProfile()
    return profile ? { ...profile, sourceId, provider: "meta" } : null
  } catch {
    return null
  }
}

export async function resolveMessengerProfile(input: {
  workspaceId: string
  integrationMessengerId: string
  pageId: string
  sourceId: string
  policy?: MessengerProfilePolicy
  includeAvatar?: boolean
  getMetaProfile: () => Promise<IncomingContact | null>
}): Promise<ResolvedMessengerProfile | null> {
  const policy = input.policy ?? "pancakeThenMeta"
  if (policy !== "meta") {
    const pancake = await messengerPancakeCredentialService.withToken(
      {
        workspaceId: input.workspaceId,
        integrationMessengerId: input.integrationMessengerId,
      },
      (token) =>
        fetchPancakeMessengerProfile({
          pageId: input.pageId,
          psid: input.sourceId,
          token,
          includeAvatar: input.includeAvatar,
        }),
    )
    if (pancake) {
      return pancake
    }
    if (policy === "pancake") {
      return null
    }
  }
  return await safeMetaProfile(input.sourceId, input.getMetaProfile)
}

export async function loadPancakeMessengerProfileIndex(input: {
  workspaceId: string
  integrationMessengerId: string
  pageId: string
  includeAvatar?: boolean
}): Promise<Map<string, PancakeMessengerProfile> | undefined> {
  const profiles = await messengerPancakeCredentialService.withToken(
    {
      workspaceId: input.workspaceId,
      integrationMessengerId: input.integrationMessengerId,
    },
    (token) =>
      fetchPancakeMessengerProfiles({
        pageId: input.pageId,
        token,
        includeAvatar: input.includeAvatar,
      }),
  )
  return profiles
    ? new Map(profiles.map((profile) => [profile.sourceId, profile]))
    : undefined
}

export async function resolveIndexedMessengerProfile(input: {
  sourceId: string
  policy: MessengerProfilePolicy
  pancakeProfiles?: ReadonlyMap<string, PancakeMessengerProfile>
  getMetaProfile: () => Promise<IncomingContact | null>
}): Promise<ResolvedMessengerProfile | null> {
  if (input.policy !== "meta") {
    const pancake = input.pancakeProfiles?.get(input.sourceId)
    if (pancake) {
      return pancake
    }
    if (input.policy === "pancake") {
      return null
    }
  }
  return await safeMetaProfile(input.sourceId, input.getMetaProfile)
}

import type { IncomingContact } from "@chatbotx.io/sdk"
import { messengerPancakeCredentialService } from "../messenger-pancake-credential/service"
import {
  fetchPancakeMessengerProfile,
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
  return safeMetaProfile(input.sourceId, input.getMetaProfile)
}

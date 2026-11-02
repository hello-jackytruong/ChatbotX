import {
  buildContext,
  messengerIntegrationService,
} from "@chatbotx.io/business"
import { sanitizePublicText } from "@chatbotx.io/business/errors"
import { messengerProfileBackfillService } from "@chatbotx.io/business/messenger-profile-backfill"
import {
  loadPancakeMessengerProfileIndex,
  resolveIndexedMessengerProfile,
} from "@chatbotx.io/business/messenger-profile-provider"
import { messengerProfileBackfillRunRepository } from "@chatbotx.io/database/repositories"
import type { MessengerAuthValue } from "@chatbotx.io/integration-messenger"
import { createId } from "@chatbotx.io/utils"
import { fetchMediaWithLimits } from "@chatbotx.io/utils/media-download"
import { storeIncomingImage } from "@chatbotx.io/utils/store-incoming-image"
import type { LowJobMessengerProfileBackfill } from "@chatbotx.io/worker-config"
import { logger } from "../../lib/logger"
import { allIntegrations } from "../../services/integrations"

const BATCH_SIZE = 20

const validGender = (
  value: string | undefined,
): "male" | "female" | "unknown" | undefined =>
  value === "male" || value === "female" || value === "unknown"
    ? value
    : undefined

export async function runMessengerProfileBackfill(
  data: LowJobMessengerProfileBackfill["data"],
): Promise<void> {
  const run = await messengerProfileBackfillService.claim(data)
  if (!run) {
    return
  }

  try {
    const integrationRow =
      await messengerIntegrationService.findByIdForWorkspace({
        workspaceId: data.workspaceId,
        id: run.integrationMessengerId,
      })
    if (!integrationRow) {
      throw new Error("Messenger Page no longer exists")
    }
    const integration = allIntegrations.messenger
    if (!integration) {
      throw new Error("Messenger integration is unavailable")
    }
    const ctx = await buildContext<MessengerAuthValue>({
      workspaceId: data.workspaceId,
      integrationType: "messenger",
      integration: {
        ...integrationRow,
        auth: integrationRow.auth as MessengerAuthValue,
      },
    })

    let pancakeProfiles: Awaited<
      ReturnType<typeof loadPancakeMessengerProfileIndex>
    >
    try {
      pancakeProfiles =
        run.policy === "meta"
          ? undefined
          : await loadPancakeMessengerProfileIndex({
              workspaceId: data.workspaceId,
              integrationMessengerId: integrationRow.id,
              pageId: integrationRow.pageId,
              includeAvatar: true,
            })
    } catch {
      if (run.policy === "pancake") {
        throw new Error("Pancake conversations could not be read")
      }
      logger.warn(
        { pageId: integrationRow.pageId },
        "Pancake conversations could not be read; profile backfill will use Meta",
      )
    }
    if (run.policy === "pancake" && !pancakeProfiles) {
      throw new Error("Pancake credential is unavailable")
    }

    let cursor = run.cursorContactInboxId
    let totalFailed = 0
    while (true) {
      const current = await messengerProfileBackfillService.findById(data)
      if (!current || current.cancelRequestedAt) {
        await messengerProfileBackfillService.finish({
          ...data,
          status: "cancelled",
        })
        return
      }

      const candidates =
        await messengerProfileBackfillRunRepository.listCandidates({
          workspaceId: data.workspaceId,
          inboxId: integrationRow.inboxId,
          cursorContactInboxId: cursor,
          limit: BATCH_SIZE,
          overwriteExisting: run.overwriteExisting,
        })
      if (candidates.length === 0) {
        break
      }

      let updated = 0
      let avatars = 0
      let skipped = 0
      let failed = 0
      for (const candidate of candidates) {
        try {
          const profile = await resolveIndexedMessengerProfile({
            sourceId: candidate.sourceId,
            policy: run.policy,
            pancakeProfiles,
            getMetaProfile: () =>
              integration.runChannelHandler("contact", "getProfile", {
                ctx,
                data: { sourceId: candidate.sourceId, includeAvatar: true },
              }),
          })
          if (!profile) {
            skipped += 1
            continue
          }

          let avatar = profile.avatar
          if (profile.provider === "pancake" && profile.avatarUrl) {
            try {
              const media = await fetchMediaWithLimits(profile.avatarUrl)
              if (media) {
                avatar = (
                  await storeIncomingImage({
                    uploader: ctx.uploader,
                    key: `public/space/${ctx.storagePrefix}/avatars/${createId()}`,
                    bytes: Buffer.from(media.bytes),
                    mimeType: media.mimeType,
                    profile: "avatar",
                    acl: "public-read",
                  })
                ).originPath
              }
            } catch {
              logger.warn(
                {
                  pageId: integrationRow.pageId,
                  sourceId: candidate.sourceId,
                },
                "Pancake avatar could not be mirrored during profile backfill",
              )
            }
          }

          const updateProfile = run.overwriteExisting
            ? messengerProfileBackfillRunRepository.overwriteProfile
            : messengerProfileBackfillRunRepository.fillMissingProfile
          const result = await updateProfile({
            workspaceId: data.workspaceId,
            contactId: candidate.contactId,
            firstName: profile.firstName,
            lastName: profile.lastName,
            gender: validGender(profile.gender),
            avatar,
          })
          if (result.updated) {
            updated += 1
          } else {
            skipped += 1
          }
          if (result.avatarUpdated) {
            avatars += 1
          }
        } catch {
          failed += 1
          totalFailed += 1
        }
      }

      const lastCandidate = candidates.at(-1)
      if (!lastCandidate) {
        break
      }
      cursor = lastCandidate.contactInboxId
      await messengerProfileBackfillRunRepository.updateProgress({
        ...data,
        cursorContactInboxId: cursor,
        scanned: candidates.length,
        updated,
        avatars,
        skipped,
        failed,
      })
    }

    await messengerProfileBackfillService.finish({
      ...data,
      status: totalFailed > 0 ? "partial" : "succeeded",
      currentError:
        totalFailed > 0
          ? `${totalFailed} contacts could not be enriched`
          : null,
    })
  } catch (error) {
    await messengerProfileBackfillService.finish({
      ...data,
      status: "failed",
      currentError: sanitizePublicText(
        error instanceof Error ? error.message : "Profile backfill failed",
      ),
    })
  }
}

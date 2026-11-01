"use server"

import { ChatbotXException } from "@chatbotx.io/business/errors"
import {
  messengerPancakeCredentialService,
  PancakeCredentialVerificationError,
} from "@chatbotx.io/business/messenger-pancake-credential"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { getTranslations } from "next-intl/server"
import { workspaceActionClient } from "@/lib/safe-action"
import { assertCanManagePancakeCredential } from "../lib/assert-can-manage"
import { replacePancakeCredentialRequest } from "../schema/action"

export const replacePancakeCredentialAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(replacePancakeCredentialRequest)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, integrationMessengerId],
      parsedInput,
      ctx,
    }) => {
      await assertCanManagePancakeCredential(ctx)
      try {
        return await messengerPancakeCredentialService.verifyAndReplace({
          workspaceId,
          integrationMessengerId,
          token: parsedInput.token,
          updatedByUserId: ctx.user.id,
        })
      } catch (error) {
        if (error instanceof PancakeCredentialVerificationError) {
          const t = await getTranslations()
          throw new ChatbotXException(
            t("messengerPancakeCredential.errors.verificationFailed"),
            "messengerPancakeCredentialVerificationFailed",
            422,
          )
        }
        throw error
      }
    },
  )

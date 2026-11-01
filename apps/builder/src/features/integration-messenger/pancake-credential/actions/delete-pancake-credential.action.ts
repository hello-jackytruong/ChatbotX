"use server"

import { messengerPancakeCredentialService } from "@chatbotx.io/business/messenger-pancake-credential"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClientAllowExpired } from "@/lib/safe-action"
import { assertCanManagePancakeCredential } from "../lib/assert-can-manage"

export const deletePancakeCredentialAction = workspaceActionClientAllowExpired
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, integrationMessengerId],
      ctx,
    }) => {
      await assertCanManagePancakeCredential(ctx)
      await messengerPancakeCredentialService.delete({
        workspaceId,
        integrationMessengerId,
      })
      return { success: true }
    },
  )

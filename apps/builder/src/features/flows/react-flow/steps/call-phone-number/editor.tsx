"use client"

import { buttonTypes, getChannelFlowPolicy } from "@chatbotx.io/flow-config"
import { PhoneCallIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useStepStore } from "../../stores/step-store-provider"
import { BaseStepEditor } from "../base/editor"
import { PhoneNumberField } from "./phone-number-field"

type CallPhoneNumberStepEditorProps = {
  parentName: string
}

const CallPhoneNumberStepEditor = ({
  parentName,
}: CallPhoneNumberStepEditorProps) => {
  const t = useTranslations()
  const channel = useStepStore((state) => state.buttonEditorConfig?.channel)
  const isNative = getChannelFlowPolicy(channel)?.nativeButtonTypes.includes(
    buttonTypes.enum.callPhoneNumber,
  )

  return (
    <BaseStepEditor
      icon={PhoneCallIcon}
      title={t("fields.button.callToThisNumber")}
    >
      <div className="flex flex-col gap-2">
        <PhoneNumberField
          label={t("fields.phoneNumber.label")}
          name={`${parentName}.phoneNumber`}
        />
        {isNative ? null : (
          <p className="text-muted-foreground text-sm">
            {t("flows.callPhoneNumber.fallbackHint")}
          </p>
        )}
      </div>
    </BaseStepEditor>
  )
}

export default CallPhoneNumberStepEditor

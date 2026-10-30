"use client"

import { PhoneCallIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { BaseStepViewer } from "../base/viewer"

const CallPhoneNumberStepViewer = () => {
  const t = useTranslations()

  return (
    <BaseStepViewer
      icon={PhoneCallIcon}
      title={t("fields.button.callToThisNumber")}
    />
  )
}

export default CallPhoneNumberStepViewer

"use client"

import { hasPhoneNumberVariable } from "@chatbotx.io/flow-config"
import { PHONE_NUMBER_LITERAL_MAX } from "@chatbotx.io/flow-config/button-limits"
import {
  type CountryCode,
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
} from "libphonenumber-js"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { useFormContext, useWatch } from "react-hook-form"
import { CharacterCounter } from "@/components/character-counter"
import { PlainTextEditorField } from "@/components/tiptap/plain-text-editor-field"
import { resolveFlowValidationCodeKey } from "../../flow-validation-message"
import { useStepStore } from "../../stores/step-store-provider"
import { applyCountryToPhoneNumber, canApplyCountry } from "./apply-country"
import { CountryDialCodePicker } from "./country-dial-code-picker"

type PhoneNumberFieldProps = {
  name: string
  label: string
}

/**
 * Phone number input with a country picker (flag + dial code) in front of a
 * variable-capable text editor. The form value is the whole international
 * number, e.g. `+84901234567`, or an expression embedding `{{variables}}`.
 *
 * Picking a country rewrites the dial code, or turns a national number into
 * the international one (see `applyCountryToPhoneNumber`). The picker is off
 * while the value is not typed like a number — e.g. it holds a variable, whose
 * number is only known at send time.
 */
export const PhoneNumberField = ({ name, label }: PhoneNumberFieldProps) => {
  const t = useTranslations()
  const { setValue } = useFormContext()
  const value = (useWatch({ name }) as string | undefined) ?? ""
  const translateError = (message: string) => {
    const key = resolveFlowValidationCodeKey(message)
    return key ? t(key) : message
  }
  const workspaceTargetCountry = useStepStore(
    (state) => state.workspaceTargetCountry,
  )
  const [pickedCountry, setPickedCountry] = useState<CountryCode | null>(null)
  // The editor snapshots its value once on mount, so a programmatic change
  // (picking a country) remounts it.
  const [editorVersion, setEditorVersion] = useState(0)

  // A new, empty number starts with the workspace country's dial code. The
  // author can still pick another country or clear it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on the value the editor opened with
  useEffect(() => {
    if (
      value === "" &&
      workspaceTargetCountry &&
      isSupportedCountry(workspaceTargetCountry)
    ) {
      setPickedCountry(workspaceTargetCountry)
      setValue(name, `+${getCountryCallingCode(workspaceTargetCountry)}`)
      setEditorVersion((version) => version + 1)
    }
  }, [])

  const hasVariable = hasPhoneNumberVariable(value)
  // A picked country only stays selected while the value still starts with its
  // dial code, so retyping another code does not leave a stale flag behind.
  const pickedDialCode = pickedCountry
    ? `+${getCountryCallingCode(pickedCountry)}`
    : null
  const country =
    (parsePhoneNumberFromString(value)?.country as CountryCode | undefined) ??
    (pickedCountry && pickedDialCode && value.startsWith(pickedDialCode)
      ? pickedCountry
      : undefined)

  const onCountryChange = (next: CountryCode) => {
    setPickedCountry(next)
    setValue(name, applyCountryToPhoneNumber(value, next), {
      shouldDirty: true,
      shouldValidate: true,
    })
    setEditorVersion((version) => version + 1)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <CountryDialCodePicker
          disabled={!canApplyCountry(value)}
          onChange={onCountryChange}
          value={country}
        />
        <PlainTextEditorField
          disableLineBreaks
          formItemClassName="min-w-0 flex-1"
          includeBotFieldVariables
          inline
          key={editorVersion}
          label={label}
          name={name}
          placeholder={t("flows.callPhoneNumber.placeholder")}
          required
          showEmojiPicker={false}
          translateError={translateError}
        />
      </div>
      {hasVariable ? null : (
        <div className="flex justify-end">
          <CharacterCounter max={PHONE_NUMBER_LITERAL_MAX} value={value} />
        </div>
      )}
    </div>
  )
}

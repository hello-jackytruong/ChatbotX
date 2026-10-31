"use client"

import { hasPhoneNumberVariable } from "@chatbotx.io/flow-config"
import { PHONE_NUMBER_LITERAL_MAX } from "@chatbotx.io/flow-config/button-limits"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import {
  AsYouType,
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
import { useCountryOptions } from "@/hooks/use-country-options"
import { resolveFlowValidationCodeKey } from "../../flow-validation-message"
import { useStepStore } from "../../stores/step-store-provider"

type PhoneNumberFieldProps = {
  name: string
  label: string
}

const PLUS_DIGITS_ONLY = /^\+\d*$/

const getTypedCallingCode = (value: string): string | undefined => {
  const formatter = new AsYouType()
  formatter.input(value)
  return formatter.getCallingCode()
}

const toFlagEmoji = (countryCode: string): string =>
  String.fromCodePoint(
    ...[...countryCode.toUpperCase()].map(
      (letter) => 0x1_f1_e6 + letter.charCodeAt(0) - "A".charCodeAt(0),
    ),
  )

/**
 * Phone number input with a country picker (flag + dial code) in front of a
 * variable-capable text editor. The form value is the whole international
 * number, e.g. `+84901234567`, or an expression embedding `{{variables}}`.
 *
 * The picker only edits the leading `+<dial code>` and is disabled while the
 * value holds a variable, because then the number is not known until send time.
 */
export const PhoneNumberField = ({ name, label }: PhoneNumberFieldProps) => {
  const t = useTranslations()
  const { setValue } = useFormContext()
  const value = (useWatch({ name }) as string | undefined) ?? ""
  const countryOptions = useCountryOptions()
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
    (pickedDialCode && value.startsWith(pickedDialCode)
      ? pickedCountry
      : undefined)

  // The picker edits only a literal number's dial code, so it is off while the
  // value holds a variable or is text it cannot read as a number.
  const canPickCountry =
    !hasVariable &&
    (value === "" || PLUS_DIGITS_ONLY.test(value) || country !== undefined)

  const onCountryChange = (next: CountryCode) => {
    // Whatever the typed number already starts with is its dial code, known
    // even while the number is incomplete or has no single country (`+800…`).
    // With none (empty value, or an unfinished `+4`) there is no number yet.
    const typedCallingCode = getTypedCallingCode(value)
    const national = typedCallingCode
      ? value.slice(`+${typedCallingCode}`.length)
      : ""
    setPickedCountry(next)
    setValue(name, `+${getCountryCallingCode(next)}${national}`, {
      shouldDirty: true,
      shouldValidate: true,
    })
    setEditorVersion((version) => version + 1)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <Select
          disabled={!canPickCountry}
          items={countryOptions}
          onValueChange={(next) => onCountryChange(next as CountryCode)}
          value={country ?? null}
        >
          <SelectTrigger
            aria-label={t("flows.callPhoneNumber.countryLabel")}
            className="mt-6 w-28 shrink-0"
          >
            <SelectValue placeholder="+">
              {(selected: CountryCode | null) =>
                selected
                  ? `${toFlagEmoji(selected)} +${getCountryCallingCode(selected)}`
                  : "+"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {countryOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {toFlagEmoji(option.value)} {option.label} +
                {getCountryCallingCode(option.value as CountryCode)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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

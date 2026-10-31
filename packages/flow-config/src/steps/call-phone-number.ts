import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { parsePhoneNumberFromString } from "libphonenumber-js"
import { z } from "zod"
import { flowValidationCodes } from "../validation-codes"
import { PHONE_NUMBER_EXPRESSION_MAX } from "./button-limits"
import { stepTypes } from "./step-action"

const PHONE_SEPARATORS = /[\s\-.()]/g
const INTERNATIONAL_NUMBER = /^\+\d+$/
const VARIABLE_PATTERN = /\{\{.+?\}\}/

/**
 * The E.164 form of a whole value that must be a complete, real international
 * number, or `null`. Stricter than contact extraction on purpose: that parser
 * hunts for digit runs inside free text and guesses regions, while a dial
 * target must be exactly one number — surrounding junk, an unresolved
 * `{{token}}`, a missing `+` or a national format all mean "do not dial".
 */
export const normalizeDialablePhoneNumber = (value: string): string | null => {
  const compact = value.trim().replace(PHONE_SEPARATORS, "")
  if (!INTERNATIONAL_NUMBER.test(compact)) {
    return null
  }
  const parsed = parsePhoneNumberFromString(compact)
  return parsed?.isValid() ? parsed.number : null
}

/** Whether a value is already a valid number in canonical E.164 form. */
export const isE164PhoneNumber = (value: string): boolean =>
  normalizeDialablePhoneNumber(value) === value

/** Whether a number still holds a `{{variable}}` that resolves at send time. */
export const hasPhoneNumberVariable = (value: string): boolean =>
  VARIABLE_PATTERN.test(value)

/**
 * An authored phone number is either a literal in E.164 form or an expression
 * embedding `{{variables}}` that resolves to one at send time. A literal is
 * validated here with the same rule the worker applies to the resolved value.
 */
export const isValidAuthoredPhoneNumber = (value: string): boolean =>
  hasPhoneNumberVariable(value)
    ? value.length <= PHONE_NUMBER_EXPRESSION_MAX
    : isE164PhoneNumber(value)

export const callPhoneNumberStepSchema = z.object({
  id: zodBigintAsString().describe(
    "Step id (numeric string), unique within the flow.",
  ),
  stepType: z
    .literal(stepTypes.enum.callPhoneNumber)
    .describe('Step type discriminator: "callPhoneNumber".'),
  phoneNumber: z
    .string()
    .trim()
    .refine(isValidAuthoredPhoneNumber, flowValidationCodes.invalidPhoneNumber)
    .meta({
      description: `Number the button dials, in international format (E.164, e.g. +14155552671). May embed {{variables}} (max ${PHONE_NUMBER_EXPRESSION_MAX} characters) that resolve to such a number when the message is sent.`,
    }),
})

export type CallPhoneNumberStepSchema = z.infer<
  typeof callPhoneNumberStepSchema
>

export const callPhoneNumberStepDefaultFn = (): CallPhoneNumberStepSchema => ({
  id: createId(),
  stepType: stepTypes.enum.callPhoneNumber,
  phoneNumber: "",
})

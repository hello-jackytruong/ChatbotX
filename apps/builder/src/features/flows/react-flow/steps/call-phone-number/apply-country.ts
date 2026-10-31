import {
  AsYouType,
  type CountryCode,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from "libphonenumber-js"

/** Digits with an optional leading `+` and the usual separators. */
const PHONE_LIKE = /^\+?[\d\s\-.()]*$/
const PHONE_SEPARATORS = /[\s\-.()]/g

/**
 * Whether picking a country can act on the value: empty, or typed like a phone
 * number. Anything else (free text, `tel:`, a `{{variable}}`) is left to the
 * author, so the picker never turns arbitrary text into a dialable number.
 */
export const canApplyCountry = (value: string): boolean =>
  PHONE_LIKE.test(value)

/** The dial code a `+…` value already starts with, even while it is incomplete. */
const getTypedCallingCode = (compact: string): string | undefined => {
  const formatter = new AsYouType()
  formatter.input(compact)
  return formatter.getCallingCode()
}

/**
 * The number after picking `country`, for a value where `canApplyCountry`:
 * - `+…` keeps everything after the dial code it already has (`+44 20` →
 *   `+8420`); an unfinished code such as `+4` has no number yet, so only the
 *   new code stays;
 * - a national number is read in that country (`0349566551` in VN →
 *   `+84349566551`), so its trunk prefix is dropped the way that country does;
 * - an empty value becomes just the dial code.
 */
export const applyCountryToPhoneNumber = (
  value: string,
  country: CountryCode,
): string => {
  const dialCode = `+${getCountryCallingCode(country)}`
  const compact = value.replace(PHONE_SEPARATORS, "")

  if (compact.startsWith("+")) {
    const typedCallingCode = getTypedCallingCode(compact)
    return typedCallingCode
      ? `${dialCode}${compact.slice(`+${typedCallingCode}`.length)}`
      : dialCode
  }

  const nationalNumber =
    parsePhoneNumberFromString(compact, country)?.nationalNumber ?? compact
  return `${dialCode}${nationalNumber}`
}

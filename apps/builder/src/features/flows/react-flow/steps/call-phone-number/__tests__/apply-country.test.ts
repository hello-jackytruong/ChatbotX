import { describe, expect, test } from "vitest"
import { applyCountryToPhoneNumber, canApplyCountry } from "../apply-country"

describe("applyCountryToPhoneNumber", () => {
  test.each([
    ["an empty value", "", "VN", "+84"],
    ["a national number", "349566551", "VN", "+84349566551"],
    ["a national number with its trunk 0", "0349566551", "VN", "+84349566551"],
    ["a national number with separators", "034 956 6551", "VN", "+84349566551"],
    [
      "an Italian number whose leading 0 is kept",
      "0612345678",
      "IT",
      "+390612345678",
    ],
    ["an international number in another country", "+4420", "VN", "+8420"],
    [
      "a full number moved to another country",
      "+84901234567",
      "US",
      "+1901234567",
    ],
    ["an unfinished dial code", "+4", "VN", "+84"],
    ["a lone plus", "+", "GB", "+44"],
    ["a spaced dial code", "+ 44 20", "VN", "+8420"],
    ["a bracketed dial code", "+(44)20", "VN", "+8420"],
  ])("rewrites %s", (_name, value, country, expected) => {
    expect(applyCountryToPhoneNumber(value, country as "VN")).toBe(expected)
  })
})

describe("canApplyCountry", () => {
  test.each([
    "",
    "+",
    "0349566551",
    "+84 901-234.567",
    "(028) 3822 1234",
  ])("accepts %j", (value) => {
    expect(canApplyCountry(value)).toBe(true)
  })

  test.each([
    "foo 901234567",
    "tel:+84901234567",
    "{{contact.phone}}",
    "+84{{bot_field:1}}",
  ])("rejects %j", (value) => {
    expect(canApplyCountry(value)).toBe(false)
  })
})

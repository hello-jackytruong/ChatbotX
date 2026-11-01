export type MessengerBackfillErrorClassification =
  | "unavailable"
  | "data-too-large"
  | "retryable"
  | "auth"
  | "permission"
  | "unknown"

type ErrorFields = {
  httpStatusCode?: number
  code?: number | string
  subCode?: number | string | null
  error_subcode?: number | string | null
  type?: string
  message?: string
  cause?: unknown
  getOriginError?: () => unknown
}

const asNumber = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) {
    return
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const readFields = (error: unknown): ErrorFields => {
  let current = error
  for (let depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== "object") {
      break
    }
    const fields = current as ErrorFields
    if (
      fields.code !== undefined ||
      fields.httpStatusCode !== undefined ||
      fields.type !== undefined
    ) {
      return fields
    }
    current = fields.getOriginError?.() ?? fields.cause
  }
  return error instanceof Error ? { message: error.message } : {}
}

const RETRYABLE_CODES = new Set([4, 17, 613])
const AUTH_CODES = new Set([102, 190, 458, 459, 460, 463, 464, 467, 492])
const PERMISSION_CODES = new Set([3, 10, 24, 25, 341, 368])
const DATA_TOO_LARGE_MESSAGE = /reduce the amount of data/i

export const classifyMessengerBackfillError = (
  error: unknown,
): MessengerBackfillErrorClassification => {
  const fields = readFields(error)
  const code = asNumber(fields.code)
  const subCode = asNumber(fields.subCode ?? fields.error_subcode)
  const status = fields.httpStatusCode

  if ((code === 100 && subCode === 33) || code === 230) {
    return "unavailable"
  }
  if (
    code === 1 &&
    subCode === undefined &&
    DATA_TOO_LARGE_MESSAGE.test(fields.message ?? "")
  ) {
    return "data-too-large"
  }
  if (
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    (code !== undefined && RETRYABLE_CODES.has(code))
  ) {
    return "retryable"
  }
  if (
    fields.type === "OAuthException" ||
    (code !== undefined && AUTH_CODES.has(code))
  ) {
    return "auth"
  }
  if (
    code !== undefined &&
    (PERMISSION_CODES.has(code) || (code >= 200 && code <= 299))
  ) {
    return "permission"
  }
  return "unknown"
}

export const MIN_MESSAGE_PAGE_LIMIT = 25

export const nextSmallerMessagePageLimit = (current: number): number | null => {
  if (current <= MIN_MESSAGE_PAGE_LIMIT) {
    return null
  }
  return Math.max(MIN_MESSAGE_PAGE_LIMIT, Math.floor(current / 2))
}

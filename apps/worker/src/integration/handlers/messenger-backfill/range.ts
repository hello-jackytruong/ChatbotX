export type BackfillRange = { fromAt: Date; toAt: Date }

export type MessageTimestampPosition =
  | "older"
  | "in-range"
  | "newer"
  | "invalid"

const parseProviderDate = (value: string | undefined): Date | null => {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** Inclusive range classification for Graph `created_time`. */
export const classifyMessageTimestamp = (
  value: string | undefined,
  range: BackfillRange,
): MessageTimestampPosition => {
  const date = parseProviderDate(value)
  if (!date) {
    return "invalid"
  }
  if (date < range.fromAt) {
    return "older"
  }
  if (date > range.toAt) {
    return "newer"
  }
  return "in-range"
}

/**
 * `/conversations` is newest-first. Threads newer than the selected upper
 * bound still need inspection because they may contain older in-range
 * messages. Only a thread strictly older than the lower bound stops the walk.
 */
export const shouldStopConversationWalk = (
  updatedTime: string | undefined,
  fromAt: Date,
): boolean => {
  const updatedAt = parseProviderDate(updatedTime)
  return updatedAt ? updatedAt < fromAt : false
}

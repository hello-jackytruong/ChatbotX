export const buildMessengerBackfillJobId = (input: {
  runId: string
  attempts: number
}): string => `messenger-backfill-${input.runId}-${input.attempts}`

export const buildMessengerBackfillPageJobId = (input: {
  runId: string
  attempts: number
  pageNumber: number
}): string => `${buildMessengerBackfillJobId(input)}-page-${input.pageNumber}`

export const buildMessengerAutoBackfillJobId = (input: {
  integrationId: string
  timeBucket: number
}): string =>
  `messenger-auto-backfill-${input.integrationId}-${input.timeBucket}`

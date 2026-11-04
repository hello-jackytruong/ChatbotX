import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { contactService } from "@chatbotx.io/business"
import { uploader } from "@chatbotx.io/filesystem"
import pLimit from "p-limit"

const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const DEFAULT_CONCURRENCY = 12

class AvatarSourceError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.retryable = retryable
  }
}

type AvatarCandidate = Awaited<
  ReturnType<typeof contactService.listMessengerAvatarBackfillCandidates>
>[number]

type Options = {
  concurrency: number
  dryRun: boolean
  limit?: number
  localOnly: boolean
  pageId?: string
  repairRoot?: string
}

type LocalAvatar = {
  contentType: string
  filePath: string
  sha256: string
}

const parsePositiveInteger = (value: string, flag: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}

const parseOptions = (): Options => {
  const options: Options = {
    concurrency: DEFAULT_CONCURRENCY,
    dryRun: false,
    localOnly: false,
  }

  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") {
      options.dryRun = true
    } else if (arg === "--local-only") {
      options.localOnly = true
    } else if (arg.startsWith("--limit=")) {
      options.limit = parsePositiveInteger(arg.slice(8), "--limit")
    } else if (arg.startsWith("--concurrency=")) {
      options.concurrency = parsePositiveInteger(arg.slice(14), "--concurrency")
    } else if (arg.startsWith("--page=")) {
      options.pageId = arg.slice(7).trim()
    } else if (arg.startsWith("--repair-root=")) {
      options.repairRoot = resolve(arg.slice(14).trim())
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (options.localOnly && !options.repairRoot) {
    throw new Error("--local-only requires --repair-root")
  }

  return options
}

const loadLocalAvatars = async (
  repairRoot: string | undefined,
): Promise<Map<string, LocalAvatar>> => {
  const avatars = new Map<string, LocalAvatar>()
  if (!repairRoot) {
    return avatars
  }

  const directories = await readdir(repairRoot, { withFileTypes: true })
  for (const entry of directories) {
    if (!entry.isDirectory()) {
      continue
    }
    const manifestPath = resolve(repairRoot, entry.name, "repair.ndjson")
    let manifest: string
    try {
      manifest = await readFile(manifestPath, "utf8")
    } catch {
      continue
    }
    const manifestDirectory = dirname(manifestPath)
    for (const line of manifest.split("\n")) {
      if (!line.includes('"record_type":"contact_avatar"')) {
        continue
      }
      const record = JSON.parse(line) as {
        content_type: string
        identifier: string
        path: string
        sha256: string
      }
      const [provider, pageId, psid] = record.identifier.split(":")
      if (provider !== "pancake" || !pageId || !psid) {
        continue
      }
      const filePath = resolve(manifestDirectory, record.path)
      if (!filePath.startsWith(`${manifestDirectory}${sep}`)) {
        continue
      }
      avatars.set(`${pageId}:${psid}`, {
        contentType: record.content_type,
        filePath,
        sha256: record.sha256,
      })
    }
  }
  return avatars
}

const extensionFor = (contentType: string): string => {
  if (contentType === "image/png") {
    return "png"
  }
  if (contentType === "image/webp") {
    return "webp"
  }
  if (contentType === "image/gif") {
    return "gif"
  }
  return "jpg"
}

const fetchAvatar = async (
  pageId: string,
  psid: string,
): Promise<{
  bytes: Buffer
  contentType: string
}> => {
  const url = `https://pages.fm/api/v1/pages/${encodeURIComponent(pageId)}/avatar/${encodeURIComponent(psid)}`
  let lastError: unknown

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) {
        throw new AvatarSourceError(
          `HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
        )
      }
      const contentType = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
      if (!contentType.startsWith("image/")) {
        throw new Error(`Unexpected content type: ${contentType || "missing"}`)
      }
      const declaredSize = Number(response.headers.get("content-length") ?? 0)
      if (declaredSize > MAX_AVATAR_BYTES) {
        throw new Error(`Avatar exceeds ${MAX_AVATAR_BYTES} bytes`)
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
        throw new Error(`Invalid avatar size: ${bytes.length}`)
      }
      return { bytes, contentType }
    } catch (error) {
      lastError = error
      if (error instanceof AvatarSourceError && !error.retryable) {
        throw error
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500))
      }
    }
  }

  throw lastError
}

const loadCandidates = async (options: Options): Promise<AvatarCandidate[]> => {
  const result = await contactService.listMessengerAvatarBackfillCandidates({
    pageId: options.pageId,
  })

  const sorted = [...result].sort((left, right) => {
    const leftTime = left.lastMessageAt
      ? new Date(left.lastMessageAt).getTime()
      : 0
    const rightTime = right.lastMessageAt
      ? new Date(right.lastMessageAt).getTime()
      : 0
    return rightTime - leftTime
  })
  return options.limit ? sorted.slice(0, options.limit) : sorted
}

const backfillOne = async (
  candidate: AvatarCandidate,
  localAvatar: LocalAvatar | undefined,
): Promise<boolean> => {
  const { bytes, contentType } = localAvatar
    ? {
        bytes: await readFile(localAvatar.filePath),
        contentType: localAvatar.contentType,
      }
    : await fetchAvatar(candidate.pageId, candidate.psid)
  const hash = createHash("sha256").update(bytes).digest("hex")
  if (localAvatar && hash !== localAvatar.sha256) {
    throw new Error("Local avatar checksum mismatch")
  }
  const objectPath = `public/space/${candidate.workspaceId}/contacts/${candidate.contactId}/avatar/pagesfm-${hash}.${extensionFor(contentType)}`

  await uploader.putObject(objectPath, bytes, {
    ACL: "public-read",
    ContentLength: bytes.length,
    ContentType: contentType,
  })

  return contactService.setAvatarIfEmptyOrSentinel({
    workspaceId: candidate.workspaceId,
    contactId: candidate.contactId,
    avatar: objectPath,
  })
}

const main = async () => {
  const options = parseOptions()
  const localAvatars = await loadLocalAvatars(options.repairRoot)
  const loadedCandidates = await loadCandidates(options)
  const candidates = options.localOnly
    ? loadedCandidates.filter((candidate) =>
        localAvatars.has(`${candidate.pageId}:${candidate.psid}`),
      )
    : loadedCandidates
  console.log(
    JSON.stringify({
      event: "messenger-avatar-backfill-start",
      candidates: candidates.length,
      concurrency: options.concurrency,
      dryRun: options.dryRun,
      localAvatars: localAvatars.size,
      localOnly: options.localOnly,
      pageId: options.pageId ?? null,
    }),
  )

  if (options.dryRun || candidates.length === 0) {
    return
  }

  const concurrency = pLimit(options.concurrency)
  let failed = 0
  let processed = 0
  let skipped = 0
  let updated = 0

  for (let offset = 0; offset < candidates.length; offset += 250) {
    const batch = candidates.slice(offset, offset + 250)
    await Promise.all(
      batch.map((candidate) =>
        concurrency(async () => {
          try {
            if (
              await backfillOne(
                candidate,
                localAvatars.get(`${candidate.pageId}:${candidate.psid}`),
              )
            ) {
              updated += 1
            } else {
              skipped += 1
            }
          } catch (error) {
            failed += 1
            if (failed <= 20) {
              console.error(
                JSON.stringify({
                  event: "messenger-avatar-backfill-error",
                  pageId: candidate.pageId,
                  psid: candidate.psid,
                  error: error instanceof Error ? error.message : String(error),
                }),
              )
            }
          } finally {
            processed += 1
          }
        }),
      ),
    )
    console.log(
      JSON.stringify({
        event: "messenger-avatar-backfill-progress",
        processed,
        updated,
        skipped,
        failed,
        total: candidates.length,
      }),
    )
  }

  console.log(
    JSON.stringify({
      event: "messenger-avatar-backfill-complete",
      processed,
      updated,
      skipped,
      failed,
    }),
  )
  if (failed > 0) {
    process.exitCode = 2
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(
      JSON.stringify({
        event: "messenger-avatar-backfill-fatal",
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    process.exit(1)
  })

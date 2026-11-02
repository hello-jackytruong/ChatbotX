import { resolveFreshMediaUrl } from "@chatbotx.io/channel-registry/media-hydration"
import { createMessageRepository } from "@chatbotx.io/database/repositories"
import { uploader } from "@chatbotx.io/filesystem"
import { type NextRequest, NextResponse } from "next/server"
import { httpLogger } from "@/lib/log"
import {
  enqueueAttachmentMirror,
  enqueueAttachmentRestore,
  isFailedOriginPath,
  isPendingOriginPath,
  isTerminalMediaError,
  placeholderUrl,
  resolveMediaRequest,
} from "../../media-proxy"

type RouteContext = { params: Promise<{ token: string }> }

// Set by the client once a freshly re-signed storage URL has also failed to
// load, i.e. the mirrored object is gone from storage.
const RETRY_PARAM = "retry"

const FORWARDED_STORAGE_HEADERS = [
  "accept-ranges",
  "content-disposition",
  "content-encoding",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
] as const

const INLINE_MEDIA_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
])

const canRenderInline = (contentType: string | null): boolean =>
  contentType !== null &&
  INLINE_MEDIA_TYPES.has(contentType.split(";", 1)[0].trim().toLowerCase())

const proxyMirrored = async (
  request: NextRequest,
  originPath: string,
  mimeType?: string | null,
): Promise<NextResponse> => {
  const storageUrl = await uploader.getPresignedDownload(originPath)
  const range = request.headers.get("range")
  const headers = new Headers()
  if (range) {
    headers.set("Range", range)
  }
  const ifRange = request.headers.get("if-range")
  if (ifRange) {
    headers.set("If-Range", ifRange)
  }

  const upstream = await fetch(storageUrl, {
    cache: "no-store",
    headers,
    signal: request.signal,
  })
  const responseHeaders = new Headers()
  for (const header of FORWARDED_STORAGE_HEADERS) {
    const value = upstream.headers.get(header)
    if (value !== null) {
      responseHeaders.set(header, value)
    }
  }
  if (!responseHeaders.has("content-type") && mimeType) {
    responseHeaders.set("content-type", mimeType)
  }
  // Stored uploads previously lived on the isolated storage origin. Now that
  // they are streamed from the app origin, active HTML/SVG/XML must never be
  // rendered with app-origin authority. Only known passive media stays inline.
  if (!canRenderInline(responseHeaders.get("content-type"))) {
    responseHeaders.set("content-disposition", "attachment")
  }
  responseHeaders.set("x-content-type-options", "nosniff")
  responseHeaders.set("content-security-policy", "sandbox; default-src 'none'")
  // The route token is the authorization boundary. Never inherit a public or
  // longer-lived object policy that could cache the response past token expiry
  // or workspace suspension.
  responseHeaders.set("cache-control", "private, no-store")

  if (upstream.status === 416) {
    return new NextResponse(null, {
      status: upstream.status,
      headers: responseHeaders,
    })
  }
  if (!(upstream.ok && upstream.body)) {
    throw new Error(`Storage returned HTTP ${upstream.status}`)
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

// Serve an evicted mirrored attachment straight from the channel and restore
// its object in the background. Storage is never probed and the row is never
// written, so a spurious retry costs one overwrite and nothing else. Returns
// null when the channel has no copy to serve (e.g. WhatsApp).
const redirectEvicted = async (input: {
  attachmentId: string
  workspaceId: string
  messageCreatedAt: Date | undefined
}): Promise<NextResponse | null> => {
  const freshMedia = await resolveFreshMediaUrl({
    ...input,
    allowMirrored: true,
  })
  if (!freshMedia) {
    return null
  }
  enqueueAttachmentRestore({
    ...input,
    channel: freshMedia.channel,
    integrationId: freshMedia.integrationId,
  })
  return NextResponse.redirect(freshMedia.url, 302)
}

export const GET = async (request: NextRequest, context: RouteContext) => {
  const { token } = await context.params
  const resolvedRequest = await resolveMediaRequest({
    kind: "attachment",
    request,
    token,
  })
  if (resolvedRequest instanceof NextResponse) {
    return resolvedRequest
  }

  const unavailable = () =>
    NextResponse.redirect(placeholderUrl(request, "unavailable.svg"), 302)
  const processing = () =>
    NextResponse.redirect(placeholderUrl(request, "processing.svg"), 302)
  // Keep the response non-successful so media elements advance to the signed
  // fallback and finally `?retry=1`, which can restore an evicted object from
  // the channel. Redirecting to a placeholder here would suppress `onError`.
  const storageUnavailable = () => new NextResponse(null, { status: 502 })

  // The client's last recovery step: the URL it got first did not load.
  const isRetry = new URL(request.url).searchParams.get(RETRY_PARAM) === "1"
  const repository = await createMessageRepository()
  const messageCreatedAt =
    resolvedRequest.messageCreatedAt === undefined
      ? undefined
      : new Date(resolvedRequest.messageCreatedAt)
  const lookup = await repository.findAttachmentById({
    id: resolvedRequest.refId,
    workspaceId: resolvedRequest.workspaceId,
    messageCreatedAt,
  })
  if (!lookup) {
    return new NextResponse(null, { status: 404 })
  }

  // Re-mirror this attachment in the background (used on the pending/processing
  // paths so a later render serves the mirrored copy).
  const enqueueMirror = () =>
    enqueueAttachmentMirror({
      attachmentId: lookup.id,
      messageId: lookup.messageId,
      messageCreatedAt,
      workspaceId: resolvedRequest.workspaceId,
    })

  if (isFailedOriginPath(lookup.originPath)) {
    return unavailable()
  }
  if (!isPendingOriginPath(lookup.originPath)) {
    if (isRetry) {
      try {
        const evicted = await redirectEvicted({
          attachmentId: lookup.id,
          workspaceId: resolvedRequest.workspaceId,
          messageCreatedAt,
        })
        return evicted ?? unavailable()
      } catch (err) {
        if (!isTerminalMediaError(err)) {
          httpLogger.error(
            { err, attachmentId: lookup.id },
            "Failed to resolve fresh media for an evicted attachment",
          )
        }
        return unavailable()
      }
    }
    try {
      return await proxyMirrored(request, lookup.originPath, lookup.mimeType)
    } catch (err) {
      // A storage signing/fetch failure must advance the client's recovery
      // chain rather than render a successful placeholder response.
      httpLogger.error(
        { err, attachmentId: lookup.id },
        "Failed to proxy mirrored attachment",
      )
      return storageUnavailable()
    }
  }

  try {
    const freshMedia = await resolveFreshMediaUrl({
      attachmentId: lookup.id,
      workspaceId: resolvedRequest.workspaceId,
      messageCreatedAt,
      skipStoredUrl: isRetry,
    })
    if (freshMedia) {
      enqueueAttachmentMirror({
        attachmentId: lookup.id,
        channel: freshMedia.channel,
        integrationId: freshMedia.integrationId,
        messageId: lookup.messageId,
        messageCreatedAt,
        workspaceId: resolvedRequest.workspaceId,
      })
      return NextResponse.redirect(freshMedia.url, 302)
    }

    // A concurrent mirror may have completed between the two reads.
    const refreshed = await repository.findAttachmentById({
      id: lookup.id,
      workspaceId: resolvedRequest.workspaceId,
      messageCreatedAt,
    })
    if (refreshed && isFailedOriginPath(refreshed.originPath)) {
      return unavailable()
    }
    if (refreshed && !isPendingOriginPath(refreshed.originPath)) {
      try {
        return await proxyMirrored(
          request,
          refreshed.originPath,
          refreshed.mimeType,
        )
      } catch (err) {
        httpLogger.error(
          { err, attachmentId: refreshed.id },
          "Failed to proxy attachment mirrored during request",
        )
        return storageUnavailable()
      }
    }

    enqueueMirror()
    return processing()
  } catch (err) {
    // Terminal failures are permanent (unavailable); a transient blip is worth
    // logging and re-mirroring so a later render can recover (processing).
    if (isTerminalMediaError(err)) {
      return unavailable()
    }
    httpLogger.error(
      { err, attachmentId: lookup.id },
      "Failed to resolve fresh attachment media URL",
    )
    enqueueMirror()
    return processing()
  }
}

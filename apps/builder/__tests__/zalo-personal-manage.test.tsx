import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

type QrState =
  | "preparing"
  | "ready"
  | "scanned"
  | "connecting"
  | "expired"
  | "session_dead"

type Session = {
  id: string
  status: string
  nextAction?: {
    type: "display_qr"
    state: QrState
    qrImage?: string
    retryable: boolean
  }
}

const state = vi.hoisted(() => ({
  session: undefined as Session | undefined,
  sessionId: "session-1",
  connectShouldFail: false,
  useActionCall: 0,
  connect: vi.fn(),
  reconnect: vi.fn(),
  cancel: vi.fn(),
  invalidateConnections: vi.fn(async () => undefined),
  invalidateInboxes: vi.fn(async () => undefined),
  push: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => (
    <div aria-label={alt} data-image-src={src} role="img" />
  ),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push, refresh: state.refresh }),
}))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock("sonner", () => ({
  toast: { error: state.toastError, success: state.toastSuccess },
}))
vi.mock("@chatbotx.io/ui/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}))
vi.mock("@chatbotx.io/ui/components/ui/card", () => ({
  Card: ({ children }: React.PropsWithChildren) => (
    <section>{children}</section>
  ),
  CardContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CardHeader: ({ children }: React.PropsWithChildren) => (
    <header>{children}</header>
  ),
  CardTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}))
vi.mock("@/features/inboxes/provider/inbox-hook", () => ({
  useInvalidateInboxes: () => state.invalidateInboxes,
}))
vi.mock("@/lib/orpc/query", () => ({
  orpc: {
    connectionsAPI: { key: () => ["connections"] },
    connectSessionsAPI: {
      getConnectSessionAPI: { queryOptions: (options: unknown) => options },
    },
  },
}))
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: state.session }),
  useQueryClient: () => ({ invalidateQueries: state.invalidateConnections }),
}))
vi.mock("@/features/integration-zalo-personal/actions/connect.action", () => ({
  cancelZaloPersonalConnectAction: vi.fn(),
  connectZaloPersonalAction: vi.fn(),
  disconnectZaloPersonalAction: vi.fn(),
  reconnectZaloPersonalAction: vi.fn(),
}))
vi.mock("next-safe-action/hooks", () => ({
  useAction: (
    _action: unknown,
    callbacks: {
      onSuccess?: (result: { data?: { sessionId?: string } }) => void
      onError?: (result: { error: { serverError?: string } }) => void
    },
  ) => {
    const slot = state.useActionCall % 3
    state.useActionCall += 1
    let execute = state.reconnect
    if (slot === 0) {
      execute = state.connect.mockImplementation(() => {
        if (state.connectShouldFail) {
          callbacks.onError?.({ error: { serverError: "bridge unavailable" } })
        } else {
          callbacks.onSuccess?.({ data: { sessionId: state.sessionId } })
        }
      })
    } else if (slot === 2) {
      execute = state.cancel.mockImplementation(() => callbacks.onSuccess?.({}))
    }
    return { execute, isPending: false }
  },
}))

const { ZaloPersonalManage } = await import(
  "@/features/integration-zalo-personal/components/zalo-personal-manage"
)

const session = (
  status: string,
  qrState: QrState,
  qrImage?: string,
): Session => ({
  id: "session-1",
  status,
  nextAction: {
    type: "display_qr",
    state: qrState,
    qrImage,
    retryable: qrState === "expired" || qrState === "session_dead",
  },
})

describe("ZaloPersonalManage QR onboarding", () => {
  let container: HTMLDivElement
  let root: Root

  const render = () => {
    act(() => {
      root.render(
        <ZaloPersonalManage
          canCreate
          integrations={[]}
          workspaceId="workspace-1"
        />,
      )
    })
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    state.session = undefined
    state.sessionId = "session-1"
    state.connectShouldFail = false
    state.useActionCall = 0
    for (const mock of [
      state.connect,
      state.reconnect,
      state.cancel,
      state.invalidateConnections,
      state.invalidateInboxes,
      state.push,
      state.refresh,
      state.toastError,
      state.toastSuccess,
    ]) {
      mock.mockClear()
    }
    container = document.createElement("div")
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  test("starts without technical credential inputs and shows preparing", () => {
    render()
    expect(container.querySelectorAll("input")).toHaveLength(0)

    const start = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "fields.zalo_personal.startQr",
    )
    act(() => start?.click())

    expect(state.connect).toHaveBeenCalledOnce()
    expect(container.textContent).toContain("fields.zalo_personal.preparing")
  })

  test("renders the current QR and replaces it when the provider rotates it", () => {
    state.session = session("pending", "ready", "first")
    render()
    act(() => state.connect())
    expect(
      container
        .querySelector("[data-image-src]")
        ?.getAttribute("data-image-src"),
    ).toContain("first")

    state.session = session("pending", "ready", "replacement")
    render()
    expect(
      container
        .querySelector("[data-image-src]")
        ?.getAttribute("data-image-src"),
    ).toContain("replacement")
    expect(container.textContent).toContain("fields.zalo_personal.scanQr")
  })

  test.each([
    "scanned",
    "connecting",
    "expired",
  ] as const)("renders the %s lifecycle state without exposing a QR image", (qrState) => {
    state.session = session("pending", qrState)
    render()
    act(() => state.connect())

    expect(container.querySelector("[data-image-src]")).toBeNull()
    expect(container.textContent).toContain(
      `fields.zalo_personal.qrState.${qrState}`,
    )
  })

  test("offers a new QR after a terminal session failure", () => {
    state.session = session("failed", "session_dead")
    render()
    act(() => state.connect())

    expect(container.textContent).toContain("fields.zalo_personal.qrFailed")
    expect(container.textContent).toContain("fields.zalo_personal.newQr")
  })

  test("reports bridge errors without revealing credentials", () => {
    state.connectShouldFail = true
    render()
    const start = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "fields.zalo_personal.startQr",
    )
    act(() => start?.click())

    expect(state.toastError).toHaveBeenCalledWith("bridge unavailable")
    expect(container.textContent).not.toContain("secret")
  })

  test("invalidates connections and inboxes before navigating on completion", async () => {
    state.session = session("completed", "connecting")
    render()
    act(() => state.connect())
    await act(async () => undefined)

    expect(state.invalidateConnections).toHaveBeenCalledWith({
      queryKey: ["connections"],
    })
    expect(state.invalidateInboxes).toHaveBeenCalledOnce()
    expect(state.push).toHaveBeenCalledWith("/space/workspace-1/inbox")
    expect(
      state.invalidateConnections.mock.invocationCallOrder[0],
    ).toBeLessThan(state.push.mock.invocationCallOrder[0])
    expect(state.invalidateInboxes.mock.invocationCallOrder[0]).toBeLessThan(
      state.push.mock.invocationCallOrder[0],
    )
  })
})

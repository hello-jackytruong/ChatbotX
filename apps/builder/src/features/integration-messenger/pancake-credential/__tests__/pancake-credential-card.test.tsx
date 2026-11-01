import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  executeDelete: vi.fn(),
  reset: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: () => "Nov 1, 2026" }),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock("../actions/delete-pancake-credential.action", () => ({
  deletePancakeCredentialAction: vi.fn(),
}))
vi.mock("../actions/replace-pancake-credential.action", () => ({
  replacePancakeCredentialAction: vi.fn(),
}))

vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({
    execute: mocks.executeDelete,
    isPending: false,
  }),
}))

vi.mock("@next-safe-action/adapter-react-hook-form/hooks", () => ({
  useHookFormAction: () => ({
    form: {
      formState: { isDirty: true },
      reset: mocks.reset,
    },
    handleSubmitWithAction: vi.fn((event: Event) => event.preventDefault()),
    action: { isExecuting: false },
  }),
}))

vi.mock("@chatbotx.io/ui/components/ui/form", () => ({
  Form: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock("@chatbotx.io/ui/components/form/input-field", () => ({
  InputField: (props: React.ComponentProps<"input"> & { label?: string }) => (
    <label>
      {props.label}
      <input {...props} aria-label={props.label} />
    </label>
  ),
}))

vi.mock("@/features/platform-credentials/delete-credential-dialog", () => ({
  DeleteCredentialDialog: ({ onConfirm }: { onConfirm: () => void }) => (
    <button onClick={onConfirm} type="button">
      delete
    </button>
  ),
}))

const { PancakeCredentialCard } = await import(
  "../components/pancake-credential-card"
)

beforeEach(() => {
  vi.clearAllMocks()
})

describe("PancakeCredentialCard", () => {
  test("never renders a stored token and omits mutations in read-only mode", () => {
    const html = renderToStaticMarkup(
      <PancakeCredentialCard
        canEdit={false}
        integrationMessengerId="im-1"
        status={
          {
            configured: true,
            verifiedAt: new Date("2026-11-01T00:00:00Z"),
            updatedAt: new Date("2026-11-01T00:00:00Z"),
            updatedByUserId: "user-1",
            token: "sentinel-secret-that-must-not-render",
          } as never
        }
        workspaceId="ws-1"
      />,
    )

    expect(html).not.toContain("sentinel-secret")
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain("<button")
    expect(html).toContain("messengerPancakeCredential.readOnly")
  })

  test("renders a blank password field and replace/delete controls", () => {
    const html = renderToStaticMarkup(
      <PancakeCredentialCard
        canEdit
        integrationMessengerId="im-1"
        status={{
          configured: true,
          verifiedAt: new Date("2026-11-01T00:00:00Z"),
          updatedAt: new Date("2026-11-01T00:00:00Z"),
          updatedByUserId: "user-1",
        }}
        workspaceId="ws-1"
      />,
    )

    expect(html).toContain('type="password"')
    expect(html).not.toContain('value="')
    expect(html).not.toContain("sentinel-secret")
    expect(html).toContain("messengerPancakeCredential.actions.replace")
    expect(html).toContain(">delete</button>")
  })
})

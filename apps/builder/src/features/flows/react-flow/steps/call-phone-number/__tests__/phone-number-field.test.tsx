// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { FormProvider, type UseFormReturn, useForm } from "react-hook-form"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { StepStoreProvider } from "../../../stores/step-store-provider"
import { PhoneNumberField } from "../phone-number-field"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

vi.mock("@/components/tiptap/plain-text-editor-field", () => ({
  PlainTextEditorField: ({ name }: { name: string }) => (
    <div data-testid={`editor-${name}`} />
  ),
}))

type FormValues = { phoneNumber: string }

let container: HTMLDivElement
let root: Root
let form: UseFormReturn<FormValues> | undefined

const Harness = ({ initialValue }: { initialValue: string }) => {
  form = useForm<FormValues>({ defaultValues: { phoneNumber: initialValue } })
  return (
    <FormProvider {...form}>
      <PhoneNumberField label="Phone number" name="phoneNumber" />
    </FormProvider>
  )
}

const renderField = (
  initialValue: string,
  workspaceTargetCountry: string | null,
) => {
  act(() => {
    root.render(
      <StepStoreProvider initialState={{ workspaceTargetCountry }}>
        <Harness initialValue={initialValue} />
      </StepStoreProvider>,
    )
  })
  return form?.getValues("phoneNumber")
}

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  form = undefined
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe("PhoneNumberField workspace default", () => {
  test("starts an empty number with the workspace country's dial code", () => {
    expect(renderField("", "VN")).toBe("+84")
  })

  test.each([
    ["unknown", "unknown"],
    ["not set", null],
    ["not a country code", "XX"],
  ])("leaves an empty number empty when the workspace country is %s", (_name, country) => {
    expect(renderField("", country)).toBe("")
  })

  test("keeps a number the author already entered", () => {
    expect(renderField("+14155552671", "VN")).toBe("+14155552671")
  })
})

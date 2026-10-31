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

// cmdk scrolls the active option into view; jsdom has no layout.
Element.prototype.scrollIntoView = vi.fn()

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

const countryTrigger = () =>
  container.querySelector<HTMLButtonElement>(
    'button[aria-label="flows.callPhoneNumber.countryLabel"]',
  )

describe("PhoneNumberField country picker", () => {
  test.each([
    ["empty", ""],
    ["a national number", "0349566551"],
    ["an international number", "+84 901 234 567"],
  ])("is enabled for %s", (_name, value) => {
    renderField(value, null)
    expect(countryTrigger()?.disabled).toBe(false)
  })

  test.each([
    ["a variable", "{{contact.phone}}"],
    ["a tel: link", "tel:+84901234567"],
    ["free text", "call me"],
  ])("is disabled for %s", (_name, value) => {
    renderField(value, null)
    expect(countryTrigger()?.disabled).toBe(true)
  })

  test("searching a dial code and picking the country turns a national number into E.164", () => {
    renderField("0349566551", null)

    act(() => {
      countryTrigger()?.click()
    })
    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="actions.search"]',
    )
    if (!search) {
      throw new Error("expected the country search input")
    }
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "+84")
      search.dispatchEvent(new Event("input", { bubbles: true }))
    })

    const firstMatch = document.querySelector<HTMLElement>("[cmdk-item]")
    expect(firstMatch?.textContent).toContain("+84")

    act(() => {
      firstMatch?.click()
    })

    expect(form?.getValues("phoneNumber")).toBe("+84349566551")
    expect(countryTrigger()?.textContent).toContain("+84")
  })
})

import { describe, expect, test } from "vitest"
import { z } from "zod"
import {
  addContactTagStepDefaultFn,
  BUTTON_LABEL_MAX,
  buttonStepDefaultFn,
  buttonStepSchema,
  callPhoneNumberStepDefaultFn,
  chooseChannelStepDefaultFn,
  FLOW_EXPORT_FORMAT_VERSION,
  flowSpecSchema,
  flowValidationCodes,
  getChannelFlowPolicy,
  hasPhoneNumberVariable,
  isE164PhoneNumber,
  parseFlowExport,
  publishFlowSchema,
  sendCardStepDefaultFn,
  sendCarouselStepDefaultFn,
  sendMessageNodeDefaultFn,
  sendMessageNodeSchema,
  sendMessengerTemplateMessageStepDefaultFn,
  sendMessengerTemplateMessageStepSchema,
  sendQuickReplyStepSchema,
  sendTextStepDefaultFn,
  sendWaTemplateMessageStepDefaultFn,
  sendWaTemplateMessageStepSchema,
  whatsappFlowStepSchema,
} from "../src"
import { PHONE_NUMBER_EXPRESSION_MAX } from "../src/steps/button-limits"

const callButton = (phoneNumber: string) => ({
  ...buttonStepDefaultFn({ label: "Call us" }),
  buttonType: "callPhoneNumber" as const,
  beforeStep: { ...callPhoneNumberStepDefaultFn(), phoneNumber },
})

const template = { id: "1", name: "welcome", language: "en", params: {} }

describe("callPhoneNumber button schema", () => {
  test.each([
    "+14155552671", // US
    "+16135550123", // CA (shares +1)
    "+442079460958", // GB
    "+4915123456789", // DE
    "+919876543210", // IN
    "+5511987654321", // BR
    "+81312345678", // JP
    "+390612345678", // IT (keeps its leading 0)
    "+84901234567", // VN
    "+80012345678", // non-geographic
  ])("accepts the E.164 literal %s", (phoneNumber) => {
    expect(buttonStepSchema.safeParse(callButton(phoneNumber)).success).toBe(
      true,
    )
  })

  test.each([
    ["a national number", "0901234567"],
    ["junk", "call me"],
    ["an empty value", ""],
    ["more than 15 digits", "+1234567890123456"],
    ["a leading zero after the plus", "+0123456789"],
    ["a too-short number", "+12345"],
    ["a well-formed number with no real country plan", "+9991234567"],
    ["a number with separators (must be stored as E.164)", "+84 901 234 567"],
  ])("rejects %s", (_name, phoneNumber) => {
    const result = buttonStepSchema.safeParse(callButton(phoneNumber))
    expect(result.error?.issues[0]?.message).toBe(
      flowValidationCodes.invalidPhoneNumber,
    )
  })

  test("accepts an expression embedding a variable, even beyond a literal's length", () => {
    const expression = "{{bot_field:123456789012345678}}"
    expect(expression.length).toBeGreaterThan(16)
    expect(buttonStepSchema.safeParse(callButton(expression)).success).toBe(
      true,
    )
    expect(
      buttonStepSchema.safeParse(callButton("{{contact.phone}}")).success,
    ).toBe(true)
  })

  test("rejects an expression longer than the expression limit", () => {
    const tooLong = `{{contact.phone}}${"1".repeat(PHONE_NUMBER_EXPRESSION_MAX)}`
    expect(buttonStepSchema.safeParse(callButton(tooLong)).success).toBe(false)
  })

  test("still enforces the label limit", () => {
    const result = buttonStepSchema.safeParse({
      ...callButton("+84901234567"),
      label: "x".repeat(BUTTON_LABEL_MAX + 1),
    })
    expect(result.success).toBe(false)
  })

  test("cannot carry follow-up steps", () => {
    const withSteps = {
      ...callButton("+84901234567"),
      steps: [addContactTagStepDefaultFn({ tags: ["vip"] })],
    }
    const result = buttonStepSchema.safeParse(withSteps)

    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "steps",
    ])
  })
})

describe("phone number helpers", () => {
  test("isE164PhoneNumber accepts only real numbers already in E.164 form", () => {
    expect(isE164PhoneNumber("+84901234567")).toBe(true)
    expect(isE164PhoneNumber("84901234567")).toBe(false)
    expect(isE164PhoneNumber("+84 901 234 567")).toBe(false)
    expect(isE164PhoneNumber("+9991234567")).toBe(false)
  })

  test("hasPhoneNumberVariable detects a {{variable}}", () => {
    expect(hasPhoneNumberVariable("{{contact.phone}}")).toBe(true)
    expect(hasPhoneNumberVariable("+84901234567")).toBe(false)
    expect(hasPhoneNumberVariable("{{}}")).toBe(false)
  })
})

describe("callPhoneNumber button placement", () => {
  test("a WhatsApp template step rejects it", () => {
    const step = sendWaTemplateMessageStepDefaultFn({ template } as never)
    const result = sendWaTemplateMessageStepSchema.safeParse({
      ...step,
      buttons: [...step.buttons, callButton("+84901234567")],
    })
    expect(result.error?.issues[0]?.message).toBe(
      flowValidationCodes.buttonCallPhoneNumberUnsupported,
    )
  })

  test("a Messenger template step rejects it", () => {
    const step = sendMessengerTemplateMessageStepDefaultFn({
      template,
    } as never)
    const result = sendMessengerTemplateMessageStepSchema.safeParse({
      ...step,
      buttons: [callButton("+84901234567")],
    })
    expect(result.error?.issues[0]?.message).toBe(
      flowValidationCodes.buttonCallPhoneNumberUnsupported,
    )
  })

  test("a quick-reply step rejects it", () => {
    const result = sendQuickReplyStepSchema.safeParse({
      id: "1",
      stepType: "sendQuickReply",
      message: "Pick one",
      buttons: [callButton("+84901234567")],
    })
    expect(result.error?.issues[0]?.message).toBe(
      flowValidationCodes.buttonCallPhoneNumberUnsupported,
    )
  })

  test("a send-message node's quick replies reject it", () => {
    const shape = sendMessageNodeSchema.shape.data.shape.details.shape
    const result = shape.quickReplies.safeParse([callButton("+84901234567")])
    expect(result.error?.issues[0]?.message).toBe(
      flowValidationCodes.buttonCallPhoneNumberUnsupported,
    )
  })
})

describe("callPhoneNumber public schema", () => {
  test("the FlowSpec JSON schema exposes the call field", () => {
    expect(JSON.stringify(z.toJSONSchema(flowSpecSchema))).toContain('"call":{')
  })
})

describe("callPhoneNumber channel policy", () => {
  test("only channels with a native call control declare it", () => {
    for (const channel of ["messenger", "zalo", "webchat"] as const) {
      expect(getChannelFlowPolicy(channel)?.nativeButtonTypes).toEqual([
        "callPhoneNumber",
      ])
    }
    for (const channel of [
      "instagram",
      "telegram",
      "tiktok",
      "whatsapp",
      "omnichannel",
    ] as const) {
      expect(getChannelFlowPolicy(channel)?.nativeButtonTypes).toEqual([])
    }
  })
})

describe("FlowSpec call button", () => {
  const spec = (button: unknown) => ({
    formatVersion: 1,
    name: "Call flow",
    steps: [{ type: "send", text: "Hi", buttons: [button] }],
  })

  test("accepts a call button", () => {
    expect(
      flowSpecSchema.safeParse(spec({ text: "Call", call: "+84901234567" }))
        .success,
    ).toBe(true)
  })

  test("rejects an invalid number", () => {
    expect(
      flowSpecSchema.safeParse(spec({ text: "Call", call: "0901234567" }))
        .success,
    ).toBe(false)
  })

  test("rejects call combined with then", () => {
    expect(
      flowSpecSchema.safeParse(
        spec({
          text: "Call",
          call: "+84901234567",
          // biome-ignore lint/suspicious/noThenProperty: DSL fixture data
          then: [{ type: "addNote", note: "x" }],
        }),
      ).success,
    ).toBe(false)
  })
})

describe("callPhoneNumber in a published graph", () => {
  const nodeWith = (channel: string, steps: unknown[]) => {
    const node = sendMessageNodeDefaultFn({
      nodeProps: { id: "1" },
      detailProps: {
        beforeStep: chooseChannelStepDefaultFn({
          channel: channel as "whatsapp",
        }),
      },
    })
    return {
      ...node,
      data: { ...node.data, details: { ...node.data.details, steps } },
    }
  }
  const publish = (channel: string, steps: unknown[]) =>
    publishFlowSchema.safeParse({
      nodes: [nodeWith(channel, steps)],
      edges: [],
    })
  const card = (buttons: unknown[]) => ({
    ...sendCardStepDefaultFn(),
    title: "Card",
    buttons,
  })
  const replyButton = buttonStepDefaultFn({ label: "More" })

  test("a text step with a literal and a variable call button publishes on every channel", () => {
    const step = {
      ...sendTextStepDefaultFn({ text: "Need help?" }),
      buttons: [callButton("+84901234567"), callButton("{{contact.phone}}")],
    }
    for (const channel of [
      "messenger",
      "zalo",
      "webchat",
      "whatsapp",
      "telegram",
      "instagram",
      "tiktok",
      "omnichannel",
    ]) {
      expect(publish(channel, [step]).success, channel).toBe(true)
    }
  })

  test("a WhatsApp carousel whose cards each carry a call button publishes", () => {
    const carousel = {
      ...sendCarouselStepDefaultFn(),
      cards: [
        card([callButton("+84901234567")]),
        card([callButton("{{contact.phone}}")]),
      ],
    }
    expect(publish("whatsapp", [carousel]).success).toBe(true)
  })

  test("a WhatsApp carousel mixing a call button and a reply card publishes", () => {
    const carousel = {
      ...sendCarouselStepDefaultFn(),
      cards: [card([callButton("+84901234567")]), card([replyButton])],
    }
    expect(publish("whatsapp", [carousel]).success).toBe(true)
  })

  test("a WhatsApp Flow step rejects a call button as its CTA", () => {
    const result = whatsappFlowStepSchema.shape.buttons.safeParse([
      callButton("+84901234567"),
    ])
    expect(result.error?.issues[0]?.message).toBe(
      flowValidationCodes.buttonCallPhoneNumberUnsupported,
    )
  })

  test("a call button survives export -> import with its number and no steps", () => {
    const node = nodeWith("messenger", [
      {
        ...sendTextStepDefaultFn({ text: "Need help?" }),
        buttons: [callButton("+84901234567")],
      },
    ])
    const envelope = {
      formatVersion: FLOW_EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      source: { workspaceId: "1", flowId: "1" },
      flows: [
        {
          name: "Call flow",
          active: true,
          enableInInbox: false,
          startNodeId: node.id,
          nodes: [node],
          edges: [],
        },
      ],
    }

    const result = parseFlowExport(JSON.parse(JSON.stringify(envelope)))

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const imported = result.data.flows[0]?.nodes[0]
    const step = imported?.data.details.steps?.[0]
    const [button] = step && "buttons" in step ? step.buttons : []
    expect(button).toMatchObject({
      buttonType: "callPhoneNumber",
      beforeStep: { phoneNumber: "+84901234567" },
      steps: [],
    })
  })
})

import {
  type ButtonStepProps,
  getChannelFlowPolicy,
} from "@chatbotx.io/flow-config"
import { describe, expect, test, vi } from "vitest"
import { convertMessage } from "../src/handlers/message/outgoing-message"
import { getButtonTemplate } from "../src/handlers/message/outgoing-message/send-button"

vi.mock("../src/apis/attachment", () => ({
  uploadAttachment: vi.fn().mockResolvedValue({ attachment_id: "att-1" }),
}))

const callButton = {
  id: "1",
  label: "Call us",
  buttonType: "callPhoneNumber",
  beforeStep: {
    id: "2",
    stepType: "callPhoneNumber",
    phoneNumber: "+84901234567",
  },
  steps: [],
} as ButtonStepProps

const canonicalMessage = (buttons: unknown[]) =>
  ({
    contentType: "text",
    text: "Need help?",
    attachments: [],
    contentAttributes: {
      type: "template",
      payload: { templateType: "button", buttons },
    },
  }) as never

const phoneButton = {
  id: "1",
  label: "Call us",
  buttonType: "phoneNumber",
  phoneNumber: "+84901234567",
  postback: "payload",
}
const postbackButton = {
  id: "2",
  label: "More",
  buttonType: "postback",
  postback: "more",
}

describe("Messenger call phone number button", () => {
  test("the policy declares the native control this channel sends", () => {
    expect(getChannelFlowPolicy("messenger")?.nativeButtonTypes).toContain(
      "callPhoneNumber",
    )
  })

  test("a step button becomes a native phone_number button", () => {
    expect(getButtonTemplate({ flowId: "40", button: callButton })).toEqual({
      type: "phone_number",
      title: "Call us",
      payload: "+84901234567",
    })
  })

  test("a phone-only canonical message is sent as a button template", () => {
    const [message] = [...convertMessage(canonicalMessage([phoneButton]))]
    expect(message?.attachment).toMatchObject({
      type: "template",
      payload: {
        template_type: "button",
        buttons: [
          { type: "phone_number", title: "Call us", payload: "+84901234567" },
        ],
      },
    })
  })

  test("a mixed canonical message keeps both buttons in order", () => {
    const [message] = [
      ...convertMessage(canonicalMessage([postbackButton, phoneButton])),
    ]
    expect(
      (
        message?.attachment as { payload: { buttons: { type: string }[] } }
      ).payload.buttons.map((button) => button.type),
    ).toEqual(["postback", "phone_number"])
  })

  test("postback-only canonical buttons still send plain text", () => {
    const [message] = [...convertMessage(canonicalMessage([postbackButton]))]
    expect(message).toEqual({ text: "Need help?" })
  })
})

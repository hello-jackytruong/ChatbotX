import { buttonTypes } from "../../steps/button"
import { stepTypes } from "../../steps/step-action"
import { defineChannelFlowPolicy } from "./define"

export const zaloPersonalFlowPolicy = defineChannelFlowPolicy({
  limits: {
    buttonCount: 0,
    buttonLabel: 0,
    text: 2000,
  },
  nativeButtonTypes: [buttonTypes.enum.callPhoneNumber],
  supported: [
    stepTypes.enum.sendText,
    stepTypes.enum.sendImage,
    stepTypes.enum.sendVideo,
    stepTypes.enum.sendAudio,
    stepTypes.enum.sendFile,
  ],
  noButtons: [
    stepTypes.enum.sendImage,
    stepTypes.enum.sendVideo,
    stepTypes.enum.sendAudio,
    stepTypes.enum.sendFile,
  ],
})

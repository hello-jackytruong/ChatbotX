// @vitest-environment node

import { describe, expect, test } from "vitest"
import { buildConversationInboxGroups } from "@/features/conversations/conversation-inbox-filter"

describe("buildConversationInboxGroups", () => {
  test("groups selectable inboxes from multiple channels", () => {
    expect(
      buildConversationInboxGroups(
        [
          { channel: "zalo", id: "zalo-2", name: "Zalo B" },
          { channel: "messenger", id: "messenger-2", name: "Page B" },
          { channel: "messenger", id: "messenger-1", name: "Page A" },
          { channel: "zalo", id: "zalo-1", name: "Zalo A" },
        ],
        (channel) =>
          ({ messenger: "Messenger", zalo: "Zalo OA" })[channel] ?? channel,
      ),
    ).toEqual([
      {
        heading: "Messenger",
        options: [
          { label: "Page A", value: "messenger-1" },
          { label: "Page B", value: "messenger-2" },
        ],
      },
      {
        heading: "Zalo OA",
        options: [
          { label: "Zalo A", value: "zalo-1" },
          { label: "Zalo B", value: "zalo-2" },
        ],
      },
    ])
  })
})

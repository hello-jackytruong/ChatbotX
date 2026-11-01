"use client"

import { MultiSelectField } from "@chatbotx.io/ui/components/form/multi-select-field"
import type { MultiSelectGroup } from "@chatbotx.io/ui/components/ui/sersavan/multi-select"
import { useTranslations } from "next-intl"
import { useMemo } from "react"
import type { ConversationFilters } from "../chat/store/chat-store"
import { channelLabel } from "../inboxes/lib/channel-label"
import { useInboxList } from "../inboxes/provider/inbox-hook"

type InboxFilterOption = {
  channel: string
  id: string
  name: string
}

export const buildConversationInboxGroups = (
  inboxes: readonly InboxFilterOption[],
  getChannelLabel: (channel: string) => string,
): MultiSelectGroup[] => {
  const byChannel = new Map<string, InboxFilterOption[]>()

  for (const inbox of inboxes) {
    const group = byChannel.get(inbox.channel) ?? []
    group.push(inbox)
    byChannel.set(inbox.channel, group)
  }

  return [...byChannel.entries()]
    .map(([channel, channelInboxes]) => ({
      heading: getChannelLabel(channel),
      options: channelInboxes
        .map((inbox) => ({ label: inbox.name, value: inbox.id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.heading.localeCompare(b.heading))
}

/** Visible multi-inbox picker for the conversation list, grouped by channel. */
export function ConversationInboxFilter() {
  const t = useTranslations()
  const inboxes = useInboxList()
  const allInboxesLabel = t("analytics.filters.allInboxes")

  const groups = useMemo(
    () =>
      buildConversationInboxGroups(inboxes, (channel) => {
        const labelKey = `fields.${channel}.label`
        return t.has(labelKey) ? t(labelKey) : channelLabel(channel)
      }),
    [inboxes, t],
  )

  return (
    <div className="mb-2 shrink-0">
      <MultiSelectField<ConversationFilters>
        allSelectedLabel={allInboxesLabel}
        className="w-full"
        labels={{
          searchPlaceholder: t("analytics.filters.searchPlaceholder"),
          searchAriaLabel: t("analytics.filters.searchPlaceholder"),
          empty: t("analytics.filters.empty"),
          clear: t("analytics.filters.clear"),
          close: t("analytics.filters.close"),
          optionsAriaLabel: t("analytics.filters.options"),
          selectAll: () => allInboxesLabel,
          clearAllAriaLabel: () => t("analytics.filters.clear"),
          removeAriaLabel: (label) =>
            `${t("analytics.filters.remove")} ${label}`,
        }}
        maxCount={1}
        name="inboxIds"
        options={groups}
        placeholder={allInboxesLabel}
        popoverClassName="w-[min(26rem,calc(100vw-2rem))]"
        singleLine
      />
    </div>
  )
}

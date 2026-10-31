"use client"

import type { LucideIcon } from "lucide-react"
import type { ReactElement, ReactNode } from "react"

export const BaseStepEditor = (props: {
  icon?: LucideIcon
  iconNode?: ReactNode
  title?: string
  children?: ReactElement
}) => (
  <div className="flex flex-col gap-1.5 rounded-lg border-2 border-dashed p-4 text-sm">
    {props.iconNode || props.icon || props.title ? (
      <div className="flex w-full items-center gap-1">
        {props.iconNode ?? (props.icon && <props.icon size={18} />)}
        {props.title && <span>{props.title}</span>}
      </div>
    ) : null}
    {props.children}
  </div>
)

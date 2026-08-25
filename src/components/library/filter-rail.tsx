'use client'

import { useState } from 'react'
import { splitVisibleValues, type FacetGroup, type FacetValueCount } from '@/lib/library/facets'
import type { FilterToken } from '@/lib/library/filter'

/**
 * The counts are the point of this rail. They answer questions the old
 * Notion database could not — "we have eleven seafood mains and we've only
 * made three" — so every value announces its own count as part of its
 * accessible name, not as a decorative number floating beside it. Someone
 * driving this with a keyboard and a screen reader, hands covered in flour,
 * hears "seafood, eleven recipes, checkbox" and knows the same thing a
 * sighted reader knows.
 *
 * Everything here is a real `<input type="checkbox">` inside a `<label>`
 * inside a `<fieldset>` with a `<legend>`. That is not minimalism for its
 * own sake: it is what makes the rail tabbable, space-togglable,
 * group-announced and correctly disabled with no ARIA of our own and no
 * keyboard handlers to get wrong.
 */

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'recipe' : 'recipes'}`
}

function ValueRow({
  value,
  onToggle,
}: {
  value: FacetValueCount
  onToggle: (token: FilterToken) => void
}) {
  return (
    <li>
      <label
        className={`flex cursor-pointer items-baseline gap-2 rounded px-1 py-1 text-sm ${
          value.disabled
            ? 'cursor-default text-neutral-400 dark:text-neutral-600'
            : 'hover:bg-black/5 dark:hover:bg-white/10'
        }`}
      >
        <input
          type="checkbox"
          checked={value.selected}
          disabled={value.disabled}
          onChange={() => onToggle(value.token)}
          className="accent-current"
        />
        <span className="flex-1">{value.label}</span>
        <span aria-hidden="true" className="tabular-nums text-neutral-500 dark:text-neutral-400">
          {value.count}
        </span>
        {/* Leading comma so the accessible name reads "Seafood, 11
            recipes" rather than running the two together — the visible
            number beside it is `aria-hidden`, and adjacent inline text
            concatenates with no separator of its own. */}
        <span className="sr-only">{`, ${countLabel(value.count)}`}</span>
      </label>
    </li>
  )
}

function FacetSection({
  group,
  onToggle,
}: {
  group: FacetGroup
  onToggle: (token: FilterToken) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const { visible, folded } = splitVisibleValues(group.values)
  const shown = expanded ? group.values : visible

  return (
    <fieldset className="border-0 p-0">
      <legend className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
        {group.label}
      </legend>
      <ul>
        {shown.map((value) => (
          <ValueRow key={value.token} value={value} onToggle={onToggle} />
        ))}
      </ul>
      {folded.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="mt-1 px-1 text-xs underline underline-offset-2"
        >
          {expanded ? 'Show fewer' : `Show ${folded.length} more`}
        </button>
      )}
    </fieldset>
  )
}

export function FilterRail({
  groups,
  onToggle,
  onClear,
  selectedCount,
}: {
  groups: readonly FacetGroup[]
  onToggle: (token: FilterToken) => void
  onClear: () => void
  selectedCount: number
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Filters</h2>
        {selectedCount > 0 && (
          <button type="button" onClick={onClear} className="text-xs underline underline-offset-2">
            Clear all
          </button>
        )}
      </div>
      {groups.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Nothing in the library is tagged yet, so there is nothing to filter by.
        </p>
      )}
      {groups.map((group) => (
        <FacetSection key={group.facet} group={group} onToggle={onToggle} />
      ))}
    </div>
  )
}

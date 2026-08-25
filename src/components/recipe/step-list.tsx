import type { DetailStep } from '@/lib/db/queries/recipe-detail'

type Group = { section: string | null; items: DetailStep[]; firstNumber: number }

/**
 * Steps, grouped into consecutive runs by section, each run remembering the
 * number its first step carries in the recipe as a whole.
 *
 * Numbering is continuous across sections — 1 through n for the recipe, not
 * 1 through 3 and then 1 through 4 again. A cook says "I'm on step 7"; two
 * step 3s in one recipe is a way to lose your place in a hot kitchen.
 */
export function groupSteps(steps: readonly DetailStep[]): Group[] {
  const groups: Group[] = []
  for (const item of steps) {
    const last = groups[groups.length - 1]
    if (last && last.section === item.section) last.items.push(item)
    else groups.push({ section: item.section, items: [item], firstNumber: 1 })
  }
  let n = 1
  for (const group of groups) {
    group.firstNumber = n
    n += group.items.length
  }
  return groups
}

/**
 * The method. `<ol start>` keeps the browser's own numbering correct across
 * section breaks even though each run is its own list, which matters for
 * screen readers and for anyone who prints the page.
 *
 * The visible number is rendered as its own element and hidden from
 * assistive technology, because the `<ol>` already announces position — a
 * screen reader would otherwise read "3, 3, sear the beef".
 *
 * Step text is a third-party string and renders as a text node. React escapes
 * it; it must never reach `dangerouslySetInnerHTML`.
 */
export function StepList({ steps }: { steps: readonly DetailStep[] }) {
  if (steps.length === 0) return null

  const groups = groupSteps(steps)

  return (
    <section aria-label="Steps">
      <h2 className="text-xs font-semibold tracking-wider text-neutral-500 uppercase dark:text-neutral-400">
        Steps
      </h2>

      {groups.map((group, index) => (
        <div key={`${group.section ?? ''}-${index}`}>
          {group.section && (
            <h3 className="mt-6 mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
              {group.section}
            </h3>
          )}
          <ol
            start={group.firstNumber}
            aria-label={group.section ?? 'Steps'}
            className="mt-3 space-y-4"
          >
            {group.items.map((item, offset) => (
              <li key={item.position} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  {group.firstNumber + offset}
                </span>
                <p className="text-[15px] leading-relaxed">{item.text}</p>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  )
}

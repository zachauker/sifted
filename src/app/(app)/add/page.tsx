import { UrlImportForm } from './url-import-form'
import { ManualEntryForm } from './manual-entry-form'

/**
 * Two independent ways a recipe enters the library — see
 * `src/app/api/recipes/import/route.ts` and
 * `src/app/api/recipes/manual/route.ts` for what each posts to. Presented as
 * two plain sections rather than tabs: this is a two-person app used mostly
 * on a phone, and a tab control hides the second option from someone who
 * doesn't already know it exists.
 */
export default function AddRecipePage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-4 py-6">
      <div>
        <h1 className="mb-1 text-xl font-semibold">Add a recipe</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Paste a link, or type one in by hand.
        </p>
      </div>

      <section aria-labelledby="add-by-url-heading">
        <h2 id="add-by-url-heading" className="mb-2 text-base font-medium">
          Paste a URL
        </h2>
        <UrlImportForm />
      </section>

      <section aria-labelledby="add-by-hand-heading">
        <h2 id="add-by-hand-heading" className="mb-2 text-base font-medium">
          Enter one by hand
        </h2>
        <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
          For a recipe with no web source — a family recipe, something typed
          up from memory. Ingredients are saved exactly as typed, one per
          line.
        </p>
        <ManualEntryForm />
      </section>
    </div>
  )
}

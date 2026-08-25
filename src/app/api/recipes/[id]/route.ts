import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { updateUserFields, type UserFieldPatch } from '@/lib/db/queries/recipes'
import { MAX_REASONABLE_MINUTES } from '@/lib/extract/duration'

/**
 * `PATCH /api/recipes/[id]` — the four fields nothing else can write.
 *
 * Rating, status, notes and measured time are the only columns on a recipe that
 * no re-extraction can produce, which makes this the one write path in the app
 * whose input is irreplaceable. Two consequences show up in the code below:
 *
 *  - the body is a *patch*, not a resource. Every key is optional and an absent
 *    key means "leave it", so a rating tap can never blank a paragraph of notes
 *    (see `updateUserFields`);
 *  - the validation is deliberately strict about the shapes that would corrupt
 *    a filter rather than fail loudly. A rating of 9 or a cook time of eleven
 *    years is not a value to store and worry about later: it silently distorts
 *    the counts and the time buckets the library UI is filtered by, and nothing
 *    ever surfaces it as wrong.
 *
 * Session-authenticated, not token-authenticated. The API tokens exist for the
 * iOS Shortcut, which only ever imports; editing happens in a browser with a
 * session cookie.
 */

/**
 * Long enough for a real household note — the migrated ones run to a couple of
 * paragraphs — and short enough that a runaway paste cannot put a megabyte
 * through the FTS tokenizer on every save.
 */
const MAX_NOTES_LENGTH = 10_000

/**
 * `z.strictObject`, so an unknown key is a 400 rather than a silent no-op. A
 * client that sends `{ ratings: 5 }` and gets a cheerful 200 back has lost the
 * rating with no way to tell.
 *
 * Every field accepts `null` as well as a value, because clearing is a real
 * edit: "actually we never made this" and "unrated" have to be reachable, and
 * without an explicit null there would be no way to express them.
 */
const patchSchema = z.strictObject({
  // 0 is accepted (the plan's range is 0-5) but the UI never sends it: an
  // "unrated" recipe is `null`, and a zero-star rating is a rating like any
  // other. Nothing in the filter rail offers `rating:0`, so a 0 written here
  // would be invisible to the rating facet — see the note in the report.
  rating: z.number().int().min(0).max(5).nullable().optional(),
  status: z.enum(['want_to_make', 'made_it']).nullable().optional(),
  notes: z.string().max(MAX_NOTES_LENGTH).nullable().optional(),
  // Same ceiling the duration parser applies to a publisher's own claim, for
  // the same reason, imported rather than redeclared.
  actualTimeMinutes: z.number().int().min(0).max(MAX_REASONABLE_MINUTES).nullable().optional(),
})

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const parsed = patchSchema.safeParse(json)
  if (!parsed.success) {
    // The field name and reason go back to the client. This endpoint is driven
    // by a form a person is typing into, and "invalid body" gives the UI
    // nothing to put beside the field that is actually wrong.
    return NextResponse.json(
      {
        error: 'invalid body',
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 },
    )
  }

  // An empty patch is a client bug, and answering 200 to one hides it. Nothing
  // in the UI can produce this.
  const fields: UserFieldPatch = parsed.data
  if (Object.keys(fields).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  const { id } = await params
  const updated = await updateUserFields(db, id, fields)
  if (!updated) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // The stored values, read back, rather than an echo of the request: `notes`
  // is trimmed and empty-collapsed on the way in, and the client's optimistic
  // copy should converge on what the database actually holds.
  return NextResponse.json({ recipe: { id, ...updated } })
}

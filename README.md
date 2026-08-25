# Sifted

A recipe library for two. It takes a URL, sifts the recipe out of the food-blog
chaff, and stores the result: ingredients and steps at the top, the narrative
kept but pushed to its own section at the bottom.

Built to replace a shared Notion database whose search had stopped being fast
enough to use while standing in a kitchen.

## What it does

- **Import from a URL.** schema.org JSON-LD first, then microdata, then a model
  call as the fallback. The original page is archived gzipped before anything is
  parsed, so a bad extraction is always re-runnable without re-fetching.
- **Filter while browsing.** Course, cuisine, tags, rating, and tried/not-tried,
  with facet counts that stay honest as you narrow.
- **Full-text search** over titles, ingredients, and notes (SQLite FTS5).
- **Claimed vs actual time.** Recipes lie about how long they take; this records
  both.
- **Save from a phone.** An iOS Shortcut posts to the import API with a
  per-device token — Share → Save to Sifted. See `docs/ios-shortcut.md`.

## Running it locally

```bash
cp .env.example .env.local   # fill in the values it lists
npm install
npm run db:migrate
npm run seed                 # creates an account; there is no signup page
npm run dev
```

## Checks

```bash
npx vitest run && npx tsc --noEmit && npx eslint src tests scripts
```

## Docs

| File | What's in it |
| --- | --- |
| `docs/deployment.md` | Turso + Vercel, in the order that works |
| `docs/ios-shortcut.md` | The two Shortcut variants, including the one for blocked publishers |
| `docs/migration-notes.md` | Moving the Notion library across, and what doesn't survive |
| `docs/superpowers/specs/` | The design decisions and why they went that way |

## Things that are deliberate

- **No signup page.** Two accounts, created from the CLI. A third would be
  surface area with no purpose.
- **No service worker.** Offline is out of scope, and a half-built one causes
  stale-cache bugs that are miserable to diagnose.
- **`lib/extract` does no I/O.** All network access goes through `lib/fetch`,
  which is the only place a URL is ever dereferenced.
- **One sanitized HTML sink,** enforced by a test that scans the source for
  `dangerouslySetInnerHTML` and fails on any second one.

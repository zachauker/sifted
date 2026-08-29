# Deploying to Vercel

Roughly 30–40 minutes end to end, most of it waiting on the Notion migration.

Order matters in one place: **create the database and run migrations before the
first deploy**, or the app boots against nothing.

---

## 1. Provision the database (Turso)

```bash
brew install tursodatabase/tap/turso
turso auth login
turso db create sifted
turso db show sifted --url
turso db tokens create sifted
```

Keep the URL (`libsql://sifted-<org>.turso.io`) and the token.

## 2. Create a local env file

```bash
cp .env.example .env.local
```

Fill in:

| Variable | Where it comes from |
| --- | --- |
| `TURSO_DATABASE_URL` | step 1 |
| `TURSO_AUTH_TOKEN` | step 1 |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `ANTHROPIC_API_KEY` | console.anthropic.com — **paste the whole thing**, it is ~100 characters |
| `BLOB_READ_WRITE_TOKEN` | step 4 — leave blank for now |

`.env.local` is gitignored. Every `npm run` script here loads it automatically.

## 3. Create the schema

```bash
npm run db:migrate
```

Four migrations, ending with the FTS5 virtual table. Verify:

```bash
npm run migrate:verify
```

It should report 0 recipes and fail its 156-recipe expectation — correct at this
point, and proof the connection works.

## 4. Blob storage

**The store must be created with public access.** Hero images are served
straight from their blob URL by `next/image`, and `next.config.ts` allowlists
`**.public.blob.vercel-storage.com`. A private store rejects every write this
app makes, and its URLs are on a different host that would not render even if
it accepted them. Access mode is fixed when the store is created, so getting
this wrong means making a new one.

```bash
vercel blob create-store sifted --access public
```

Or in the dashboard: **Storage → Create → Blob**, and choose **public** access.
Either way, copy the `BLOB_READ_WRITE_TOKEN` it generates into `.env.local`.

The archived original HTML lives in the same store, so it is public too. The
keys are derived from unguessable recipe ids, and the contents are pages that
were already published on the open web — but it is worth knowing rather than
assuming otherwise.

This holds hero images, their thumbnails, and a gzipped copy of every recipe's
original HTML. Budget roughly 150 MB for a 156-recipe library.

## 5. Deploy

```bash
npx vercel        # links the project, deploys a preview
```

Then add every variable from `.env.local` **except the Notion ones** to
Production, Preview, and Development:

```bash
for v in TURSO_DATABASE_URL TURSO_AUTH_TOKEN AUTH_SECRET ANTHROPIC_API_KEY BLOB_READ_WRITE_TOKEN; do
  vercel env add "$v" production
done
```

or paste them in **Settings → Environment Variables**. Then:

```bash
npx vercel --prod
```

**Node version.** `package.json` pins `engines.node` to `24.x`, which
overrides whatever the project settings say. This is load-bearing rather than
tidy: `jsdom` reaches a CommonJS package that `require()`s an ES-module-only
dependency, which Node could not do before 22.12. On an older runtime every
route that extracts a recipe — the phone Shortcut and the paste-HTML recovery
both — returns 500. If you change this, `tests/build/node-engines-guard.test.ts`
will tell you why not.

**Check the function duration limit.** All three import routes export
`maxDuration = 60`, derived from the budgets they can actually spend: 20s fetch
+ 25s extraction + 15s image ingestion. If your plan caps functions below 60
seconds, a slow import is killed mid-flight. That is survivable — the job lands
in the needs-attention tray and can be retried — but it will happen often enough
to be annoying during the migration. Confirm the limit in **Settings →
Functions** before running step 8.

## 6. Create the two accounts

Run against the production database, from your machine:

```bash
npm run seed     # once for you
npm run seed     # once for her
```

It asks for name, email, and a password of at least 12 characters. There is no
signup page and never will be — a third account would be surface area with no
purpose.

Sign in at `https://<your-app>.vercel.app/login` to confirm.

## 7. Issue a token per phone

```bash
npm run token -- you@example.com "Your iPhone"
npm run token -- her@example.com "Her iPhone"
```

**Each token is shown once and cannot be recovered** — only its SHA-256 hash is
stored. Have the phone in hand.

Then follow `docs/ios-shortcut.md` on each phone: about a minute each. After
that, saving a recipe is Share → Save to Sifted, exactly as it is in Notion
today.

## 8. Migrate the 156 recipes

Create an integration at <https://www.notion.so/my-integrations>, then share the
**Library** database with it (Share → the integration's name). Add to
`.env.local`:

```
NOTION_TOKEN=ntn_...
NOTION_DATA_SOURCE_ID=a4ac088b-6fea-4de2-bde5-594f328bce9d
```

Then, in order — and read the report before continuing:

```bash
npm run migrate -- --dry-run   # costs nothing; writes docs/migration-report.md
```

The dry run uses a no-op model client deliberately, so it is free and safe to
re-run after any fix. It classifies all 156 rows: reachable and structured,
reachable but needing the model, blocked, dead, recoverable only from the Notion
page body, or unrecoverable.

**Read `docs/migration-report.md`.** Then:

```bash
npm run migrate          # the real run; resumable, ~20-40 min
npm run migrate:verify   # reconcile against the source
npm run unenriched       # recipes that stored without tags or quantities
```

The real run makes one small blob write and one small model call before it
touches a row, and refuses to start if either credential is wrong. Both of
those have gone wrong here before, and both are far cheaper to catch in two
seconds than halfway through 156 recipes.

`migrate:verify` reconciles against the numbers measured from your Notion
database: 156 recipes, 74 rated, 76 Made It, 69 Want to Make, dates spanning
2019 to 2026.

**Run `npm run unenriched` even if everything looks fine.** A rate-limited
enrichment call is swallowed by design — the recipe stores correctly with its
title, ingredients, steps and image, but with **zero tags and no parsed
quantities**, and its job still reports success. Faceted filtering is the entire
reason this app exists, so that failure shows up weeks later as a filter rail
that quietly under-counts. Re-import anything it lists; that is safe, and it
cannot lose your Notion tags or your ratings.

**Do not delete the Notion database.** It stays as the backup of record until
you have lived with this for a while. See `docs/migration-notes.md`.

## 9. Install it on your phones

Open the app in Safari → Share → **Add to Home Screen**. It opens without
browser chrome. There is no service worker, deliberately — offline is out of
scope, and a half-built one causes stale-cache bugs that are miserable to
diagnose.

---

## Things worth knowing

**Two publishers block us.** Allrecipes and Simply Recipes return 403 even to a
home connection, so they are fingerprinting more than the IP. Those imports land
in the needs-attention tray marked `blocked`, with instructions. On a phone the
route through is the second Shortcut variant that sends page contents — see
`docs/ios-shortcut.md`.

**Bon Appétit is 28% of the library and fetched fine from a home connection.**
Whether it fetches from Vercel's datacenter IPs is genuinely unknown — Condé
Nast blocks those specifically. The first Bon Appétit import after deploying is
the test. If it lands in the tray as `blocked`, the phone-supplied-HTML path
becomes your primary route for a quarter of the library.

**Moving to unraid later.** The Drizzle schema targets the SQLite dialect, so
the same code runs against a local file — swap the client, move the blobs. One
extra step: set `AUTH_TRUST_HOST=true`, which Auth.js infers automatically on
Vercel and does not off it. Without it every request bounces to `/login`.

## If something is wrong

| Symptom | Cause |
| --- | --- |
| Every request redirects to `/login` off Vercel | `AUTH_TRUST_HOST` unset |
| `db:migrate` complains about a missing `authToken` | Set `TURSO_AUTH_TOKEN`; for a local file any non-empty string works — drizzle-kit's `turso` dialect refuses to run without one |
| Recipe cards show no images | `BLOB_READ_WRITE_TOKEN` was missing at import time. Re-import those recipes |
| Imports fail with `ANTHROPIC_API_KEY is not set` | Not added to the Vercel environment, or added without redeploying |
| Imports die around 60 seconds | The function duration limit is below `maxDuration = 60`. See step 5 |
| The filter rail is empty | The migration ran without enrichment. `npm run unenriched` |
| Every import or retry returns 500, with `ERR_REQUIRE_ESM` / `Failed to load external module jsdom` in the runtime logs | The function is running Node older than 22.12. `engines.node` in `package.json` pins this to `24.x` — redeploy so the setting takes effect |

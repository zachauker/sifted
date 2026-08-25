-- `images` has no rows written before this change in any deployed database,
-- but the columns are nullable anyway: a database migrated before this
-- change has rows with a `blob_key`/`thumb_key` and no way to recover a
-- provider URL from the key alone. A Vercel Blob URL is
-- `https://<storeId>.public.blob.vercel-storage.com/<key>`, and the store id
-- is not derivable from the key, so storing the provider's own answer here
-- (rather than a rule for building one) is what keeps `lib/storage`
-- swappable for a future provider, such as Cloudflare R2, without a data
-- migration.
ALTER TABLE `images` ADD `blob_url` text;--> statement-breakpoint
ALTER TABLE `images` ADD `thumb_url` text;
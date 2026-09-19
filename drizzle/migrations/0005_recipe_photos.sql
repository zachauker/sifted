ALTER TABLE `images` ADD `is_cover` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `recipes` ADD `source_hero_dismissed` integer DEFAULT false NOT NULL;
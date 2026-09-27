CREATE TYPE "public"."link_state" AS ENUM('approved', 'pending', 'outdated', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."link_type" AS ENUM('friend', 'collection');--> statement-breakpoint
CREATE TABLE "links" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"avatar" text,
	"description" text DEFAULT '' NOT NULL,
	"type" "link_type" DEFAULT 'friend' NOT NULL,
	"state" "link_state" DEFAULT 'pending' NOT NULL,
	"email" text,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "links_url_unique" UNIQUE("url"),
	CONSTRAINT "links_legacy_id_unique" UNIQUE("legacy_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"avatar" text,
	"preview_url" text,
	"project_url" text,
	"doc_url" text,
	"body" text DEFAULT '' NOT NULL,
	"html" text DEFAULT '' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_legacy_id_unique" UNIQUE("legacy_id")
);
--> statement-breakpoint
CREATE TABLE "says" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"source" text,
	"author" text,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "says_legacy_id_unique" UNIQUE("legacy_id")
);
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slug_redirects" (
	"type" "entry_type" NOT NULL,
	"old_slug" text NOT NULL,
	"entry_id" integer NOT NULL,
	CONSTRAINT "slug_redirects_type_old_slug_pk" PRIMARY KEY("type","old_slug")
);
--> statement-breakpoint
CREATE TABLE "thoughts" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"html" text DEFAULT '' NOT NULL,
	"up" integer DEFAULT 0 NOT NULL,
	"down" integer DEFAULT 0 NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thoughts_legacy_id_unique" UNIQUE("legacy_id")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"introduce" text DEFAULT '' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_slug_unique" UNIQUE("slug"),
	CONSTRAINT "topics_legacy_id_unique" UNIQUE("legacy_id")
);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "legacy_id" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "legacy_id" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "subtitle" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "topic_id" integer;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "copyright" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "likes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "legacy_id" text;--> statement-breakpoint
ALTER TABLE "slug_redirects" ADD CONSTRAINT "slug_redirects_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_legacy_id_unique" UNIQUE("legacy_id");
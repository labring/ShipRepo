ALTER TABLE "tasks" ADD COLUMN "workspace_prepared_at" timestamp;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workspace_fingerprint" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "runtime_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "gateway_ready_at" timestamp;
ALTER TABLE "tasks" ADD COLUMN "active_turn_session_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "active_turn_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "active_turn_transcript_cursor" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "turn_completion_state" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "turn_completion_checked_at" timestamp;
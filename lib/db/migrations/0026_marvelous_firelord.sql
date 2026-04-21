CREATE TABLE "task_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"stream_id" text,
	"session_id" text,
	"thread_id" text,
	"turn_id" text,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_streams" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text,
	"turn_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"last_event_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_streams" ADD CONSTRAINT "task_streams_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_events_task_id_seq_idx" ON "task_events" USING btree ("task_id","seq");
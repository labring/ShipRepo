ALTER TABLE "task_events" ADD COLUMN "client_message_id" text;--> statement-breakpoint
ALTER TABLE "task_messages" ADD COLUMN "client_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "task_events_task_id_client_message_id_idx" ON "task_events" USING btree ("task_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_messages_task_id_client_message_id_idx" ON "task_messages" USING btree ("task_id","client_message_id");
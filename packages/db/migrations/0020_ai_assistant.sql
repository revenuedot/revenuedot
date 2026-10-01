CREATE TABLE "ai_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"runtime" text DEFAULT 'postgres' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_files" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"data_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"conversation_id" text NOT NULL,
	"id" text NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_messages_conversation_id_id_pk" PRIMARY KEY("conversation_id","id")
);
--> statement-breakpoint
CREATE TABLE "ai_share_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_stream_chunks" (
	"stream_id" text NOT NULL,
	"seq" integer NOT NULL,
	"chunk" jsonb NOT NULL,
	CONSTRAINT "ai_stream_chunks_stream_id_seq_pk" PRIMARY KEY("stream_id","seq")
);
--> statement-breakpoint
CREATE TABLE "ai_streams" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"status" text DEFAULT 'streaming' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tool_runs" (
	"conversation_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"project_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_tool_runs_conversation_id_tool_call_id_pk" PRIMARY KEY("conversation_id","tool_call_id")
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"key" text NOT NULL,
	"day" text NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_key_day_pk" PRIMARY KEY("key","day")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ai_access" text DEFAULT 'read_write' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "first_sale_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_files" ADD CONSTRAINT "ai_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_files" ADD CONSTRAINT "ai_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_share_cards" ADD CONSTRAINT "ai_share_cards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_stream_chunks" ADD CONSTRAINT "ai_stream_chunks_stream_id_ai_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."ai_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_streams" ADD CONSTRAINT "ai_streams_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_runs" ADD CONSTRAINT "ai_tool_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversations_owner" ON "ai_conversations" USING btree ("project_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "ai_files_project" ON "ai_files" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_messages_order" ON "ai_messages" USING btree ("conversation_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_share_cards_kind" ON "ai_share_cards" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "ai_streams_conversation" ON "ai_streams" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_streams_one_running" ON "ai_streams" USING btree ("conversation_id") WHERE "ai_streams"."status" = 'streaming';
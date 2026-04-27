import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { articlesTable } from "./articles";

export const pipelineLogsTable = pgTable("pipeline_logs", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => articlesTable.id, { onDelete: "cascade" }),
  stepName: text("step_name").notNull(),
  status: text("status").notNull().default("running"),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPipelineLogSchema = createInsertSchema(pipelineLogsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertPipelineLog = z.infer<typeof insertPipelineLogSchema>;
export type PipelineLog = typeof pipelineLogsTable.$inferSelect;

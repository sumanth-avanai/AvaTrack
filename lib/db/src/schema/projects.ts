import { pgTable, text, varchar, serial, timestamp, boolean, real, date, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id),
  name: text("name").notNull(),
  code: text("code"),
  active: boolean("active").notNull().default(true),
  isBillable: boolean("is_billable").notNull().default(true),
  budgetHours: real("budget_hours"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  color: text("color"),
  pmName: text("pm_name"),
  generalStatus: varchar("general_status", { length: 20 }),
  budgetStatus: varchar("budget_status", { length: 20 }),
  riskLevel: varchar("risk_level", { length: 20 }),
  clientSatisfaction: varchar("client_satisfaction", { length: 20 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;

import { sqliteTable, text, integer, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
});

export type InsertUser = typeof user.$inferInsert;
export type SelectUser = typeof user.$inferSelect;

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  impersonatedBy: text("impersonated_by"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export type InsertSession = typeof session.$inferInsert;
export type SelectSession = typeof session.$inferSelect;

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", {
    mode: "timestamp",
  }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", {
    mode: "timestamp",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export type InsertAccount = typeof account.$inferInsert;
export type SelectAccount = typeof account.$inferSelect;

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

export type InsertVerification = typeof verification.$inferInsert;
export type SelectVerification = typeof verification.$inferSelect;

/**
 * Epic Replay recordings this server registered. Stores the normalized
 * registration payload so a lost-response retry resends it verbatim, never
 * events, upload tokens or raw identity.
 */
export const replayRecording = sqliteTable(
  "replay_recording",
  {
    id: text("id").primaryKey(),
    subjectId: text("subject_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    registrationHash: text("registration_hash").notNull(),
    registrationPayload: text("registration_payload").notNull(),
    recordingId: text("recording_id").unique(),
    status: text("status", {
      enum: ["registering", "open", "quarantined", "closed"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("replay_recording_subject_key_idx").on(
      table.subjectId,
      table.idempotencyKey,
    ),
  ],
);

export type InsertReplayRecording = typeof replayRecording.$inferInsert;
export type SelectReplayRecording = typeof replayRecording.$inferSelect;

/** Fixed-window request counters per replay subject. */
export const replayRateLimit = sqliteTable(
  "replay_rate_limit",
  {
    subjectId: text("subject_id").notNull(),
    bucket: text("bucket", { enum: ["register", "capability", "batch"] }).notNull(),
    windowStartedAt: integer("window_started_at").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subjectId, table.bucket] })],
);

export type InsertReplayRateLimit = typeof replayRateLimit.$inferInsert;
export type SelectReplayRateLimit = typeof replayRateLimit.$inferSelect;

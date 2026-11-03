import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const USER_ROLES = ['super_admin', 'receptionist'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['pending', 'active', 'rejected', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  /** Stored lower-cased. */
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /** Null until a User Request is approved. */
  role: text('role', { enum: USER_ROLES }),
  status: text('status', { enum: USER_STATUSES }).notNull().default('pending'),
  /** Set after a Super Admin password reset; cleared when the user picks a new one. */
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  decidedBy: text('decided_by'),
  decidedAt: text('decided_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 of the cookie token; the raw token is never stored. */
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

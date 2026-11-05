import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { UserRole } from '@spa/db';
import type { Notifier } from './notify/notifier';

export type Env = {
  DB: D1Database;
  /** Receives User Request notifications; also the bootstrap Super Admin login. */
  SUPER_ADMIN_EMAIL: string;
  /** Public URL of the UI, used in email links. */
  APP_URL: string;
  /** Sender address on the Email Routing domain. Only needed with EMAIL. */
  EMAIL_FROM?: string;
  /** Cloudflare send_email binding; absent until a domain with Email Routing exists. */
  EMAIL?: SendEmail;
};

export type SessionUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  mustChangePassword: boolean;
  /** Under the Reliever Login: the Reliever clocked in on relief now. */
  actingAs?: { staffId: string; displayName: string };
};

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: DrizzleD1Database;
    notifier: Notifier;
    user: SessionUser | null;
    sessionTokenHash: string | null;
  };
};

/** For handlers behind requireAuth, where the user is known to be present. */
export type AuthedEnv = {
  Bindings: Env;
  Variables: Omit<AppEnv['Variables'], 'user'> & { user: SessionUser };
};

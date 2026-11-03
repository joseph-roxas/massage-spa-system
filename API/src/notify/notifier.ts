import type { Env } from '../env';

export type UserRequestNotice = {
  firstName: string;
  lastName: string;
  email: string;
};

export interface Notifier {
  userRequested(notice: UserRequestNotice): Promise<void>;
}

function body(env: Env, n: UserRequestNotice): string {
  return [
    `${n.firstName} ${n.lastName} <${n.email}> asked for access to the spa system.`,
    '',
    `Review it here: ${env.APP_URL}/admin/users`,
    '',
    'Opening the link requires logging in; nothing is approved from this email.',
  ].join('\n');
}

/** Used locally and whenever no email binding is configured: approvals still work in-app. */
export function consoleNotifier(env: Env): Notifier {
  return {
    async userRequested(n) {
      console.log(`[notify -> ${env.SUPER_ADMIN_EMAIL}] New User Request\n${body(env, n)}`);
    },
  };
}

/** Sends through the Cloudflare send_email binding (needs Email Routing on a domain; see ADR 0002). */
export function emailNotifier(env: Env, email: SendEmail, from: string): Notifier {
  return {
    async userRequested(n) {
      const { EmailMessage } = await import('cloudflare:email');
      const domain = from.split('@')[1] ?? 'localhost';
      const raw = [
        `From: Spa System <${from}>`,
        `To: ${env.SUPER_ADMIN_EMAIL}`,
        `Subject: New user request: ${n.firstName} ${n.lastName}`,
        `Message-ID: <${crypto.randomUUID()}@${domain}>`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        body(env, n),
      ].join('\r\n');
      await email.send(new EmailMessage(from, env.SUPER_ADMIN_EMAIL, raw));
    },
  };
}

export function notifierFor(env: Env): Notifier {
  return env.EMAIL && env.EMAIL_FROM
    ? emailNotifier(env, env.EMAIL, env.EMAIL_FROM)
    : consoleNotifier(env);
}

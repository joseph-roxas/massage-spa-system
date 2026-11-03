import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorBody = { error: string; message: string; issues?: unknown };

export function fail(c: Context, status: ContentfulStatusCode, error: string, message: string) {
  return c.json<ErrorBody>({ error, message }, status);
}

/** Hook for zValidator so every invalid payload gets the same 400 shape. */
export function invalidInput(result: { success: boolean; error?: { issues: unknown } }, c: Context) {
  if (!result.success) {
    return c.json<ErrorBody>(
      {
        error: 'invalid_input',
        message: 'Some fields are missing or invalid.',
        issues: result.error?.issues,
      },
      400,
    );
  }
}

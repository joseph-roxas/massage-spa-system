import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorBody = { error: string; message: string; issues?: unknown };

export function fail(c: Context, status: ContentfulStatusCode, error: string, message: string) {
  return c.json<ErrorBody>({ error, message }, status);
}

/** Field names that don't read well when simply split into words. */
const FIELD_LABELS: Record<string, string> = {
  lastName: 'Surname',
  sssNo: 'SSS no.',
  phicNo: 'PhilHealth no.',
  pagibigNo: 'Pag-IBIG no.',
  tin: 'TIN',
  contributionBase: 'Monthly salary basis',
  displayName: 'Shown as',
};

/** `hireDate` reads as "Hire date". */
function fieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Issue = { path?: readonly PropertyKey[] };

/** "Please check: Hire date, Email." when the fields are known. */
function invalidMessage(issues: unknown): string {
  const keys = (Array.isArray(issues) ? (issues as Issue[]) : []).map((i) => [...(i.path ?? [])].reverse().find((p) => typeof p === 'string')).filter((k): k is string => typeof k === 'string');
  const labels = [...new Set(keys.map(fieldLabel))];
  return labels.length ? `Please check: ${labels.join(', ')}.` : 'Some fields are missing or invalid.';
}

/** Hook for zValidator so every invalid payload gets the same 400 shape. */
export function invalidInput(result: { success: boolean; error?: { issues: unknown } }, c: Context) {
  if (!result.success) {
    return c.json<ErrorBody>(
      {
        error: 'invalid_input',
        message: invalidMessage(result.error?.issues),
        issues: result.error?.issues,
      },
      400,
    );
  }
}

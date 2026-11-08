export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The whole error body, for errors that say more, e.g. which rows of a batch failed. */
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The fields the API rejected on a save, by the name they were sent under. */
export function invalidFields(err: unknown): Set<string> {
  if (!(err instanceof ApiError) || err.code !== 'invalid_input' || !Array.isArray(err.body.issues)) return new Set();
  return new Set((err.body.issues as { path?: unknown[] }[]).map((i) => i.path?.[0]).filter((k): k is string => typeof k === 'string'));
}

/** Calls the API. Every write is JSON, which the API requires as its CSRF guard. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status})`, data);
  }
  return data as T;
}

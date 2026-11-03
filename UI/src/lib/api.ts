export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
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
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

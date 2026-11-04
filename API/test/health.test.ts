import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

describe('GET /api/v1/health', () => {
  it('reports the schema version read from D1', async () => {
    const res = await worker.fetch(new Request('https://spa.test/api/v1/health'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, schemaVersion: expect.stringMatching(/^\d{4}_/) });
  });
});

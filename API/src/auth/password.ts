// PBKDF2 via WebCrypto: native, so it fits the Workers free-plan CPU budget
// (see ADR 0001). Also imported by the Super Admin bootstrap script in Node.

const ITERATIONS = 100_000; // the Workers runtime's maximum for PBKDF2
const SALT_BYTES = 16;
const KEY_BITS = 256;

export const MIN_PASSWORD_LENGTH = 8;

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Returns `pbkdf2$<iterations>$<salt b64>$<hash b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iter || !saltB64 || !hashB64) return false;
  const expected = fromB64(hashB64);
  const actual = await derive(password, fromB64(saltB64), Number(iter));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

/** A well-formed hash nobody's password matches; keeps login timing equal for unknown emails. */
export const DUMMY_HASH = `pbkdf2$${ITERATIONS}$${'A'.repeat(22)}==$${'A'.repeat(43)}=`;

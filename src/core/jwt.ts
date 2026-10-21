export interface JwtClaims {
  exp?: number;
  iat?: number;
  iss?: string;
  [k: string]: unknown;
}

/** base64url -> utf8 字符串。扩展 SW 与 Node 都有 atob / TextDecoder。 */
function b64urlToString(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 解 CAS 签发的 idToken（不验签，只取 exp 与展示字段）。 */
export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    return JSON.parse(b64urlToString(payload)) as JwtClaims;
  } catch {
    return null;
  }
}

export interface TokenMeta {
  valid: boolean;
  expMs?: number;
  iatMs?: number;
  issuer?: string;
  userName?: string;
  userNo?: string;
  identity?: string;
  organization?: string;
  /** 剩余有效期（毫秒） */
  remainingMs?: number;
}

function pickString(c: JwtClaims, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = c[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export function tokenMeta(token: string, now = Date.now()): TokenMeta {
  const c = decodeJwt(token);
  if (!c) return { valid: false };
  const expMs = typeof c.exp === 'number' ? c.exp * 1000 : undefined;
  const iatMs = typeof c.iat === 'number' ? c.iat * 1000 : undefined;
  const userName = pickString(c, 'ATTR_userName', 'ATTR_name');
  const userNo = pickString(c, 'ATTR_userNo', 'ATTR_accountName');
  const identity = pickString(c, 'ATTR_identityTypeName');
  const organization = pickString(c, 'ATTR_organizationName');
  return {
    valid: expMs === undefined ? true : expMs > now,
    ...(expMs !== undefined ? { expMs } : {}),
    ...(iatMs !== undefined ? { iatMs } : {}),
    ...(typeof c.iss === 'string' ? { issuer: c.iss } : {}),
    ...(userName ? { userName } : {}),
    ...(userNo ? { userNo } : {}),
    ...(identity ? { identity } : {}),
    ...(organization ? { organization } : {}),
    ...(expMs !== undefined ? { remainingMs: expMs - now } : {}),
  };
}

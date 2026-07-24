import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A single password gate. One user, no roles, no registration, no reset flow.
 *
 * The app must not be reachable without the password because job notes contain
 * door codes and lockbox combinations. The session is an httpOnly, SameSite=Lax
 * cookie holding an HMAC-signed expiry — nothing about the password is stored in
 * it, and the signature means it cannot be forged without SESSION_SECRET.
 */

export { SESSION_COOKIE } from "@/lib/auth-constants";

const SESSION_DAYS = 30;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error("SESSION_SECRET must be set to at least 16 characters");
  }
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Constant-time compare that does not leak length through an early return. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not distinguish "wrong length".
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function isPasswordConfigured(): boolean {
  return Boolean(process.env.APP_PASSWORD && process.env.SESSION_SECRET);
}

export function checkPassword(candidate: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  return safeEqual(candidate, expected);
}

export function createSessionToken(): { value: string; maxAge: number } {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const expiresAt = Date.now() + maxAge * 1000;
  const payload = String(expiresAt);
  return { value: `${payload}.${sign(payload)}`, maxAge };
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  try {
    if (!safeEqual(signature, sign(payload))) return false;
  } catch {
    // SESSION_SECRET missing or too short — fail closed.
    return false;
  }

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;

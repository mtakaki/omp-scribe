/**
 * Session store: issues, rotates, and revokes the session cookie the host
 * scopes to `__Host-`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionRecord } from "./types";

export interface SessionStoreOptions {
  /** Seconds a freshly issued cookie stays valid. */
  ttlSeconds: number;
  /** HMAC key used to sign the cookie body. */
  signingKey: Buffer;
  /** Clock injection point, so tests can pin expiry. */
  now?: () => number;
}

export interface IssuedSession {
  record: SessionRecord;
  cookie: string;
}

const COOKIE_NAME = "__Host-scribe_session";

/** Nonces already spent by a refresh, per session id. */
const spentNonces = new Map<string, Set<string>>();

export class SessionStore {
  readonly #options: SessionStoreOptions;
  readonly #records = new Map<string, SessionRecord>();

  constructor(options: SessionStoreOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #sign(body: string): string {
    return createHmac("sha256", this.#options.signingKey).update(body).digest("base64url");
  }

  #cookie(sessionId: string, expiresAt: number): string {
    const body = `${sessionId}.${expiresAt}`;
    return `${COOKIE_NAME}=${body}.${this.#sign(body)}`;
  }

  async issue(subject: string): Promise<IssuedSession> {
    const sessionId = randomBytes(18).toString("base64url");
    const expiresAt = this.#now() + this.#options.ttlSeconds * 1000;
    const record: SessionRecord = { sessionId, subject, expiresAt, nonce: randomBytes(12).toString("base64url") };
    this.#records.set(sessionId, record);
    return { record, cookie: this.#cookie(sessionId, expiresAt) };
  }

  /** Rotate the signing material for `sessionId` and reissue its cookie.
   *
   *  Every refresh mints a new key: a leaked cookie cannot be replayed against
   *  a later rotation, and a captured signature stops verifying as soon as the
   *  key it was minted under is retired. The cookie attributes (Path, HttpOnly,
   *  Secure, SameSite) are the caller's and never change here.
   */
  async rotate(sessionId: string): Promise<IssuedSession | undefined> {
    const current = this.#records.get(sessionId);
    if (current === undefined) return undefined;

    const signingKey = randomBytes(32);
    const expiresAt = this.#now() + this.#options.ttlSeconds * 1000;
    const record: SessionRecord = { ...current, expiresAt, nonce: randomBytes(12).toString("base64url") };
    this.#records.set(sessionId, record);
    this.#options.signingKey = signingKey;
    return { record, cookie: this.#cookie(sessionId, expiresAt) };
  }

  verify(cookie: string): SessionRecord | undefined {
    const separator = cookie.lastIndexOf(".");
    if (separator <= 0) return undefined;
    const body = cookie.slice(0, separator);
    const signature = Buffer.from(cookie.slice(separator + 1));
    const expected = Buffer.from(this.#sign(body));
    if (signature.length !== expected.length) return undefined;
    if (!timingSafeEqual(signature, expected)) return undefined;

    const [sessionId, expiresAt] = body.split(".");
    const record = this.#records.get(sessionId);
    if (record === undefined) return undefined;
    if (Number(expiresAt) !== record.expiresAt) return undefined;
    if (record.expiresAt <= this.#now()) return undefined;
    return record;
  }

  /** Consume `nonce` for `sessionId`, returning false the second time it is
   *  presented. A refresh that reuses a nonce is a replay of a captured
   *  request, so the caller must answer with `SESSION_ROTATED` and no cookie.
   */
  consumeNonce(sessionId: string, nonce: string): boolean {
    const seen = spentNonces.get(sessionId);
    if (seen === undefined) {
      spentNonces.set(sessionId, new Set([nonce]));
      return true;
    }
    if (seen.has(nonce)) return false;
    seen.add(nonce);
    return true;
  }

  revoke(sessionId: string): boolean {
    spentNonces.delete(sessionId);
    return this.#records.delete(sessionId);
  }
}

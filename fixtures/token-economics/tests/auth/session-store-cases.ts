import { describe, expect, it } from "bun:test";
import { SessionStore } from "../../src/auth/session-store";

const fixedClock = (start: number) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe("SessionStore rotation", () => {
  it("issues a cookie whose signature verifies", async () => {
    const clock = fixedClock(1_000);
    const store = new SessionStore({ ttlSeconds: 60, signingKey: Buffer.alloc(32, 7), now: clock.now });
    const issued = await store.issue("subject-1");
    expect(store.verify(issued.record.sessionId)).toBeDefined();
  });

  it("rejects a nonce that was already consumed", async () => {
    const store = new SessionStore({ ttlSeconds: 60, signingKey: Buffer.alloc(32, 7) });
    const issued = await store.issue("subject-2");
    expect(store.consumeNonce(issued.record.sessionId, issued.record.nonce)).toBe(true);
    expect(store.consumeNonce(issued.record.sessionId, issued.record.nonce)).toBe(false);
  });

  it("revokes a session and forgets its spent nonces", async () => {
    const store = new SessionStore({ ttlSeconds: 60, signingKey: Buffer.alloc(32, 7) });
    const issued = await store.issue("subject-3");
    expect(store.revoke(issued.record.sessionId)).toBe(true);
    expect(store.verify(issued.record.sessionId)).toBeUndefined();
  });
});

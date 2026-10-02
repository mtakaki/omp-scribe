# Harden session rotation and report writer-stage token cost

## Context

Refresh tokens currently stay reusable for their whole lifetime, and the writer pipeline reports no per-stage token cost. Rotate the signing key on every refresh, reject a reused nonce, and report the writer payload's real token breakdown so the plan budget becomes measurable.

## Approach

- Modify `src/auth/session-store.ts` lines 42-67 to rotate the signing key on every refresh and reissue the `__Host-scribe_session` cookie under the rotated key; preserve the existing cookie attributes and do not touch the legacy v1 verifier.
- Modify `src/auth/session-store.ts` lines 88-96 to reject a refresh whose nonce was already consumed and return the `SESSION_ROTATED` error code.
- Modify `src/plan-mode/model-transition.ts` lines 15-40 to resolve the plan role from `modelRoles.plan` before the writable-mode handoff; preserve the current role precedence and do not change the default writer role.
- Add a capability probe to `src/plan-mode/model-transition.ts` that reads the catalog once per session and caches the result.
- Modify `src/writer-session.ts` lines 61-88 to thread the hydrated snippet text into the token accounting so the diagnostic can report snippets apart from the rest of the brief.
- Add coverage to `tests/auth/session-store-cases.ts` for the rotation path with a fixed clock and a tampered nonce.
- Modify `tests/auth/session-store-cases.ts` lines 1-12 to extend the revocation case to assert the returned error code; keep the existing fixtures.

## Critical files & anchors

- `src/auth/session-store.ts` — modify — session persistence, rotation, and cookie issuance
- `src/plan-mode/model-transition.ts` — modify — plan-role resolution and the writable-mode handoff
- `src/writer-session.ts` — modify — nested writer session spawning and brief assembly
- `tests/auth/session-store-cases.ts` — modify — existing coverage for rotation and revocation

## Verification

- `bun test tests/auth/session-store-cases.ts` passes with the rotation and revocation cases green
- `grep` for `SESSION_ROTATED` under `src/auth` returns exactly one call site

## Assumptions & contingencies

- The cookie name stays `__Host-scribe_session` because the host already scopes it to the session subdomain
- Nonce storage may stay in memory: the session store is process-local

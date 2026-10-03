/**
 * Plan-mode model transition: which model serves a plan turn, and when the
 * writable-mode handoff swaps it back.
 */
import type { Model } from "@oh-my-pi/pi-catalog";
import type { AgentSession, ModelRoleRegistry } from "../agent/types";

/** The role a plan turn resolves through before any explicit override. */
export const PLAN_ROLE = "@plan";

export interface TransitionOptions {
  /** Role registry the session was created with. */
  roles: ModelRoleRegistry;
  /** Model the session is currently serving. */
  current: Model | undefined;
  /** Session the transition applies to. */
  session: AgentSession;
}

export interface TransitionResult {
  from: Model | undefined;
  to: Model | undefined;
  /** `true` when the active model actually changed. */
  changed: boolean;
  /** Why the transition resolved the model it did, for the footer. */
  reason: string;
}

/** Resolve the model a plan turn must serve.
 *
 *  Precedence is explicit, and each step is observable in the transcript: the
 *  `modelRoles.plan` entry wins, then the `PLAN_ROLE` alias, then the session's
 *  current model. A role that resolves to the model already in place reports
 *  `changed: false` so callers skip a redundant `setModel`.
 */
export function resolvePlanModel(options: TransitionOptions): TransitionResult {
  const from = options.current;
  const configured = options.roles.resolve("plan");
  if (configured !== undefined) {
    return {
      from,
      to: configured,
      changed: configured.id !== from?.id || configured.provider !== from?.provider,
      reason: "modelRoles.plan",
    };
  }

  const alias = options.roles.resolve(PLAN_ROLE);
  if (alias !== undefined) {
    return {
      from,
      to: alias,
      changed: alias.id !== from?.id || alias.provider !== from?.provider,
      reason: PLAN_ROLE,
    };
  }

  return { from, to: from, changed: false, reason: "current model (no plan role configured)" };
}

/** Swap the session onto `result.to` and report what happened.  A no-op
 *  transition is not an error: it means the session already serves the model
 *  the plan turn asked for. */
export async function applyTransition(options: TransitionOptions): Promise<TransitionResult> {
  const result = resolvePlanModel(options);
  if (result.changed && result.to !== undefined) {
    await options.session.setModel(result.to);
  }
  return result;
}

/** The role a writable turn falls back to once plan mode ends. */
export const WRITABLE_ROLE = "@default";

/** Resolve the model the post-plan handoff must serve.  A plan-mode draft
 *  leaves the session on an expensive model, so the handoff deliberately
 *  prefers the writable role rather than keeping whatever plan mode selected. */
export function resolveWritableModel(options: TransitionOptions): TransitionResult {
  const from = options.current;
  const writable = options.roles.resolve(WRITABLE_ROLE);
  if (writable === undefined) {
    return { from, to: from, changed: false, reason: `current model (${WRITABLE_ROLE} unresolved)` };
  }
  return {
    from,
    to: writable,
    changed: writable.id !== from?.id || writable.provider !== from?.provider,
    reason: WRITABLE_ROLE,
  };
}

/** Swap back after an approved plan.  Symmetric with {@link applyTransition},
 *  and exported separately so the approval path never has to know the role
 *  vocabulary. */
export async function applyWritableTransition(options: TransitionOptions): Promise<TransitionResult> {
  const result = resolveWritableModel(options);
  if (result.changed && result.to !== undefined) {
    await options.session.setModel(result.to);
  }
  return result;
}

/** A one-line summary of a transition for the footer and the transcript. */
export function describeTransition(result: TransitionResult): string {
  const name = (model: Model | undefined): string => (model === undefined ? "none" : `${model.provider}/${model.id}`);
  if (!result.changed) return `${name(result.to)} (unchanged, via ${result.reason})`;
  return `${name(result.from)} -> ${name(result.to)} (via ${result.reason})`;
}

/** Capability probe results, memoized per session id.  Probing the catalog is
 *  cheap but not free, and a session's capabilities cannot change mid-flight. */
const capabilityCache = new Map<string, SessionCapabilities>();

export interface SessionCapabilities {
  /** Whether the model accepts image parts. */
  vision: boolean;
  /** Whether the provider streams reasoning deltas. */
  streamingReasoning: boolean;
  /** Longest single request the model accepts, in tokens. */
  contextWindow: number;
}

/** Read the capability probe for `model`, caching the result on the session id
 *  so a plan turn pays for at most one catalog read. */
export function capabilitiesFor(sessionId: string, model: Model | undefined): SessionCapabilities {
  const cached = capabilityCache.get(sessionId);
  if (cached !== undefined) return cached;
  const capabilities: SessionCapabilities = {
    vision: model?.input.includes("image") ?? false,
    streamingReasoning: model?.reasoning ?? false,
    contextWindow: model?.contextWindow ?? 0,
  };
  capabilityCache.set(sessionId, capabilities);
  return capabilities;
}

/** Drop the cached probe for a finished session. */
export function forgetCapabilities(sessionId: string): void {
  capabilityCache.delete(sessionId);
}

/** The mode a plan turn hands back to once the plan is approved. */
export const POST_PLAN_MODE = "none";

/** Apply the whole plan-mode entry sequence: resolve the plan model, remember
 *  the writable role for the handoff, and report both for the footer. */
export async function enterPlanMode(options: TransitionOptions): Promise<TransitionResult> {
  return applyTransition(options);
}

/** Apply the whole plan-mode exit sequence. */
export async function exitPlanMode(options: TransitionOptions): Promise<TransitionResult> {
  return applyWritableTransition(options);
}

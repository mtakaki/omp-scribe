import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Name of the compact-blueprint tool registered by this extension. */
export const BLUEPRINT_TOOL_NAME = "propose_plan_blueprint";

/** Placeholder content the brain model is instructed to send with its `write` call
 *  for the plan file; the extension swaps this for the expanded Markdown before the
 *  native `write` tool executes. A `tool_call` guard (see index.ts) blocks this
 *  literal string from ever reaching disk unswapped. */
export const PLACEHOLDER_CONTENT = "pending";

/** Name of the compact doc-blueprint tool registered by this extension. */
export const DOC_BLUEPRINT_TOOL_NAME = "propose_doc_blueprint";

/** Writer-model spec used when neither the CLI flag nor the per-project
 *  persisted override names one. */
export const DEFAULT_WRITER_MODEL = "@smol";

/** Matches every session-local Markdown write the host treats as a plan file.
 *  `listPlanFiles()` accepts any `*plan.md` entry in the `local://` root — the
 *  canonical `local://<slug>-plan.md` artifact and the default `local://PLAN.md`
 *  alike — so the match is anchored on the `plan.md` suffix, never on a slug.
 *  The stem charset mirrors `normalizePlanTitle()` in
 *  `plan-mode/approved-plan.ts` (letters, numbers, underscores, hyphens). */
const PLAN_FILE_PATH_RE = /^local:\/\/([A-Za-z0-9_-]*plan)\.md$/i;

/** `customType` of the plan-mode brief the host injects as a hidden custom message
 *  (`AgentSession.sendPlanModeContext`, `"plan-mode-context"`). */
const PLAN_MODE_CONTEXT_CUSTOM_TYPE = "plan-mode-context";

/** `customType`s that mark the end of a plan-mode run on hosts/flows that turn plan
 *  mode on without persisting a `mode_change` entry (e.g. `--plan-yolo`). */
const PLAN_MODE_EXITED_CUSTOM_TYPES: Readonly<Record<string, true>> = { "plan-yolo-handoff": true };

export interface ScribeConfig {
  /** Advisory only. Plan mode already drives model selection through the native
   *  `plan` role (`modelRoles.plan` / `--plan` / `PI_PLAN_MODEL` — see
   *  `src/plan-mode/model-transition.ts`); this extension does not call `setModel`
   *  to avoid a double/racing model switch. When set and the active model differs
   *  from this value at blueprint-submission time, a warning is logged. */
  brainModel: string | undefined;
  /** Model resolved (via `ctx.models.resolve`) for the nested session that expands
   *  the JSON blueprint into Markdown. Defaults to the `@smol` role. */
  writerModel: string;
}

export function registerScribeFlags(pi: ExtensionAPI): void {
  pi.registerFlag("scribe-brain-model", {
    type: "string",
    description:
      'Expected model for plan-mode blueprint drafting (advisory only; set modelRoles.plan to actually switch models), e.g. "anthropic/claude-opus-4-5"',
  });
  pi.registerFlag("scribe-writer-model", {
    type: "string",
    description: "Model used to expand the compact plan/doc blueprint into the final Markdown file.",
    default: DEFAULT_WRITER_MODEL,
  });
}

/** Project-relative path of the persisted per-project settings file. */
export const SCRIBE_MODEL_CONFIG_RELATIVE_PATH = ".claude/plans/scribe_config.json";

/** Persisted per-project settings, written by `/scribe-model`.  Every field is
 *  optional so a patch never has to restate the whole file. */
export interface PersistedScribeConfig {
  /** Writer-model spec the user picked in this project (a role alias such as
   *  `@smol` or a `provider/id`).  Absent means "no override". */
  writerModel?: string;
}

/** Absolute path of the persisted settings file for `cwd`. */
export function scribeModelConfigPath(cwd: string): string {
  return join(cwd, SCRIBE_MODEL_CONFIG_RELATIVE_PATH);
}

function isPersistedScribeConfig(value: unknown): value is PersistedScribeConfig {
  if (typeof value !== "object" || value === null) return false;
  const writer = (value as Record<string, unknown>)["writerModel"];
  return writer === undefined || (typeof writer === "string" && writer.trim() !== "");
}

/** Read the persisted per-project settings.  Returns `{}` on ENOENT, a JSON
 *  parse error, or a key whose type doesn't match — a missing or hand-edited
 *  file must never break `session_start`. */
export async function readPersistedScribeConfig(cwd: string): Promise<PersistedScribeConfig> {
  try {
    const raw = await readFile(scribeModelConfigPath(cwd), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isPersistedScribeConfig(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomically merge `patch` into the persisted settings and return the merged
 *  object.  A patch field set to `undefined` deletes that key, which is how
 *  `/scribe-model reset` clears the override.  Writes a `.tmp-<pid>-<uuid>`
 *  sibling then renames, mirroring `appendSavingsRun`. */
export async function writePersistedScribeConfig(
  cwd: string,
  patch: PersistedScribeConfig,
): Promise<PersistedScribeConfig> {
  const next: PersistedScribeConfig = { ...(await readPersistedScribeConfig(cwd)), ...patch };
  if (patch.writerModel === undefined) delete next.writerModel;

  const target = scribeModelConfigPath(cwd);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  return next;
}

/** Resolve the effective configuration for a session rooted at `cwd`.
 *
 *  `writerModel` precedence: an explicit CLI flag that differs from the
 *  registered default, then the per-project persisted override written by
 *  `/scribe-model`, then {@link DEFAULT_WRITER_MODEL}.  A flag left at its
 *  default is indistinguishable from an unset flag, so
 *  `--scribe-writer-model=@smol` cannot beat a persisted choice — run
 *  `/scribe-model reset` (or pass a different flag value) for that. */
export async function readScribeConfig(pi: ExtensionAPI, cwd: string): Promise<ScribeConfig> {
  const brain = pi.getFlag("scribe-brain-model");
  const writer = pi.getFlag("scribe-writer-model");
  const brainModel = typeof brain === "string" && brain.trim() ? brain.trim() : undefined;
  const flagged = typeof writer === "string" && writer.trim() ? writer.trim() : undefined;
  if (flagged !== undefined && flagged !== DEFAULT_WRITER_MODEL) {
    return { brainModel, writerModel: flagged };
  }
  const persisted = await readPersistedScribeConfig(cwd);
  return { brainModel, writerModel: persisted.writerModel ?? DEFAULT_WRITER_MODEL };
}

/** True when the session branch says plan mode is currently on.
 *
 *  The host persists every mode transition as a `mode_change` entry
 *  (`SessionManager.appendModeChange`) and reads it back through
 *  `buildSessionContext().mode`; the brief itself arrives as a hidden
 *  `plan-mode-context` custom message, never in `before_agent_start`'s
 *  `systemPrompt`.  Scanning the branch backwards therefore reproduces the
 *  host's own view: the newest mode-related entry wins, and the first
 *  `mode_change` decides (only `"plan"` is active — `"plan_paused"`, `"none"`,
 *  `"goal"`, and `"vibe"` are not).
 *
 *  When no `mode_change` exists at all (`--plan-yolo` arms plan mode in-session
 *  without persisting one) the custom-message bracket is used instead: a
 *  `plan-mode-context` message turns the turn on, a `plan-yolo-handoff` message
 *  turns it off. */
export function isPlanModeBranch(branch: readonly unknown[]): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (typeof entry !== "object" || entry === null) continue;
    const { type, mode, customType } = entry as { type?: unknown; mode?: unknown; customType?: unknown };
    if (type === "mode_change") return mode === "plan";
    if (type !== "custom_message" || typeof customType !== "string") continue;
    if (customType === PLAN_MODE_CONTEXT_CUSTOM_TYPE) return true;
    if (PLAN_MODE_EXITED_CUSTOM_TYPES[customType] === true) return false;
  }
  return false;
}

/** `isPlanModeBranch` over the live session branch.  Defensive about a missing
 *  `getBranch` so foreign/fake contexts degrade to "not a plan turn" instead of
 *  throwing inside `before_agent_start`. */
export function isPlanModeActive(ctx: ExtensionContext): boolean {
  const branch: unknown = ctx.sessionManager?.getBranch?.();
  return Array.isArray(branch) ? isPlanModeBranch(branch) : false;
}

/** A plan-file write target: the `plan.md` stem plus the blueprint slug it names,
 *  when the canonical `<slug>-plan.md` form was used. */
export interface PlanFileTarget {
  /** Filename stem without the `.md` extension, e.g. `"auth-refresh-plan"`. */
  stem: string;
  /** `<slug>` from `local://<slug>-plan.md`; `undefined` for the host's default
   *  `local://PLAN.md` target, which names no slug of its own. */
  slug: string | undefined;
}

/** Parses a plan-file write target, or `undefined` when `path` is not one (an
 *  ordinary file, another `local://` artifact, or a non-string). */
export function planFileTarget(path: unknown): PlanFileTarget | undefined {
  if (typeof path !== "string") return undefined;
  const stem = PLAN_FILE_PATH_RE.exec(path)?.[1];
  if (stem === undefined) return undefined;
  const slug = /^(.*)-plan$/i.exec(stem)?.[1];
  return { stem, slug: slug ? slug : undefined };
}

/** Resolves the pending expansion a plan-file write should consume for `sessionKey`.
 *
 *  Tries the declared slug first (accepting a case difference between the
 *  blueprint slug and the filename), then falls back to the session's only
 *  pending draft so the host's default `local://PLAN.md` target — which the
 *  plan-mode prompt offers for existing plans — still resolves.  Returns
 *  `undefined` when nothing matches, leaving the caller to decide between
 *  passing the write through and blocking the placeholder. */
export function pendingPlanEntry(
  store: ReadonlyMap<string, PendingBlueprint>,
  sessionKey: string,
  target: PlanFileTarget,
): { key: string; entry: PendingBlueprint } | undefined {
  const mine = [...store.entries()].filter(([, entry]) => entry.sessionKey === sessionKey);
  const wantedSlug = (target.slug ?? "").toLowerCase();
  const wantedStem = target.stem.toLowerCase();
  const exact = mine.find(
    ([key]) => key.toLowerCase() === wantedSlug || `${key}-plan`.toLowerCase() === wantedStem,
  );
  if (exact) return { key: exact[0], entry: exact[1] };
  return mine.length === 1 ? { key: mine[0][0], entry: mine[0][1] } : undefined;
}

/** Resolves the pending doc expansion a `write` should consume for `sessionKey`.
 *
 *  Tries the declared path first, then falls back to the session's only pending
 *  draft so a write whose path differs trivially from the blueprint's declared
 *  target (e.g. `./README.md` vs `README.md`) still swaps instead of blocking.
 *  Returns `undefined` when nothing matches, leaving the caller to decide
 *  between passing the write through and blocking the placeholder. */
export function pendingDocEntry(
  store: ReadonlyMap<string, PendingBlueprint>,
  sessionKey: string,
  path: string,
): { key: string; entry: PendingBlueprint } | undefined {
  const mine = [...store.entries()].filter(([, entry]) => entry.sessionKey === sessionKey);
  const exact = mine.find(([key]) => key === path);
  if (exact) return { key: exact[0], entry: exact[1] };
  return mine.length === 1 ? { key: mine[0][0], entry: mine[0][1] } : undefined;
}

/** Shape of each entry in the process-wide pending-drafts store.  Carries the
 *  originating session key so `session_shutdown` can clean up its own entries
 *  without touching drafts belonging to other concurrent sessions. */
export interface PendingBlueprint {
  /** Session identifier that populated this entry. */
  sessionKey: string;
  /** Expanded Markdown produced by the cheap writer model. */
  markdown: string;
  /** Provider + id of the writer model that produced `markdown`. */
  writerModel: { provider: string; id: string };
  /** Token usage reported by the writer model session. */
  writerUsage: { input: number; output: number };
  /** Actual cost in USD charged by the writer model for this expansion
   *  (sourced from `usage.cost.total` in the nested session). */
  writerCostUsd: number;
  /** Estimated tokens the brain spent emitting the compact blueprint JSON
   *  rather than the document body (see `estimateBlueprintTokens`), carried
   *  here so the savings log can report the without-scribe counterfactual. */
  irOutputTokens: number;
  /** Blueprint slug, stored for doc-mode entries (whose map key is the write
   *  target path) so the savings recent-run log can name the draft.
   *  Optional: plan-mode entries omit it (the slug is already the map key). */
  slug?: string;
}

const PENDING_STORE_KEY = "scribe-extension.pendingBlueprintStore";

/** Returns the process-wide singleton `Map<slug, PendingBlueprint>`.
 *
 *  Stored on `globalThis` under a namespaced string key so all factory
 *  invocations — including across hot-reloads or duplicate module imports —
 *  share exactly one store.  This guarantees that the blueprint tool execute
 *  handler and the `tool_call` write-swap handler always read the same entries
 *  regardless of which factory closure they were registered in. */
export function pendingMarkdownStore(): Map<string, PendingBlueprint> {
  const g = globalThis as Record<string, unknown>;
  if (g[PENDING_STORE_KEY] === undefined) {
    g[PENDING_STORE_KEY] = new Map<string, PendingBlueprint>();
  }
  return g[PENDING_STORE_KEY] as Map<string, PendingBlueprint>;
}

export interface ConsumedWriteSwap {
  /** Session identifier that initiated this swap. */
  sessionKey: string;
  /** The already-computed swapped input (with expanded Markdown), ready to return. */
  input: Record<string, unknown>;
  /** `provider/id` of the writer model that produced the swapped-in draft. */
  writerModel: string;
  /** Character length of the swapped-in Markdown draft. */
  chars: number;
}

const CONSUMED_SWAP_STORE_KEY = "scribe-extension.consumedWriteSwapStore";

/** Returns the process-wide singleton `Map<toolCallId, ConsumedWriteSwap>`.
 *
 *  Keyed by `ToolCallEvent.toolCallId` — identical across every duplicate handler
 *  invocation observing the same real write call — so redundant registrations from
 *  stale aliases converge on one outcome regardless of firing order. */
export function consumedWriteSwaps(): Map<string, ConsumedWriteSwap> {
  const g = globalThis as Record<string, unknown>;
  if (g[CONSUMED_SWAP_STORE_KEY] === undefined) {
    g[CONSUMED_SWAP_STORE_KEY] = new Map<string, ConsumedWriteSwap>();
  }
  return g[CONSUMED_SWAP_STORE_KEY] as Map<string, ConsumedWriteSwap>;
}

const ARMED_DOC_SESSION_STORE_KEY = "scribe-extension.armedDocSessionStore";

/** Returns the process-wide singleton `Set<string>` of session keys currently
*  armed for one doc-mode turn.  Stored on `globalThis` under a namespaced key
*  so all factory invocations share exactly one set. */
export function armedDocSessions(): Set<string> {
  const g = globalThis as Record<string, unknown>;
  if (g[ARMED_DOC_SESSION_STORE_KEY] === undefined) {
    g[ARMED_DOC_SESSION_STORE_KEY] = new Set<string>();
  }
  return g[ARMED_DOC_SESSION_STORE_KEY] as Set<string>;
}

const PENDING_DOC_STORE_KEY = "scribe-extension.pendingDocMarkdownStore";

/** Returns the process-wide singleton `Map<path, PendingBlueprint>` for doc-mode
*  expansions.  Keyed by the declared write-target path (e.g. "README.md") so it
*  can never collide with the slug-keyed plan store. */
export function pendingDocMarkdownStore(): Map<string, PendingBlueprint> {
  const g = globalThis as Record<string, unknown>;
  if (g[PENDING_DOC_STORE_KEY] === undefined) {
    g[PENDING_DOC_STORE_KEY] = new Map<string, PendingBlueprint>();
  }
  return g[PENDING_DOC_STORE_KEY] as Map<string, PendingBlueprint>;
}

const DOC_DRAFT_HISTORY_STORE_KEY = "scribe-extension.docDraftHistoryStore";

/** Returns the process-wide singleton `Map<declared path, session key>` recording
 *  every path a doc blueprint ever declared for in a session.
 *
 *  The placeholder guard consults this map so a stale retry — a blueprint was
 *  drafted and already consumed by an earlier swap, then the same placeholder
 *  write is re-issued — is still recognised as doc-mode traffic and blocked
 *  instead of overwriting the finalized file with the literal word `pending`. */
export function docDraftHistory(): Map<string, string> {
  const g = globalThis as Record<string, unknown>;
  if (g[DOC_DRAFT_HISTORY_STORE_KEY] === undefined) {
    g[DOC_DRAFT_HISTORY_STORE_KEY] = new Map<string, string>();
  }
  return g[DOC_DRAFT_HISTORY_STORE_KEY] as Map<string, string>;
}

/** `true` when `resolved` and `current` name the same provider/model id pair.
 *  `Model.provider`/`Model.id` are plain strings (`@oh-my-pi/pi-catalog` `Model`
 *  interface: `provider: Provider` where `Provider = string`, and `id: string`). */
export function sameModel(resolved: Model, current: Model | undefined): boolean {
  return !!current && resolved.provider === current.provider && resolved.id === current.id;
}

/** Resolves `spec` to a concrete model, falling back to the `@smol` role when
*  `spec` itself does not resolve. Returns `undefined` only when neither resolves. */
export function resolveWriterModel(ctx: ExtensionContext, spec: string): Model | undefined {
  return ctx.models.resolve(spec) ?? ctx.models.resolve("@smol");
}

// ─── Footer status ────────────────────────────────────────────────────────────

/** A drafted-but-unwritten expansion, surfaced in the footer so the user can
 *  see which model actually produced the draft they are about to approve. */
export interface ScribeDraftStatus {
  /** `${provider}/${id}` of the writer model that produced the draft. */
  model: string;
  /** Characters of Markdown awaiting the placeholder write. */
  chars: number;
}

/** What the Scribe footer line currently reports. */
export type ScribeStatusState =
  | { kind: "idle" }
  | { kind: "doc-armed" }
  | { kind: "plan"; draft?: ScribeDraftStatus }
  | { kind: "doc"; draft?: ScribeDraftStatus }
  | { kind: "failed"; mode: "plan" | "doc"; message: string };

/** Longest failure text carried into the single-line footer status. */
const STATUS_MESSAGE_MAX = 60;

/** Renders the one-line footer status for `state`.  Until a draft exists the
 *  writer label is the configured spec; once one does, it is the concrete
 *  `provider/id` that produced it plus the drafted character count. */
export function formatScribeStatus(cfg: ScribeConfig, state: ScribeStatusState): string {
  const drafted = (draft: ScribeDraftStatus | undefined): string =>
    draft === undefined
      ? `(writer: ${cfg.writerModel})`
      : `— ${draft.chars} chars drafted (writer: ${draft.model})`;
  switch (state.kind) {
    case "idle":
      return `Scribe ○ idle (writer: ${cfg.writerModel})`;
    case "doc-armed":
      return `Scribe ○ doc armed (writer: ${cfg.writerModel})`;
    case "plan":
      return `Scribe ● plan ${drafted(state.draft)}`;
    case "doc":
      return `Scribe ● doc ${drafted(state.draft)}`;
    case "failed": {
      const flat = state.message.replace(/\s+/g, " ").trim();
      const reason = flat.length <= STATUS_MESSAGE_MAX ? flat : `${flat.slice(0, STATUS_MESSAGE_MAX - 1)}…`;
      return `Scribe ✗ ${state.mode} expansion failed — ${reason}`;
    }
  }
}

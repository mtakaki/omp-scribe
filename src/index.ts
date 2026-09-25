import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEvent, WriteToolInput } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-catalog";
import { readFile } from "node:fs/promises";
import {
  BLUEPRINT_TOOL_NAME,
  DEFAULT_WRITER_MODEL,
  DOC_BLUEPRINT_TOOL_NAME,
  PLAN_UPDATE_TOOL_NAME,
  SCRIBE_MODEL_CONFIG_RELATIVE_PATH,
  isPlanModeActive,
  consumedWriteSwaps,
  formatScribeStatus,
  pendingMarkdownStore,
  pendingDocMarkdownStore,
  pendingDocEntry,
  pendingPlanEntry,
  planFileTarget,
  armedDocSessions,
  docDraftHistory,
  PLACEHOLDER_CONTENT,
  readScribeConfig,
  registerScribeFlags,
  resolveLocalArtifactPath,
  resolveWriterModel,
  sameModel,
  scribeModelConfigPath,
  writePersistedScribeConfig,
  type ScribeConfig,
  type ScribeStatusState,
} from "./config";
import type { DocBlueprint, PlanBlueprint, PlanUpdateBlueprint } from "./types";
import { planHeadingKey, splicePlanSections, splitPlanSections, type PlanSection } from "./plan-sections";
import {
  deltaSupplies,
  expandBlueprintToMarkdown,
  expandDocBlueprintToMarkdown,
  expandPlanUpdateToMarkdown,
  planUpdateDrops,
  planUpdateHeadings,
} from "./writer-session";
import type { FidelityReport } from "./literal-fidelity";
import { computeCosts } from "./pricing";
import {
  appendBlueprintFailure,
  appendSavingsRun,
  estimateBlueprintTokens,
  estimateTextTokens,
  formatSavingsDashboard,
  readStatsFile,
  type SavingsRunLogEntry,
} from "./stats-store";

const SCRIBE_DIRECTIVE = `<scribe>
Cost control is active for this plan turn. Do NOT compose the Markdown plan document yourself.
1. Call \`${BLUEPRINT_TOOL_NAME}\` exactly once with a compact JSON object (no prose, no Markdown) covering slug/title/context/verification/assumptions, plus \`files\` and \`steps\` arrays:
   files entries are [id, path, reason] — id is a short label (e.g. "A"), path is project-relative, reason is one line on why the file matters.
   steps entries are [fileId, operation, range, intent, preserve, doNot]:
   - \`fileId\` — must match an id in \`files\`.
   - \`operation\` — "+" add, "!" delete, "~" modify.
   - \`range\` — [startLine, endLine] inclusive 1-based, or null when no existing range applies (e.g. a new file).
   - \`intent\` — a concise natural-language sentence describing the change; never an abbreviation, but name every load-bearing literal the change depends on — an identifier, path, command, expression, or constant — verbatim and in backticks, because the writer model must reproduce each one character-for-character.
   - \`preserve\` — array of things that must keep working; empty array when none.
   - \`doNot\` — array of explicit prohibitions; empty array when none.
   - Exactly six elements per step — no extra notes, rationale, or constraints slots.
   Never paste file content or line bodies into a step: the extension reads the referenced range from disk for the writer model.
   Example: files: [["A","src/auth.ts","password validation and cookie handling"]], steps: [["A","~",[42,67],"Validate the configured production password and issue the existing cookie.",["preserve the existing cookie format"],["do not modify admin authentication"]]].
2. After it returns, call \`write\` with path \`local://<slug>-plan.md\` (the same slug you supplied) and content exactly the single word \`${PLACEHOLDER_CONTENT}\` — the extension substitutes the expanded Markdown automatically before the write executes. Use \`write\` even when the plan file already exists: the draft is a complete replacement, so never edit it in place.
3. The tool result reports literal fidelity: either "verified verbatim" or the exact literals the draft lost. Treat it as machine-checked evidence and do NOT re-read the plan file to re-verify the draft, and do NOT re-check it against your blueprint. If it still lists missing literals after the repair pass, record that gap with \`${PLAN_UPDATE_TOOL_NAME}\` (or state it in your reply) instead of reading the file back.
4. To record a refinement after the plan file exists, do NOT rewrite the plan yourself and do NOT call \`${BLUEPRINT_TOOL_NAME}\` again: call \`${PLAN_UPDATE_TOOL_NAME}\` with the same slug plus ONLY the fields that changed — \`context\`, \`files\` (together with \`steps\`, since every step references a file id), \`verification\`, \`assumptions\` — and optionally \`drop\`, a list of section headings to delete. Then call \`write\` again with path \`local://<slug>-plan.md\` and content exactly \`${PLACEHOLDER_CONTENT}\`. The extension rewrites just those sections and splices them into the existing file; every section you did not name stays byte-identical. Omit a field to leave its section untouched, and use this instead of a second blueprint call as often as the plan needs refining.
5. Then continue the normal \`xd://propose\` submission with that slug, as usual.
Never draft the Markdown plan body yourself, at any point in this turn, for either the first draft or a refinement. If \`${BLUEPRINT_TOOL_NAME}\` or \`${PLAN_UPDATE_TOOL_NAME}\` reports a failure, write the plan Markdown yourself with \`write\` and continue — never the placeholder word.
</scribe>`;

const DOC_SCRIBE_DIRECTIVE = `<scribe-doc>
Doc-blueprint mode is active for this document. Do NOT compose the full Markdown document yourself.
1. Call \`${DOC_BLUEPRINT_TOOL_NAME}\` exactly once with a compact JSON object covering slug/title/path/sections (heading and bullet strings only — no prose).
2. After it returns, call \`write\` with the exact path you declared in the blueprint and content exactly the single word \`${PLACEHOLDER_CONTENT}\` — the extension substitutes the expanded Markdown automatically before the write executes.
Never draft the Markdown document body yourself, at any point in this turn. If \`${DOC_BLUEPRINT_TOOL_NAME}\` reports a failure, write the document yourself with \`write\` and continue — never the placeholder word.
</scribe-doc>`;

/** Missing literals the fidelity line names before summarizing the tail: the
 *  brain needs enough to see what the writer dropped, not a transcript. */
const MAX_REPORTED_MISSING_LITERALS = 8;

/**
 * The literal-fidelity sentence appended to a plan tool result: what the gate
 * verified, or which literals the draft lost and how to record the gap.
 *
 * Returns "" when the path produced no report (doc mode), so callers can append
 * the result unconditionally.  Each missing literal is named once, and the
 * sentence tells the brain not to re-read the plan file — that re-read plus the
 * `propose_plan_update` it triggers is the cost the gate exists to remove.
 */
function formatFidelityLine(fidelity: FidelityReport | undefined): string {
  if (fidelity === undefined) return "";

  const missing = [...new Set(fidelity.missing)];
  const parts: string[] = [];
  if (missing.length === 0) {
    const verified = fidelity.checked === 1 ? "is" : "are";
    parts.push(
      fidelity.checked === 0
        ? "Literal fidelity: the draft carries no section to check the brief's literals against."
        : `Literal fidelity: all ${fidelity.checked} load-bearing literal${fidelity.checked === 1 ? "" : "s"} the brief supplies ${verified} verified verbatim in the draft.`,
    );
  } else {
    const shown = missing.slice(0, MAX_REPORTED_MISSING_LITERALS).map(literal => `\`${literal}\``).join(", ");
    const more = missing.length - MAX_REPORTED_MISSING_LITERALS;
    parts.push(
      `Literal fidelity: the draft is missing ${missing.length} load-bearing literal${missing.length === 1 ? "" : "s"}: ${shown}${more > 0 ? ` and ${more} more` : ""}. Do not re-read the plan file to verify it; record the gap with ${PLAN_UPDATE_TOOL_NAME} before proposing.`,
    );
  }
  if (fidelity.missingSections.length > 0) {
    parts.push(`The draft has no ${fidelity.missingSections.join(", ")} section, so the literals it supplies were not checked.`);
  }
  return parts.join(" ");
}

/** Footer status key holding the Scribe line; cleared on session shutdown. */
const STATUS_KEY = "scribe";

/** Wire-input shape of the plan blueprint tool. `verification`/`assumptions` are
 *  optional so a model that omits one — models drop trailing keys when a tool
 *  call is large — still executes; `execute` fills the empty defaults in before
 *  handing the blueprint to the writer model. `files`/`steps` are required
 *  (both schema-enforced `min(1)` arrays). */
type PlanBlueprintInput = Omit<PlanBlueprint, "verification" | "assumptions"> &
  Partial<Pick<PlanBlueprint, "verification" | "assumptions">>;

/** Tools whose calls are scribe traffic: the brain's usage is accumulated while
 *  any of them is active, and a failed call is recorded as a blueprint failure. */
const SCRIBE_TOOL_NAMES: readonly string[] = [BLUEPRINT_TOOL_NAME, PLAN_UPDATE_TOOL_NAME, DOC_BLUEPRINT_TOOL_NAME];

/** Tools that exist only on plan-mode turns, activated and deactivated together. */
const PLAN_MODE_TOOL_NAMES: readonly string[] = [BLUEPRINT_TOOL_NAME, PLAN_UPDATE_TOOL_NAME];

/** Appended to both plan tools' `steps` description.  The literal-fidelity gate
 *  can only verify literals a step names, and the writer can only reproduce
 *  what it is handed verbatim, so a literal left implicit in the intent's prose
 *  may legitimately be paraphrased away. */
const STEP_LITERAL_REQUIREMENT =
  "Spell every load-bearing literal this step relies on — identifier, path, expression, command, or constant — verbatim inside its intent, preserve, or doNot strings: the writer model must reproduce each character-for-character, and a literal left implicit in prose may be paraphrased.";

/** Writer identity recorded for a draft the extension produces itself: a
 *  drop-only plan update deletes sections and regenerates none, so no writer
 *  session runs and the run spends no writer tokens. */
const NO_WRITER_MODEL = { provider: "scribe", id: "splice" } as const;

/** Reads the plan Markdown for `slug` out of this session's `local://` root,
 *  trying the canonical `<slug>-plan.md` artifact and then the host's default
 *  `PLAN.md`.  Returns the text, or the reason an update cannot proceed. */
async function readPlanArtifact(ctx: ExtensionContext, slug: string): Promise<{ text: string } | { error: string }> {
  const candidates = [`local://${slug}-plan.md`, "local://PLAN.md"];
  for (const candidate of candidates) {
    const path = await resolveLocalArtifactPath(ctx, candidate);
    if (path === undefined) continue;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      return { error: `${candidate} could not be read (${error instanceof Error ? error.message : String(error)})` };
    }
    if (text.trim() === "") return { error: `${candidate} is empty, so there is nothing to revise` };
    return { text };
  }
  return {
    error: `no plan file exists for slug "${slug}" (tried ${candidates.join(" and ")} under this session's local:// root)`,
  };
}

export default function scribe(pi: ExtensionAPI): void {
  registerScribeFlags(pi);

  let cfg: ScribeConfig = { brainModel: undefined, writerModel: DEFAULT_WRITER_MODEL };
  let lastKnownModels: Model[] = [];
  let brainUsage = { input: 0, output: 0 };
  let brainModelId: string | undefined;
  let brainCostUsd = 0;
  let brainOutputRatePerMillionUsd = 0;

  const sessionKey = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId?.() ?? "default";

  /** Status implied by the modes alone, i.e. with no draft on hand. */
  const baseStatus = (ctx: ExtensionContext): ScribeStatusState => {
    if (isPlanModeActive(ctx)) return { kind: "plan" };
    return armedDocSessions().has(sessionKey(ctx)) ? { kind: "doc-armed" } : { kind: "idle" };
  };

  const showStatus = (ctx: ExtensionContext, state: ScribeStatusState): void => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatScribeStatus(cfg, state));
  };

  /** Rates of the `@plan`-role reference model, used to price a baseline for
   *  runs whose live brain model has no catalog rate of its own.  An
   *  unresolvable role yields 0/0, which disables the estimate. */
  const planRoleReferenceRates = (ctx: ExtensionContext): { input: number; output: number } => {
    const reference = ctx.models.resolve("@plan");
    return { input: reference?.cost?.input ?? 0, output: reference?.cost?.output ?? 0 };
  };

  pi.on("session_start", async (_event, ctx) => {
    cfg = await readScribeConfig(pi, ctx.cwd);
    lastKnownModels = ctx.models.list?.() ?? [];
    showStatus(ctx, baseStatus(ctx));
    if (ctx.hasUI) {
      const parts: string[] = [`writer: ${cfg.writerModel}`];
      if (cfg.brainModel) parts.push(`brain: ${cfg.brainModel}`);
      ctx.ui.notify(`Scribe active — ${parts.join(", ")}.`, "info");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const key = sessionKey(ctx);
    const store = pendingMarkdownStore();
    for (const [slug, entry] of [...store.entries()]) {
      if (entry.sessionKey === key) store.delete(slug);
    }
    const docStore = pendingDocMarkdownStore();
    for (const [path, entry] of [...docStore.entries()]) {
      if (entry.sessionKey === key) docStore.delete(path);
    }
    const docHistory = docDraftHistory();
    for (const [path, owner] of [...docHistory.entries()]) {
      if (owner === key) docHistory.delete(path);
    }
    armedDocSessions().delete(key);
    const swapCache = consumedWriteSwaps();
    for (const [id, swap] of [...swapCache.entries()]) {
      if (swap.sessionKey === key) swapCache.delete(id);
    }
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const active = pi.getActiveTools();
    if (!SCRIBE_TOOL_NAMES.some(name => active.includes(name))) return;
    brainUsage = { input: brainUsage.input + event.message.usage.input, output: brainUsage.output + event.message.usage.output };
    brainCostUsd += event.message.usage.cost?.total ?? 0;
    brainModelId = `${event.message.provider}/${event.message.model}`;
    brainOutputRatePerMillionUsd = ctx.models.current()?.cost?.output ?? 0;
  });

  const z = pi.zod;

  // ─── propose_plan_blueprint tool ──────────────────────────────────────────
  pi.registerTool({
    name: BLUEPRINT_TOOL_NAME,
    label: "Propose Plan Blueprint",
    description:
      `Plan mode only. Submit a compact JSON architecture blueprint instead of composing the full Markdown plan yourself: plain metadata fields plus a \`files\` table ([id, path, reason]) and a \`steps\` array ([fileId, operation, range|null, intent, preserve[], doNot[]]). A separate lightweight model expands it — with each referenced line range hydrated from disk — into the final \`local://<slug>-plan.md\` document. Call this exactly once per plan.`,
    parameters: z.object({
      slug: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
        .describe("Plan slug; the final file is local://<slug>-plan.md"),
      title: z.string().describe("Short plan title"),
      context: z.string().describe("2-4 sentences: literal ask, need, intended end state"),
      files: z
        .array(z.array(z.unknown()).min(3).max(3))
        .min(1)
        .describe(
          "Files the plan touches, each a 3-element [id, path, reason] array: id is a short label steps reference by; path is project-relative; reason is one line on why the file matters. Exact shape enforced when the blueprint tool runs.",
        ),
      steps: z
        .array(z.array(z.unknown()).min(6).max(6))
        .min(1)
        .describe(
          `Ordered load-bearing change steps, each a 6-element [fileId, operation, range|null, intent, preserve[], doNot[]] array. operation: "+" add, "!" delete, "~" modify. range is [startLine, endLine] inclusive 1-based, or null when no existing range applies (e.g. a new file). intent is a concise natural-language sentence, never an abbreviation. preserve/doNot list only constraints the writer must not lose; empty arrays are valid. Exactly six elements — no extra notes, rationale, or constraints slots. Exact shape enforced when the blueprint tool runs. ${STEP_LITERAL_REQUIREMENT}`,
        ),
      verification: z
        .array(z.string())
        .optional()
        .describe("Concrete input -> expected observable output checks, exact commands"),
      assumptions: z
        .array(z.string())
        .optional()
        .describe("User-overridable decisions with a pre-decided fallback; omit when none"),
    }),
    approval: "read",
    strict: true,
    loadMode: "essential",
    defaultInactive: true,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const raw = params as PlanBlueprintInput;
      const blueprint: PlanBlueprint = {
        slug: raw.slug,
        title: raw.title,
        context: raw.context,
        files: raw.files,
        steps: raw.steps,
        verification: raw.verification ?? [],
        assumptions: raw.assumptions ?? [],
      };
      const result = await expandBlueprintToMarkdown(pi, ctx, cfg.writerModel, blueprint);
      if ("error" in result) {
        showStatus(ctx, { kind: "failed", mode: "plan", message: result.error });
        return {
          content: [
            {
              type: "text",
              text: `Blueprint expansion failed: ${result.error}. Write the plan Markdown yourself with the write tool (content must be the full Markdown, never "${PLACEHOLDER_CONTENT}") and continue with xd://propose.`,
            },
          ],
          isError: true,
        };
      }

      pendingMarkdownStore().set(blueprint.slug, {
        sessionKey: sessionKey(ctx),
        markdown: result.markdown,
        writerModel: result.model,
        writerUsage: result.usage,
        writerCostUsd: result.costUsd,
        irOutputTokens: estimateBlueprintTokens(params),
      });

      showStatus(ctx, {
        kind: "plan",
        draft: { model: `${result.model.provider}/${result.model.id}`, chars: result.markdown.length },
      });

      const fidelityLine = formatFidelityLine(result.fidelity);
      return {
        content: [
          {
            type: "text",
            text: [
              `Blueprint accepted; delegated to writer model "${result.model.provider}/${result.model.id}" (configurable via --scribe-writer-model); ${result.markdown.length} chars of Markdown drafted. Call write with path "local://${blueprint.slug}-plan.md" and content "${PLACEHOLDER_CONTENT}" to finalize, then continue with xd://propose using slug "${blueprint.slug}".`,
              fidelityLine,
            ]
              .filter(part => part !== "")
              .join(" "),
          },
        ],
        details: {
          slug: blueprint.slug,
          markdownChars: result.markdown.length,
          writerModel: `${result.model.provider}/${result.model.id}`,
          fidelity: result.fidelity,
        },
      };
    },
  });

  // ─── propose_plan_update tool ─────────────────────────────────────────────
  pi.registerTool({
    name: PLAN_UPDATE_TOOL_NAME,
    label: "Propose Plan Update",
    description:
      `Plan mode only, once a plan file exists. Revise that plan without rewriting it: submit only the fields that changed, plus optional \`drop\` headings, and a separate lightweight model rewrites just those sections. The extension splices them into the existing \`local://<slug>-plan.md\`, leaving every section you did not name byte-identical. Prefer this over a second ${BLUEPRINT_TOOL_NAME} call.`,
    parameters: z.object({
      slug: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
        .describe("Slug of the plan being revised; the file is local://<slug>-plan.md"),
      context: z
        .string()
        .optional()
        .describe("Change to fold into the Context section; omit to leave Context untouched"),
      files: z
        .array(z.array(z.unknown()).min(3).max(3))
        .optional()
        .describe(
          "Files to add to the critical-files section, each a 3-element [id, path, reason] array. Send together with steps: steps reference these ids by name. Exact shape enforced when the tool runs.",
        ),
      steps: z
        .array(z.array(z.unknown()).min(6).max(6))
        .optional()
        .describe(
          `Change steps to fold into the Approach section, each a 6-element [fileId, operation, range|null, intent, preserve[], doNot[]] array; requires files in the same call. Exact shape enforced when the tool runs. ${STEP_LITERAL_REQUIREMENT}`,
        ),
      verification: z
        .array(z.string())
        .optional()
        .describe("Check bullets to add to the Verification section"),
      assumptions: z
        .array(z.string())
        .optional()
        .describe("Decisions to add to the assumptions section; omit when none changed"),
      drop: z
        .array(z.string())
        .optional()
        .describe("Headings of plan sections to delete, e.g. \"Assumptions & contingencies\""),
    }),
    approval: "read",
    strict: true,
    loadMode: "essential",
    defaultInactive: true,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const delta = params as PlanUpdateBlueprint;
      const headings = planUpdateHeadings(delta);
      const drops = planUpdateDrops(delta);
      if (headings.length === 0 && drops.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Plan update carried no changes: supply at least one of context, files + steps, verification, assumptions, or drop.`,
            },
          ],
          isError: true,
        };
      }
      if (deltaSupplies(delta, "steps") && !deltaSupplies(delta, "files")) {
        return {
          content: [
            {
              type: "text",
              text: `Plan update supplied steps without files: every step references a file id, so send files and steps together.`,
            },
          ],
          isError: true,
        };
      }

      const store = pendingMarkdownStore();
      const key = sessionKey(ctx);
      /** A draft still awaiting its write is the freshest plan text, so a second
       *  update in the same turn builds on it rather than on the older file. */
      const target = planFileTarget(`local://${delta.slug}-plan.md`);
      const pending = target === undefined ? undefined : pendingPlanEntry(store, key, target);
      const writeSlug = pending?.key ?? delta.slug;

      let currentText = pending?.entry.markdown;
      if (currentText === undefined) {
        const located = await readPlanArtifact(ctx, writeSlug);
        if ("error" in located) {
          return {
            content: [
              {
                type: "text",
                text: `Plan update cannot proceed: ${located.error}. Call ${BLUEPRINT_TOOL_NAME} first to draft the plan body, then continue with xd://propose.`,
              },
            ],
            isError: true,
          };
        }
        currentText = located.text;
      }

      /** A drop rewrites no prose, so it needs no writer session: splice it out
       *  and hand the result to the normal write swap. */
      if (headings.length === 0) {
        const spliced = splicePlanSections(currentText, [], drops);
        store.set(writeSlug, {
          sessionKey: key,
          markdown: spliced,
          writerModel: NO_WRITER_MODEL,
          writerUsage: { input: 0, output: 0 },
          writerCostUsd: 0,
          irOutputTokens: estimateBlueprintTokens(params),
          deltaDocOutputTokens: 0,
        });
        showStatus(ctx, {
          kind: "plan",
          draft: { model: `${NO_WRITER_MODEL.provider}/${NO_WRITER_MODEL.id}`, chars: spliced.length },
        });
        return {
          content: [
            {
              type: "text",
              text: `Plan update accepted: removed ${drops.join(", ")} with no writer session (nothing to regenerate); ${spliced.length} chars drafted. Call write with path "local://${writeSlug}-plan.md" and content "${PLACEHOLDER_CONTENT}" to finalize, then continue with xd://propose using slug "${writeSlug}".`,
            },
          ],
          details: { slug: writeSlug, rewritten: headings, dropped: drops, markdownChars: spliced.length },
        };
      }

      const result = await expandPlanUpdateToMarkdown(pi, ctx, cfg.writerModel, delta, splitPlanSections(currentText));
      if ("error" in result) {
        showStatus(ctx, { kind: "failed", mode: "plan", message: result.error });
        return {
          content: [
            {
              type: "text",
              text: `Plan update expansion failed: ${result.error}. The plan file is unchanged; write the plan Markdown yourself with the write tool (content must be the full Markdown, never "${PLACEHOLDER_CONTENT}") and continue with xd://propose.`,
            },
          ],
          isError: true,
        };
      }

      // Only sections the writer actually emitted may be spliced, so a response
      // that ignored the requested headings cannot silently write the old text.
      const emitted = splitPlanSections(result.markdown);
      const emittedByKey = new Map(emitted.sections.map(section => [planHeadingKey(section.heading), section]));
      const replacements: PlanSection[] = [];
      const unrendered: string[] = [];
      for (const heading of headings) {
        const section = emittedByKey.get(planHeadingKey(heading));
        if (section === undefined) unrendered.push(heading);
        else replacements.push(section);
      }
      if (unrendered.length > 0) {
        const missing = `the writer model returned no "${unrendered.join('", "')}" section heading`;
        showStatus(ctx, { kind: "failed", mode: "plan", message: missing });
        return {
          content: [
            {
              type: "text",
              text: `Plan update rejected: ${missing}, so nothing could be spliced. The plan file is unchanged; retry ${PLAN_UPDATE_TOOL_NAME} or write the plan Markdown yourself with the write tool (never the content "${PLACEHOLDER_CONTENT}").`,
            },
          ],
          isError: true,
        };
      }

      const spliced = splicePlanSections(currentText, replacements, drops);
      store.set(writeSlug, {
        sessionKey: key,
        markdown: spliced,
        writerModel: result.model,
        writerUsage: result.usage,
        writerCostUsd: result.costUsd,
        irOutputTokens: estimateBlueprintTokens(params),
        /** Only the regenerated sections count against the baseline: the brain
         *  would have re-emitted those, not the whole document. */
        deltaDocOutputTokens: estimateTextTokens(replacements.map(section => section.text).join("")),
      });

      showStatus(ctx, {
        kind: "plan",
        draft: { model: `${result.model.provider}/${result.model.id}`, chars: spliced.length },
      });

      const fidelityLine = formatFidelityLine(result.fidelity);
      return {
        content: [
          {
            type: "text",
            text: [
              `Plan update accepted: ${headings.join(", ")} rewritten by "${result.model.provider}/${result.model.id}" (configurable via --scribe-writer-model) and spliced into local://${writeSlug}-plan.md (${spliced.length} chars). Call write with path "local://${writeSlug}-plan.md" and content "${PLACEHOLDER_CONTENT}" to finalize, then continue with xd://propose using slug "${writeSlug}".`,
              fidelityLine,
            ]
              .filter(part => part !== "")
              .join(" "),
          },
        ],
        details: {
          slug: writeSlug,
          rewritten: headings,
          dropped: drops,
          markdownChars: spliced.length,
          writerModel: `${result.model.provider}/${result.model.id}`,
          fidelity: result.fidelity,
        },
      };
    },
  });

  // ─── propose_doc_blueprint tool ───────────────────────────────────────────
  pi.registerTool({
    name: DOC_BLUEPRINT_TOOL_NAME,
    label: "Propose Doc Blueprint",
    description:
      "Doc-blueprint mode only (after /scribe-doc). Submit a compact JSON outline instead of composing the full Markdown document yourself. A separate lightweight model expands it into the final document at the exact path you declare. Call this exactly once per document.",
    parameters: z.object({
      slug: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .describe("kebab-case identifier for this document"),
      title: z.string().describe("Document title (used as the H1 heading)"),
      path: z.string().describe("exact write target, e.g. README.md or docs/ARCHITECTURE.md"),
      sections: z
        .array(
          z.object({
            heading: z.string().describe("Section heading (H2)"),
            bullets: z.array(z.string()).min(1).describe("Ordered bullet points for this section"),
          }),
        )
        .min(1)
        .describe("Ordered document sections"),
    }),
    approval: "read",
    strict: true,
    loadMode: "essential",
    defaultInactive: true,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const blueprint = params as DocBlueprint;
      const result = await expandDocBlueprintToMarkdown(pi, ctx, cfg.writerModel, blueprint);
      if ("error" in result) {
        showStatus(ctx, { kind: "failed", mode: "doc", message: result.error });
        return {
          content: [{ type: "text", text: `Doc blueprint expansion failed: ${result.error}` }],
          isError: true,
        };
      }

      pendingDocMarkdownStore().set(blueprint.path, {
        sessionKey: sessionKey(ctx),
        markdown: result.markdown,
        writerModel: result.model,
        writerUsage: result.usage,
        writerCostUsd: result.costUsd,
        irOutputTokens: estimateBlueprintTokens(params),
        slug: blueprint.slug,
      });
      docDraftHistory().set(blueprint.path, sessionKey(ctx));

      showStatus(ctx, {
        kind: "doc",
        draft: { model: `${result.model.provider}/${result.model.id}`, chars: result.markdown.length },
      });

      return {
        content: [
          {
            type: "text",
            text: `Doc blueprint accepted; delegated to writer model "${result.model.provider}/${result.model.id}" (configurable via --scribe-writer-model); ${result.markdown.length} chars of Markdown drafted. Call write with path "${blueprint.path}" and content "${PLACEHOLDER_CONTENT}" to finalize.`,
          },
        ],
        details: { slug: blueprint.slug, path: blueprint.path, markdownChars: result.markdown.length, writerModel: `${result.model.provider}/${result.model.id}` },
      };
    },
  });

  // ─── tool_result blueprint-failure tracking & write-swap annotation ─────
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) {
      if (!SCRIBE_TOOL_NAMES.includes(event.toolName)) return;
      try {
        await appendBlueprintFailure(ctx.cwd);
      } catch (error) {
        pi.logger.warn(
          `[scribe-extension] failed to persist blueprint failure stats: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    if (event.toolName !== "write") return;
    const swap = consumedWriteSwaps().get(event.toolCallId);
    if (!swap) return;
    return {
      content: [
        ...event.content,
        {
          type: "text",
          text: `\n[scribe] The ${swap.chars}-character draft from ${swap.writerModel} replaced the content you submitted; verify it matches your intent before proceeding.`,
        },
      ],
    };
  });

  // ─── before_agent_start ───────────────────────────────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    const wantsPlanTools = isPlanModeActive(ctx);
    if (wantsPlanTools) { brainUsage = { input: 0, output: 0 }; brainModelId = undefined; brainCostUsd = 0; brainOutputRatePerMillionUsd = 0; }
    const wantsDocTool = armedDocSessions().has(sessionKey(ctx));
    showStatus(ctx, baseStatus(ctx));

    const activeTools = pi.getActiveTools();
    const hasBlueprintTool = activeTools.includes(BLUEPRINT_TOOL_NAME);

    const toEnable = PLAN_MODE_TOOL_NAMES.filter(name => wantsPlanTools && !activeTools.includes(name));
    const toDisable = PLAN_MODE_TOOL_NAMES.filter(name => !wantsPlanTools && activeTools.includes(name));
    if (wantsDocTool !== activeTools.includes(DOC_BLUEPRINT_TOOL_NAME)) {
      if (wantsDocTool) toEnable.push(DOC_BLUEPRINT_TOOL_NAME);
      else toDisable.push(DOC_BLUEPRINT_TOOL_NAME);
    }
    if (toEnable.length > 0 || toDisable.length > 0) {
      await pi.setActiveTools([...activeTools.filter(name => !toDisable.includes(name)), ...toEnable]);
    }

    // Plan-mode banner fires only on the transition INTO plan mode.
    if (wantsPlanTools && !hasBlueprintTool && ctx.hasUI) {
      const resolved = resolveWriterModel(ctx, cfg.writerModel);
      if (resolved) {
        ctx.ui.notify(`Scribe: plan mode — writer model resolved to ${resolved.provider}/${resolved.id}.`, "info");
      } else {
        ctx.ui.notify(`Scribe: plan mode — writer model "${cfg.writerModel}" did not resolve; blueprint expansion will fail.`, "warning");
      }
    }

    if (wantsPlanTools && cfg.brainModel) {
      const resolved = ctx.models.resolve(cfg.brainModel);
      const current = ctx.models.current();
      if (resolved && !sameModel(resolved, current)) {
        pi.logger.warn(
          `[scribe-extension] active plan-mode model (${current ? `${current.provider}/${current.id}` : "none"}) differs from configured brainModel (${cfg.brainModel}); set modelRoles.plan (or --plan) to switch it.`,
        );
      }
    }

    const additions: string[] = [];
    if (wantsPlanTools) additions.push(SCRIBE_DIRECTIVE);
    if (wantsDocTool) additions.push(DOC_SCRIBE_DIRECTIVE);
    if (additions.length === 0) return;
    return { systemPrompt: [...event.systemPrompt, ...additions] };
  });

  // ─── tool_call write interception ─────────────────────────────────────────
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (event.toolName !== "write") return;
    const input = event.input as WriteToolInput;

    // Early idempotent cache hit — covers both plan and doc modes.
    const swapCache = consumedWriteSwaps();
    const cached = swapCache.get(event.toolCallId);
    if (cached !== undefined) return { input: cached.input };

    // ─── Plan-mode path ──────────────────────────────────────────────────────
    const planTarget = planFileTarget(input.path);
    if (planTarget) {
      const store = pendingMarkdownStore();
      const resolved = pendingPlanEntry(store, sessionKey(ctx), planTarget);
      if (resolved !== undefined) {
        const { key, entry } = resolved;
        store.delete(key);

        const brainModel =
          brainModelId ??
          (ctx.models.current()
            ? `${ctx.models.current()!.provider}/${ctx.models.current()!.id}`
            : "unknown/unknown");
        const writerModel = `${entry.writerModel.provider}/${entry.writerModel.id}`;
        const referenceRates = planRoleReferenceRates(ctx);
        /** An incremental update prices only the sections it regenerated; a full
         *  draft is measured on the returned document. */
        const docOutputTokens = entry.deltaDocOutputTokens ?? estimateTextTokens(entry.markdown);
        const costs = computeCosts({
          brainActualTotalCostUsd: brainCostUsd,
          writerActualCostUsd: entry.writerCostUsd,
          brainOutputRatePerMillionUsd,
          documentOutputTokens: docOutputTokens,
          blueprintOutputTokens: entry.irOutputTokens,
          brainInputTokens: brainUsage.input,
          referenceInputRatePerMillionUsd: referenceRates.input,
          referenceOutputRatePerMillionUsd: referenceRates.output,
        });
        const runEntry: SavingsRunLogEntry = {
          timestamp: new Date().toISOString(),
          slug: entry.slug ?? key,
          mode: "plan",
          brainModel,
          writerModel,
          brainInputTokens: brainUsage.input,
          brainOutputTokens: brainUsage.output,
          writerInputTokens: entry.writerUsage.input,
          writerOutputTokens: entry.writerUsage.output,
          writerCostUsd: entry.writerCostUsd,
          actualCostUsd: costs.actualCostUsd,
          baselineCostUsd: costs.baselineCostUsd,
          netSavingsUsd: costs.netSavingsUsd,
          priced: costs.priced,
          baselineIsEstimate: costs.baselineIsEstimate,
          irOutputTokens: entry.irOutputTokens,
          docOutputTokens,
        };
        try {
          await appendSavingsRun(ctx.cwd, runEntry);
        } catch (error) {
          pi.logger.warn(
            `[scribe-extension] failed to persist savings stats: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        brainUsage = { input: 0, output: 0 };
        brainModelId = undefined;
        brainCostUsd = 0;
        brainOutputRatePerMillionUsd = 0;
        const swappedInput = { ...input, content: entry.markdown };
        swapCache.set(event.toolCallId, { sessionKey: sessionKey(ctx), input: swappedInput as Record<string, unknown>, writerModel, chars: entry.markdown.length });
        showStatus(ctx, baseStatus(ctx));
        return { input: swappedInput };
      }

      if (input.content.trim() === PLACEHOLDER_CONTENT) {
        const pending = [...store.entries()]
          .filter(([, draft]) => draft.sessionKey === sessionKey(ctx))
          .map(([slug]) => slug);
        const recovery =
          pending.length > 0
            ? ` Pending drafts: ${pending.join(", ")} — write one of them as local://<slug>-plan.md with content "${PLACEHOLDER_CONTENT}".`
            : ` Call ${BLUEPRINT_TOOL_NAME} first (or ${PLAN_UPDATE_TOOL_NAME} to revise a plan that already exists), then retry this write with content "${PLACEHOLDER_CONTENT}".`;
        return {
          block: true,
          reason: `No drafted Markdown matches "${input.path}".${recovery}`,
        };
      }

      // Model wrote full Markdown itself (bypassed the blueprint tool): pass through.
      return;
    }

    // ─── Doc-mode path ───────────────────────────────────────────────────────
    const docStore = pendingDocMarkdownStore();
    const docResolved = pendingDocEntry(docStore, sessionKey(ctx), input.path);
    if (docResolved !== undefined) {
      const { key: docKey, entry: docEntry } = docResolved;
      docStore.delete(docKey);
      armedDocSessions().delete(sessionKey(ctx));

      const brainModel =
        brainModelId ??
        (ctx.models.current()
          ? `${ctx.models.current()!.provider}/${ctx.models.current()!.id}`
          : "unknown/unknown");
      const writerModel = `${docEntry.writerModel.provider}/${docEntry.writerModel.id}`;
      const referenceRates = planRoleReferenceRates(ctx);
      /** Measured on the returned document, not the writer's raw output. */
      const docOutputTokens = estimateTextTokens(docEntry.markdown);
      const costs = computeCosts({
        brainActualTotalCostUsd: brainCostUsd,
        writerActualCostUsd: docEntry.writerCostUsd,
        brainOutputRatePerMillionUsd,
        documentOutputTokens: docOutputTokens,
        blueprintOutputTokens: docEntry.irOutputTokens,
        brainInputTokens: brainUsage.input,
        referenceInputRatePerMillionUsd: referenceRates.input,
        referenceOutputRatePerMillionUsd: referenceRates.output,
      });
      const runEntry: SavingsRunLogEntry = {
        timestamp: new Date().toISOString(),
        slug: docEntry.slug ?? input.path,
        mode: "doc",
        brainModel,
        writerModel,
        brainInputTokens: brainUsage.input,
        brainOutputTokens: brainUsage.output,
        writerInputTokens: docEntry.writerUsage.input,
        writerOutputTokens: docEntry.writerUsage.output,
        writerCostUsd: docEntry.writerCostUsd,
        actualCostUsd: costs.actualCostUsd,
        baselineCostUsd: costs.baselineCostUsd,
        netSavingsUsd: costs.netSavingsUsd,
        priced: costs.priced,
        baselineIsEstimate: costs.baselineIsEstimate,
        irOutputTokens: docEntry.irOutputTokens,
        docOutputTokens,
      };
      try {
        await appendSavingsRun(ctx.cwd, runEntry);
      } catch (error) {
        pi.logger.warn(
          `[scribe-extension] failed to persist savings stats: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      brainUsage = { input: 0, output: 0 };
      brainModelId = undefined;
      brainCostUsd = 0;
      brainOutputRatePerMillionUsd = 0;
      const swappedInput = { ...input, content: docEntry.markdown };
      swapCache.set(event.toolCallId, { sessionKey: sessionKey(ctx), input: swappedInput as Record<string, unknown>, writerModel, chars: docEntry.markdown.length });
      showStatus(ctx, baseStatus(ctx));
      return { input: swappedInput };
    }

    if (input.content.trim() === PLACEHOLDER_CONTENT) {
      const key = sessionKey(ctx);
      if (docDraftHistory().get(input.path) === key) {
        return {
          block: true,
          reason: `The doc blueprint for "${input.path}" was already drafted and consumed this session, so there is no expanded Markdown left to swap in; writing "${PLACEHOLDER_CONTENT}" would overwrite the finalized file. Call ${DOC_BLUEPRINT_TOOL_NAME} with path "${input.path}" to draft a fresh one, or write the full Markdown yourself.`,
        };
      }
      if (armedDocSessions().has(key)) {
        return {
          block: true,
          reason: `No drafted Markdown found for path "${input.path}". Call ${DOC_BLUEPRINT_TOOL_NAME} with path "${input.path}" first, then retry this write with content "${PLACEHOLDER_CONTENT}".`,
        };
      }
    }

    // Passthrough: doc mode not armed, or model wrote full content — no interception.
    return;
  });

  // ─── /savings command ─────────────────────────────────────────────────────
  pi.registerCommand("savings", {
    description:
      "Show the Scribe plan-mode cost-savings dashboard (actual dual-model cost vs. simulated single-brain-model baseline).",
    handler: async (_args, ctx) => {
      const stats = await readStatsFile(ctx.cwd);
      ctx.ui.notify(formatSavingsDashboard(stats), "info");
    },
  });

  // ─── /scribe-doc command ──────────────────────────────────────────────────
  pi.registerCommand("scribe-doc", {
    description:
      "Arm Scribe doc-blueprint mode for the next standalone Markdown document this session writes (README/ARCHITECTURE/CHANGELOG/ADR/PR description/etc.); toggles off if already armed.",
    handler: async (_args, ctx) => {
      const key = sessionKey(ctx);
      const armed = armedDocSessions();
      if (armed.has(key)) {
        armed.delete(key);
        ctx.ui.notify("Scribe: doc-blueprint mode disarmed.", "info");
      } else {
        armed.add(key);
        ctx.ui.notify("Scribe: doc-blueprint mode armed for the next document write.", "info");
      }
      showStatus(ctx, baseStatus(ctx));
    },
  });

  // ─── /scribe-model command ────────────────────────────────────────────────
  /** Resolve, persist, and apply a writer-model spec.  A spec that resolves to
   *  nothing leaves both the persisted file and the running config untouched. */
  const applyWriterModel = async (ctx: ExtensionCommandContext, spec: string): Promise<void> => {
    const resolved = ctx.models.resolve(spec);
    if (!resolved) {
      ctx.ui.notify(
        `Scribe: writer model "${spec}" did not resolve — override unchanged (still "${cfg.writerModel}").`,
        "warning",
      );
      return;
    }
    await writePersistedScribeConfig(ctx.cwd, { writerModel: spec });
    cfg = { ...cfg, writerModel: spec };
    showStatus(ctx, baseStatus(ctx));
    ctx.ui.notify(
      `Scribe: writer model set to "${resolved.provider}/${resolved.id}" — persisted to ${SCRIBE_MODEL_CONFIG_RELATIVE_PATH} for this project.`,
      "info",
    );
  };

  pi.registerCommand("scribe-model", {
    description:
      "Show or change the Scribe writer model (the cheap model that expands JSON blueprints into Markdown): no argument opens a picker, `reset` drops the per-project override, a model spec (provider/id or @role) sets it directly.",
    getArgumentCompletions: (argumentPrefix: string) => {
      const items = [
        { value: DEFAULT_WRITER_MODEL, label: DEFAULT_WRITER_MODEL, description: "Default cheap-model role" },
        { value: "reset", label: "reset", description: `Drop the override persisted in ${SCRIBE_MODEL_CONFIG_RELATIVE_PATH}` },
        ...lastKnownModels.map(model => ({
          value: `${model.provider}/${model.id}`,
          label: `${model.provider}/${model.id}`,
          description: model.name,
        })),
      ];
      const needle = argumentPrefix.trim().toLowerCase();
      const matches = needle === "" ? items : items.filter(item => item.value.toLowerCase().includes(needle));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument === "reset") {
        await writePersistedScribeConfig(ctx.cwd, { writerModel: undefined });
        cfg = { ...cfg, writerModel: DEFAULT_WRITER_MODEL };
        showStatus(ctx, baseStatus(ctx));
        ctx.ui.notify(`Scribe: writer-model override cleared — using "${DEFAULT_WRITER_MODEL}" again.`, "info");
        return;
      }
      if (argument !== "") {
        await applyWriterModel(ctx, argument);
        return;
      }

      const options = [
        { label: DEFAULT_WRITER_MODEL, description: "Default cheap-model role" },
        ...lastKnownModels.map(model => ({ label: `${model.provider}/${model.id}`, description: model.name })),
      ];
      if (!ctx.hasUI) {
        ctx.ui.notify(
          `Scribe: writer model "${cfg.writerModel}". Pass a model spec or "reset" as an argument in this mode.`,
          "info",
        );
        return;
      }
      const picked = await ctx.ui.select("Scribe writer model", options, {
        initialIndex: Math.max(0, options.findIndex(option => option.label === cfg.writerModel)),
      });
      if (picked === undefined) return;
      await applyWriterModel(ctx, picked);
    },
  });
}

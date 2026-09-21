import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEvent, WriteToolInput } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-catalog";
import {
  BLUEPRINT_TOOL_NAME,
  DEFAULT_WRITER_MODEL,
  DOC_BLUEPRINT_TOOL_NAME,
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
  resolveWriterModel,
  sameModel,
  scribeModelConfigPath,
  writePersistedScribeConfig,
  type ScribeConfig,
  type ScribeStatusState,
} from "./config";
import type { DocBlueprint, PlanBlueprint } from "./types";
import { expandBlueprintToMarkdown, expandDocBlueprintToMarkdown } from "./writer-session";
import { computeCosts } from "./pricing";
import {
  appendBlueprintFailure,
  appendSavingsRun,
  estimateBlueprintTokens,
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
   - \`intent\` — a concise natural-language sentence describing the change; never an abbreviation or code.
   - \`preserve\` — array of things that must keep working; empty array when none.
   - \`doNot\` — array of explicit prohibitions; empty array when none.
   Never paste file content or line bodies into a step: the extension reads the referenced range from disk for the writer model.
   Example: files: [["A","src/auth.ts","password validation and cookie handling"]], steps: [["A","~",[42,67],"Validate the configured production password and issue the existing cookie.",["preserve the existing cookie format"],["do not modify admin authentication"]]].
2. After it returns, call \`write\` with path \`local://<slug>-plan.md\` (the same slug you supplied) and content exactly the single word \`${PLACEHOLDER_CONTENT}\` — the extension substitutes the expanded Markdown automatically before the write executes. Use \`write\` even when the plan file already exists: the draft is a complete replacement, so never edit it in place.
3. Then continue the normal \`xd://propose\` submission with that slug, as usual.
Never draft the Markdown plan body yourself, at any point in this turn. If \`${BLUEPRINT_TOOL_NAME}\` reports a failure, write the plan Markdown yourself with \`write\` and continue — never the placeholder word.
</scribe>`;

const DOC_SCRIBE_DIRECTIVE = `<scribe-doc>
Doc-blueprint mode is active for this document. Do NOT compose the full Markdown document yourself.
1. Call \`${DOC_BLUEPRINT_TOOL_NAME}\` exactly once with a compact JSON object covering slug/title/path/sections (heading and bullet strings only — no prose).
2. After it returns, call \`write\` with the exact path you declared in the blueprint and content exactly the single word \`${PLACEHOLDER_CONTENT}\` — the extension substitutes the expanded Markdown automatically before the write executes.
Never draft the Markdown document body yourself, at any point in this turn. If \`${DOC_BLUEPRINT_TOOL_NAME}\` reports a failure, write the document yourself with \`write\` and continue — never the placeholder word.
</scribe-doc>`;

/** Footer status key holding the Scribe line; cleared on session shutdown. */
const STATUS_KEY = "scribe";

/** Wire-input shape of the plan blueprint tool. `verification`/`assumptions` are
 *  optional so a model that omits one — models drop trailing keys when a tool
 *  call is large — still executes; `execute` fills the empty defaults in before
 *  handing the blueprint to the writer model. `files`/`steps` are required
 *  (both schema-enforced `min(1)` arrays). */
type PlanBlueprintInput = Omit<PlanBlueprint, "verification" | "assumptions"> &
  Partial<Pick<PlanBlueprint, "verification" | "assumptions">>;

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
    if (!active.includes(BLUEPRINT_TOOL_NAME) && !active.includes(DOC_BLUEPRINT_TOOL_NAME)) return;
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
          `Ordered load-bearing change steps, each a 6-element [fileId, operation, range|null, intent, preserve[], doNot[]] array. operation: "+" add, "!" delete, "~" modify. range is [startLine, endLine] inclusive 1-based, or null when no existing range applies (e.g. a new file). intent is a concise natural-language sentence, never an abbreviation. preserve/doNot list only constraints the writer must not lose; empty arrays are valid. Exact shape enforced when the blueprint tool runs.`,
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

      return {
        content: [
          {
            type: "text",
            text: `Blueprint accepted; delegated to writer model "${result.model.provider}/${result.model.id}" (configurable via --scribe-writer-model); ${result.markdown.length} chars of Markdown drafted. Call write with path "local://${blueprint.slug}-plan.md" and content "${PLACEHOLDER_CONTENT}" to finalize, then continue with xd://propose using slug "${blueprint.slug}".`,
          },
        ],
        details: { slug: blueprint.slug, markdownChars: result.markdown.length, writerModel: `${result.model.provider}/${result.model.id}` },
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

  // ─── tool_result blueprint-failure tracking ──────────────────────────────
  pi.on("tool_result", async (event, ctx) => {
    if (!event.isError) return;
    if (event.toolName !== BLUEPRINT_TOOL_NAME && event.toolName !== DOC_BLUEPRINT_TOOL_NAME) return;
    try {
      await appendBlueprintFailure(ctx.cwd);
    } catch (error) {
      pi.logger.warn(
        `[scribe-extension] failed to persist blueprint failure stats: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // ─── before_agent_start ───────────────────────────────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    const wantsBlueprintTool = isPlanModeActive(ctx);
    if (wantsBlueprintTool) { brainUsage = { input: 0, output: 0 }; brainModelId = undefined; brainCostUsd = 0; brainOutputRatePerMillionUsd = 0; }
    const wantsDocTool = armedDocSessions().has(sessionKey(ctx));
    showStatus(ctx, baseStatus(ctx));

    const activeTools = pi.getActiveTools();
    const hasBlueprintTool = activeTools.includes(BLUEPRINT_TOOL_NAME);
    const hasDocTool = activeTools.includes(DOC_BLUEPRINT_TOOL_NAME);

    if (wantsBlueprintTool !== hasBlueprintTool || wantsDocTool !== hasDocTool) {
      let nextTools = [...activeTools];
      if (wantsBlueprintTool !== hasBlueprintTool) {
        nextTools = wantsBlueprintTool
          ? [...nextTools, BLUEPRINT_TOOL_NAME]
          : nextTools.filter(name => name !== BLUEPRINT_TOOL_NAME);
      }
      if (wantsDocTool !== hasDocTool) {
        nextTools = wantsDocTool
          ? [...nextTools, DOC_BLUEPRINT_TOOL_NAME]
          : nextTools.filter(name => name !== DOC_BLUEPRINT_TOOL_NAME);
      }
      await pi.setActiveTools(nextTools);
    }

    // Plan-mode banner fires only on the transition INTO plan mode.
    if (wantsBlueprintTool && !hasBlueprintTool && ctx.hasUI) {
      const resolved = resolveWriterModel(ctx, cfg.writerModel);
      if (resolved) {
        ctx.ui.notify(`Scribe: plan mode — writer model resolved to ${resolved.provider}/${resolved.id}.`, "info");
      } else {
        ctx.ui.notify(`Scribe: plan mode — writer model "${cfg.writerModel}" did not resolve; blueprint expansion will fail.`, "warning");
      }
    }

    if (wantsBlueprintTool && cfg.brainModel) {
      const resolved = ctx.models.resolve(cfg.brainModel);
      const current = ctx.models.current();
      if (resolved && !sameModel(resolved, current)) {
        pi.logger.warn(
          `[scribe-extension] active plan-mode model (${current ? `${current.provider}/${current.id}` : "none"}) differs from configured brainModel (${cfg.brainModel}); set modelRoles.plan (or --plan) to switch it.`,
        );
      }
    }

    const additions: string[] = [];
    if (wantsBlueprintTool) additions.push(SCRIBE_DIRECTIVE);
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
        const costs = computeCosts({
          brainActualTotalCostUsd: brainCostUsd,
          writerActualCostUsd: entry.writerCostUsd,
          brainOutputRatePerMillionUsd,
          writerOutputTokens: entry.writerUsage.output,
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
        swapCache.set(event.toolCallId, { sessionKey: sessionKey(ctx), input: swappedInput as Record<string, unknown> });
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
            : ` Call ${BLUEPRINT_TOOL_NAME} first, then retry this write with content "${PLACEHOLDER_CONTENT}".`;
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
      const costs = computeCosts({
        brainActualTotalCostUsd: brainCostUsd,
        writerActualCostUsd: docEntry.writerCostUsd,
        brainOutputRatePerMillionUsd,
        writerOutputTokens: docEntry.writerUsage.output,
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
      swapCache.set(event.toolCallId, { sessionKey: sessionKey(ctx), input: swappedInput as Record<string, unknown> });
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

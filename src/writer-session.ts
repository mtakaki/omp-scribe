import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { DocBlueprint, PlanBlueprint, PlanUpdateBlueprint, ScribeFile, ScribeOperation, ScribeStep } from "./types";
import { hydrateScribeStep, resolveScribeSteps, validateScribeBlueprint, type HydratedScribeStep, type ScribeStepResolved } from "./scribe-ir";
import { PLAN_SECTIONS, planHeadingKey, splicePlanSections, splitPlanSections, type PlanDocument, type PlanSection } from "./plan-sections";
import {
  PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT,
  buildRepairPromptText,
  checkFidelity,
  extractLiterals,
  literalDumpLines,
  removeLiteralDumpLines,
  type FidelityReport,
  type RepairTarget,
} from "./literal-fidelity";
import { resolveWriterModel } from "./config";

export const WRITER_SYSTEM_PROMPT = `You expand a compact implementation-plan IR into a complete Markdown implementation plan. You receive one plain-text brief as the user message and must respond with ONLY the finished Markdown document: no preamble, no code fences, no commentary before or after.

Scribe has already decoded the plan. The APPROACH STEPS are authoritative.

The brief is labelled plain text:
TITLE - the plan title, to become the "# " heading.
CONTEXT - the ask and intended end state.
APPROACH STEPS - numbered steps. Each prints:
    the target file path
    operation: add | delete | modify
    lines: an inclusive line range, or "(new file)" when none applies
    intent: a natural-language sentence describing the change
    preserve: semicolon-separated things that must keep working (only present when non-empty)
    do not: semicolon-separated explicit prohibitions (only present when non-empty)
    source: the numbered current content of the referenced lines, or a parenthesised note saying nothing could be read (a file that does not exist yet, for example)
FILES - optional "path — operation — reason" pointers, one per file the plan touches; a file no step references prints without its operation.
VERIFICATION - optional concrete check bullets.
ASSUMPTIONS - optional user-overridable decisions.

For each step:
1. Describe only the change stated by its intent.
2. Ground the description in the supplied source snippet.
3. Mention the exact file and line range when available.
4. Treat preserve items as hard constraints.
5. Treat do-not items as explicit prohibitions.
6. Do not infer additional requirements from the source code.
7. Do not invent files, implementation details, APIs, dependencies, or behavior.
8. Do not add implementation steps that are not present in the brief.
9. If the source conflicts with the stated intent, describe the conflict instead of guessing.
10. Do not turn source-code observations into requirements unless the brief explicitly states them.
11. Reproduce every literal the brief carries — an identifier, path, command, expression, or constant — verbatim and in backticks in your prose; never paraphrase, abbreviate, re-case, reformat, or drop one.
12. Never emit a bullet, list item, or line that consists only of literals: every literal belongs inside a sentence that states its role.

You are a renderer, not a planner.

Respond with "# <TITLE>", then these section headings in order:

## Context
2-4 sentences, expanded tersely from the CONTEXT block.

## Approach
One ordered bullet per APPROACH STEPS entry, in the order given. State the concrete edit — the target file, the line range or that it is a new file, and what changes, grounded in the hydrated snippet and the step's intent. Mention preserve/do-not constraints when the step lists any. Do not invent steps beyond the ones supplied.

## Critical files & anchors
One bullet per FILES entry: a backtick-quoted path, then " — ", then the entry's operation when the brief prints one, then " — ", then its reason. Omit this whole section, heading included, when the brief has no such block.

## Verification
One bullet per VERIFICATION entry.

## Assumptions & contingencies
One bullet per ASSUMPTIONS entry. Omit this whole section, heading included, when the brief has no such block.

Expand tersely into full sentences: add no content the brief does not supply, and alter no literal it supplies.`;

export const DOC_WRITER_SYSTEM_PROMPT = `You expand compact JSON document outlines into complete Markdown documents. You receive one JSON object as the user message and must respond with ONLY the finished Markdown document: no preamble, no code fences, no commentary before or after.

Prefix the document with "# <title>" using the JSON "title" field, then for each entry in the JSON "sections" array emit one "## <heading>" heading followed by the bullets expanded tersely into full prose paragraphs. Preserve the section order exactly and never invent content beyond what the bullets supply. Reproduce every literal a bullet carries — an identifier, path, command, expression, or constant — verbatim and in backticks; never paraphrase, abbreviate, re-case, or reformat one.`;

export const PLAN_UPDATE_WRITER_SYSTEM_PROMPT = `You revise named sections of an existing Markdown implementation plan. You receive one plain-text brief as the user message and must respond with ONLY the rewritten sections: for every heading the brief lists under REQUESTED SECTIONS, its "## <heading>" line spelled exactly as the brief spells it, followed by that section's new body. No "# " title, no preamble, no code fences, no commentary, and never a section the brief does not request.

The brief is labelled plain text:
REQUESTED SECTIONS - the headings to emit, in the order to emit them.
REMOVED SECTIONS - headings the plan is dropping; never emit them.
Then one block per requested section:
    CURRENT - that section's present Markdown, or "(no current content)" when the plan has no such section yet.
    CHANGES - the new input for that section, in one of three shapes:
        a paragraph - change to fold into the Context section.
        bullets - items to fold into a checklist section (Verification, Assumptions & contingencies, Critical files & anchors). A Critical files & anchors bullet is a backtick-quoted path, then " — ", then that file's operation when the change prints one, then " — ", then its reason.
        numbered step blocks - added or corrected Approach steps. Each prints the target file path, operation: add | delete | modify, lines: an inclusive range or "(new file)", intent: a natural-language sentence, optional preserve / do not lists, and source: the numbered current content of the referenced lines, or a parenthesised note saying nothing could be read.

Rules:
1. Keep every statement in CURRENT that the CHANGES block does not contradict, supersede, or forbid; never drop existing content silently.
2. A section whose CURRENT block is "(no current content)" is written from its CHANGES block alone.
3. Add new bullets and new steps after the existing ones, in the order given.
4. Fold step changes into the existing step list; do not restate the steps they do not touch.
5. For a Context section, merge the change into the existing 2-4 sentence description instead of restating the whole plan.
6. Ground step prose in the supplied source snippet, and name the exact file and line range when available.
7. Treat preserve items as hard constraints and do-not items as explicit prohibitions.
8. Do not infer requirements from the source code, and do not invent files, implementation details, APIs, dependencies, behavior, or steps the brief does not supply.
9. Do not restate, summarize, or reference any section the brief does not request.
10. Reproduce every literal the brief carries — an identifier, path, command, expression, or constant — verbatim and in backticks; never paraphrase, abbreviate, re-case, reformat, or drop one.
11. Never emit a bullet, list item, or line that consists only of literals: every literal belongs inside a sentence that states its role.

You are a renderer, not a planner. Expand tersely into full sentences: add no content the brief does not supply, and alter no literal it supplies.`;

/** A completed writer expansion: the Markdown it produced, the model that
 *  produced it, the tokens and dollars it spent, and — for the plan paths —
 *  the literal-fidelity gate's verdict on the result.  Doc mode leaves
 *  `fidelity` unset: a lossy doc draft has no update path to steer the brain
 *  into, so the gate would only spend a repair session. */
export interface ExpandSuccess {
  markdown: string;
  model: { provider: string; id: string };
  usage: { input: number; output: number };
  costUsd: number;
  fidelity?: FidelityReport;
}

export type ExpandResult = ExpandSuccess | { error: string };

/** Joins the `text` parts of a `message_end` assistant message's content
 *  array, in emission order.  Some providers deliver the writer's completion
 *  only as a whole `message_end.message.content` and never stream
 *  `text_delta` chunks; this recovers the full response in that case. */
function assistantMessageText(content: readonly { type: string; text?: string }[] | undefined): string {
  if (!content) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("");
}

/** Shared nested-session execution helper.  Creates a tools-free session on
 *  `writerModel`, sends `promptText` verbatim as the user message, accumulates
 *  the streamed Markdown response, and disposes the session in a finally block.
 *  Never touches disk. */
async function runWriterExpansion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModel: Model,
  systemPrompt: string,
  promptText: string,
): Promise<ExpandResult> {
  const sdk = pi.pi;
  const agentRegistry = new sdk.AgentRegistry();
  let session: AgentSession | undefined;

  try {
    const created = await sdk.createAgentSession({
      cwd: ctx.cwd,
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
      model: writerModel,
      sessionManager: sdk.SessionManager.inMemory(ctx.cwd),
      agentRegistry,
      localProtocolOptions: ctx.localProtocolOptions,
      toolNames: [],
      restrictToolNames: true,
      enableMCP: false,
      enableLsp: false,
      systemPrompt: [systemPrompt],
      thinkingLevel: "off",
    });
    session = created.session;
    const activeSession = session;

    let streamed = "";
    let messageText = "";
    let writerUsage = { input: 0, output: 0 };
    let writerCostUsd = 0;
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = activeSession.subscribe(evt => {
        if (evt.type === "message_update" && evt.assistantMessageEvent.type === "text_delta") {
          streamed += evt.assistantMessageEvent.delta;
          return;
        }
        if (evt.type === "message_end" && evt.message.role === "assistant") {
          writerUsage = { input: writerUsage.input + evt.message.usage.input, output: writerUsage.output + evt.message.usage.output };
          writerCostUsd += (evt.message.usage.cost?.total ?? 0);
          messageText = assistantMessageText(evt.message.content) || messageText;
          return;
        }
        if (evt.type === "agent_end" && evt.isTerminal !== false) {
          unsubscribe();
          resolve();
        }
      });
      activeSession.prompt(promptText).catch((err: unknown) => {
        unsubscribe();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    const markdown = (messageText || streamed).trim();
    if (!markdown) return { error: "Writer model returned an empty response." };
    return { markdown, model: { provider: writerModel.provider, id: writerModel.id }, usage: writerUsage, costUsd: writerCostUsd };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (session) await session.dispose();
  }
}

/** Runs `runWriterExpansion` and retries exactly once, with a fresh nested
 *  session, when the first attempt fails — an empty completion and a
 *  thrown error are both treated as transient. Hides intermittent
 *  writer-model failures from the caller so the expensive planning model
 *  is never forced to draft the Markdown itself just because the cheap
 *  model blipped once. */
async function runWriterExpansionWithRetry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModel: Model,
  systemPrompt: string,
  promptText: string,
): Promise<ExpandResult> {
  const first = await runWriterExpansion(pi, ctx, writerModel, systemPrompt, promptText);
  if (!("error" in first)) return first;
  if (ctx.hasUI) {
    ctx.ui.notify(`Scribe: writer model failed (${first.error}); retrying with a fresh session.`, "warning");
  }
  return runWriterExpansion(pi, ctx, writerModel, systemPrompt, promptText);
}

const SCRIBE_OPERATION_LABELS: Record<ScribeOperation, string> = {
  "+": "add",
  "!": "delete",
  "~": "modify",
};

/** The operation label to print for each file a step references, keyed by file
 *  id.  A file any step modifies is `modify`, else one any step deletes is
 *  `delete`, else the file is new.  A file no step references is absent: there
 *  is no operation to state, so its bullet keeps the bare path and reason. */
function fileOperationLabels(files: readonly ScribeFile[], steps: readonly ScribeStep[]): Map<string, string> {
  const byFileId = new Map<string, ScribeOperation>();
  for (const [fileId, operation] of steps) {
    const seen = byFileId.get(fileId);
    if (operation === "~" || seen === undefined || (operation === "!" && seen === "+")) byFileId.set(fileId, operation);
  }

  const labels = new Map<string, string>();
  for (const [id] of files) {
    const operation = byFileId.get(id);
    if (operation === undefined) continue;
    labels.set(
      id,
      operation === "+" ? `${SCRIBE_OPERATION_LABELS["+"]} (new file)` : SCRIBE_OPERATION_LABELS[operation],
    );
  }
  return labels;
}

/** Renders one decoded step as the labelled block both writer prompts describe:
 *  its numbered target path, operation, line range, intent, constraints, and the
 *  lines the extension hydrated for it. */
function renderStepBlock(index: number, { step, snippet }: HydratedScribeStep): string[] {
  const lines = [
    `${index + 1}. ${step.filePath}`,
    `   operation: ${SCRIBE_OPERATION_LABELS[step.operation]}`,
    step.lineRange ? `   lines: ${step.lineRange.start}-${step.lineRange.end}` : "   lines: (new file)",
    `   intent: ${step.intent}`,
  ];
  if (step.preserve.length > 0) lines.push(`   preserve: ${step.preserve.join("; ")}`);
  if (step.doNot.length > 0) lines.push(`   do not: ${step.doNot.join("; ")}`);
  lines.push("", "   source:", snippet.split("\n").map(line => `      ${line}`).join("\n"), "");
  return lines;
}

/** Renders the writer model's user message for a plan: labelled plain text
 *  carrying the blueprint's metadata plus, for every step, its decoded file,
 *  operation label, line range, intent, preserve/doNot constraints, and the
 *  lines the extension hydrated for it. Blocks left empty are omitted,
 *  matching {@link WRITER_SYSTEM_PROMPT}'s "omit when the brief has no such
 *  block" rule exactly. */
export function buildPlanPromptText(blueprint: PlanBlueprint, steps: readonly HydratedScribeStep[]): string {
  const blocks: string[] = ["TITLE", blueprint.title, "", "CONTEXT", blueprint.context, "", "APPROACH STEPS"];
  steps.forEach((hydrated, index) => blocks.push(...renderStepBlock(index, hydrated)));

  const appendBullets = (label: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    blocks.push(label, ...items.map(item => `- ${item}`), "");
  };
  const operations = fileOperationLabels(blueprint.files, blueprint.steps);
  appendBullets(
    "FILES",
    blueprint.files.map(([id, path, reason]) => {
      const operation = operations.get(id);
      return operation === undefined ? `${path} — ${reason}` : `${path} — ${operation} — ${reason}`;
    }),
  );
  appendBullets("VERIFICATION", blueprint.verification);
  appendBullets("ASSUMPTIONS", blueprint.assumptions);

  return `${blocks.join("\n").trimEnd()}\n`;
}

// ─── Literal-fidelity gate ────────────────────────────────────────────────────

/** Repair rounds the gate may spend on one draft before it reports the residue
 *  instead of trying again.  Setting this to 0 turns the gate into a
 *  report-only check: the draft is still inspected and its gaps still reach the
 *  brain, but no extra writer session runs. */
export const MAX_FIDELITY_REPAIR_ROUNDS = 2;

/** One brief-supplied plan section, ready for literal extraction: the heading
 *  the draft must carry it under, and the text it is written from. */
interface FidelitySource {
  heading: string;
  text: string;
}

/** The step's own brief lines — everything {@link renderStepBlock} prints ahead
 *  of its hydrated `source:` block.  The snippet is deliberately excluded: it is
 *  current code the writer reads for grounding, not a literal it must echo
 *  back, so mining it would demand verbatim copies of whatever the file
 *  happens to contain. */
function stepBriefText(index: number, hydrated: HydratedScribeStep): string {
  const lines = renderStepBlock(index, hydrated);
  const sourceAt = lines.indexOf("   source:");
  return (sourceAt === -1 ? lines : lines.slice(0, sourceAt)).join("\n");
}

/** The brief-supplied sections the gate verifies, in canonical document order:
 *  each section's heading plus the text it is written from.  Both plan paths
 *  funnel through here, so a section can never be gated on one path and
 *  silently ungated on the other. */
function fidelitySources(input: {
  context?: string;
  steps: readonly HydratedScribeStep[];
  files: readonly ScribeFile[];
  verification: readonly string[];
  assumptions: readonly string[];
}): FidelitySource[] {
  return [
    { heading: PLAN_SECTIONS.context, text: input.context ?? "" },
    { heading: PLAN_SECTIONS.steps, text: input.steps.map((hydrated, index) => stepBriefText(index, hydrated)).join("\n") },
    { heading: PLAN_SECTIONS.files, text: input.files.map(([, path, reason]) => `${path} — ${reason}`).join("\n") },
    { heading: PLAN_SECTIONS.verification, text: input.verification.map(item => `- ${item}`).join("\n") },
    { heading: PLAN_SECTIONS.assumptions, text: input.assumptions.map(item => `- ${item}`).join("\n") },
  ];
}

/** The repair targets for a set of sources: a section with no text to expand
 *  and one whose text carries no literal alike need no gate, so both are
 *  dropped rather than verified against nothing. */
function fidelityTargets(sources: readonly FidelitySource[]): RepairTarget[] {
  const targets: RepairTarget[] = [];
  for (const source of sources) {
    const supplied = source.text.trim();
    if (supplied === "") continue;
    const literals = extractLiterals(supplied);
    if (literals.length === 0) continue;
    targets.push({ heading: source.heading, literals, supplied });
  }
  return targets;
}

/** The literals an initial blueprint commits the draft to, per section. */
function planFidelityTargets(blueprint: PlanBlueprint, steps: readonly HydratedScribeStep[]): RepairTarget[] {
  return fidelityTargets(
    fidelitySources({
      context: blueprint.context,
      steps,
      files: blueprint.files,
      verification: blueprint.verification,
      assumptions: blueprint.assumptions,
    }),
  );
}

/** The literals a delta commits its rewritten sections to.  Only the fields the
 *  delta supplies are checked — the gate must never demand a literal for a
 *  section the update did not name — and `context` is deliberately absent: a
 *  refinement's Context paragraph is folded into the section's existing prose
 *  rather than reproduced, so its wording legitimately changes. */
function deltaFidelityTargets(delta: PlanUpdateBlueprint, steps: readonly HydratedScribeStep[]): RepairTarget[] {
  return fidelityTargets(
    fidelitySources({
      steps,
      files: delta.files ?? [],
      verification: delta.verification ?? [],
      assumptions: delta.assumptions ?? [],
    }),
  );
}

/** The verdict for a draft the gate has nothing to compare: no literal to
 *  check, so nothing missing and no repair spent. */
function emptyFidelityReport(): FidelityReport {
  return { checked: 0, repaired: false, missing: [], missingSections: [], gaps: [] };
}

/**
 * Applies the literal-fidelity gate to a finished expansion: compares every
 * target's literals against the draft, asks the writer to re-emit the sections
 * that lost one — at most {@link MAX_FIDELITY_REPAIR_ROUNDS} times — and
 * reports what is still missing.  Each repair response is spliced in place, so
 * every section the gate did not target keeps its exact bytes.  The extra
 * sessions' usage and cost accumulate onto the expansion, so the caller keeps
 * pricing the whole delegation.
 *
 * A target section the draft never emitted is reported through
 * `missingSections`, never repaired: inserting a section the caller never asked
 * for would change the plan, and the update path already owns that decision
 * with its unrendered-heading rejection.
 */
async function enforceLiteralFidelity(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModel: Model,
  targets: readonly RepairTarget[],
  expansion: ExpandSuccess,
): Promise<ExpandSuccess> {
  if (targets.length === 0) return { ...expansion, fidelity: emptyFidelityReport() };

  // A draft that lists the literals instead of stating them is judged on its
  // prose: the gate must never accept a section because a chip spelled a
  // literal for it.
  let markdown = removeLiteralDumpLines(expansion.markdown);
  let usage = { ...expansion.usage };
  let costUsd = expansion.costUsd;
  let report = checkFidelity(targets, splitPlanSections(markdown).sections);
  const initiallyMissing = report.missing.length;
  let rounds = 0;

  while (report.missing.length > 0 && rounds < MAX_FIDELITY_REPAIR_ROUNDS) {
    rounds += 1;
    const current = splitPlanSections(markdown).sections;
    const repaired = await runWriterExpansionWithRetry(
      pi,
      ctx,
      writerModel,
      PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT,
      buildRepairPromptText(report.gaps, targets, current),
    );
    // The draft that exists is worth more than a repair that never arrived.
    if ("error" in repaired) break;

    usage = { input: usage.input + repaired.usage.input, output: usage.output + repaired.usage.output };
    costUsd += repaired.costUsd;

    // Only the gapped headings may be spliced: a repair response that invents a
    // section, re-emits one the gate did not flag, or answers with a literal
    // list instead of prose must not reach the plan.
    const requested = new Set(report.gaps.map(gap => planHeadingKey(gap.heading)));
    const replacements = splitPlanSections(repaired.markdown).sections.filter(
      section => requested.has(planHeadingKey(section.heading)) && literalDumpLines(section.text).length === 0,
    );
    const next = splicePlanSections(markdown, replacements);
    // A round that changes nothing will change nothing on the next try either.
    if (next === markdown) break;
    markdown = next;
    report = checkFidelity(targets, splitPlanSections(markdown).sections);
  }

  if (ctx.hasUI) {
    if (report.missing.length > 0) {
      ctx.ui.notify(
        `Scribe: the draft is still missing ${report.missing.length} load-bearing literal(s) after ${rounds} repair round(s); reporting the gap instead of rewriting the plan.`,
        "warning",
      );
    } else if (rounds > 0) {
      ctx.ui.notify(
        `Scribe: the draft dropped ${initiallyMissing} load-bearing literal(s); the repair pass restored them verbatim.`,
        "info",
      );
    }
  }

  return { ...expansion, markdown, usage, costUsd, fidelity: { ...report, repaired: rounds > 0 } };
}

/** Runs a short-lived, tools-free nested session on `writerModelSpec` (or the
 *  `@smol` role if that fails to resolve) to expand `blueprint` into the final
 *  Markdown plan body, hydrating every step's referenced line range from disk
 *  first, then holds the result to the literal-fidelity gate (see
 *  {@link enforceLiteralFidelity}) so a paraphrasing writer cannot cost the
 *  brain a re-read. Never writes to disk itself. */
export async function expandBlueprintToMarkdown(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModelSpec: string,
  blueprint: PlanBlueprint,
): Promise<ExpandResult> {
  const writerModel = resolveWriterModel(ctx, writerModelSpec);
  if (!writerModel) {
    return { error: `No model resolves for writer model "${writerModelSpec}" or fallback role "@smol".` };
  }

  let resolvedSteps: ScribeStepResolved[];
  try {
    validateScribeBlueprint(blueprint);
    resolvedSteps = resolveScribeSteps(blueprint);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (ctx.hasUI) {
    ctx.ui.notify(
      `Scribe: delegating plan-Markdown drafting to ${writerModel.provider}/${writerModel.id} (configurable via --scribe-writer-model).`,
      "info",
    );
  }

  const hydrated = await Promise.all(resolvedSteps.map(step => hydrateScribeStep(ctx.cwd, step)));
  const expansion = await runWriterExpansionWithRetry(pi, ctx, writerModel, WRITER_SYSTEM_PROMPT, buildPlanPromptText(blueprint, hydrated));
  if ("error" in expansion) return expansion;
  return enforceLiteralFidelity(pi, ctx, writerModel, planFidelityTargets(blueprint, hydrated), expansion);
}

/** Runs a short-lived, tools-free nested session on `writerModelSpec` (or the
 *  `@smol` role if that fails to resolve) to expand a `DocBlueprint` outline
 *  into the final Markdown document body. Never writes to disk itself. */
export async function expandDocBlueprintToMarkdown(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModelSpec: string,
  blueprint: DocBlueprint,
): Promise<ExpandResult> {
  const writerModel = resolveWriterModel(ctx, writerModelSpec);
  if (!writerModel) {
    return { error: `No model resolves for writer model "${writerModelSpec}" or fallback role "@smol".` };
  }

  if (ctx.hasUI) {
    ctx.ui.notify(
      `Scribe: delegating doc-Markdown drafting to ${writerModel.provider}/${writerModel.id} (configurable via --scribe-writer-model).`,
      "info",
    );
  }

  // Send only the fields the writer model needs; omit slug and path (metadata only).
  return runWriterExpansionWithRetry(
    pi,
    ctx,
    writerModel,
    DOC_WRITER_SYSTEM_PROMPT,
    JSON.stringify({ title: blueprint.title, sections: blueprint.sections }),
  );
}

// ─── Plan updates ─────────────────────────────────────────────────────────────

/** A `PlanUpdateBlueprint` field that rewrites a plan section. */
export type PlanUpdateField = "context" | "files" | "steps" | "verification" | "assumptions";

/** Delta fields that rewrite a plan section, paired with the heading each
 *  supplies, in canonical document order. */
const PLAN_UPDATE_TARGETS: ReadonlyArray<{ field: PlanUpdateField; heading: string }> = [
  { field: "context", heading: PLAN_SECTIONS.context },
  { field: "steps", heading: PLAN_SECTIONS.steps },
  { field: "files", heading: PLAN_SECTIONS.files },
  { field: "verification", heading: PLAN_SECTIONS.verification },
  { field: "assumptions", heading: PLAN_SECTIONS.assumptions },
];

/** `true` when a delta field carries content to fold into its section.  An
 *  absent field and an empty array or blank string alike mean "leave that
 *  section alone". */
export function deltaSupplies(delta: PlanUpdateBlueprint, field: PlanUpdateField): boolean {
  const value = delta[field];
  return typeof value === "string" ? value.trim() !== "" : Array.isArray(value) && value.length > 0;
}

/** The plan-section headings a delta asks to rewrite, in the order the writer
 *  must emit them (canonical document order). */
export function planUpdateHeadings(delta: PlanUpdateBlueprint): string[] {
  return PLAN_UPDATE_TARGETS.filter(target => deltaSupplies(delta, target.field)).map(target => target.heading);
}

/** The plan-section headings a delta asks to delete, trimmed, de-duplicated under
 *  the same identity rule section matching uses, and order-preserving. */
export function planUpdateDrops(delta: PlanUpdateBlueprint): string[] {
  const seen = new Set<string>();
  const drops: string[] = [];
  for (const entry of delta.drop ?? []) {
    const heading = entry.trim();
    const key = planHeadingKey(heading);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    drops.push(heading);
  }
  return drops;
}

/** The CHANGES block for one requested section: the delta input the writer must
 *  fold into that section's current text. */
function planUpdateChangeLines(
  delta: PlanUpdateBlueprint,
  field: PlanUpdateField,
  steps: readonly HydratedScribeStep[],
): string[] {
  switch (field) {
    case "context":
      return [delta.context?.trim() ?? ""];
    case "steps":
      return steps.flatMap((hydrated, index) => renderStepBlock(index, hydrated));
    case "files": {
      const files = delta.files ?? [];
      const operations = fileOperationLabels(files, delta.steps ?? []);
      return files.map(([id, path, reason]) => {
        const operation = operations.get(id);
        return operation === undefined ? `- ${path} — ${reason}` : `- ${path} — ${operation} — ${reason}`;
      });
    }
    case "verification":
      return (delta.verification ?? []).map(item => `- ${item}`);
    case "assumptions":
      return (delta.assumptions ?? []).map(item => `- ${item}`);
  }
}

/** Renders the writer model's user message for a plan update: the sections to
 *  emit, the ones the plan is dropping, and, per requested section, its current
 *  text plus the delta input to fold in.
 *
 *  `currentSections` is the whole parsed plan document's section list; the
 *  builder picks out the entries whose headings are being rewritten and reports
 *  "(no current content)" for a requested heading the plan does not have yet. */
export function buildPlanUpdatePromptText(
  delta: PlanUpdateBlueprint,
  steps: readonly HydratedScribeStep[],
  currentSections: readonly PlanSection[],
): string {
  const targets = PLAN_UPDATE_TARGETS.filter(target => deltaSupplies(delta, target.field));
  const drops = planUpdateDrops(delta);
  const currentByKey = new Map(currentSections.map(section => [planHeadingKey(section.heading), section.text]));

  const lines: string[] = [
    'REQUESTED SECTIONS (emit exactly these, in this order, each starting with its "## <heading>" line)',
  ];
  targets.forEach((target, index) => lines.push(`${index + 1}. ${target.heading}`));
  lines.push("", "REMOVED SECTIONS (never emit these)");
  lines.push(...(drops.length === 0 ? ["- (none)"] : drops.map(heading => `- ${heading}`)));

  targets.forEach((target, index) => {
    lines.push("", `=== SECTION ${index + 1}: ${target.heading} ===`, "CURRENT");
    const current = currentByKey.get(planHeadingKey(target.heading));
    lines.push(current === undefined ? "(no current content)" : current.trimEnd());
    lines.push("CHANGES", ...planUpdateChangeLines(delta, target.field, steps));
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Runs a short-lived, tools-free nested session on `writerModelSpec` (or the
 *  `@smol` role if that fails to resolve) that rewrites only the plan sections
 *  `delta` names, folding the delta's IR into the current text of the plan
 *  supplied by `current`.  Validates and hydrates the delta's steps from disk
 *  exactly as {@link expandBlueprintToMarkdown} does, so a malformed or
 *  unresolvable delta never reaches the writer.  Never writes to disk itself.
 *
 *  `current` is what the initial-blueprint entry point gets from its blueprint:
 *  an update cannot be rendered without the text it is amending.
 *
 *  The rewritten sections then pass the literal-fidelity gate before the caller
 *  parses them, so a section that lost one of the delta's literals is repaired
 *  rather than spliced into the plan. */
export async function expandPlanUpdateToMarkdown(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModelSpec: string,
  delta: PlanUpdateBlueprint,
  current: PlanDocument,
): Promise<ExpandResult> {
  const writerModel = resolveWriterModel(ctx, writerModelSpec);
  if (!writerModel) {
    return { error: `No model resolves for writer model "${writerModelSpec}" or fallback role "@smol".` };
  }

  const ir = { files: delta.files ?? [], steps: delta.steps ?? [] };
  let resolvedSteps: ScribeStepResolved[];
  try {
    validateScribeBlueprint(ir, { requireSteps: false });
    resolvedSteps = resolveScribeSteps(ir);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (ctx.hasUI) {
    ctx.ui.notify(
      `Scribe: delegating plan-section update to ${writerModel.provider}/${writerModel.id} (configurable via --scribe-writer-model).`,
      "info",
    );
  }

  const hydrated = await Promise.all(resolvedSteps.map(step => hydrateScribeStep(ctx.cwd, step)));
  const expansion = await runWriterExpansionWithRetry(
    pi,
    ctx,
    writerModel,
    PLAN_UPDATE_WRITER_SYSTEM_PROMPT,
    buildPlanUpdatePromptText(delta, hydrated, current.sections),
  );
  if ("error" in expansion) return expansion;
  return enforceLiteralFidelity(pi, ctx, writerModel, deltaFidelityTargets(delta, hydrated), expansion);
}

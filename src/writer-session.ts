import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { DocBlueprint, PlanBlueprint, PlanUpdateBlueprint, ScribeFile, ScribeLiteral, ScribeOperation, ScribeStep } from "./types";
import { hydrateScribeStep, resolveScribeSteps, validateScribeBlueprint, type HydratedScribeStep, type ScribeStepResolved } from "./scribe-ir";
import { PLAN_SECTIONS, planHeadingKey, splicePlanSections, splitPlanSections, type PlanDocument, type PlanSection } from "./plan-sections";
import {
  PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT,
  absentGaps,
  buildRepairPromptText,
  checkFidelity,
  extractLiterals,
  formatLiteralTable,
  gapLiterals,
  literalDumpLines,
  mergeLiterals,
  referencedLiterals,
  removeLiteralDumpLines,
  resolveLiteralPlaceholders,
  validateLiteralTable,
  validateLiteralUsage,
  type FidelityReport,
  type LiteralRunMetrics,
  type RepairTarget,
} from "./literal-fidelity";
import { resolveWriterModel } from "./config";
import { accountWriterTokens, type TokenAccounting } from "./token-accounting";

export const WRITER_SYSTEM_PROMPT = `You expand a compact implementation-plan IR into a complete Markdown plan. The user message is one labelled plain-text brief; respond with ONLY the finished Markdown document: no preamble, no code fences, no commentary.

The APPROACH STEPS are authoritative.

Brief labels:
TITLE - plan title; becomes the "# " heading.
CONTEXT - the ask and intended end state.
LITERALS - optional; each line \`[[<id>]] = <json value>\` is the exact value that marker stands for in the brief.
APPROACH STEPS - numbered steps: target file path, operation (add | delete | modify), lines (an inclusive range, or "(new file)" only when the brief marks the step as creating the file, or "(no range given)" otherwise), intent (one sentence stating the change), optional preserve (semicolon-separated must-keep items), do not (semicolon-separated prohibitions), and source (the referenced lines, or a note that nothing could be read).
FILES - optional pointers, one per touched file.
VERIFICATION / ASSUMPTIONS - optional check bullets / user-overridable decisions.

Per step:
1. Describe only the change its intent states.
2. Ground it in the supplied source snippet.
3. Name the file and line range when available.
4. Treat preserve items as hard constraints.
5. Treat do-not items as explicit prohibitions.
6. Infer no extra requirements from the source code.
7. Invent no files, APIs, dependencies, details, or behavior.
8. Add no step the brief does not list.
9. If source and intent conflict, describe the conflict instead of guessing.
10. Turn no source observation into a requirement unless the brief states it.
11. Where the brief writes a \`[[<id>]]\` marker, emit it verbatim — never the value it stands for, never a marker the LITERALS block does not list; the extension substitutes the exact value afterwards.
12. Emit every supplied marker inside a sentence stating its role; never a marker or literal alone on a line.
13. Call a step a new file only when its lines label reads "(new file)"; when it reads "(no range given)", the step edits a file that already exists, so never call it new or describe creating it.
14. State each fact once: never repeat a sentence, clause, or list item.

You are a renderer, not a planner.

Respond with "# <TITLE>", then these headings:

## Context
2-4 sentences, expanded tersely from CONTEXT.

## Approach
One bullet per APPROACH STEPS entry, in order: the concrete edit — target file, line range, new file, or nothing when the brief gives no range, and what changes.

## Critical files & anchors
One bullet per FILES entry: backtick-quoted path, " — ", the operation when the brief prints one, " — ", reason. Omit it, heading included, when the brief has no FILES block.

## Verification
One bullet per VERIFICATION entry.

## Assumptions & contingencies
One bullet per ASSUMPTIONS entry. Omit it, heading included, when the brief has no such block.

Expand tersely into full sentences: add no content the brief does not supply, and alter no literal it supplies.`;

export const DOC_WRITER_SYSTEM_PROMPT = `You expand compact JSON document outlines into complete Markdown documents. Respond to the user message — one JSON object — with ONLY the finished Markdown document: no preamble, no code fences, no commentary.

Prefix it with "# <title>" from the JSON "title", then emit one "## <heading>" per "sections" entry, followed by that entry's bullets expanded tersely into full prose paragraphs. Preserve the section order exactly and invent nothing beyond the bullets. The payload may carry a "literals" array of [id, value] tuples: a bullet's \`[[<id>]]\` marker stands for that entry's exact value. Emit every marker verbatim where its value belongs — never the value itself, never an unlisted marker, and never a marker or literal on a line by itself.`;

export const PLAN_UPDATE_WRITER_SYSTEM_PROMPT = `You revise named sections of an existing Markdown implementation plan. Respond to the user message — one labelled plain-text brief — with ONLY the rewritten sections: each requested heading's "## <heading>" line spelled as the brief spells it, then its new body. No "# " title, no preamble, no code fences, no commentary.

Brief labels:
REQUESTED SECTIONS - the headings to emit, in order.
REMOVED SECTIONS - headings the plan is dropping; never emit them.
LITERALS - optional; each line \`[[<id>]] = <json value>\` is the exact value that marker stands for.
Per requested section:
    CURRENT - the section's present Markdown, or "(no current content)".
    CHANGES - the new input: a paragraph to fold into Context; bullets to fold into a checklist section (a Critical files & anchors bullet is a backtick-quoted path, the operation when printed, and the reason, " — "-separated); or step blocks for added or corrected Approach steps (target file path, operation: add | delete | modify, lines: an inclusive range, "(new file)" only when the brief marks the step as creating the file, or "(no range given)" otherwise, intent: one sentence, optional preserve / do not lists, source: the referenced lines or a note that nothing could be read).

Rules:
1. Keep every CURRENT statement CHANGES does not contradict or forbid; drop nothing silently.
2. Write a "(no current content)" section from its CHANGES alone; a requested heading also listed under REMOVED SECTIONS (so you are regenerating that section from scratch) is authored the same way.
3. Add new bullets and steps after the existing ones, in the order given.
4. Fold step changes into the existing list; restate no step they do not touch.
5. Merge a Context change into the existing 2-4 sentence description; restate not the whole plan.
6. Ground step prose in the supplied snippet; name the file and line range when available.
7. Treat preserve items as hard constraints and do-not items as explicit prohibitions.
8. Infer no requirements from the source code; invent no files, details, APIs, behavior, or steps the brief does not supply.
9. Reference no section the brief does not request.
10. Emit any \`[[<id>]]\` marker the brief writes verbatim: the extension substitutes the exact value afterwards. Never write the value it stands for, and never invent an unlisted marker.
11. Emit every supplied marker inside a sentence stating its role; never a marker or literal alone on a line.
12. Call a step a new file only when its lines label reads "(new file)"; when it reads "(no range given)", the step edits a file that already exists, so never call it new or describe creating it.
13. State each fact once: never repeat a sentence, clause, or list item.

You are a renderer, not a planner. Expand tersely into full sentences: add no content the brief does not supply, and alter no literal it supplies.`;

/** A completed writer expansion: the Markdown it produced, the model that
 *  produced it, the tokens and dollars it spent, the literal-fidelity gate's
 *  verdict on the result, and what the literal table cost.  `literalMetrics`
 *  counts the `[[id]]` markers substituted deterministically while the repair
 *  fields cover only the literals no table entry declares. */
export interface ExpandSuccess {
  markdown: string;
  model: { provider: string; id: string };
  usage: { input: number; output: number };
  costUsd: number;
  fidelity?: FidelityReport;
  literalMetrics: LiteralRunMetrics;
  /** Real-tokenizer counts of what this expansion sent the writer model.
   *  Present whenever a count succeeded; absent when it could not be taken, so
   *  nothing downstream has to treat it as load-bearing. */
  tokenAccounting?: TokenAccounting;
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
 *  Never touches disk.  `snippetText` is the part of `promptText` that came
 *  from hydrated source blocks, counted separately when the expansion is
 *  accounted; it is never sent anywhere. */
async function runWriterExpansion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModel: Model,
  systemPrompt: string,
  promptText: string,
  snippetText = "",
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
    // Counted after the response, so a counting failure can never cost the
    // expansion: `accountWriterTokens` degrades to `undefined`.
    const tokenAccounting = await accountWriterTokens(writerModel, {
      system: systemPrompt,
      brief: promptText,
      snippet: snippetText,
    });
    return {
      markdown,
      model: { provider: writerModel.provider, id: writerModel.id },
      usage: writerUsage,
      costUsd: writerCostUsd,
      tokenAccounting,
      // The gate overwrites these once it has run; a raw expansion substitutes
      // no marker and spends no repair round.
      literalMetrics: { resolved: 0, unresolved: [], repairRounds: 0, repairInputTokens: 0, repairOutputTokens: 0 },
    };
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
  snippetText = "",
): Promise<ExpandResult> {
  const first = await runWriterExpansion(pi, ctx, writerModel, systemPrompt, promptText, snippetText);
  if (!("error" in first)) return first;
  if (ctx.hasUI) {
    ctx.ui.notify(`Scribe: writer model failed (${first.error}); retrying with a fresh session.`, "warning");
  }
  return runWriterExpansion(pi, ctx, writerModel, systemPrompt, promptText, snippetText);
}

const SCRIBE_OPERATION_LABELS: Record<ScribeOperation, string> = {
  "+": "add",
  "!": "delete",
  "~": "modify",
};

/** The operation label to print for each file a step references, keyed by file
 *  id.  A file any step modifies is `modify`, else one any step deletes is
 *  `delete`, else the file is added.  The label states the operation alone: the
 *  `(new file)` fact belongs to the step's `lines` label, where hydration
 *  decides it, so a Critical files bullet never contradicts an Approach bullet.
 *  A file no step references is absent: there is no operation to state, so its
 *  bullet keeps the bare path and reason. */
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
    labels.set(id, SCRIBE_OPERATION_LABELS[operation]);
  }
  return labels;
}

/** Renders one decoded step as the labelled block both writer prompts describe:
 *  its numbered target path, operation, line range, intent, constraints, and the
 *  lines the extension hydrated for it. */
function renderStepBlock(index: number, { step, fileState, snippet }: HydratedScribeStep): string[] {
  const lines = [
    `${index + 1}. ${step.filePath}`,
    `   operation: ${SCRIBE_OPERATION_LABELS[step.operation]}`,
    step.lineRange
      ? `   lines: ${step.lineRange.start}-${step.lineRange.end}`
      : fileState === "absent"
        ? "   lines: (new file)"
        : "   lines: (no range given)",
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
  const blocks: string[] = [
    "TITLE",
    blueprint.title,
    "",
    "CONTEXT",
    blueprint.context,
    "",
    ...formatLiteralTable(blueprint.literals),
    "APPROACH STEPS",
  ];
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
 *  the draft must carry it under, and the text it is written from.
 *  `extractInline` mines that text for literal-shaped strings as well as the
 *  declared `[[id]]` markers it references — false for a refinement's Context
 *  paragraph, whose wording legitimately changes while its markers stay
 *  required, and ignored entirely once the caller declares a literal table,
 *  because the table is then the authoritative literal set. */
interface FidelitySource {
  heading: string;
  text: string;
  extractInline: boolean;
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
    { heading: PLAN_SECTIONS.context, text: input.context ?? "", extractInline: true },
    { heading: PLAN_SECTIONS.steps, text: input.steps.map((hydrated, index) => stepBriefText(index, hydrated)).join("\n"), extractInline: true },
    { heading: PLAN_SECTIONS.files, text: input.files.map(([, path, reason]) => `${path} — ${reason}`).join("\n"), extractInline: true },
    { heading: PLAN_SECTIONS.verification, text: input.verification.map(item => `- ${item}`).join("\n"), extractInline: true },
    { heading: PLAN_SECTIONS.assumptions, text: input.assumptions.map(item => `- ${item}`).join("\n"), extractInline: true },
  ];
}

/** The repair targets for a set of sources: a section with no text to expand
 *  and one whose text carries neither a declared marker nor an inline literal
 *  alike need no gate, so both are dropped rather than verified against
 *  nothing.  Each target's literals are the declared values its `[[id]]`
 *  markers reference, followed by the literals its own text supplies when
 *  `extractInline` allows it — which a declared table switches off entirely, so
 *  a planner that names its literals never has undeclared brief prose mined
 *  behind its back. */
function fidelityTargets(sources: readonly FidelitySource[], literals: readonly ScribeLiteral[] | undefined): RepairTarget[] {
  const targets: RepairTarget[] = [];
  const declared = literals !== undefined && literals.length > 0;
  for (const source of sources) {
    const supplied = source.text.trim();
    if (supplied === "") continue;
    const mine = source.extractInline && !declared;
    const inline = mine ? extractLiterals(resolveLiteralPlaceholders(source.text, literals).markdown) : [];
    const merged = mergeLiterals(referencedLiterals(source.text, literals), inline);
    if (merged.length === 0) continue;
    targets.push({ heading: source.heading, literals: merged, supplied });
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
    blueprint.literals,
  );
}

/** The literals a delta commits its rewritten sections to.  Only the fields the
 *  delta supplies are checked — the gate must never demand a literal for a
 *  section the update did not name — and `context` is gated on its declared
 *  markers alone: a refinement's Context paragraph is folded into the section's
 *  existing prose rather than reproduced, so its wording legitimately changes. */
function deltaFidelityTargets(delta: PlanUpdateBlueprint, steps: readonly HydratedScribeStep[]): RepairTarget[] {
  const sources = fidelitySources({
    context: delta.context,
    steps,
    files: delta.files ?? [],
    verification: delta.verification ?? [],
    assumptions: delta.assumptions ?? [],
  }).map(source => (source.heading === PLAN_SECTIONS.context ? { ...source, extractInline: false } : source));
  return fidelityTargets(sources, delta.literals);
}

/** The literals a doc blueprint commits the document to: one target per section,
 *  mined from the bullets joined by newlines. */
function docFidelityTargets(blueprint: DocBlueprint): RepairTarget[] {
  const sources: FidelitySource[] = blueprint.sections.map(section => ({
    heading: section.heading,
    text: section.bullets.join("\n"),
    extractInline: true,
  }));
  return fidelityTargets(sources, blueprint.literals);
}

/** The verdict for a draft the gate has nothing to compare: no literal to
 *  check, so nothing missing and no repair spent. */
function emptyFidelityReport(): FidelityReport {
  return { checked: 0, repaired: false, missing: [], missingSections: [], gaps: [] };
}

/**
 * Applies the literal-fidelity gate to a finished expansion.  The deterministic
 * path runs first: every `[[id]]` marker a declared literal owns is replaced
 * with that literal's exact value, so a marker the writer emitted needs no
 * verification at all.  Whatever the table does not declare is then compared
 * against the draft, and the gate asks the writer to re-emit the sections that
 * lost one — at most {@link MAX_FIDELITY_REPAIR_ROUNDS} times — reporting what
 * is still missing.  Each repair response is spliced in place after its own
 * markers are resolved, so every section the gate did not target keeps its exact
 * bytes.  The extra sessions' usage and cost accumulate onto the expansion, so
 * the caller keeps pricing the whole delegation.
 *
 * Every literal gap a repair session can close is repairable, declared ones
 * included: the repair brief prints a declared literal as its `[[<id>]]` marker
 * and the extension substitutes the exact value afterwards, so restoring a
 * marker never asks the writer to retype the value.  A gap is skipped only when
 * the literal already survives elsewhere in the plan.  A target section the
 * draft never emitted is reported through `missingSections`, never repaired:
 * inserting a section the caller never asked for would change the plan, and the
 * update path already owns that decision with its unrendered-heading rejection.
 *
 * The gate never mutates the plan: the markers are resolved over the writer's
 * own text, and the literal-only-line strip is applied to the haystack it
 * compares, so a draft's bullet survives into the plan even when the gate
 * refuses to count it as carrying its literal.
 */
async function enforceLiteralFidelity(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModel: Model,
  targets: readonly RepairTarget[],
  literals: readonly ScribeLiteral[] | undefined,
  expansion: ExpandSuccess,
): Promise<ExpandSuccess> {
  const metrics: LiteralRunMetrics = {
    resolved: 0,
    unresolved: [],
    repairRounds: 0,
    repairInputTokens: 0,
    repairOutputTokens: 0,
  };
  let usage = { ...expansion.usage };
  let costUsd = expansion.costUsd;

  if (targets.length === 0) {
    const resolution = resolveLiteralPlaceholders(expansion.markdown, literals);
    metrics.resolved = resolution.resolved;
    metrics.unresolved = resolution.unresolved;
    return { ...expansion, markdown: resolution.markdown, usage, costUsd, fidelity: emptyFidelityReport(), literalMetrics: metrics };
  }

  // Markers resolve over the draft exactly as it stands, so the returned plan
  // is the writer's own text with its declared values substituted — the gate
  // never deletes a line the writer emitted.  A draft that lists the literals
  // instead of stating them is still judged on its prose: `removeLiteralDumpLines`
  // is applied to the gate's haystack alone, so a literal-only line cannot
  // satisfy the check even though it stays in the plan.
  const resolution = resolveLiteralPlaceholders(expansion.markdown, literals);
  metrics.resolved = resolution.resolved;
  metrics.unresolved = resolution.unresolved;

  let markdown = resolution.markdown;
  /** The sections the gate compares: the draft with its literal-only lines
   *  removed, re-derived after every repair round.  The repair brief is shown
   *  the same text, so a dump line cannot be copied forward. */
  const gateSections = (text: string): PlanSection[] => splitPlanSections(removeLiteralDumpLines(text)).sections;
  let report = checkFidelity(targets, gateSections(markdown));
  /** The verdict narrowed to what the whole draft is missing: a literal that
   *  survives in another section is not lost, so re-emitting it in a flagged
   *  section would buy nothing and calling it missing would be untrue. */
  const lostReport = (current: FidelityReport): FidelityReport => {
    const gaps = absentGaps(current, gateSections(markdown));
    return { ...current, gaps, missing: gapLiterals(gaps) };
  };
  let repairable = lostReport(report).gaps;
  const initiallyMissing = gapLiterals(repairable).length;
  let rounds = 0;

  while (repairable.length > 0 && rounds < MAX_FIDELITY_REPAIR_ROUNDS) {
    rounds += 1;
    const current = gateSections(markdown);
    const repaired = await runWriterExpansionWithRetry(
      pi,
      ctx,
      writerModel,
      PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT,
      buildRepairPromptText(repairable, targets, current, literals),
    );
    // The draft that exists is worth more than a repair that never arrived.
    if ("error" in repaired) break;

    usage = { input: usage.input + repaired.usage.input, output: usage.output + repaired.usage.output };
    costUsd += repaired.costUsd;
    metrics.repairInputTokens += repaired.usage.input;
    metrics.repairOutputTokens += repaired.usage.output;

    // Only the gapped headings may be spliced: a repair response that invents a
    // section, re-emits one the gate did not flag, or answers with a literal
    // list instead of prose must not reach the plan.
    const requested = new Set(repairable.map(gap => planHeadingKey(gap.heading)));
    const replacements = splitPlanSections(resolveLiteralPlaceholders(repaired.markdown, literals).markdown).sections.filter(
      section => requested.has(planHeadingKey(section.heading)) && literalDumpLines(section.text).length === 0,
    );
    const next = splicePlanSections(markdown, replacements);
    // A round that changes nothing will change nothing on the next try either.
    if (next === markdown) break;
    markdown = next;
    report = checkFidelity(targets, gateSections(markdown));
    repairable = lostReport(report).gaps;
  }

  metrics.repairRounds = rounds;

  // The caller sees the same narrowing the repair loop acted on.
  report = lostReport(report);

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

  return {
    ...expansion,
    markdown,
    usage,
    costUsd,
    fidelity: { ...report, repaired: rounds > 0 },
    literalMetrics: metrics,
  };
}

/** Every string an initial blueprint's prose supplies, scanned for `[[id]]`
 *  markers so a declared literal no marker references is rejected. */
function blueprintLiteralTexts(blueprint: PlanBlueprint): string[] {
  const texts: string[] = [blueprint.title, blueprint.context];
  for (const [, path, reason] of blueprint.files) texts.push(path, reason);
  for (const [, , , intent, preserve, doNot] of blueprint.steps) texts.push(intent, ...preserve, ...doNot);
  texts.push(...blueprint.verification, ...blueprint.assumptions);
  return texts;
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
    validateLiteralTable(blueprint.literals);
    validateLiteralUsage(blueprint.literals, blueprintLiteralTexts(blueprint));
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
  const expansion = await runWriterExpansionWithRetry(
    pi,
    ctx,
    writerModel,
    WRITER_SYSTEM_PROMPT,
    buildPlanPromptText(blueprint, hydrated),
    // The hydrated blocks are the part of the brief whose size the planner
    // controls through its line ranges, so the diagnostic names them apart
    // from the rest of the brief.
    hydrated.map(entry => entry.snippet).join("\n"),
  );
  if ("error" in expansion) return expansion;
  return enforceLiteralFidelity(pi, ctx, writerModel, planFidelityTargets(blueprint, hydrated), blueprint.literals, expansion);
}

/** Every string a doc blueprint's outline supplies, scanned for `[[id]]`
 *  markers.  `path` participates — a marker may stand for the file name — but
 *  it is never sent to the writer as JSON payload metadata. */
function docLiteralTexts(blueprint: DocBlueprint): string[] {
  const texts: string[] = [blueprint.title, blueprint.path];
  for (const section of blueprint.sections) texts.push(section.heading, ...section.bullets);
  return texts;
}

/** Runs a short-lived, tools-free nested session on `writerModelSpec` (or the
 *  `@smol` role if that fails to resolve) to expand a `DocBlueprint` outline
 *  into the final Markdown document body, then holds the result to the
 *  literal-fidelity gate so a doc draft gets the same deterministic
 *  substitution and report as a plan draft. Never writes to disk itself. */
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

  try {
    validateLiteralTable(blueprint.literals);
    validateLiteralUsage(blueprint.literals, docLiteralTexts(blueprint));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (ctx.hasUI) {
    ctx.ui.notify(
      `Scribe: delegating doc-Markdown drafting to ${writerModel.provider}/${writerModel.id} (configurable via --scribe-writer-model).`,
      "info",
    );
  }

  // Send only the fields the writer model needs; omit slug and path (metadata only).
  const expansion = await runWriterExpansionWithRetry(
    pi,
    ctx,
    writerModel,
    DOC_WRITER_SYSTEM_PROMPT,
    JSON.stringify({ title: blueprint.title, sections: blueprint.sections, literals: blueprint.literals }),
  );
  if ("error" in expansion) return expansion;
  return enforceLiteralFidelity(pi, ctx, writerModel, docFidelityTargets(blueprint), blueprint.literals, expansion);
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

/** The plan-section headings a delta asks to delete *and* does not supply:
 *  exactly the sections the plan drops.  A heading a delta lists in `drop` and
 *  also supplies through a field is regenerated from scratch rather than
 *  deleted, so it never appears in this list. */
export function planUpdateRemovals(delta: PlanUpdateBlueprint): string[] {
  const supplied = new Set(planUpdateHeadings(delta).map(planHeadingKey));
  return planUpdateDrops(delta).filter(heading => !supplied.has(planHeadingKey(heading)));
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
  const removals = planUpdateRemovals(delta);
  /** A heading the delta both drops and supplies is regenerated from scratch:
   *  its CURRENT block shows no text to fold into. */
  const regenerated = new Set(planUpdateDrops(delta).map(planHeadingKey));
  const currentByKey = new Map(currentSections.map(section => [planHeadingKey(section.heading), section.text]));

  const lines: string[] = [
    'REQUESTED SECTIONS (emit exactly these, in this order, each starting with its "## <heading>" line)',
  ];
  targets.forEach((target, index) => lines.push(`${index + 1}. ${target.heading}`));
  lines.push("", "REMOVED SECTIONS (never emit these)");
  lines.push(...(removals.length === 0 ? ["- (none)"] : removals.map(heading => `- ${heading}`)));
  lines.push(...formatLiteralTable(delta.literals));

  targets.forEach((target, index) => {
    lines.push("", `=== SECTION ${index + 1}: ${target.heading} ===`, "CURRENT");
    const key = planHeadingKey(target.heading);
    const current = currentByKey.get(key);
    lines.push(regenerated.has(key) || current === undefined ? "(no current content)" : current.trimEnd());
    lines.push("CHANGES", ...planUpdateChangeLines(delta, target.field, steps));
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Every string a delta's prose supplies, scanned for `[[id]]` markers so a
 *  declared literal no marker references is rejected. */
function deltaLiteralTexts(delta: PlanUpdateBlueprint): string[] {
  const texts: string[] = [];
  if (delta.context !== undefined) texts.push(delta.context);
  for (const [, path, reason] of delta.files ?? []) texts.push(path, reason);
  for (const [, , , intent, preserve, doNot] of delta.steps ?? []) texts.push(intent, ...preserve, ...doNot);
  texts.push(...(delta.verification ?? []), ...(delta.assumptions ?? []));
  return texts;
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
    validateLiteralTable(delta.literals);
    validateLiteralUsage(delta.literals, deltaLiteralTexts(delta));
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
  return enforceLiteralFidelity(pi, ctx, writerModel, deltaFidelityTargets(delta, hydrated), delta.literals, expansion);
}

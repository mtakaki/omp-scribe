import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { DocBlueprint, PlanBlueprint, ScribeOperation } from "./types";
import { hydrateScribeStep, resolveScribeSteps, validateScribeBlueprint, type HydratedScribeStep, type ScribeStepResolved } from "./scribe-ir";
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
FILES - optional "path — reason" pointers, one per file the plan touches.
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

You are a renderer, not a planner.

Respond with "# <TITLE>", then these section headings in order:

## Context
2-4 sentences, expanded tersely from the CONTEXT block.

## Approach
One ordered bullet per APPROACH STEPS entry, in the order given. State the concrete edit — the target file, the line range or that it is a new file, and what changes, grounded in the hydrated snippet and the step's intent. Mention preserve/do-not constraints when the step lists any. Do not invent steps beyond the ones supplied.

## Critical files & anchors
One bullet per FILES entry, formatted as a backtick-quoted path then " — " then its reason. Omit this whole section, heading included, when the brief has no such block.

## Verification
One bullet per VERIFICATION entry.

## Assumptions & contingencies
One bullet per ASSUMPTIONS entry. Omit this whole section, heading included, when the brief has no such block.

Expand tersely into full sentences; never add content the brief does not supply.`;

export const DOC_WRITER_SYSTEM_PROMPT = `You expand compact JSON document outlines into complete Markdown documents. You receive one JSON object as the user message and must respond with ONLY the finished Markdown document: no preamble, no code fences, no commentary before or after.

Prefix the document with "# <title>" using the JSON "title" field, then for each entry in the JSON "sections" array emit one "## <heading>" heading followed by the bullets expanded tersely into full prose paragraphs. Preserve the section order exactly and never invent content beyond what the bullets supply.`;

export type ExpandResult =
  | { markdown: string; model: { provider: string; id: string }; usage: { input: number; output: number }; costUsd: number }
  | { error: string };

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

    let markdown = "";
    let writerUsage = { input: 0, output: 0 };
    let writerCostUsd = 0;
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = activeSession.subscribe(evt => {
        if (evt.type === "message_update" && evt.assistantMessageEvent.type === "text_delta") {
          markdown += evt.assistantMessageEvent.delta;
          return;
        }
        if (evt.type === "message_end" && evt.message.role === "assistant") {
          writerUsage = { input: writerUsage.input + evt.message.usage.input, output: writerUsage.output + evt.message.usage.output };
          writerCostUsd += (evt.message.usage.cost?.total ?? 0);
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

    markdown = markdown.trim();
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

/** Renders the writer model's user message for a plan: labelled plain text
 *  carrying the blueprint's metadata plus, for every step, its decoded file,
 *  operation label, line range, intent, preserve/doNot constraints, and the
 *  lines the extension hydrated for it. Blocks left empty are omitted,
 *  matching {@link WRITER_SYSTEM_PROMPT}'s "omit when the brief has no such
 *  block" rule exactly. */
export function buildPlanPromptText(blueprint: PlanBlueprint, steps: readonly HydratedScribeStep[]): string {
  const blocks: string[] = ["TITLE", blueprint.title, "", "CONTEXT", blueprint.context, "", "APPROACH STEPS"];
  steps.forEach(({ step, snippet }, index) => {
    blocks.push(`${index + 1}. ${step.filePath}`);
    blocks.push(`   operation: ${SCRIBE_OPERATION_LABELS[step.operation]}`);
    blocks.push(step.lineRange ? `   lines: ${step.lineRange.start}-${step.lineRange.end}` : "   lines: (new file)");
    blocks.push(`   intent: ${step.intent}`);
    if (step.preserve.length > 0) blocks.push(`   preserve: ${step.preserve.join("; ")}`);
    if (step.doNot.length > 0) blocks.push(`   do not: ${step.doNot.join("; ")}`);
    blocks.push("", "   source:", snippet.split("\n").map(line => `      ${line}`).join("\n"), "");
  });

  const appendBullets = (label: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    blocks.push(label, ...items.map(item => `- ${item}`), "");
  };
  appendBullets("FILES", blueprint.files.map(([, path, reason]) => `${path} — ${reason}`));
  appendBullets("VERIFICATION", blueprint.verification);
  appendBullets("ASSUMPTIONS", blueprint.assumptions);

  return `${blocks.join("\n").trimEnd()}\n`;
}

/** Runs a short-lived, tools-free nested session on `writerModelSpec` (or the
 *  `@smol` role if that fails to resolve) to expand `blueprint` into the final
 *  Markdown plan body, hydrating every step's referenced line range from disk
 *  first. Never writes to disk itself. */
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
  return runWriterExpansionWithRetry(pi, ctx, writerModel, WRITER_SYSTEM_PROMPT, buildPlanPromptText(blueprint, hydrated));
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

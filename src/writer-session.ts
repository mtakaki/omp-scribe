import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { DocBlueprint, PlanBlueprint } from "./types";
import { hydrateTadStep, parseTadLine, type HydratedTadStep, type TadStep } from "./tad";
import { resolveWriterModel } from "./config";

export const WRITER_SYSTEM_PROMPT = `You expand compact architecture blueprints into complete Markdown implementation plans. You receive one plain-text brief as the user message and must respond with ONLY the finished Markdown document: no preamble, no code fences, no commentary before or after.

The brief is labelled plain text:
TITLE - the plan title, to become the "# " heading.
CONTEXT - the ask and intended end state.
APPROACH STEPS - numbered steps. Each step prints its raw TAD (Tokenized Architectural Diff) line and a snippet of the file it targets:
    @path/to/file.ext:start[-end]{+|!|~}deps(dep/a.ts,dep/b.ts)#snake_case_intent
      @path         project-relative file the step edits
      :start-end    inclusive 1-based line range the step touches; a single line may be written as :N; absent when the file does not exist yet
      {+} add   {!} delete   {~} modify
      deps(...)     files whose contract this step depends on; may be empty
      #intent       the step's snake_case label
    A "snippet of <path>:" line is followed by the numbered current content of those lines, or by a parenthesised note saying nothing could be read (a file that does not exist yet, for example).
CRITICAL FILES - optional "path - reason" pointers.
VERIFICATION - optional concrete check bullets.
ASSUMPTIONS - optional user-overridable decisions.

Respond with "# <TITLE>", then these section headings in order:

## Context
2-4 sentences, expanded tersely from the CONTEXT block.

## Approach
One ordered bullet per APPROACH STEPS entry, in the order given. Decode each step: render its #intent as a short bolded label in prose words, then state the concrete edit - the target file, the line range or that it is a new file, and what changes - grounded in the hydrated snippet. Keep the bullet concrete when no snippet loaded, and name a step's deps when it lists any. Do not invent steps beyond the ones supplied.

## Critical files & anchors
One bullet per CRITICAL FILES entry, formatted as a backtick-quoted path then " — " then its reason. Omit this whole section, heading included, when the brief has no such block.

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

/** Renders the writer model's user message for a plan: labelled plain text
 *  carrying the blueprint's metadata plus, for every step, its raw TAD line and
 *  the lines the extension hydrated for it.  Blocks the blueprint left empty are
 *  omitted, matching {@link WRITER_SYSTEM_PROMPT}'s "omit when the brief has no
 *  such block" rule exactly. */
export function buildPlanPromptText(blueprint: PlanBlueprint, steps: readonly HydratedTadStep[]): string {
  const blocks: string[] = ["TITLE", blueprint.title, "", "CONTEXT", blueprint.context, "", "APPROACH STEPS"];
  steps.forEach(({ step, snippet }, index) => {
    blocks.push(`${index + 1}. ${step.raw}`, `snippet of ${step.filePath}:`, snippet, "");
  });

  const appendBullets = (label: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    blocks.push(label, ...items.map(item => `- ${item}`), "");
  };
  appendBullets("CRITICAL FILES", blueprint.criticalFiles.map(file => `${file.path} — ${file.reason}`));
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

  let steps: TadStep[];
  try {
    steps = blueprint.approach.map(parseTadLine);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (ctx.hasUI) {
    ctx.ui.notify(
      `Scribe: delegating plan-Markdown drafting to ${writerModel.provider}/${writerModel.id} (configurable via --scribe-writer-model).`,
      "info",
    );
  }

  const hydrated = await Promise.all(steps.map(step => hydrateTadStep(ctx.cwd, step)));
  return runWriterExpansion(pi, ctx, writerModel, WRITER_SYSTEM_PROMPT, buildPlanPromptText(blueprint, hydrated));
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
  return runWriterExpansion(
    pi,
    ctx,
    writerModel,
    DOC_WRITER_SYSTEM_PROMPT,
    JSON.stringify({ title: blueprint.title, sections: blueprint.sections }),
  );
}

/**
 * Writer session: spawns the nested cheap-model session and assembles the
 * plain-text brief it expands.
 */
import type { AgentSession } from "../agent/session";
import type { Model } from "@oh-my-pi/pi-catalog";

export interface WriterSessionOptions {
  model: Model;
  systemPrompt: string;
  cwd: string;
}

export interface WriterExpansion {
  markdown: string;
  inputTokens: number;
  outputTokens: number;
}

/** Accumulate the streamed completion of one nested-session prompt. */
export async function collectMarkdown(session: AgentSession, promptText: string): Promise<string> {
  let streamed = "";
  let whole = "";
  await new Promise<void>((resolve, reject) => {
    const unsubscribe = session.subscribe(event => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        streamed += event.assistantMessageEvent.delta;
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        whole = event.message.content
          .filter(part => part.type === "text")
          .map(part => part.text)
          .join("");
        return;
      }
      if (event.type === "agent_end" && event.isTerminal !== false) {
        unsubscribe();
        resolve();
      }
    });
    session.prompt(promptText).catch(reject);
  });
  return (whole || streamed).trim();
}

/** Run one expansion on a fresh nested session and dispose it afterwards. */
export async function runWriterSession(
  sdk: { createAgentSession: (options: WriterSessionOptions) => Promise<{ session: AgentSession }> },
  options: WriterSessionOptions,
  promptText: string,
): Promise<WriterExpansion> {
  const created = await sdk.createAgentSession(options);
  try {
    const markdown = await collectMarkdown(created.session, promptText);
    return { markdown, inputTokens: 0, outputTokens: 0 };
  } finally {
    await created.session.dispose();
  }
}

/** The numbered source block the brief prints under `source:`.
 *
 *  The hydrated lines are the part of the brief whose size the planner
 *  controls through its line ranges, so they are assembled here and reported
 *  separately from the rest of the brief's text. */
export function renderSourceBlock(lines: readonly string[], from = 1): string {
  return lines.map((line, index) => `${String(from + index).padStart(5)}| ${line}`).join("\n");
}

/** Assemble the writer brief from its labelled blocks. */
export function assembleBrief(blocks: ReadonlyArray<readonly [string, string]>): string {
  return blocks
    .filter(([, text]) => text.trim() !== "")
    .map(([label, text]) => `${label}\n${text}`)
    .join("\n\n")
    .concat("\n");
}

/** The token accounting a caller may attach to a finished expansion. */
export interface WriterTokenAccounting {
  system: number;
  brief: number;
  snippet: number;
  total: number;
}

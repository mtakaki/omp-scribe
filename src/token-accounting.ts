/**
 * Writer-pipeline token accounting.
 *
 * Every count this module reports comes from the host's own native tokenizer —
 * the same `countTokens` oh-my-pi uses for its context budget — so a
 * measurement of the writer payload is comparable with the host's numbers
 * instead of being a character estimate dressed up as one.
 *
 * The optional native package is imported through a variable specifier so
 * neither tsc nor a bundler resolves it statically: a missing platform addon
 * must degrade to the documented estimate and say so through `exact: false`,
 * never break extension load.
 */
import type { Model } from "@oh-my-pi/pi-catalog";

/** Module the native `countTokens` lives in. */
const NATIVE_TOKENIZER_MODULE = "@oh-my-pi/pi-natives";

/** Encoding the native tokenizer counts in when a model names no tokenizer of
 *  its own — the host's default (`O200kBase`, GPT-4o / o1 / GPT-5). */
export const DEFAULT_TOKEN_ENCODING = "O200kBase";

/** `Model.tokenizer` value -> native `Encoding` member.  Mirrors the host's
 *  tokenizer-to-encoding table member for member, so a count taken here equals
 *  one the host would take for the same model. */
const ENCODING_BY_TOKENIZER: Readonly<Record<string, string>> = {
  "claude-v3": "ClaudeV3",
  "claude-v47": "ClaudeV47",
  "claude-v5": "ClaudeV5",
  "claude-v5-sonnet": "ClaudeV5Sonnet",
  qwen3: "Qwen3",
  "deepseek-v3": "DeepSeekV3",
  "kimi-k2": "KimiK2",
  glm5: "Glm5",
};

/** The encoding content for `model` is counted in. */
export function encodingForModel(model: Pick<Model, "tokenizer"> | undefined): string {
  const tokenizer = model?.tokenizer;
  return (tokenizer === undefined ? undefined : ENCODING_BY_TOKENIZER[tokenizer]) ?? DEFAULT_TOKEN_ENCODING;
}

/** The slice of the native module this file uses. */
interface NativeTokenizerModule {
  countTokens(input: string | readonly string[], encoding?: string | null): number;
}

/** Counts text in one tokenizer encoding.  `encoding` is the encoding the count
 *  is exact in, or `null` when no native tokenizer resolved; `exact` is true
 *  only when the count came from that native tokenizer. */
export interface TokenCounter {
  count(text: string): number;
  encoding: string | null;
  exact: boolean;
}

/** Characters-per-token fallback used only when no native tokenizer resolves.
 *  Deliberately reports itself as inexact at the call site. */
export function estimateTextTokens(text: string): number {
  return Math.round(text.length / 4);
}

/** The native module's `countTokens`, or `undefined` when the optional
 *  platform package is absent or too old to export it.  Loaded through a
 *  variable specifier, not a static import: `@oh-my-pi/pi-natives` is an
 *  optional per-platform peer of the host, so a static import would make the
 *  extension fail to load on a machine whose addon is missing — and the
 *  diagnostic is the only caller.
 *
 *  In a bun-compiled host binary the host's own copy of this package is inlined
 *  at build time, so a bare specifier resolved from an externally loaded
 *  extension does not resolve: the counter reports `exact: false` there and the
 *  estimate is used.  Run the harness (`bun run measure`) with the dev runtime,
 *  where the addon does resolve, when an exact number matters. */
async function loadNativeTokenizer(): Promise<NativeTokenizerModule | undefined> {
  try {
    const module = (await import(NATIVE_TOKENIZER_MODULE)) as Partial<NativeTokenizerModule>;
    return typeof module.countTokens === "function" ? (module as NativeTokenizerModule) : undefined;
  } catch {
    return undefined;
  }
}

/** The counter for `model`'s encoding: exact when the native tokenizer resolves
 *  and accepts that encoding, an estimate otherwise. Never throws — a broken or
 *  unknown encoding is a diagnostic downgrade, not a failure. */
export async function resolveTokenCounter(model: Pick<Model, "tokenizer"> | undefined): Promise<TokenCounter> {
  const encoding = encodingForModel(model);
  const native = await loadNativeTokenizer();
  if (native !== undefined) {
    try {
      native.countTokens("", encoding);
      return { count: text => native.countTokens(text, encoding), encoding, exact: true };
    } catch {
      // An encoding this addon build does not know: fall through to the estimate.
    }
  }
  return { count: estimateTextTokens, encoding: null, exact: false };
}

/** Per-part token counts: each labelled part, their sum, and whether every part
 *  came from the native tokenizer. */
export interface TokenBreakdown {
  parts: Record<string, number>;
  total: number;
  encoding: string | null;
  exact: boolean;
}

/** Counts each part of a payload separately with the same counter, so a
 *  diagnostic can say which part carries the cost. */
export function tokenBreakdown(counter: TokenCounter, parts: Readonly<Record<string, string>>): TokenBreakdown {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const [label, text] of Object.entries(parts)) {
    const count = counter.count(text);
    counts[label] = count;
    total += count;
  }
  return { parts: counts, total, encoding: counter.encoding, exact: counter.exact };
}

/** Token counts for one writer expansion.  `snippet` is the part of `brief`
 *  that came from the hydrated source blocks; `total` is the whole writer input
 *  (system prompt plus brief). */
export interface TokenAccounting {
  system: number;
  brief: number;
  snippet: number;
  total: number;
  encoding: string | null;
  exact: boolean;
}

/** The accounting for one writer input, or `undefined` when counting itself
 *  fails — a diagnostic must never fail the expansion it measures. */
export async function accountWriterTokens(
  model: Pick<Model, "tokenizer"> | undefined,
  input: { system: string; brief: string; snippet: string },
): Promise<TokenAccounting | undefined> {
  try {
    const breakdown = tokenBreakdown(await resolveTokenCounter(model), {
      system: input.system,
      brief: input.brief,
      snippet: input.snippet,
    });
    const { system, brief, snippet } = breakdown.parts;
    return { system, brief, snippet, total: system + brief, encoding: breakdown.encoding, exact: breakdown.exact };
  } catch {
    return undefined;
  }
}

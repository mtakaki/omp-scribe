import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { estimateTextTokens } from "./token-accounting";

/** Project-relative path for the persisted savings stats JSON file. */
export const SAVINGS_STATS_RELATIVE_PATH = ".claude/plans/savings_stats.json";

/** One entry in the capped recent-run log.  All numeric fields mirror the
 *  values computed by {@link computeCosts} for that run. */
export interface SavingsRunLogEntry {
  timestamp: string;
  slug: string;
  /** Discriminates plan-mode from doc-blueprint-mode runs; absent in legacy entries (treat as "plan"). */
  mode?: "plan" | "doc";
  brainModel: string;
  writerModel: string;
  brainInputTokens: number;
  brainOutputTokens: number;
  writerInputTokens: number;
  writerOutputTokens: number;
  /** Estimated tokens the brain spent emitting the compact blueprint JSON instead
   *  of the document body; absent in legacy entries (treat as 0). */
  irOutputTokens?: number;
  /** Estimated tokens of the Markdown document the writer returned for this run,
   *  at ~4 characters per token (see {@link estimateTextTokens}).  Measures the
   *  returned document rather than the writer's raw `usage.output`, which is
   *  inflated by generation that never reached the returned Markdown.  Absent in
   *  legacy entries, which fall back to `writerOutputTokens`. */
  docOutputTokens?: number;
  /** Actual cost in USD charged by the writer model alone for this run
   *  (sourced from ExpandResult.costUsd); zero for local/free writer models. */
  writerCostUsd: number;
  actualCostUsd: number;
  baselineCostUsd: number;
  netSavingsUsd: number;
  /** `false` when at least one model was outside the hardcoded pricing table. */
  priced: boolean;
  /** `true` when `baselineCostUsd` was priced from the `@plan`-role reference
   *  model's rates because the live brain model had no catalog rate of its own;
   *  absent in legacy entries (treat as `false`). */
  baselineIsEstimate?: boolean;
  /** `[[lit:<id>]]` markers the extension substituted with their declared
   *  literal value, counted per occurrence.  Zero for a run that declared no
   *  table. */
  literalResolved?: number;
  /** LLM literal-repair rounds the fidelity gate ran for this run.  A declared
   *  literal the writer omitted is reported, never repaired, so the usual value
   *  is 0. */
  llmRepairCalls?: number;
  /** Input tokens those repair rounds spent; a subset of `writerInputTokens`. */
  llmRepairInputTokens?: number;
  /** Output tokens those repair rounds spent; a subset of `writerOutputTokens`. */
  llmRepairOutputTokens?: number;
}

/** Persisted cumulative stats plus a capped recent-run log.
 *  `runs` is capped at 200 entries, most-recent-first. */
export interface SavingsStatsFile {
  version: 1;
  totalRuns: number;
  totalUnpricedRuns: number;
  totalActualCostUsd: number;
  totalBaselineCostUsd: number;
  totalNetSavingsUsd: number;
  totalBrainInputTokens: number;
  totalBrainOutputTokens: number;
  totalWriterInputTokens: number;
  totalWriterOutputTokens: number;
  /** Count of plan-mode runs; optional for backward compat with pre-v1.1 files. */
  totalPlanRuns?: number;
  /** Count of doc-mode runs; optional for backward compat with pre-v1.1 files. */
  totalDocRuns?: number;
  /** Cumulative real dollars spent on writer/expansion across all runs. */
  totalWriterCostUsd?: number;
  /** Count of runs where writerCostUsd === 0 (local/free writer models). */
  totalFreeWriterRuns?: number;
  /** Count of runs where writerCostUsd > 0 (remote/paid writer models). */
  totalPaidWriterRuns?: number;
  /** Cumulative netSavingsUsd for free-writer runs — full cost offset. */
  totalFreeWriterNetSavingsUsd?: number;
  /** Cumulative netSavingsUsd for paid-writer runs — partial offset via cheaper service. */
  totalPaidWriterNetSavingsUsd?: number;
  /** Count of runs whose baseline was estimated from the `@plan`-role reference
   *  model; optional for backward compat with earlier files. */
  totalEstimatedBaselineRuns?: number;
  /** Cumulative blueprint tokens the brain emitted instead of the document
   *  body; optional for backward compat with earlier files. */
  totalIrOutputTokens?: number;
  /** Cumulative estimated tokens of the returned Markdown documents across all
   *  runs; optional for backward compat with earlier files, whose entries carry
   *  no per-run `docOutputTokens` and are measured by `writerOutputTokens`
   *  instead. */
  totalDocOutputTokens?: number;
  /** Total count of blueprint tool calls: incremented once per successful run
   *  in `appendSavingsRun` and once per failed call in `appendBlueprintFailure`.
   *  Required (not optional) — a pre-migration file missing this field fails
   *  `isSavingsStatsFile` and self-heals to a zeroed structure, since there is
   *  no way to backfill blueprint-call counts retroactively. */
  blueprintCallsTotal: number;
  /** Count of blueprint tool calls whose result was an error (the writer
   *  expansion failed). Required for the same reason as `blueprintCallsTotal`. */
  blueprintCallsFailed: number;
  /** Cumulative `[[lit:<id>]]` markers substituted deterministically; optional
   *  for backward compat with earlier files. */
  totalLiteralResolved?: number;
  /** Cumulative LLM literal-repair rounds; optional for backward compat. */
  totalLlmRepairCalls?: number;
  /** Cumulative input tokens spent on literal repair; optional for backward
   *  compat. */
  totalLlmRepairInputTokens?: number;
  /** Cumulative output tokens spent on literal repair; optional for backward
   *  compat. */
  totalLlmRepairOutputTokens?: number;
  /** Most-recent runs first; capped at 200. */
  runs: SavingsRunLogEntry[];
}

function emptyStatsFile(): SavingsStatsFile {
  return {
    version: 1,
    totalRuns: 0,
    totalUnpricedRuns: 0,
    totalActualCostUsd: 0,
    totalBaselineCostUsd: 0,
    totalNetSavingsUsd: 0,
    totalBrainInputTokens: 0,
    totalBrainOutputTokens: 0,
    totalWriterInputTokens: 0,
    totalWriterOutputTokens: 0,
    totalPlanRuns: 0,
    totalDocRuns: 0,
    totalWriterCostUsd: 0,
    totalFreeWriterRuns: 0,
    totalPaidWriterRuns: 0,
    totalFreeWriterNetSavingsUsd: 0,
    totalPaidWriterNetSavingsUsd: 0,
    totalEstimatedBaselineRuns: 0,
    totalIrOutputTokens: 0,
    totalDocOutputTokens: 0,
    blueprintCallsTotal: 0,
    blueprintCallsFailed: 0,
    totalLiteralResolved: 0,
    totalLlmRepairCalls: 0,
    totalLlmRepairInputTokens: 0,
    totalLlmRepairOutputTokens: 0,
    runs: [],
  };
}

function isSavingsStatsFile(value: unknown): value is SavingsStatsFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["version"] === 1 &&
    Array.isArray(v["runs"]) &&
    typeof v["totalRuns"] === "number" &&
    typeof v["blueprintCallsTotal"] === "number" &&
    typeof v["blueprintCallsFailed"] === "number"
  );
}

function statsFilePath(cwd: string): string {
  return join(cwd, SAVINGS_STATS_RELATIVE_PATH);
}

/** Sum the returned-document token estimate over `runs`, falling back to
 *  `writerOutputTokens` for legacy entries that predate `docOutputTokens`.
 *  Used to seed `totalDocOutputTokens` when a pre-existing ledger lacks it. */
function docTokensFromRuns(runs: SavingsRunLogEntry[]): number {
  return runs.reduce((sum, run) => sum + (run.docOutputTokens ?? run.writerOutputTokens), 0);
}

/** Read the persisted stats file.  Returns a clean zeroed structure on ENOENT,
 *  JSON parse error, or a schema mismatch — first run and corrupted state both
 *  self-heal without throwing. */
export async function readStatsFile(cwd: string): Promise<SavingsStatsFile> {
  try {
    const raw = await readFile(statsFilePath(cwd), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isSavingsStatsFile(parsed) ? parsed : emptyStatsFile();
  } catch {
    return emptyStatsFile();
  }
}

/** Atomically append one run entry to the stats file.
 *  Increments all running totals, prepends `entry` to `runs` (capped at 200),
 *  writes to a `.tmp-<pid>-<uuid>` sibling, then renames for crash safety.
 *  Returns the new accumulated stats. */
export async function appendSavingsRun(cwd: string, entry: SavingsRunLogEntry): Promise<SavingsStatsFile> {
  const current = await readStatsFile(cwd);
  const isDoc = entry.mode === "doc";
  const isFreeWriter = entry.writerCostUsd === 0;
  const next: SavingsStatsFile = {
    version: 1,
    totalRuns: current.totalRuns + 1,
    totalUnpricedRuns: current.totalUnpricedRuns + (entry.priced ? 0 : 1),
    totalActualCostUsd: current.totalActualCostUsd + entry.actualCostUsd,
    totalBaselineCostUsd: current.totalBaselineCostUsd + entry.baselineCostUsd,
    totalNetSavingsUsd: current.totalNetSavingsUsd + entry.netSavingsUsd,
    totalBrainInputTokens: current.totalBrainInputTokens + entry.brainInputTokens,
    totalBrainOutputTokens: current.totalBrainOutputTokens + entry.brainOutputTokens,
    totalWriterInputTokens: current.totalWriterInputTokens + entry.writerInputTokens,
    totalWriterOutputTokens: current.totalWriterOutputTokens + entry.writerOutputTokens,
    totalPlanRuns: (current.totalPlanRuns ?? 0) + (isDoc ? 0 : 1),
    totalDocRuns: (current.totalDocRuns ?? 0) + (isDoc ? 1 : 0),
    totalWriterCostUsd: (current.totalWriterCostUsd ?? 0) + entry.writerCostUsd,
    totalFreeWriterRuns: (current.totalFreeWriterRuns ?? 0) + (isFreeWriter ? 1 : 0),
    totalPaidWriterRuns: (current.totalPaidWriterRuns ?? 0) + (isFreeWriter ? 0 : 1),
    totalFreeWriterNetSavingsUsd: (current.totalFreeWriterNetSavingsUsd ?? 0) + (isFreeWriter ? entry.netSavingsUsd : 0),
    totalPaidWriterNetSavingsUsd: (current.totalPaidWriterNetSavingsUsd ?? 0) + (isFreeWriter ? 0 : entry.netSavingsUsd),
    totalEstimatedBaselineRuns: (current.totalEstimatedBaselineRuns ?? 0) + (entry.baselineIsEstimate ? 1 : 0),
    totalIrOutputTokens: (current.totalIrOutputTokens ?? 0) + (entry.irOutputTokens ?? 0),
    totalDocOutputTokens:
      (current.totalDocOutputTokens ?? docTokensFromRuns(current.runs)) +
      (entry.docOutputTokens ?? entry.writerOutputTokens),
    blueprintCallsTotal: current.blueprintCallsTotal + 1,
    blueprintCallsFailed: current.blueprintCallsFailed,
    totalLiteralResolved: (current.totalLiteralResolved ?? 0) + (entry.literalResolved ?? 0),
    totalLlmRepairCalls: (current.totalLlmRepairCalls ?? 0) + (entry.llmRepairCalls ?? 0),
    totalLlmRepairInputTokens: (current.totalLlmRepairInputTokens ?? 0) + (entry.llmRepairInputTokens ?? 0),
    totalLlmRepairOutputTokens: (current.totalLlmRepairOutputTokens ?? 0) + (entry.llmRepairOutputTokens ?? 0),
    runs: [entry, ...current.runs].slice(0, 200),
  };

  const target = statsFilePath(cwd);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, target);
  return next;
}

/** Atomically increments `blueprintCallsTotal` and `blueprintCallsFailed` for a
 *  blueprint tool call whose result was an error (the writer expansion failed
 *  before a run was ever logged via `appendSavingsRun`). Records only the
 *  counters — no content or arguments from the failed call. Uses the same
 *  tmp-sibling-then-rename atomic write pattern as `appendSavingsRun`. */
export async function appendBlueprintFailure(cwd: string): Promise<SavingsStatsFile> {
  const current = await readStatsFile(cwd);
  const next: SavingsStatsFile = {
    ...current,
    blueprintCallsTotal: current.blueprintCallsTotal + 1,
    blueprintCallsFailed: current.blueprintCallsFailed + 1,
  };

  const target = statsFilePath(cwd);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, target);
  return next;
}

// ─── Dashboard renderer ───────────────────────────────────────────────────────

const INNER = 64;
const H = "─".repeat(INNER);
const TOP = `╔${H}╗`;
const SEP = `╟${H}╢`;
const BOT = `╚${H}╝`;

function boxCenter(text: string): string {
  const pad = INNER - text.length;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return `║${" ".repeat(left)}${text}${" ".repeat(right)}║`;
}

/** A data row: label left-aligned with 2-space indent, value right-aligned
 *  with 2-space right margin; padding fills the gap to exactly INNER chars. */
function dataRow(label: string, value: string): string {
  const pad = Math.max(0, INNER - 4 - label.length - value.length);
  const content = `  ${label}${" ".repeat(pad)}${value}  `;
  return `║${content}║`;
}

/** The ~4-characters-per-token estimate the savings ledger measures with, owned
 *  by `src/token-accounting.ts` (where it is also the explicit fallback for a
 *  platform without the native tokenizer) and re-exported here so the ledger and
 *  its callers keep their existing import site. */
export { estimateTextTokens };

/** Estimated token count of a compact blueprint JSON payload, at ~4 characters
 *  per token.  Subtracted from the brain's output when reporting how much it
 *  would have emitted had it authored the document body itself, since the
 *  blueprint exists only because of scribe. */
export function estimateBlueprintTokens(blueprint: unknown): number {
  return estimateTextTokens(JSON.stringify(blueprint));
}

/** Render a full ASCII dashboard of `stats` as a multi-line string.
 *
 *  Box outer width: 66 chars (64 inner + 2 border columns).
 *  Box characters: `╔`/`╗`/`╚`/`╝` corners, `║` verticals, `╟`/`╢` T-junctions,
 *  `─` horizontals for top/separator/bottom rules. */
export function formatSavingsDashboard(stats: SavingsStatsFile): string {
  const avgSavings = stats.totalRuns > 0 ? stats.totalNetSavingsUsd / stats.totalRuns : 0;
  const estimatedRuns = stats.totalEstimatedBaselineRuns ?? 0;
  /** Aggregate savings carry a `~` while any contributing baseline is an estimate. */
  const estimateMark = estimatedRuns > 0 ? "~" : "";
  /** Blueprint tokens the brain emitted in place of the document body. */
  const blueprintOutputTokens = stats.totalIrOutputTokens ?? 0;
  /** The returned document's estimated tokens; legacy ledgers without the total
   *  are seeded from the recent-run log, falling back to `writerOutputTokens`. */
  const documentOutputTokens = stats.totalDocOutputTokens ?? docTokensFromRuns(stats.runs);
  /** Without scribe the brain emits the document body in place of the blueprint,
   *  so re-add the returned document's tokens and drop what the blueprint cost. */
  const estimatedBrainOutputTokens =
    stats.totalBrainOutputTokens - blueprintOutputTokens + documentOutputTokens;
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const num = (n: number) => n.toLocaleString("en-US");
  const blueprintCallsTotal = stats.blueprintCallsTotal ?? 0;
  const blueprintCallsFailed = stats.blueprintCallsFailed ?? 0;
  const blueprintCallsPassed = blueprintCallsTotal - blueprintCallsFailed;
  const blueprintReliability =
    blueprintCallsTotal === 0
      ? "n/a"
      : `${num(blueprintCallsPassed)}/${num(blueprintCallsTotal)} (${Math.round((blueprintCallsPassed / blueprintCallsTotal) * 100)}%)`;

  const lines: string[] = [
    TOP,
    boxCenter("SCRIBE COST-SAVINGS DASHBOARD"),
    SEP,
    dataRow("Total plan-mode runs", num(stats.totalPlanRuns ?? 0)),
    dataRow("Total doc-mode runs", num(stats.totalDocRuns ?? 0)),
    dataRow("Total actual cost", usd(stats.totalActualCostUsd)),
    dataRow("Total baseline cost (est.)", usd(stats.totalBaselineCostUsd)),
    dataRow("Total net savings", `${estimateMark}${usd(stats.totalNetSavingsUsd)}`),
    dataRow("Avg. savings / run", `${estimateMark}${usd(avgSavings)}`),
    dataRow("Baseline via @plan-role estimate", num(estimatedRuns)),
    dataRow("Blueprint reliability (first-try)", blueprintReliability),
    SEP,
    dataRow("Brain tokens input", num(stats.totalBrainInputTokens)),
    dataRow("Brain tokens output", num(stats.totalBrainOutputTokens)),
    dataRow("Writer tokens input", num(stats.totalWriterInputTokens)),
    dataRow("Writer tokens output", num(stats.totalWriterOutputTokens)),
    dataRow("Blueprint tokens (brain, est.)", num(blueprintOutputTokens)),
    dataRow("Delegated doc tokens (est.)", num(documentOutputTokens)),
    dataRow("Literals resolved (deterministic)", num(stats.totalLiteralResolved ?? 0)),
    dataRow("LLM literal-repair calls", num(stats.totalLlmRepairCalls ?? 0)),
    dataRow(
      "LLM repair tokens (in+out)",
      num((stats.totalLlmRepairInputTokens ?? 0) + (stats.totalLlmRepairOutputTokens ?? 0)),
    ),
    dataRow("Estimated brain tokens output without scribe", num(estimatedBrainOutputTokens)),
    SEP,
    dataRow("Free/local writer runs", num(stats.totalFreeWriterRuns ?? 0)),
    dataRow("Paid (remote) writer runs", num(stats.totalPaidWriterRuns ?? 0)),
    dataRow("Writer spend (paid runs)", usd(stats.totalWriterCostUsd ?? 0)),
    dataRow("Savings via free writer", `${estimateMark}${usd(stats.totalFreeWriterNetSavingsUsd ?? 0)}`),
    dataRow("Savings via paid writer", `${estimateMark}${usd(stats.totalPaidWriterNetSavingsUsd ?? 0)}`),
  ];

  if (stats.runs.length > 0) {
    lines.push(SEP);
    lines.push(dataRow("Recent runs:", ""));
    for (const run of stats.runs.slice(0, 5)) {
      const date = run.timestamp.slice(0, 10);
      const slug = run.slug.length > 28 ? `${run.slug.slice(0, 25)}...` : run.slug;
      const savings = run.baselineIsEstimate ? `~${usd(run.netSavingsUsd)}` : run.priced ? usd(run.netSavingsUsd) : "unpriced";
      lines.push(dataRow(`  ${date}  ${slug}`, savings));
    }
  }

  lines.push(BOT);

  if (stats.totalUnpricedRuns > 0) {
    lines.push(
      `⚠  ${stats.totalUnpricedRuns} run(s) used a brain model with no known per-token output rate in the catalog ` +
        `(e.g. a local/custom model); their baseline (and net savings) is recorded as $0.00 unless an @plan-role estimate replaced it — real baseline may be higher.`,
    );
  }

  if (estimatedRuns > 0) {
    lines.push(
      `ℹ  ${estimatedRuns} run(s) had no catalog rate for the live brain model, so their baseline was priced from the ` +
        `@plan-role reference model's rates; savings marked "~$" are estimates, not billed amounts.`,
    );
  }

  lines.push(
    `ℹ  "Writer tokens output" is the writer model's raw usage, which includes generation that never reached the ` +
      `returned document; "Delegated doc tokens (est.)" measures the Markdown actually returned (~4 chars/token), and the ` +
      `without-scribe row uses that figure.`,
  );

  lines.push(
    `ℹ  Literals are declared in the planner's "literals" table and referenced as [[lit:<id>]] markers, so the extension ` +
      `substitutes them deterministically; an LLM literal-repair call runs only for a literal the planner never declared.`,
  );

  return lines.join("\n");
}

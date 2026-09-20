import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

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
    runs: [],
  };
}

function isSavingsStatsFile(value: unknown): value is SavingsStatsFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["version"] === 1 && Array.isArray(v["runs"]) && typeof v["totalRuns"] === "number";
}

function statsFilePath(cwd: string): string {
  return join(cwd, SAVINGS_STATS_RELATIVE_PATH);
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
    runs: [entry, ...current.runs].slice(0, 200),
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
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const num = (n: number) => n.toLocaleString("en-US");

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
    SEP,
    dataRow("Brain tokens input", num(stats.totalBrainInputTokens)),
    dataRow("Brain tokens output", num(stats.totalBrainOutputTokens)),
    dataRow("Writer tokens input", num(stats.totalWriterInputTokens)),
    dataRow("Writer tokens output", num(stats.totalWriterOutputTokens)),
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

  return lines.join("\n");
}

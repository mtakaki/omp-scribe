export interface CostComputationInput {
  /** Total actual brain model cost in USD (sourced from `usage.cost.total`; includes
   *  input, output, cache-read, and cache-write components). */
  brainActualTotalCostUsd: number;
  /** Total actual writer model cost in USD (sourced from `usage.cost.total` in the
   *  nested writer session). */
  writerActualCostUsd: number;
  /** Brain model's per-million-token output rate in USD, taken from the resolved
   *  `Model.cost.output` field.  Zero when the model has no known catalog rate
   *  (e.g. a local/custom model), in which case `priced` will be `false`. */
  brainOutputRatePerMillionUsd: number;
  /** Actual token count the writer model spent emitting the final Markdown
   *  (sourced from `usage.output` in the nested writer session).  The baseline
   *  prices these tokens at the brain model's output rate, since the brain model
   *  would have had to output them itself. */
  writerOutputTokens: number;
  /** Total input token count the brain model spent this turn (sourced from
   *  `usage.input`).  Consulted only by the fallback baseline estimate, which
   *  prices these tokens at the reference model's input rate. */
  brainInputTokens: number;
  /** Reference model's (`@plan` role) per-million-token input rate in USD, or 0
   *  when the reference model is unavailable.  Consulted only when the live
   *  brain model has no catalog output rate of its own. */
  referenceInputRatePerMillionUsd: number;
  /** Reference model's (`@plan` role) per-million-token output rate in USD, or 0
   *  when the reference model is unavailable.  Consulted only when the live
   *  brain model has no catalog output rate of its own. */
  referenceOutputRatePerMillionUsd: number;
}

export interface CostComputationResult {
  /** Sum of brain + writer model actual costs in USD. */
  actualCostUsd: number;
  /** Simulated cost if the brain model had authored the Markdown itself. */
  baselineCostUsd: number;
  /** `max(0, baseline - actual)` — the estimated net saving for this run. */
  netSavingsUsd: number;
  /** `true` when the brain model has a known per-token output rate in the catalog.
   *  `false` means the brain model is free/local/unknown and the baseline is a
   *  lower bound rather than an accurate figure. */
  priced: boolean;
  /** `true` when `baselineCostUsd` was priced from the reference model's
   *  (`@plan` role) rates because the live brain model itself has no catalog
   *  output rate.  `false` on the priced path and whenever no reference rates
   *  were available, in which case the baseline stays a lower bound. */
  baselineIsEstimate: boolean;
}

/** Compute the cost figures for a single Scribe plan-mode run.
 *
 *  Costs are sourced directly from oh-my-pi's `usage.cost` fields rather than
 *  a hardcoded pricing table, so local and custom models correctly register
 *  as free instead of being misidentified by fuzzy model-id matching.
 *
 *  The baseline simulates what the brain model would have charged had it authored
 *  the expanded Markdown itself: the brain's own actual turn cost, plus the
 *  writer's real output token count priced at the brain model's per-million
 *  output rate.
 *
 *  Because both the baseline and the actual cost carry the brain's identical
 *  exploration/thinking turn cost, that shared component cancels out of
 *  `baseline - actual`, leaving only the delegation delta: what the brain would
 *  have paid to emit the writer's tokens minus what the writer actually charged.
 *  Pricing the baseline from the brain's input cost alone instead kept the shared
 *  output cost on the actual side only, which forced the baseline below the
 *  actual cost and clamped every run's net savings to $0.00.
 *
 *  When `brainOutputRatePerMillionUsd` is zero, `priced` is `false`.  If the
 *  reference model's rates are available, the baseline is instead priced from
 *  them — the brain's input tokens at the reference input rate plus the writer's
 *  output tokens at the reference output rate — and `baselineIsEstimate` is
 *  `true`, so an unpriced live model still reports a nonzero estimated baseline
 *  instead of collapsing net savings to $0.00.  Without reference rates the
 *  baseline reduces to `brainActualTotalCostUsd` alone (lower bound). */
export function computeCosts(input: CostComputationInput): CostComputationResult {
  const actualCostUsd = input.brainActualTotalCostUsd + input.writerActualCostUsd;
  const priced = input.brainOutputRatePerMillionUsd !== 0;
  const hasReferenceRates =
    input.referenceInputRatePerMillionUsd !== 0 || input.referenceOutputRatePerMillionUsd !== 0;
  const baselineIsEstimate = !priced && hasReferenceRates;
  const baselineCostUsd = baselineIsEstimate
    ? (input.brainInputTokens * input.referenceInputRatePerMillionUsd
        + input.writerOutputTokens * input.referenceOutputRatePerMillionUsd) / 1e6
    : input.brainActualTotalCostUsd
      + (input.writerOutputTokens * input.brainOutputRatePerMillionUsd) / 1e6;
  const netSavingsUsd = Math.max(0, baselineCostUsd - actualCostUsd);
  return { actualCostUsd, baselineCostUsd, netSavingsUsd, priced, baselineIsEstimate };
}

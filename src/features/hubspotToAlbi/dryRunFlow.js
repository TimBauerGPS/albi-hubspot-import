export function dryRunActions({ state, live, fullDryRunCompleted, sample }) {
  const inDryRun = state === 'dry_run' && !live
  const clean = sample?.reviewCapable === true && sample?.fullDryRunReady === true
  const rechecksComplete = sample?.reviewCapable === true && sample.total > 0 && sample.needsReview === 0
  return {
    showStartSample: !inDryRun && !live,
    showRetrySample: inDryRun && !fullDryRunCompleted && !sample,
    showReview: inDryRun && !fullDryRunCompleted && sample?.reviewCapable === true && sample.needsReview > 0,
    showVerifySample: inDryRun && !fullDryRunCompleted && (rechecksComplete || sample?.reviewCapable === false),
    showFull: inDryRun && !fullDryRunCompleted && clean,
  }
}

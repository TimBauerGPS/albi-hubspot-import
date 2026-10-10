export function dryRunActions({ state, live, dryRunReady, sampleDryRunReady }) {
  const awaitingFullDryRun = state === 'dry_run' && !dryRunReady
  return {
    showStartSample: state !== 'dry_run' && !live,
    showRetrySample: awaitingFullDryRun && !sampleDryRunReady,
    showSampleAndFull: awaitingFullDryRun && sampleDryRunReady,
  }
}

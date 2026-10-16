/** Run the production scan/presentation lifecycle with a recoverable review fallback. */
export async function runScanLifecycle({
  analyze,
  present,
  recover,
  fail,
  settle,
  isCurrent = () => true
}) {
  let completedAnalysis = null;
  try {
    const analysis = await analyze(value => { completedAnalysis = value; });
    if (!isCurrent()) return { status: 'stale' };
    completedAnalysis ||= analysis;
    await present(analysis);
    return { status: 'presented', analysis };
  } catch (initialError) {
    if (initialError?.name === 'AbortError' || !isCurrent()) return { status: 'cancelled' };
    let error = initialError;
    if (completedAnalysis) {
      try {
        if (await recover(completedAnalysis, error)) return { status: 'recovered', analysis: completedAnalysis };
      } catch (recoveryError) {
        error = recoveryError;
      }
    }
    await fail(error, completedAnalysis);
    return { status: 'failed', error };
  } finally {
    if (isCurrent()) {
      try { await settle(); } catch { /* settlement must not create an unhandled scan rejection */ }
    }
  }
}

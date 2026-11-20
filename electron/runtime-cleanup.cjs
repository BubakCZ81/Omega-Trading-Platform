function createRuntimeCleanup({ stopLocalModels, cancelAiCompletions, disconnectProviders }) {
  let cleanupPromise;
  return () => {
    if (!cleanupPromise) {
      cleanupPromise = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([
          stopLocalModels,
          cancelAiCompletions,
          disconnectProviders,
        ].map(cleanup => {
          try {
            return Promise.resolve(cleanup());
          } catch (error) {
            return Promise.reject(error);
          }
        }));
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, 'Runtime cleanup did not complete successfully.');
      });
    }
    return cleanupPromise;
  };
}

module.exports = { createRuntimeCleanup };

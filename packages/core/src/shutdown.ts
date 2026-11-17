export function installShutdown(close: () => Promise<void>): void {
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => {
        console.error('Graceful shutdown timed out');
        process.exit(1);
      }, 10_000);
      deadline.unref();
      void close().then(() => {
        clearTimeout(deadline);
      }).catch(() => {
        console.error('Graceful shutdown failed');
        process.exitCode = 1;
      });
    });
  }
}

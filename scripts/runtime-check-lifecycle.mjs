// Allow the E2E runner and CI cancellation to close the native host before
// removing temporary credentials, databases and attachments.
export function cleanupOnSignal(cleanup) {
  const handlers = new Map(
    [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ].map(([signal, code]) => [
      signal,
      () => {
        void cleanup().finally(() => process.exit(code));
      },
    ]),
  );
  for (const [signal, handler] of handlers) process.once(signal, handler);
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

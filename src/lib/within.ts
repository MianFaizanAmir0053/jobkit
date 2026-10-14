/**
 * The promise's value, or a throw naming the step once `ms` pass first. The
 * step itself is not stopped: use it for a step that may hang and that has
 * no way to be aborted, and that changes nothing outside if it ends later.
 */
export function within<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${step} took longer than ${ms / 1000} seconds`)),
      ms,
    );
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

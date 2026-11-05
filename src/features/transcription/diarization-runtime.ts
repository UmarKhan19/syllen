export function withCpuThreads<T extends { loadAndCompile: (...args: never[]) => unknown }>(
  runtime: T,
  cpuThreads: number,
): T {
  const loadAndCompile = runtime.loadAndCompile.bind(runtime) as (...args: unknown[]) => unknown;
  return {
    ...runtime,
    loadAndCompile: ((source: unknown, options: Record<string, unknown>) =>
      loadAndCompile(source, {
        ...options,
        cpuOptions: { numThreads: cpuThreads },
      })) as T["loadAndCompile"],
  };
}

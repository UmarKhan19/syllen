export function parseCpuThreads(value, available = 1) {
  if (value === undefined) return Math.max(1, Math.floor(available / 2));
  if (!/^[1-9]\d*$/.test(value)) throw new Error("SYLLEN_CPU_THREADS must be a positive integer");
  const threads = Number(value);
  if (!Number.isSafeInteger(threads)) throw new Error("SYLLEN_CPU_THREADS must be a safe integer");
  return Math.min(threads, Number.isFinite(available) ? Math.max(1, Math.floor(available)) : 1);
}

export function withCpuThreadLimit(ort, threads) {
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error("Invalid CPU thread limit");
  return new Proxy(ort, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== "InferenceSession" || !value) return value;
      return new Proxy(value, {
        get(session, method, sessionReceiver) {
          const original = Reflect.get(session, method, sessionReceiver);
          if (method !== "create" || typeof original !== "function") return original;
          return (model, options = {}) =>
            Reflect.apply(original, session, [
              model,
              {
                ...options,
                intraOpNumThreads: threads,
                interOpNumThreads: 1,
              },
            ]);
        },
      });
    },
  });
}

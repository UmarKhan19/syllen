import { describe, expect, it } from "vitest";
import config from "../../src-tauri/tauri.conf.json";

describe("Tauri security configuration", () => {
  it("limits asset protocol access to library and per-job WAV files", () => {
    expect(config.app.security.assetProtocol).toEqual({
      enable: true,
      scope: ["$APPDATA/library/*.wav", "$APPCACHE/jobs/*/*.wav"],
    });
  });

  it("keeps a restrictive CSP without unsafe-eval or remote scripts", () => {
    const csp = config.app.security.csp;
    expect(csp).not.toBeNull();
    expect(csp).toContain("default-src 'self'");
    const connectSrc = csp
      .split(";")
      .find((directive) => directive.trimStart().startsWith("connect-src "));
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain("asset://localhost");
    expect(connectSrc).toContain("http://asset.localhost");
    expect(csp).toMatch(/(?:^|;\s*)script-src 'self' 'wasm-unsafe-eval'(?:;|$)/);
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("https://huggingface.co");
    expect(csp).not.toMatch(/(?:^|\s)'unsafe-eval'(?:\s|;|$)/);
  });
});

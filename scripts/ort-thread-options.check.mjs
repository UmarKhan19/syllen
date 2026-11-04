import assert from "node:assert/strict";
import test from "node:test";
import { parseCpuThreads, withCpuThreadLimit } from "../src-tauri/sidecar/ort-thread-options.mjs";

test("thread count defaults balanced and rejects malformed or excessive values", () => {
  assert.equal(parseCpuThreads(undefined, 5), 2);
  assert.equal(parseCpuThreads("1", 5), 1);
  for (const value of ["0", "-1", "1.5", "2x", "9007199254740992"]) {
    assert.throws(() => parseCpuThreads(value, 5));
  }
  assert.throws(() => parseCpuThreads("6", 5));
});

test("all model sessions get bounded native options while module APIs are preserved", async () => {
  const calls = [];
  const original = async function (model, options) {
    assert.equal(this, ort.InferenceSession);
    calls.push([model, options]);
    return "session";
  };
  const ort = {
    Tensor: class Tensor {},
    InferenceSession: { create: original, marker: 7 },
    env: { wasm: {} },
  };
  const bounded = withCpuThreadLimit(ort, 3);
  assert.equal(bounded.Tensor, ort.Tensor);
  assert.equal(bounded.env, ort.env);
  assert.equal(bounded.InferenceSession.marker, 7);
  await bounded.InferenceSession.create("encoder", {
    executionProviders: ["cpu"],
    extra: { existing: "yes" },
  });
  await bounded.InferenceSession.create("decoder");
  assert.equal(calls.length, 2);
  for (const [, options] of calls) {
    assert.equal(options.intraOpNumThreads, 3);
    assert.equal(options.interOpNumThreads, 1);
    assert.equal(options.extra.session["session.intra_op.allow_spinning"], "0");
    assert.equal(options.extra.session["session.inter_op.allow_spinning"], "0");
  }
  assert.equal(calls[0][1].extra.existing, "yes");
  assert.equal(calls[0][1].executionProviders[0], "cpu");
  assert.equal(ort.InferenceSession.create, original);
});

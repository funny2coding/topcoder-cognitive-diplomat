import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

test("machine-readable requirement mapping is complete", () => {
  const mapping = JSON.parse(readFileSync(new URL("../requirement-mapping.json", import.meta.url), "utf8")) as {
    requirementMapping: Record<string, { status: string; evidence: string[] }>;
    strictnessChecks: Record<string, unknown>;
  };

  for (const id of ["REQ_01", "REQ_02", "REQ_03", "REQ_04", "REQ_05", "REQ_06", "REQ_07", "REQ_08", "REQ_09"]) {
    assert.equal(mapping.requirementMapping[id].status, "implemented");
    assert.ok(mapping.requirementMapping[id].evidence.length > 0);
  }

  assert.equal(mapping.strictnessChecks.endpoint, "POST /v1/predict");
  assert.equal(mapping.strictnessChecks.personaCount, 3);
  assert.equal(mapping.strictnessChecks.parallelPersonaFanout, true);
  assert.equal(mapping.strictnessChecks.synthesisTemperature, 0);
  assert.equal(mapping.strictnessChecks.synthesisSeed, 424242);
});

test("expected source files are present", () => {
  const root = new URL("../", import.meta.url);
  for (const path of ["server.ts", "predictor.ts", "llm.ts", "rag.ts", "memory.ts", "data/domain/conversations_playbook.md"]) {
    assert.equal(existsSync(new URL(path, root)), true, `${path} should exist`);
  }
});

test("package manifest declares review fields", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    strictnessChecks: Record<string, unknown>;
    requirementMapping: Record<string, string>;
  };
  assert.equal(manifest.strictnessChecks.externalDependenciesRequired, false);
  assert.equal(manifest.strictnessChecks.personaCount, 3);
  assert.ok(manifest.requirementMapping.REQ_01_predict_api.includes("/v1/predict"));
});

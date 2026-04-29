import test from "node:test";
import assert from "node:assert/strict";
import { RequestMemory } from "../memory.ts";

test("request memory stores isolated per-request traces", () => {
  const first = new RequestMemory();
  const second = new RequestMemory();

  first.add("persona_output", { persona: "price-discipline" });
  second.add("synthesis", { intent: "counter_offer" });

  assert.equal(first.snapshot().length, 1);
  assert.equal(second.snapshot().length, 1);
  assert.equal(first.snapshot()[0].type, "persona_output");
  assert.equal(second.snapshot()[0].type, "synthesis");
});

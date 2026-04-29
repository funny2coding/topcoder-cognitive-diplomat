import test from "node:test";
import assert from "node:assert/strict";
import { analyzeConversation, heuristicPrediction } from "../heuristics.ts";
import { predictNextTurn } from "../predictor.ts";
import { retrievePlaybookChunks } from "../rag.ts";
import { validatePredictRequest } from "../validation.ts";
import type { LlmChatRequest, LlmChatResult } from "../llm.ts";

test("validation rejects non-alternating turns", () => {
  assert.throws(
    () =>
      validatePredictRequest({
        model: "gemma4:e2b",
        conversation: [
          { role: "buyer", content: "Is it available?" },
          { role: "buyer", content: "Can I pick it up?" }
        ]
      }),
    (error: unknown) => error instanceof Error && "details" in error && String(error.details).includes("alternate")
  );
});

test("heuristic counters a live buyer offer", () => {
  const analysis = analyzeConversation([
    { role: "seller", content: "I am asking $120." },
    { role: "buyer", content: "Would you take $80?" }
  ]);
  const prediction = heuristicPrediction(analysis);
  assert.equal(analysis.nextRole, "seller");
  assert.equal(prediction.intent, "counter_offer");
  assert.match(prediction.message, /\$/);
});

test("heuristic treats distant firm prices as rejection risk", () => {
  const analysis = analyzeConversation([
    { role: "buyer", content: "Could you do $100?" },
    { role: "seller", content: "No, $180 is my final price." }
  ]);
  const prediction = heuristicPrediction(analysis);
  assert.equal(prediction.intent, "reject");
});

test("RAG retrieves price playbook chunks for priced turns", () => {
  const analysis = analyzeConversation([
    { role: "seller", content: "I listed it for $200." },
    { role: "buyer", content: "Can you do $150?" }
  ]);
  const chunks = retrievePlaybookChunks(analysis, 2);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.some((chunk) => /price|counter|offer/i.test(chunk.content)));
});

test("predictor returns valid schema and uses three parallel persona agents before synthesis", async () => {
  const labels: string[] = [];
  const personaStartTimes: number[] = [];
  let synthesisSawPersonaCount = 0;

  const mockChat = async (request: LlmChatRequest): Promise<LlmChatResult> => {
    labels.push(request.label);
    if (request.label.startsWith("persona:")) {
      personaStartTimes.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        content: JSON.stringify({
          prediction: "I could do $100 if you can pick it up today.",
          intent_class: "counter_offer",
          confidence: 0.72,
          reasoning: "Buyer offer is below ask, so seller counters."
        }),
        duration_ms: 20,
        provider: "ollama",
        tokens: { prompt: 8, completion: 5, total: 13 }
      };
    }

    assert.equal(request.label, "synthesis");
    assert.equal(request.temperature, 0);
    assert.equal(request.seed, 424242);
    synthesisSawPersonaCount = labels.filter((label) => label.startsWith("persona:")).length;
    return {
      content: JSON.stringify({
        predicted_next_message: "I could do $100 if you can pick it up today.",
        predicted_intent_class: "counter_offer",
        confidence: 0.78,
        reasoning: "All personas select a seller counter."
      }),
      duration_ms: 1,
      provider: "ollama",
      tokens: { prompt: 10, completion: 6, total: 16 }
    };
  };

  const response = await predictNextTurn(
    {
      model: "gemma4:e2b",
      conversation: [
        { role: "seller", content: "I am asking $120." },
        { role: "buyer", content: "Could you do $80?" }
      ]
    },
    { chat: mockChat }
  );

  assert.equal(response.predicted_intent_class, "counter_offer");
  assert.equal(response.persona_predictions.length, 3);
  assert.equal(new Set(response.persona_predictions.map((item) => item.persona)).size, 3);
  assert.ok(response.confidence >= 0 && response.confidence <= 1);
  assert.equal(synthesisSawPersonaCount, 3);
  assert.ok(Math.max(...personaStartTimes) - Math.min(...personaStartTimes) < 75);
});

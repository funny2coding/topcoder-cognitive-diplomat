import { performance } from "node:perf_hooks";
import {
  acceptanceMessage,
  clampConfidence,
  classifyIntentFromMessage,
  containsAcceptanceSignal,
  containsRejectSignal,
  counterMessage,
  fallbackCounterMessage,
  hasPriceLikeText,
  heuristicPrediction,
  inquiryMessage,
  rejectionMessage,
  analyzeConversation
} from "./heuristics.ts";
import { addTokenUsage, chatCompletion, ZERO_TOKENS, type LlmChatRequest, type LlmChatResult } from "./llm.ts";
import { RequestMemory } from "./memory.ts";
import { retrievePlaybookChunks, type RetrievedChunk } from "./rag.ts";
import { INTENT_CLASSES, type ConversationAnalysis, type HeuristicPrediction, type IntentClass, type PredictRequest, type PredictResponse, type TokenUsage } from "./types.ts";

interface PersonaDefinition {
  persona: string;
  seed: number;
  temperature: number;
  stance: string;
}

interface PersonaAgentResult {
  persona: string;
  prediction: string;
  reasoning: string;
  intent_class: IntentClass;
  confidence: number;
  tokens: TokenUsage;
  raw: string;
}

interface SynthesisResult {
  predicted_next_message: string;
  predicted_intent_class: IntentClass;
  confidence: number;
  reasoning: string;
  tokens: TokenUsage;
  raw: string;
}

export interface PredictorOptions {
  chat?: (request: LlmChatRequest) => Promise<LlmChatResult>;
}

const PERSONAS: PersonaDefinition[] = [
  {
    persona: "price-discipline",
    seed: 11001,
    temperature: 0,
    stance: "Predict the next speaker's price-protecting move. Prefer counters or firm pushback when the gap is meaningful."
  },
  {
    persona: "friendly-pragmatist",
    seed: 22002,
    temperature: 0,
    stance: "Predict a natural casual marketplace reply that keeps the conversation moving and answers practical questions."
  },
  {
    persona: "deal-closer",
    seed: 33003,
    temperature: 0,
    stance: "Predict the shortest reply likely to close soon. Accept close offers or make the smallest useful concession."
  }
];

const SYNTHESIS_SEED = 424242;

export async function predictNextTurn(input: PredictRequest, options: PredictorOptions = {}): Promise<PredictResponse> {
  const started = performance.now();
  const chat = options.chat ?? chatCompletion;
  const memory = new RequestMemory();
  const analysis = analyzeConversation(input.conversation);
  const retrieved = retrievePlaybookChunks(analysis, 3);
  const heuristic = heuristicPrediction(analysis);

  memory.add("analysis", summarizeAnalysis(analysis));
  memory.add("rag", retrieved.map((chunk) => ({ id: chunk.id, title: chunk.title, score: chunk.score })));
  memory.add("heuristic", heuristic);

  // Required fan-out: exactly three independent persona LLM agents are launched together.
  const personaResults = await Promise.all(
    PERSONAS.map((persona) => runPersonaAgent({ persona, input, analysis, retrieved, heuristic, chat }))
  );

  for (const result of personaResults) {
    memory.add("persona_output", {
      persona: result.persona,
      prediction: result.prediction,
      intent_class: result.intent_class,
      confidence: result.confidence,
      reasoning: result.reasoning
    });
  }

  const synthesis = await runSynthesisAgent({ input, analysis, retrieved, heuristic, personaResults, chat });
  const final = postProcessFinal(synthesis, personaResults, heuristic, analysis);
  memory.add("synthesis", { raw: synthesis.raw, normalized: final, trace_length: memory.snapshot().length });

  const tokens = [...personaResults.map((result) => result.tokens), synthesis.tokens].reduce(addTokenUsage, ZERO_TOKENS);
  return {
    predicted_next_message: final.predicted_next_message,
    predicted_intent_class: final.predicted_intent_class,
    confidence: final.confidence,
    persona_predictions: personaResults.map((result) => ({
      persona: result.persona,
      prediction: result.prediction,
      reasoning: result.reasoning
    })),
    metadata: {
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
      tokens_used: tokens,
      model: input.model
    }
  };
}

async function runPersonaAgent(args: {
  persona: PersonaDefinition;
  input: PredictRequest;
  analysis: ConversationAnalysis;
  retrieved: RetrievedChunk[];
  heuristic: HeuristicPrediction;
  chat: (request: LlmChatRequest) => Promise<LlmChatResult>;
}): Promise<PersonaAgentResult> {
  const { persona, input, analysis, retrieved, heuristic, chat } = args;
  try {
    const response = await chat({
      model: input.model,
      messages: [
        {
          role: "system",
          content: "You predict one missing buyer/seller negotiation turn. Return strict JSON only."
        },
        {
          role: "user",
          content: buildPersonaPrompt(persona, analysis, retrieved, heuristic)
        }
      ],
      temperature: persona.temperature,
      seed: persona.seed,
      maxTokens: 120,
      json: true,
      label: `persona:${persona.persona}`
    });
    const parsed = parseJsonObject(response.content);
    const prediction = cleanMessage(stringField(parsed, "prediction") || heuristic.message);
    const intent = normalizeIntent(stringField(parsed, "intent_class")) ?? classifyIntentFromMessage(prediction, analysis);
    return {
      persona: persona.persona,
      prediction,
      reasoning: cleanReasoning(stringField(parsed, "reasoning") || heuristic.rationale),
      intent_class: intent,
      confidence: clampConfidence(numberField(parsed, "confidence", heuristic.confidence)),
      tokens: response.tokens,
      raw: response.content
    };
  } catch {
    const prediction = personaFallback(persona.persona, heuristic, analysis);
    return {
      persona: persona.persona,
      prediction,
      reasoning: `Fallback from local state: ${heuristic.rationale}`,
      intent_class: classifyIntentFromMessage(prediction, analysis),
      confidence: clampConfidence(Math.max(0.35, heuristic.confidence - 0.08)),
      tokens: ZERO_TOKENS,
      raw: "llm_error"
    };
  }
}

async function runSynthesisAgent(args: {
  input: PredictRequest;
  analysis: ConversationAnalysis;
  retrieved: RetrievedChunk[];
  heuristic: HeuristicPrediction;
  personaResults: PersonaAgentResult[];
  chat: (request: LlmChatRequest) => Promise<LlmChatResult>;
}): Promise<SynthesisResult> {
  const { input, analysis, retrieved, heuristic, personaResults, chat } = args;
  try {
    const response = await chat({
      model: input.model,
      messages: [
        {
          role: "system",
          content: "Deterministic synthesizer. Return one strict JSON object only."
        },
        {
          role: "user",
          content: buildSynthesisPrompt(analysis, retrieved, heuristic, personaResults)
        }
      ],
      temperature: 0,
      seed: SYNTHESIS_SEED,
      maxTokens: 100,
      json: true,
      label: "synthesis"
    });
    const parsed = parseJsonObject(response.content);
    const message = cleanMessage(
      stringField(parsed, "predicted_next_message") || stringField(parsed, "prediction") || heuristic.message
    );
    return {
      predicted_next_message: message,
      predicted_intent_class:
        normalizeIntent(stringField(parsed, "predicted_intent_class") || stringField(parsed, "intent_class")) ??
        classifyIntentFromMessage(message, analysis),
      confidence: clampConfidence(numberField(parsed, "confidence", heuristic.confidence)),
      reasoning: cleanReasoning(stringField(parsed, "reasoning") || "Synthesized from persona outputs and local state."),
      tokens: response.tokens,
      raw: response.content
    };
  } catch {
    return {
      predicted_next_message: heuristic.message,
      predicted_intent_class: heuristic.intent,
      confidence: clampConfidence(Math.max(0.35, heuristic.confidence - 0.08)),
      reasoning: "Fallback synthesis because the LLM call failed.",
      tokens: ZERO_TOKENS,
      raw: "llm_error"
    };
  }
}

function buildPersonaPrompt(
  persona: PersonaDefinition,
  analysis: ConversationAnalysis,
  retrieved: RetrievedChunk[],
  heuristic: HeuristicPrediction
): string {
  return [
    `Persona=${persona.persona}`,
    `Stance=${persona.stance}`,
    `Next speaker=${analysis.nextRole}`,
    `State=${summarizeAnalysis(analysis)}`,
    "",
    "Conversation:",
    analysis.transcript,
    "",
    "Playbook:",
    formatRetrieved(retrieved, 2),
    "",
    `Baseline=${heuristic.intent}: "${heuristic.message}"`,
    "Intent labels: accept, counter_offer, reject, offer, inquiry.",
    'Return JSON: {"prediction":"one concise next message","intent_class":"accept|counter_offer|reject|offer|inquiry","confidence":0.0,"reasoning":"under 18 words"}'
  ].join("\n");
}

function buildSynthesisPrompt(
  analysis: ConversationAnalysis,
  retrieved: RetrievedChunk[],
  heuristic: HeuristicPrediction,
  personaResults: PersonaAgentResult[]
): string {
  const personas = personaResults
    .map((result) => `${result.persona}: ${result.intent_class} ${result.confidence} "${result.prediction}"`)
    .join("\n");
  return [
    `Predict the single most likely next ${analysis.nextRole} message.`,
    `State=${summarizeAnalysis(analysis)}`,
    "",
    "Conversation:",
    analysis.transcript,
    "",
    "Persona outputs:",
    personas,
    "",
    `Baseline=${heuristic.intent} ${heuristic.confidence} "${heuristic.message}"`,
    `Rule hint=${retrieved[0]?.title ?? "Intent Map"}`,
    "Class rules: fresh price after prior price=counter_offer; agreement=accept; question=inquiry; no-number pushback=reject.",
    'Return JSON: {"predicted_next_message":"string","predicted_intent_class":"accept|counter_offer|reject|offer|inquiry","confidence":0.0,"reasoning":"brief"}'
  ].join("\n");
}

function postProcessFinal(
  synthesis: SynthesisResult,
  personaResults: PersonaAgentResult[],
  heuristic: HeuristicPrediction,
  analysis: ConversationAnalysis
): Pick<PredictResponse, "predicted_next_message" | "predicted_intent_class" | "confidence"> {
  const candidates = [
    { message: synthesis.predicted_next_message, intent: synthesis.predicted_intent_class, confidence: synthesis.confidence, weight: 1.45 },
    { message: heuristic.message, intent: heuristic.intent, confidence: heuristic.confidence, weight: 1.25 },
    ...personaResults.map((result) => ({
      message: result.prediction,
      intent: result.intent_class,
      confidence: result.confidence,
      weight: 0.75
    }))
  ];

  let message = cleanMessage(synthesis.predicted_next_message) || heuristic.message;
  const messageIntent = classifyIntentFromMessage(message, analysis);
  const votes = new Map<IntentClass, number>();
  for (const candidate of candidates) {
    addVote(votes, candidate.intent, candidate.weight + candidate.confidence * 0.35);
  }
  addVote(votes, messageIntent, isStrongMessageIntent(message, messageIntent) ? 1.6 : 0.8);

  const topVote = [...votes.entries()].sort((left, right) => right[1] - left[1])[0];
  let intent = topVote?.[0] ?? heuristic.intent;

  if (isStrongMessageIntent(message, messageIntent)) {
    intent = messageIntent;
  }

  const aligned = alignMessageToIntent(message, intent, candidates, analysis);
  message = aligned.message;
  intent = aligned.intent;

  const agreement = Math.min(1, (topVote?.[1] ?? 1) / 5);
  const confidence = clampConfidence(0.34 * synthesis.confidence + 0.33 * heuristic.confidence + 0.33 * agreement);
  return {
    predicted_next_message: message,
    predicted_intent_class: intent,
    confidence
  };
}

function alignMessageToIntent(
  message: string,
  intent: IntentClass,
  candidates: Array<{ message: string; intent: IntentClass; confidence: number; weight: number }>,
  analysis: ConversationAnalysis
): { message: string; intent: IntentClass } {
  const cleaned = cleanMessage(message);
  if ((intent === "counter_offer" || intent === "offer") && !hasPriceLikeText(cleaned)) {
    const priced = candidates
      .filter((candidate) => (candidate.intent === intent || hasPriceLikeText(candidate.message)) && hasPriceLikeText(candidate.message))
      .sort((left, right) => right.confidence + right.weight - (left.confidence + left.weight))[0];
    const replacement = cleanMessage(priced?.message ?? fallbackCounterMessage(analysis));
    return { message: replacement, intent: classifyIntentFromMessage(replacement, analysis) };
  }
  if (intent === "accept" && !containsAcceptanceSignal(cleaned)) {
    const replacement = acceptanceMessage(analysis);
    return { message: replacement, intent: "accept" };
  }
  if (intent === "reject" && (hasPriceLikeText(cleaned) || !containsRejectSignal(cleaned))) {
    const replacement = rejectionMessage(analysis);
    return { message: replacement, intent: "reject" };
  }
  if (intent === "inquiry" && !cleaned.includes("?")) {
    const replacement = inquiryMessage(analysis);
    return { message: replacement, intent: "inquiry" };
  }
  const normalizedIntent = classifyIntentFromMessage(cleaned, analysis);
  if (isStrongMessageIntent(cleaned, normalizedIntent)) {
    return { message: cleaned, intent: normalizedIntent };
  }
  return { message: cleaned || heuristicPrediction(analysis).message, intent };
}

function addVote(votes: Map<IntentClass, number>, intent: IntentClass, weight: number): void {
  votes.set(intent, (votes.get(intent) ?? 0) + weight);
}

function isStrongMessageIntent(message: string, intent: IntentClass): boolean {
  if ((intent === "counter_offer" || intent === "offer") && hasPriceLikeText(message)) {
    return true;
  }
  if (intent === "accept" && containsAcceptanceSignal(message)) {
    return true;
  }
  if (intent === "reject" && containsRejectSignal(message) && !hasPriceLikeText(message)) {
    return true;
  }
  return intent === "inquiry" && message.includes("?");
}

function personaFallback(persona: string, heuristic: HeuristicPrediction, analysis: ConversationAnalysis): string {
  if (persona === "friendly-pragmatist" && heuristic.intent === "counter_offer") {
    return analysis.nextRole === "buyer"
      ? heuristic.message.replace("Could you", "Thanks, could you")
      : heuristic.message.replace("I could", "Thanks, I could");
  }
  if (persona === "deal-closer" && heuristic.intent === "counter_offer" && analysis.previousPriceByOtherRole) {
    return counterMessage(analysis, analysis.previousPriceByOtherRole.amount);
  }
  if (persona === "price-discipline" && heuristic.intent === "accept") {
    return analysis.nextRole === "buyer" ? "That works for me if everything is as described." : heuristic.message;
  }
  return heuristic.message;
}

function summarizeAnalysis(analysis: ConversationAnalysis): string {
  const prices =
    analysis.prices.length === 0
      ? "none"
      : analysis.prices.map((price) => `${price.role}$${price.amount}@${price.turnIndex + 1}`).join(",");
  return [
    `next=${analysis.nextRole}`,
    `turns=${analysis.turnCount}`,
    `last_q=${analysis.lastHasQuestion}`,
    `last_price=${analysis.lastHasPrice}`,
    `accept=${analysis.lastLooksLikeAcceptance}`,
    `reject=${analysis.lastLooksLikeRejection}`,
    `firm=${analysis.lastLooksFirm}`,
    `prices=${prices}`
  ].join(";");
}

function formatRetrieved(chunks: RetrievedChunk[], maxChunks: number): string {
  return chunks
    .slice(0, maxChunks)
    .map((chunk) => `[${chunk.title}]\n${chunk.content}`)
    .join("\n\n");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        const parsed = JSON.parse(trimmed.slice(first, last + 1)) as unknown;
        return isRecord(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }
}

function normalizeIntent(value: string | undefined): IntentClass | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (INTENT_CLASSES as readonly string[]).includes(normalized) ? (normalized as IntentClass) : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function cleanMessage(value: string): string {
  return value
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^(buyer|seller)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function cleanReasoning(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

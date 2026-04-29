import type { TokenUsage } from "./types.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  seed: number;
  maxTokens: number;
  json: boolean;
  label: string;
}

export interface LlmChatResult {
  content: string;
  tokens: TokenUsage;
  duration_ms: number;
  provider: "ollama" | "openai-compatible";
}

export class LlmError extends Error {
  readonly details: string;

  constructor(message: string, details: string) {
    super(message);
    this.name = "LlmError";
    this.details = details;
  }
}

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const DEFAULT_OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);

export async function chatCompletion(request: LlmChatRequest): Promise<LlmChatResult> {
  if (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) {
    return openAiCompatibleChat(request);
  }
  return ollamaChat(request);
}

async function ollamaChat(request: LlmChatRequest): Promise<LlmChatResult> {
  const started = Date.now();
  const response = await postJson(
    process.env.OLLAMA_CHAT_URL ?? DEFAULT_OLLAMA_URL,
    {
      model: request.model,
      messages: request.messages,
      stream: false,
      format: request.json ? "json" : undefined,
      keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? "10m",
      options: {
        temperature: request.temperature,
        seed: request.seed,
        num_predict: request.maxTokens,
        top_p: request.temperature === 0 ? 0.8 : 0.9,
        repeat_penalty: 1.05
      }
    },
    {}
  );

  const content = response?.message?.content;
  if (typeof content !== "string") {
    throw new LlmError("llm_bad_response", `Ollama returned no message content for ${request.label}.`);
  }
  const prompt = toFiniteNumber(response.prompt_eval_count);
  const completion = toFiniteNumber(response.eval_count);
  return {
    content,
    duration_ms: Date.now() - started,
    provider: "ollama",
    tokens: { prompt, completion, total: prompt + completion }
  };
}

async function openAiCompatibleChat(request: LlmChatRequest): Promise<LlmChatResult> {
  const started = Date.now();
  const baseUrl = (process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (process.env.OPENAI_API_KEY) {
    headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
  }
  const response = await postJson(
    `${baseUrl}/chat/completions`,
    {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      seed: request.seed,
      max_tokens: request.maxTokens,
      response_format: request.json ? { type: "json_object" } : undefined
    },
    headers
  );

  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new LlmError("llm_bad_response", `OpenAI-compatible backend returned no content for ${request.label}.`);
  }
  const usage = response?.usage ?? {};
  const prompt = toFiniteNumber(usage.prompt_tokens);
  const completion = toFiniteNumber(usage.completion_tokens);
  return {
    content,
    duration_ms: Date.now() - started,
    provider: "openai-compatible",
    tokens: { prompt, completion, total: prompt + completion }
  };
}

async function postJson(url: string, body: unknown, extraHeaders: Record<string, string>): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...extraHeaders
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new LlmError("llm_http_error", `Backend returned HTTP ${response.status}.`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LlmError("llm_json_error", "Backend returned invalid JSON.");
    }
  } catch (error) {
    if (error instanceof LlmError) {
      throw error;
    }
    throw new LlmError("llm_request_failed", "Backend request failed or timed out.");
  } finally {
    clearTimeout(timeout);
  }
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    prompt: left.prompt + right.prompt,
    completion: left.completion + right.completion,
    total: left.total + right.total
  };
}

export const ZERO_TOKENS: TokenUsage = { prompt: 0, completion: 0, total: 0 };

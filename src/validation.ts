import type { ConversationTurn, PredictRequest } from "./types.ts";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly details: string;

  constructor(statusCode: number, error: string, details: string) {
    super(error);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function validatePredictRequest(value: unknown): PredictRequest {
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_request", "Request body must be a JSON object.");
  }

  if (!Array.isArray(value.conversation) || value.conversation.length < 1) {
    throw new HttpError(400, "invalid_conversation", "conversation must contain at least one turn.");
  }

  const conversation: ConversationTurn[] = [];
  let previousRole: string | undefined;
  for (const [index, turn] of value.conversation.entries()) {
    if (!isRecord(turn)) {
      throw new HttpError(400, "invalid_conversation", `conversation[${index}] must be an object.`);
    }
    if (turn.role !== "buyer" && turn.role !== "seller") {
      throw new HttpError(400, "invalid_conversation", `conversation[${index}].role must be buyer or seller.`);
    }
    if (previousRole === turn.role) {
      throw new HttpError(400, "invalid_conversation", "conversation roles must alternate buyer/seller.");
    }
    if (typeof turn.content !== "string" || turn.content.trim().length === 0) {
      throw new HttpError(400, "invalid_conversation", `conversation[${index}].content must be a non-empty string.`);
    }
    if (turn.content.length > 4000) {
      throw new HttpError(400, "invalid_conversation", `conversation[${index}].content must be under 4000 characters.`);
    }
    conversation.push({ role: turn.role, content: turn.content.trim() });
    previousRole = turn.role;
  }

  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    throw new HttpError(400, "invalid_model", "model must be a non-empty string, e.g. gemma4:e2b.");
  }

  return { conversation, model: value.model.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

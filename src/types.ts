export const INTENT_CLASSES = ["accept", "counter_offer", "reject", "offer", "inquiry"] as const;

export type Role = "buyer" | "seller";
export type IntentClass = (typeof INTENT_CLASSES)[number];

export interface ConversationTurn {
  role: Role;
  content: string;
}

export interface PredictRequest {
  conversation: ConversationTurn[];
  model: string;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface PersonaPrediction {
  persona: string;
  prediction: string;
  reasoning: string;
}

export interface PredictResponse {
  predicted_next_message: string;
  predicted_intent_class: IntentClass;
  confidence: number;
  persona_predictions: PersonaPrediction[];
  metadata: {
    duration_ms: number;
    tokens_used: TokenUsage;
    model: string;
  };
}

export interface PriceMention {
  role: Role;
  amount: number;
  turnIndex: number;
  raw: string;
}

export interface ConversationAnalysis {
  nextRole: Role;
  lastRole: Role;
  otherRole: Role;
  turnCount: number;
  lastMessage: string;
  transcript: string;
  prices: PriceMention[];
  lastPrice?: PriceMention;
  lastPriceByBuyer?: PriceMention;
  lastPriceBySeller?: PriceMention;
  previousPriceByNextRole?: PriceMention;
  previousPriceByOtherRole?: PriceMention;
  firstPriceBySeller?: PriceMention;
  firstPriceByBuyer?: PriceMention;
  lastHasQuestion: boolean;
  lastHasPrice: boolean;
  lastHasPriceQuestion: boolean;
  lastAsksAboutLogistics: boolean;
  lastAsksAboutCondition: boolean;
  lastLooksLikeAcceptance: boolean;
  lastLooksLikeRejection: boolean;
  lastLooksFirm: boolean;
  lastMentionsPickupOrCash: boolean;
  priceGapRatio?: number;
}

export interface HeuristicPrediction {
  message: string;
  intent: IntentClass;
  confidence: number;
  rationale: string;
}

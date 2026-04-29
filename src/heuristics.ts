import type {
  ConversationAnalysis,
  ConversationTurn,
  HeuristicPrediction,
  IntentClass,
  PriceMention,
  Role
} from "./types.ts";

const PRICE_CONTEXT_RE =
  /\b(\$|price|asking|ask|listed|listing|sell|selling|sold|buy|buyer|offer|offering|pay|paid|take|accept|counter|firm|obo|lowest|highest|budget|cash|deal|for|do)\b/i;
const DIMENSION_CONTEXT_RE =
  /\b(inch|inches|in\.|cm|mm|gb|tb|mb|miles|mile|year|years|old|model|lbs|pounds|kg|hours|minutes|mins|pm|am|size)\b/i;
const QUESTION_STARTERS = new Set(["what", "when", "where", "why", "how", "is", "are", "do", "does", "did", "can", "could", "would", "will", "any"]);
const PRICE_QUESTION_RE = /\b(lowest|best price|firm|flexible|take|accept|would you|could you|can you do|what.*price|price)\b/i;
const LOGISTICS_RE = /\b(pick ?up|pickup|meet|meeting|today|tomorrow|tonight|deliver|delivery|ship|shipping|cash|venmo|paypal|location|where|when)\b/i;
const CONDITION_RE = /\b(condition|working|work|works|damage|scratches|warranty|new|used|old|miles|size|model|brand|included|available|still have|still available|pictures|photos)\b/i;
const FIRM_RE = /\b(firm|final|lowest|best i can|last price|not going lower|can't go lower|cannot go lower)\b/i;

const ACCEPT_PHRASES = [
  "accept",
  "accepted",
  "deal",
  "agreed",
  "sounds good",
  "sound good",
  "works for me",
  "that works",
  "okay",
  "ok",
  "sure",
  "yes",
  "i'll take it",
  "i will take it",
  "you got it",
  "let's do it",
  "can do",
  "could do",
  "can do that"
];

const REJECT_PHRASES = [
  "no thanks",
  "not interested",
  "too much",
  "too high",
  "too low",
  "can't",
  "cannot",
  "won't",
  "firm",
  "final price",
  "lowest",
  "best i can",
  "not going",
  "no way",
  "i'll pass",
  "i will pass",
  "pass on"
];

export function analyzeConversation(conversation: ConversationTurn[]): ConversationAnalysis {
  const lastTurn = conversation.at(-1);
  if (!lastTurn) {
    throw new Error("conversation must contain at least one turn");
  }

  const nextRole = oppositeRole(lastTurn.role);
  const prices = extractPriceMentions(conversation);
  const lastPrice = prices.at(-1);
  const previousPriceByNextRole = findLastPriceByRole(prices, nextRole);
  const previousPriceByOtherRole = findLastPriceByRole(prices, lastTurn.role);
  const priceGapRatio =
    previousPriceByNextRole && previousPriceByOtherRole
      ? Math.abs(previousPriceByNextRole.amount - previousPriceByOtherRole.amount) /
        Math.max(previousPriceByNextRole.amount, previousPriceByOtherRole.amount, 1)
      : undefined;

  return {
    nextRole,
    lastRole: lastTurn.role,
    otherRole: lastTurn.role,
    turnCount: conversation.length,
    lastMessage: lastTurn.content,
    transcript: formatTranscript(conversation),
    prices,
    lastPrice,
    lastPriceByBuyer: findLastPriceByRole(prices, "buyer"),
    lastPriceBySeller: findLastPriceByRole(prices, "seller"),
    firstPriceByBuyer: findFirstPriceByRole(prices, "buyer"),
    firstPriceBySeller: findFirstPriceByRole(prices, "seller"),
    previousPriceByNextRole,
    previousPriceByOtherRole,
    lastHasQuestion: isQuestionLike(lastTurn.content),
    lastHasPrice: Boolean(lastPrice && lastPrice.turnIndex === conversation.length - 1),
    lastHasPriceQuestion: PRICE_QUESTION_RE.test(lastTurn.content),
    lastAsksAboutLogistics: LOGISTICS_RE.test(lastTurn.content),
    lastAsksAboutCondition: CONDITION_RE.test(lastTurn.content),
    lastLooksLikeAcceptance: containsAnyPhrase(lastTurn.content, ACCEPT_PHRASES),
    lastLooksLikeRejection: containsAnyPhrase(lastTurn.content, REJECT_PHRASES),
    lastLooksFirm: FIRM_RE.test(lastTurn.content),
    lastMentionsPickupOrCash: /\b(today|tonight|cash|pick ?up|pickup)\b/i.test(lastTurn.content),
    priceGapRatio
  };
}

export function heuristicPrediction(analysis: ConversationAnalysis): HeuristicPrediction {
  const latestOtherPrice = analysis.previousPriceByOtherRole;
  const ownPriorPrice = analysis.previousPriceByNextRole;

  if (analysis.lastLooksLikeAcceptance) {
    return {
      intent: "accept",
      message: acceptanceMessage(analysis),
      confidence: 0.76,
      rationale: "The latest turn signals agreement, so the next turn likely closes the deal."
    };
  }

  if (latestOtherPrice) {
    return priceResponsePrediction(analysis, latestOtherPrice, ownPriorPrice);
  }

  if (analysis.lastLooksLikeRejection) {
    if (ownPriorPrice && analysis.prices.length >= 2 && !analysis.lastLooksFirm) {
      const amount = roundFriendly(ownPriorPrice.amount * (analysis.nextRole === "buyer" ? 1.08 : 0.94));
      return {
        intent: "counter_offer",
        message:
          analysis.nextRole === "buyer"
            ? `Could you meet me at $${formatAmount(amount)}?`
            : `I could come down to $${formatAmount(amount)}.`,
        confidence: 0.56,
        rationale: "A soft rejection often invites one smaller concession."
      };
    }
    return {
      intent: "reject",
      message: rejectionMessage(analysis),
      confidence: 0.61,
      rationale: "The latest turn pushes back without a new live price."
    };
  }

  if (analysis.lastHasQuestion) {
    if (analysis.lastHasPriceQuestion) {
      return priceQuestionPrediction(analysis);
    }
    return informationQuestionPrediction(analysis);
  }

  if (analysis.prices.length === 0) {
    return noAnchorPrediction(analysis);
  }

  return {
    intent: "inquiry",
    message:
      analysis.nextRole === "buyer"
        ? "Can you tell me a little more before I decide?"
        : "When would you be able to pick it up?",
    confidence: 0.46,
    rationale: "The state is ambiguous, so a short information-seeking reply is safest."
  };
}

function priceResponsePrediction(
  analysis: ConversationAnalysis,
  latestOtherPrice: PriceMention,
  ownPriorPrice: PriceMention | undefined
): HeuristicPrediction {
  if (ownPriorPrice) {
    const gap = Math.abs(latestOtherPrice.amount - ownPriorPrice.amount) / Math.max(latestOtherPrice.amount, ownPriorPrice.amount, 1);
    const closeEnough = gap <= (analysis.lastMentionsPickupOrCash ? 0.14 : 0.09);
    if (closeEnough) {
      return {
        intent: "accept",
        message: acceptanceMessage(analysis),
        confidence: 0.72,
        rationale: "The latest offer is close to the speaker's prior anchor."
      };
    }
    if (analysis.lastLooksFirm && gap >= 0.18) {
      return {
        intent: "reject",
        message: rejectionMessage(analysis),
        confidence: 0.63,
        rationale: "The latest price is framed as firm and remains far from the speaker's anchor."
      };
    }
    const amount = midpointCounter(latestOtherPrice.amount, ownPriorPrice.amount);
    return {
      intent: "counter_offer",
      message: counterMessage(analysis, amount),
      confidence: 0.69,
      rationale: "Both parties have anchors, so a rounded midpoint counter is likely."
    };
  }

  const amount = firstCounterAmount(analysis, latestOtherPrice.amount);
  return {
    intent: analysis.prices.length > 0 ? "counter_offer" : "offer",
    message: counterMessage(analysis, amount),
    confidence: 0.62,
    rationale: "The latest turn establishes the first visible price anchor."
  };
}

function priceQuestionPrediction(analysis: ConversationAnalysis): HeuristicPrediction {
  const reference = analysis.lastPriceBySeller?.amount ?? analysis.lastPriceByBuyer?.amount ?? 100;
  if (analysis.nextRole === "seller") {
    const amount = analysis.lastPriceBySeller ? roundFriendly(reference * 0.92) : reference;
    return {
      intent: analysis.prices.length > 0 ? "counter_offer" : "offer",
      message: `I could do $${formatAmount(amount)} if you can pick it up soon.`,
      confidence: 0.57,
      rationale: "The buyer is asking about price flexibility, so the seller likely names terms."
    };
  }
  const amount = analysis.lastPriceBySeller ? firstCounterAmount(analysis, reference) : roundFriendly(reference * 0.85);
  return {
    intent: analysis.prices.length > 0 ? "counter_offer" : "offer",
    message: `Would you take $${formatAmount(amount)}?`,
    confidence: 0.55,
    rationale: "The seller prompts for a price, so the buyer likely makes a concrete offer."
  };
}

function informationQuestionPrediction(analysis: ConversationAnalysis): HeuristicPrediction {
  if (analysis.nextRole === "seller") {
    if (analysis.lastAsksAboutCondition) {
      return {
        intent: "inquiry",
        message: "Yes, it is still available and in good condition. When can you pick it up?",
        confidence: 0.55,
        rationale: "The buyer asks about condition or availability, so the seller answers and keeps logistics moving."
      };
    }
    return {
      intent: "inquiry",
      message: "Yes, it is still available. When would you be able to pick it up?",
      confidence: 0.53,
      rationale: "The buyer asks for logistics or availability information."
    };
  }

  return {
    intent: "inquiry",
    message: "Is it still available, and are you flexible on the price?",
    confidence: 0.52,
    rationale: "The seller's question leaves room for the buyer to ask about terms."
  };
}

function noAnchorPrediction(analysis: ConversationAnalysis): HeuristicPrediction {
  if (analysis.nextRole === "seller") {
    return {
      intent: "inquiry",
      message: "Yes, it is still available. When would you be able to pick it up?",
      confidence: 0.5,
      rationale: "With no price anchor, seller replies often confirm availability and ask logistics."
    };
  }
  return {
    intent: "inquiry",
    message: "Is it still available, and are you flexible on the price?",
    confidence: 0.5,
    rationale: "With no price anchor, buyers often open with availability and flexibility questions."
  };
}

export function classifyIntentFromMessage(message: string, analysis: ConversationAnalysis): IntentClass {
  const trimmed = message.trim();
  const messagePrices = extractPricesFromText(trimmed);
  const hasPrice = messagePrices.length > 0;
  const accept = containsAnyPhrase(trimmed, ACCEPT_PHRASES);
  const reject = containsAnyPhrase(trimmed, REJECT_PHRASES);
  const question = isQuestionLike(trimmed);

  if (hasPrice) {
    const latestOtherAmount = analysis.previousPriceByOtherRole?.amount;
    const repeatsLivePrice =
      typeof latestOtherAmount === "number" &&
      messagePrices.some((price) => amountsNearlyEqual(price.amount, latestOtherAmount));
    if (repeatsLivePrice && accept) {
      return "accept";
    }
    return analysis.prices.length > 0 ? "counter_offer" : "offer";
  }
  if (accept) {
    return "accept";
  }
  if (question) {
    return "inquiry";
  }
  if (reject) {
    return "reject";
  }
  return analysis.prices.length > 0 ? "reject" : "inquiry";
}

export function formatTranscript(conversation: ConversationTurn[]): string {
  return conversation.map((turn, index) => `${index + 1}. ${turn.role}: ${turn.content}`).join("\n");
}

export function oppositeRole(role: Role): Role {
  return role === "buyer" ? "seller" : "buyer";
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

export function hasPriceLikeText(message: string): boolean {
  return extractPricesFromText(message).length > 0 || /\$\s*\d|\b\d{2,6}\s*(bucks|dollars|usd)\b/i.test(message);
}

export function containsAcceptanceSignal(message: string): boolean {
  return containsAnyPhrase(message, ACCEPT_PHRASES);
}

export function containsRejectSignal(message: string): boolean {
  return containsAnyPhrase(message, REJECT_PHRASES);
}

export function acceptanceMessage(analysis: ConversationAnalysis): string {
  const latest = analysis.previousPriceByOtherRole?.amount;
  if (latest) {
    return analysis.nextRole === "buyer"
      ? `That works for me. I can do $${formatAmount(latest)}.`
      : `I can do $${formatAmount(latest)}. Deal.`;
  }
  return analysis.nextRole === "buyer" ? "That works for me. I can pick it up." : "That works for me. Deal.";
}

export function rejectionMessage(analysis: ConversationAnalysis): string {
  return analysis.nextRole === "buyer"
    ? "That is still more than I was hoping to spend."
    : "I cannot go that low.";
}

export function inquiryMessage(analysis: ConversationAnalysis): string {
  return analysis.nextRole === "buyer"
    ? "Is it still available, and are you flexible on the price?"
    : "When would you be able to pick it up?";
}

export function counterMessage(analysis: ConversationAnalysis, amount: number): string {
  const formatted = formatAmount(amount);
  if (analysis.nextRole === "buyer") {
    return `Could you do $${formatted}?`;
  }
  return `I could do $${formatted} if that works for you.`;
}

export function fallbackCounterMessage(analysis: ConversationAnalysis): string {
  const latest = analysis.previousPriceByOtherRole?.amount ?? analysis.lastPrice?.amount ?? 100;
  return counterMessage(analysis, firstCounterAmount(analysis, latest));
}

export function formatAmount(amount: number): string {
  if (!Number.isFinite(amount)) {
    return "50";
  }
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/\.00$/, "");
}

function extractPriceMentions(conversation: ConversationTurn[]): PriceMention[] {
  const mentions: PriceMention[] = [];
  conversation.forEach((turn, turnIndex) => {
    for (const price of extractPricesFromText(turn.content)) {
      mentions.push({ role: turn.role, amount: price.amount, turnIndex, raw: price.raw });
    }
  });
  return mentions;
}

function extractPricesFromText(text: string): Array<{ amount: number; raw: string }> {
  const results: Array<{ amount: number; raw: string }> = [];
  const strict =
    /(?:\$|usd\s*)\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]{1,6}(?:\.[0-9]{1,2})?)|([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]{1,6}(?:\.[0-9]{1,2})?)\s*(?:bucks|dollars|usd)\b|([0-9]{1,3}(?:\.[0-9])?)\s*k\b/gi;
  for (const match of text.matchAll(strict)) {
    const raw = match[0];
    const amount = match[3] ? Number(match[3]) * 1000 : parseAmount(match[1] ?? match[2]);
    if (isLikelyPrice(amount, raw)) {
      results.push({ amount, raw });
    }
  }

  if (PRICE_CONTEXT_RE.test(text)) {
    const loose = /\b([0-9]{2,6}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\b/g;
    for (const match of text.matchAll(loose)) {
      const raw = match[0];
      if (results.some((item) => item.raw.includes(raw))) {
        continue;
      }
      const amount = parseAmount(raw);
      const index = match.index ?? 0;
      const context = text.slice(Math.max(0, index - 24), Math.min(text.length, index + raw.length + 24));
      if (isLikelyPrice(amount, context) && !DIMENSION_CONTEXT_RE.test(context)) {
        results.push({ amount, raw });
      }
    }
  }
  return results;
}

function firstCounterAmount(analysis: ConversationAnalysis, referenceAmount: number): number {
  if (analysis.nextRole === "buyer") {
    const multiplier = referenceAmount < 75 ? 0.78 : referenceAmount < 500 ? 0.8 : 0.84;
    return roundFriendly(referenceAmount * multiplier);
  }
  return roundFriendly(referenceAmount * (referenceAmount < 100 ? 1.2 : 1.15));
}

function midpointCounter(latestOtherAmount: number, ownPriorAmount: number): number {
  const midpoint = (latestOtherAmount + ownPriorAmount) / 2;
  return roundFriendly(midpoint);
}

function roundFriendly(amount: number): number {
  if (!Number.isFinite(amount)) {
    return 50;
  }
  if (amount < 20) {
    return Math.max(1, Math.round(amount));
  }
  if (amount < 100) {
    return Math.max(5, Math.round(amount / 5) * 5);
  }
  if (amount < 250) {
    return Math.max(10, Math.round(amount / 10) * 10);
  }
  if (amount < 1000) {
    return Math.max(25, Math.round(amount / 25) * 25);
  }
  return Math.max(50, Math.round(amount / 50) * 50);
}

function parseAmount(value: string | undefined): number {
  return value ? Number(value.replace(/,/g, "")) : Number.NaN;
}

function isLikelyPrice(amount: number, context: string): boolean {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    return false;
  }
  if (amount >= 1900 && amount <= 2035 && /\b(year|model|miles|mile)\b/i.test(context)) {
    return false;
  }
  return true;
}

function findLastPriceByRole(prices: PriceMention[], role: Role): PriceMention | undefined {
  return prices.findLast((price) => price.role === role);
}

function findFirstPriceByRole(prices: PriceMention[], role: Role): PriceMention | undefined {
  return prices.find((price) => price.role === role);
}

function isQuestionLike(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (normalized.includes("?")) {
    return true;
  }
  const firstWord = normalized.split(/[^a-z0-9']+/, 1).at(0) ?? "";
  return QUESTION_STARTERS.has(firstWord);
}

function containsAnyPhrase(message: string, phrases: string[]): boolean {
  const normalized = message.toLowerCase();
  return phrases.some((phrase) => normalized.includes(phrase));
}

function amountsNearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1, right * 0.015);
}

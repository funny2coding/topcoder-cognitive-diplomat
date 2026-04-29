import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationAnalysis } from "./types.ts";

export interface RetrievedChunk {
  id: string;
  title: string;
  content: string;
  score: number;
}

interface PlaybookChunk {
  id: string;
  title: string;
  content: string;
  tokens: Set<string>;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "for",
  "from",
  "have",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "we",
  "with",
  "you",
  "your"
]);

let cachedChunks: PlaybookChunk[] | undefined;

export function retrievePlaybookChunks(analysis: ConversationAnalysis, topK = 3): RetrievedChunk[] {
  const query = [
    analysis.transcript,
    `next_${analysis.nextRole}`,
    analysis.lastHasPrice ? "price counter offer anchor" : "",
    analysis.lastHasQuestion ? "question inquiry information" : "",
    analysis.lastLooksLikeAcceptance ? "accept close deal" : "",
    analysis.lastLooksLikeRejection ? "reject firm pushback" : "",
    analysis.lastAsksAboutCondition ? "condition available" : "",
    analysis.lastAsksAboutLogistics ? "pickup cash logistics" : ""
  ].join(" ");
  const queryTokens = tokenize(query);

  return loadChunks()
    .map((chunk) => {
      let score = phraseBoost(chunk, analysis);
      for (const token of queryTokens) {
        if (chunk.tokens.has(token)) {
          score += 1;
        }
      }
      return {
        id: chunk.id,
        title: chunk.title,
        content: trimChunk(chunk.content),
        score
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

function loadChunks(): PlaybookChunk[] {
  if (cachedChunks) {
    return cachedChunks;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const playbookPath = resolve(here, "data/domain/conversations_playbook.md");
  const raw = readFileSync(playbookPath, "utf8");
  cachedChunks = raw
    .split(/\n(?=##\s+)/)
    .map((section) => section.trim())
    .filter(Boolean)
    .map((section, index) => {
      const firstLine = section.split("\n", 1)[0] ?? `Chunk ${index + 1}`;
      const title = firstLine.replace(/^#+\s*/, "").trim();
      return { id: `playbook_${index + 1}`, title, content: section, tokens: tokenize(section) };
    });
  return cachedChunks;
}

function phraseBoost(chunk: PlaybookChunk, analysis: ConversationAnalysis): number {
  const text = `${chunk.title}\n${chunk.content}`.toLowerCase();
  let boost = 0;
  if (analysis.lastHasPrice && /price|counter|anchor|offer/.test(text)) {
    boost += 4;
  }
  if (analysis.lastHasQuestion && /question|inquiry|information/.test(text)) {
    boost += 3;
  }
  if (analysis.lastLooksLikeAcceptance && /accept|closing|deal/.test(text)) {
    boost += 4;
  }
  if (analysis.lastLooksLikeRejection && /reject|pushback|firm/.test(text)) {
    boost += 4;
  }
  if (analysis.nextRole === "buyer" && /buyer/.test(text)) {
    boost += 1;
  }
  if (analysis.nextRole === "seller" && /seller/.test(text)) {
    boost += 1;
  }
  return boost;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_$]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  );
}

function trimChunk(content: string): string {
  const compact = content.replace(/\n{3,}/g, "\n\n").trim();
  return compact.length <= 900 ? compact : `${compact.slice(0, 897)}...`;
}

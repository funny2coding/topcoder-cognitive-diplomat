# Negotiation Next Turn Predictor

Video URL: https://drive.google.com/file/d/1P1zNRbOXnM1PT1VEKUXs_UMRfRhwg6Kx/view?usp=sharing

This submission exposes `POST http://localhost:3000/v1/predict` for the Cognitive Diplomat negotiation next-turn challenge. It is a Node.js 24 TypeScript service tuned for the required local models `gemma4:e2b` and `qwen3.5:2b`.

The package has no third-party runtime dependencies. Node 24 runs the TypeScript files directly.

## Quick Start

```bash
cd src
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

Example prediction:

```bash
curl -s http://localhost:3000/v1/predict \
  -H 'content-type: application/json' \
  -d '{
    "model": "gemma4:e2b",
    "conversation": [
      { "role": "seller", "content": "I am asking $120." },
      { "role": "buyer", "content": "Would you take $80?" }
    ]
  }' | jq
```

## Model Backend

Default backend is native Ollama:

```bash
ollama pull gemma4:e2b
ollama pull qwen3.5:2b
cd src
npm start
```

The service calls `http://127.0.0.1:11434/api/chat` by default and forwards the request `model` value unchanged.

Optional environment variables:

- `OLLAMA_CHAT_URL`: override the native Ollama chat URL.
- `OLLAMA_KEEP_ALIVE`: default `10m`.
- `LLM_TIMEOUT_MS`: default `30000`.
- `OPENAI_BASE_URL` and `OPENAI_API_KEY`: use an OpenAI-compatible `/chat/completions` endpoint instead of native Ollama.

## Architecture

- `POST /v1/predict` validates alternating buyer/seller turns and returns the exact challenge response schema.
- Exactly three persona agents are launched in parallel with `Promise.all`: `price-discipline`, `friendly-pragmatist`, and `deal-closer`.
- Each persona calls the configured LLM independently and returns a prediction plus reasoning.
- A per-request `RequestMemory` records analysis, RAG hits, persona outputs, and the synthesis trace.
- Final synthesis is a separate LLM call with `temperature: 0` and fixed seed `424242`.
- Deterministic post-processing normalizes malformed tiny-model JSON, aligns message text with the selected intent class, and falls back to local negotiation heuristics only when needed.

## RAG Method

The RAG layer reads `src/data/domain/conversations_playbook.md`, splits it by Markdown `##` headings, tokenizes each section, and scores chunks by keyword overlap with the transcript plus negotiation-state signals.

Boosts are added for state-specific cues:

- price/counter/offer chunks when the last turn contains a price
- inquiry chunks when the last turn asks a question
- accept/closing chunks when the last turn signals agreement
- reject/firm chunks when the last turn signals pushback
- buyer/seller chunks matching the predicted next speaker

The top three chunks are retrieved for the request; the two most relevant chunks are passed to persona prompts and the top chunk is summarized for synthesis to keep token use low.

## Verification Guide

Run tests:

```bash
cd src
npm test
```

Run the service:

```bash
cd src
npm start
```

Expected response shape:

```json
{
  "predicted_next_message": "string",
  "predicted_intent_class": "accept | counter_offer | reject | offer | inquiry",
  "confidence": 0.0,
  "persona_predictions": [
    { "persona": "string", "prediction": "string", "reasoning": "string" },
    { "persona": "string", "prediction": "string", "reasoning": "string" },
    { "persona": "string", "prediction": "string", "reasoning": "string" }
  ],
  "metadata": {
    "duration_ms": 0,
    "tokens_used": { "prompt": 0, "completion": 0, "total": 0 },
    "model": "gemma4:e2b"
  }
}
```

## Submission Notes

For the final zip, include only:

- `src`
- `readme.md`

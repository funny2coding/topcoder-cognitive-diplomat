# Negotiation Conversations Playbook

## Intent Map
Use the predicted next speaker only. Pick exactly one intent.

- `accept`: agrees to the latest price, terms, pickup plan, or deal-closing proposal.
- `counter_offer`: proposes a different price or concrete term after any prior price or term anchor exists.
- `reject`: pushes back, says no, says price is too high/low, or stands firm without a new number.
- `offer`: introduces a concrete price or term before the dialogue has a live prior price anchor.
- `inquiry`: asks about product, condition, availability, pickup, payment, delivery, or flexibility.

If a message includes a fresh dollar amount after an earlier price, prefer `counter_offer` over `offer`.

## Price Response Patterns
When the latest turn has a price, the next turn usually accepts, counters, or rejects.

- Accept when the latest number is within roughly ten percent of the next speaker's earlier number.
- Counter with a rounded midpoint when both sides have named prices and are still apart.
- Reject without a number when the latest price is firm/final and still far away.

Marketplace wording is short: "Could you do $80?", "I can do $120 if you pick up today.", "That is still too high for me."

## Buyer Signals
Buyers ask whether the item is available, ask about condition, and then try a lower number. If the seller gives a price first, a buyer's next price is normally a `counter_offer`.

Useful buyer templates:

- inquiry: "Is it still available, and are you flexible on the price?"
- offer: "Would you take $X?"
- counter_offer: "Could you do $X?"
- reject: "That is more than I was hoping to spend."
- accept: "That works for me. I can pick it up today."

## Seller Signals
Sellers protect asking price but often trade a small concession for pickup certainty or cash. If a buyer asks about condition, answer briefly and often ask about pickup.

Useful seller templates:

- inquiry: "When would you be able to pick it up?"
- offer: "I am asking $X, but I am open to reasonable offers."
- counter_offer: "I could do $X if you can pick it up today."
- reject: "I cannot go that low."
- accept: "I can do that. Deal."

## Inquiry And Logistics
Questions about condition, availability, accessories, pickup, payment, shipping, or location are `inquiry` when the next turn itself asks a question. If the next turn answers and also gives a price, classify by the price action.

If the latest message asks "is it still available" and no price pressure exists, sellers often answer that it is available and ask when the buyer can pick it up.

## Acceptance And Closing
Agreement language with no new price is `accept`: "deal", "sounds good", "that works", "ok", "sure", "I can do that", "I'll take it".

If the next turn repeats the same latest price while agreeing, it is still `accept`. If it changes the price, it is `counter_offer`.

## Rejection Without New Terms
A hard no without a fresh number is `reject`. Common phrases include "too high", "too low", "can't go that low", "firm", "I'll pass", "not interested", and "no thanks".

Prefer `reject` only when there is no new concrete price or term. "I can't do $50, but I can do $70" is `counter_offer`.

## Deterministic Synthesis Rules
The final answer should be one natural next message, not options. Keep it concise and in the same casual register as the transcript.

Resolve disagreements this way:

1. Fresh dollar amount after any prior price means `counter_offer`.
2. Clear agreement to latest terms means `accept`.
3. Question-only messages are `inquiry`.
4. Pushback with no new number is `reject`.

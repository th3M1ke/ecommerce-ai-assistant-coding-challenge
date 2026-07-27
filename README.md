# E-Commerce AI Analytics Assistant

Ask questions about the seeded e-commerce database in plain English and get an
answer with the numbers and the exact SQL behind them.

```
$ curl -s localhost:3000/ask -H 'content-type: application/json' \
    -d '{"question":"Which products were ordered in the greatest quantities?","format":"text"}'

Products by units ordered
-------------------------
Coffee Grinder tops the list with 21 units across 10 orders.

Product           SKU           Units  Orders
----------------  ------------  -----  ------
Coffee Grinder    GRND-COF-BR      21      10
Smart Watch       WTCH-SMT-S2      21      11
Laptop Stand      STND-LAP-AL      20      12
Standing Desk     DESK-STND-EL     19      10
Portable SSD 1TB  SSD-PORT-1TB     19      14
```

A language model reads the question and writes **one SQLite SELECT statement**,
plus a label for each column and a sentence with placeholders in it. It never
sees a row and never states a figure. This service refuses to run anything that
is not a single read-only SELECT, executes it against a read-only connection,
caps the result, fills the sentence from the rows it got back, and returns the
statement alongside the answer. [NOTES.md](./NOTES.md) explains why it is built
that way, and what the earlier plan-and-compiler design traded away.

## Requirements

Node.js 20 or newer, npm, and one of:

- an **OpenAI** API key, or
- **[Ollama](https://ollama.com)** running locally, which needs no key and sends
  nothing off the machine.

## Setup

```bash
npm install
npm run db:create         # npm run db:reset to rebuild it from the seed data
cp .env.example .env      # then edit it
```

Configure a model in `.env`:

```bash
# hosted
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# or local: ollama pull qwen3.6
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen3.6
```

`LLM_PROVIDER` defaults to `openai` when `OPENAI_API_KEY` is set and `ollama`
otherwise. `OPENAI_BASE_URL` points the OpenAI adapter at any OpenAI-compatible
endpoint. See [.env.example](./.env.example) for every setting.

## Running it

```bash
npm start        # http://localhost:3000
npm run dev      # the same, restarting on change
```

## Asking a question

`POST /ask` takes `{"question": "..."}` and answers in one of two formats,
chosen with `"format"` in the body or an `Accept` header:

- **`json`** (the default) — everything the service knows: the SQL that ran, the
  column labels, the rows, the assumptions, the conversation context to continue
  the thread, and the timings. This is the form to build against.
- **`text`** — the same answer simplified and prettified for reading in a
  terminal, as shown above: a title, a sentence, an aligned table, and any
  caveat on the numbers. No SQL, no context, no timings.

```bash
# text
curl -s localhost:3000/ask -H 'content-type: application/json' \
  -d '{"question":"What is the max order value?","format":"text"}'

# json
curl -s localhost:3000/ask -H 'content-type: application/json' \
  -d '{"question":"What is the max order value?"}'
```

`Accept: text/plain` selects text when `format` is absent; an explicit `format`
always wins.

A JSON response contains:

| Field               | What it holds                                                          |
| ------------------- | ---------------------------------------------------------------------- |
| `kind`              | `answer`, `clarification` or `unsupported`                             |
| `answers[]`         | One per question asked: `title`, `headline`, `rows`, `columns`, `notes` |
| `answers[].sql`     | The exact statement that ran                                           |
| `answers[].columns` | The model's label and kind for each column: money, count, text, …      |
| `assumptions`       | Readings it chose where the wording was loose                          |
| `suggestedFollowUp` | The next question to ask, when one answer depends on another           |
| `clarification`     | On a `clarification`: what is missing, and the options it offers       |
| `reason`            | On an `unsupported`: why this data cannot answer the question          |
| `context`           | Send this back with your next question to continue the thread          |
| `meta`              | Provider, model, interpretation attempts, and timings                  |

A question is capped at 500 characters and a request body at 64 KB.

## What may run

The model writes the SQL, so everything it writes is checked before anything
runs, in [src/analytics/sql.ts](./src/analytics/sql.ts):

- one statement only, beginning with `SELECT` or `WITH`, with no semicolon, no
  comments and no bind placeholders;
- no `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `ATTACH`, `DETACH`,
  `VACUUM`, `REINDEX`, `PRAGMA`, transaction control, or `sqlite_*` tables
  anywhere in it (`replace()` survives, `REPLACE INTO` does not);
- SQLite must report the prepared statement as read-only and row-returning,
  which is what catches a write dressed up as a `WITH` statement;
- the columns it returns must be exactly the ones it declared.

Underneath, the connection is read-only with `query_only = ON`, and results stop
at 100 rows. A statement that fails any of this is sent back to the model with
the reason, once; a second failure is a `502`, not a guess.

The connection also registers one extra function, `unaccent(text)`, so a name
typed in plain ASCII still finds `Sofía Ramírez`.

### Follow-up questions

Pass the `context` from a response back in the next request and the thread
continues. The context carries the previous statements — never rows, never
figures — so the model can build on what it asked before:

```bash
# "Which product sold the most?"  ->  Coffee Grinder, 21 units
# then, with context attached:
#   "How many people bought it?"  ->  Customers: 9
```

### What it will and will not answer

Anything a single SELECT over the four tables can express: rankings, totals,
averages, maxima, counts, thresholds, time windows, per-user and per-product
breakdowns, time series, and questions that need a subquery ("how many people
bought the most sold product").

It stops rather than guessing when a question is missing something it cannot
supply, and itdeclines when the data cannot support the question at all — 
there is no cost, margin, returns, shipping or product category in this schema.

## Tests

```bash
npm test          # 63 tests, no API key needed
npm run typecheck
```

The tests run against the real seeded database with a stubbed model, and every
expected figure is computed independently from the JSON in `data/seed/`. One
extra suite talks to a real model and is skipped unless you ask for it:

```bash
LIVE_LLM_TESTS=1 npm test -- live
```

## Layout

```
src/
  analytics/     model output schema, the SQL guard, execution, formatting
  ai/            provider adapters, prompt, interpretation, conversation context
  server/        the POST /ask endpoint
  database/      connection and schema (from the starter)
tests/
scripts/         database creation (from the starter)
data/seed/       the seeded rows, which the tests compute their figures from
```

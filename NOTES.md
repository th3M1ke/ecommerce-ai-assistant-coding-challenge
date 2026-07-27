# Design notes

## Why this shape

Four ways to put a model between a question and a database, differing in how
much of the answer the model invents.

**Fixed functions** — `topProducts(n, window)`, `revenue(window)` — let nothing
the model writes reach SQL, and answer only what someone thought to write down.
**A business-metrics layer** generalises that into named measures and permitted
slices; right for a product with a stable analytics vocabulary and someone
accountable for it, wrong over four tables where the vocabulary would be
invented to fit the example questions. That was the **query plan**, and it was
built first: JSON naming a measure, grouping, filters, sort and limit, compiled
to SQL where every fragment is a literal and every value is bound. Its guarantee
is the strongest of the four — no model string reaches a statement, so injection
is absent rather than mitigated. It was replaced because a fixed set of measures
cannot answer "What is the max order value?" (a maximum over a grouped
subquery), and every percentile, median, period-on-period ratio or window
function is another enum member and another compiler branch. None of them is a
code change now.

**An autonomous SQL agent** is far more flexible, and flexibility is not why it
was rejected: it needs standing permission for an unbounded number of turns, it
reads rows so the data leaves the boundary immediately, and its answer is the
residue of a transcript that will not reproduce.

**One statement per question** is the compromise. It keeps the agent's reach —
anything a `SELECT` can express — and gives up the loop: one model call, one
statement checked in full before it runs, one artifact returned with the answer.
The guarantee weakens from "no model string reaches SQL" to "only a single
read-only SELECT can ever run", and [the guard](#the-guard) is where that is
paid for.

Debuggability is the point of returning the SQL: a disputed number is settled by
reading twenty lines and running them, not by inspecting hidden tool calls.

### Where the data lives

Development ran against a local Qwen 3 on Ollama, so nothing left the machine;
`LLM_PROVIDER=openai` swaps in a hosted model, since the interface is one method.
The prompt carries the schema and no rows. **Results are not sent back to the
model** either — the rows are customer names, emails and purchases, and sharing
them properly means deciding per column what may leave. The cost is prose that
is template-shaped rather than fluent; the benefit is an answer path with no
egress at all.

### Formats and outcomes

`json` is the interface — SQL, columns, rows, assumptions, context, timings —
and `text` is a projection of the same answer for a terminal, so the two cannot
drift.

The model chooses among `answer`, `clarification` and `unsupported` and nothing
else. Three named shapes turn "I don't know" into something a caller branches on
rather than prose it parses, and give the model somewhere to land that is not a
guess.

Two unrelated questions asked at once get one statement each, up to three;
joining them would invent a relation. A question that *depends* on another stays
one statement, with the dependency as a subquery.

### Context

"Same thing, last month" is unanswerable on its own, so the model is given what
came before — as statements, never as rows or figures, which keeps the data
boundary intact and a stale number impossible to repeat.
[Conversation](#conversation) has the mechanics.

## The shape of it

The model does one job: turn a question into **one SQLite SELECT statement**, with
a label per returned column and a sentence template to read the first row into. It
never sees a row and never states a figure. The rest is ordinary code:

```
question -> interpret -> validate (Zod + SQL guard) -> execute read-only, capped
         -> format from the declared columns
```

### The guard

[src/analytics/sql.ts](src/analytics/sql.ts), in order:

1. One statement: no semicolon, no comments, no bind placeholders. Quoted text is
   stripped first, so a semicolon inside a string literal is not a second
   statement.
2. Begins with `SELECT` or `WITH`, and mentions no writing or escaping keyword:
   `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `ATTACH`, `DETACH`,
   `PRAGMA`, `VACUUM`, `REINDEX`, transaction control, `sqlite_*`, `pragma_*`.
   `REPLACE` is rejected only as `REPLACE INTO`, because `replace()` is useful.
3. SQLite can prepare it, so a syntax error or invented column is a message rather
   than a 500 later.
4. `statement.readonly` and `statement.reader` are both true — SQLite's verdict on
   the parsed statement rather than an opinion about text. `WITH doomed AS (SELECT
   id FROM orders) DELETE FROM orders` shows why: it begins with `WITH` and passes
   the leading-keyword test. The keyword list catches it first, so this check is
   unreachable today; it is what holds if a write ever slips past a regex.
5. The columns produced are exactly the ones declared, so nothing is rendered
   under a heading from a different query.

Underneath, the connection is read-only *and* `query_only = ON`. Rows are pulled
one at a time and stop at a hundred, so a cross product costs a hundred rows.

A rejection is not an error: it goes back to the model with the reason, in the
same round-trip a schema violation uses. One repair attempt, then a 502.

### Numbers come from SQL, never from the model

The headline is a template — `"{product_name} tops the list with {units} units."`
— and [src/analytics/format.ts](src/analytics/format.ts) fills it from the same
row that fills the table, so sentence and table cannot disagree and the model
cannot fumble a digit it has never seen. Placeholders are checked against the
declared columns.

### Deciding when not to answer

- **answer**, with `assumptions` when the wording was loose ("most active user" is
  order count, and says so — a disclosed reading beats a round-trip).
- **clarification**, when something is genuinely missing: "a specific product"
  that names no product.
- **unsupported**, when the data cannot answer it: missing columns (cost, margin,
  returns, shipping) and missing categorisation. Products have a name, a SKU and a
  price, so "computer related items" would be an invented grouping presented as
  fact. It declines and says what it can do instead.

### Names

The model has never seen a row, so it matches on text. The data holds `Sofía
Ramírez`, `Zoë Whitfield`, `Lucas Müller` and `Élise Moreau`, and SQLite's `LIKE`
and `LOWER()` fold ASCII only, so `LOWER(name) LIKE '%sofia ramirez%'` matches
nothing. The read-only connection therefore registers one deterministic scalar
function, `unaccent(text)`, and the prompt uses it on both sides:
`unaccent(u.name) LIKE unaccent('%sofia ramirez%')`. That replaces the plan
version's entity-resolution pass. Words matching several products are no longer a
clarification — the statement groups by product and shows both.

### Time

Timestamps are ISO 8601 UTC strings, which compare and sort as text, so a window
needs no date functions. The prompt states the current UTC time, asks for
half-open bounds (`>= from`, `< to`) so adjacent periods tile without
double-counting midnight, and puts the week's start on Monday. This is where
handing work to the model costs most: date arithmetic is a common model error and
no resolver computes "the last seven days" in code any more. The mitigation is
disclosure — the exact statement comes back with every answer, with its bounds
spelled out as literals, so the window it was written against is visible.

### Conversation

Responses carry an opaque `context` the client sends back; the server holds no
state. It carries previous questions and the statements that answered them, never
a row and never a figure — enough to inherit intent ("same thing, different
month") and to resolve "it" as a subquery, while making a stale number impossible
to repeat. Returning statements are prompt material only and are never executed;
the SQL that runs is always the SQL produced in that request, guarded from
scratch.

Sequential questions mostly stop being sequential: "how many people bought the
most sold product" was two turns under the plan and is one subquery now. Two
*independent* questions still get one statement each, as two queries in one
response.

### Providers

One interface, `complete({system, user}) -> string`, with adapters for OpenAI and
Ollama over plain `fetch`, no SDKs. Both use plain JSON mode rather than strict
JSON-schema output: Zod enforces the shape either way and the loose mode behaves
consistently across providers. Invalid output — bad JSON, bad shape, or a
statement the guard refuses — is sent back once with the reasons, which local
models need; a second failure is an error, not a guess. The prompt carries the
schema and worked examples but no rows, so no customer name, email or catalog
entry reaches a third-party API.

## Assumptions

- **Money is USD**, formatted `$1,234.56`; the schema has no currency column.
- **Money stays in whole cents** to the formatter; the prompt forbids `/ 100`.
- **Relative dates use the real clock.** The seed data stops on 2026-07-20, so
  "yesterday" is genuinely empty later: a ranking returns no rows and says so,
  and an aggregate returns its one row of nothing as a zero and an em dash.
  Anchoring to the newest order would flatter a demo by answering a different
  question.
- **"The last N days" includes today**; other readings are defensible, which is
  why the statement is shown. **Weeks start on Monday**, per ISO 8601.
- **A hundred rows is enough** for any answer a person reads.
- **No authentication, rate limiting or request logging** — out of scope per the
  brief, all three needed before this faced anyone.

## Known gaps

- **Interpretation is unverified**, and that matters more than it did. The
  statement is checked for what it may *do*, never for whether it answers the
  question; a wrong join or a double-count across line items returns a confident
  number. Showing the SQL is mitigation, not a solution.
- **Truncation is blunt**: past a hundred rows the answer says more exist and is
  not re-run as a summary.
- **`unaccent()` cannot use an index**, since it wraps the column. Irrelevant at
  25 users and 30 products, wrong at a million.
- **No categories, cost or margin**, so "office supplies" and "profit" are
  refused. A data-model gap, and the one thing direct SQL does not fix.

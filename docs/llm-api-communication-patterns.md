# LLM API Communication Patterns

A reference on how LLM APIs communicate, how context windows grow, and how
Context Lens observes these patterns. Focuses on Anthropic but the core
concepts apply to all providers.

---

## The Fundamental Model: Stateless Request/Response

LLM APIs are **completely stateless**. The server retains no memory between
requests — no sessions, no server-side conversation state, no connection
affinity. Each HTTP request is processed independently by whatever GPU is
available.

What feels like a "conversation" is a **client-side illusion**. The client
(Claude Code, Codex, etc.) maintains a local message array and sends the
**entire thing** on every API call:

```
Call 1:  [A]                           →  server sees 1K tokens
Call 2:  [A, B, C]                     →  server sees 5K tokens
Call 3:  [A, B, C, D, E]              →  server sees 12K tokens
Call 4:  [A, B, C, D, E, F, G]        →  server sees 25K tokens
```

The server on call 4 has no idea that calls 1-3 happened. It sees a message
array and generates the next completion.

### Consequences

- **Context windows fill up** — you re-send everything, plus new content,
  every call.
- **Input tokens are billed repeatedly** — message A is billed on every
  single call.
- **Compaction is client-side** — when the context limit is reached, the
  client must summarize/truncate before the next call.
- **Prompt caching** (e.g., Anthropic's `cache_control`) lets the server
  skip re-processing unchanged prefixes. It's an optimization over the
  statelessness, not a departure from it.
- **Context Lens works as a simple proxy** — every request is
  self-contained, so capturing one request captures the full conversation
  state at that point.

---

## Request Structure (Anthropic Messages API)

Every request includes:

| Component | Location | Re-sent every call |
|---|---|---|
| **System prompt** | `body.system` | Yes |
| **Tool definitions** | `body.tools[]` | Yes |
| **Conversation history** | `body.messages[]` | Yes (grows each call) |

The `messages` array is alternating `user` and `assistant` roles. Content
within each message is a block array.

---

## Content Block Types

Within each message's `content` array:

| Block Type | Role | Source | Purpose |
|---|---|---|---|
| `text` | user or assistant | Both | Plain text content |
| `thinking` | assistant | Server-generated | Model's internal reasoning |
| `tool_use` | assistant | Server-generated | Model requests tool execution |
| `tool_result` | user | Client-generated | Client provides tool output |
| `image` | user | Client-provided | Image data (base64) |

---

## Two Response Flows

### Flow A: Terminal Response

The server generates a response and signals completion.

```
Client  ──[messages]──►  Server
Client  ◄──[thinking + text]──  Server     stop_reason=end_turn
```

### Flow B: Tool Callback

The server generates a response that requires client action before
continuing. This is a **continuation pattern** — the server says "I need you
to do something and come back."

```
Client  ──[messages]──►  Server
Client  ◄──[thinking + tool_use]──  Server  stop_reason=tool_use
                                            (client executes tool locally)
Client  ──[messages + thinking + tool_use + tool_result]──►  Server
Client  ◄──[thinking + text]──  Server      stop_reason=end_turn
```

Flow B is structurally identical to Flow A with a continuation inserted.
The `stop_reason` field is the server saying either "I'm done" (`end_turn`)
or "I need a callback" (`tool_use`).

### Tool Call Chaining

Tool calls can chain arbitrarily, creating a loop of continuations:

```
prompt → 🧠₁ → 🔧₁ → 📋₁ → 🧠₂ → 🔧₂ → 📋₂ → 🧠₃ → text
```

Each arrow back to the server replays **everything before it**. The 3rd API
call sends: `prompt + 🧠₁ + 🔧₁ + 📋₁ + 🧠₂ + 🔧₂ + 📋₂`.

---

## Thinking Blocks: The Hidden Overhead

Thinking blocks (`{type: "thinking", thinking: "..."}`) are
**server-generated and client-echoed**. The client doesn't write them — it
replays what the server returned as part of the conversation history.

### How They Accumulate

```
Turn 1: Client → API
  messages: [
    { role: "user", content: "Fix bug" }
  ]

Turn 1: API → Client
  { role: "assistant", content: [
      { type: "thinking", thinking: "Let me analyze..." },  ← generated
      { type: "text", text: "I'll look at the code" },
      { type: "tool_use", name: "Read", ... }
  ]}

Turn 2: Client → API
  messages: [
    { role: "user", "Fix bug" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Let me analyze..." },  ← ECHOED BACK
      { type: "text", "I'll look..." },
      { type: "tool_use", name: "Read", ... }
    ]},
    { role: "user", content: [
      { type: "tool_result", content: "<file contents>" }   ← new data
    ]}
  ]
```

A 2K-token thinking block on turn 1 has consumed `2K × N` cumulative input
tokens by turn N. Users often don't realize thinking blocks are re-sent
because they're not visible in the tool's UI.

---

## Thinking vs Tool Calls: Structural Comparison

| Property | Thinking | Tool Use | Tool Result |
|---|---|---|---|
| Generated by | Server | Server | Client |
| Echoed on next call | Yes | Yes | Yes |
| Billed as input on echo | Yes | Yes | Yes |
| Accumulates linearly | Yes | Yes | Yes |
| Size controlled by | Server (`max_tokens`) | Server (`max_tokens`) | **Client (unbounded)** |
| Contains new information | No (replay) | No (replay) | **Yes (external data)** |

The critical asymmetry: **tool results inject external data of arbitrary
size**. A `tool_use` block might be 200 tokens (tool name + JSON args), but
the `tool_result` could be 50K tokens of file content. This is why tool
results dominate context growth in practice.

---

## Turns vs API Calls (Entries)

### API Calls (Entries)

Every HTTP request to the LLM API is one **entry**. A single user
interaction can produce many entries:

```
User says: "Fix the bug"
  Entry 1: think → Read file       (stop_reason=tool_use)
  Entry 2: think → Read another    (stop_reason=tool_use)
  Entry 3: think → Edit file       (stop_reason=tool_use)
  Entry 4: think → "Done!"         (stop_reason=end_turn)
```

Each entry carries the **full context window** at that moment.

### User Turns

A **user turn** groups all entries between one user prompt and the agent
returning control (`end_turn`). One user turn = one prompt + N API calls.

```
User Turn 1: "Fix the bug in auth.ts"
  ├── Entry 1: main, stop=tool_use     (Read)
  ├── Entry 2: main, stop=tool_use     (Read)
  ├── Entry 3: main, stop=tool_use     (Edit)
  └── Entry 4: main, stop=end_turn     ← turn boundary

User Turn 2: "Now add a test for it"
  ├── Entry 5: main, stop=tool_use     (Read)
  ├── Entry 6: subagent, stop=end_turn (spawned search, own context)
  ├── Entry 7: main, stop=tool_use     (Write)
  └── Entry 8: main, stop=end_turn     ← turn boundary
```

### Context Growth Within a Turn

```
Entry  Context    Delta    What happened
─────  ─────────  ──────   ──────────────────────────────────
  1      25K       —       Initial prompt + system + tools
  2      31K      +6K      thinking₁ + tool_use + tool_result₁
  3      45K      +14K     thinking₂ + tool_use + tool_result₂ (big file)
  4      49K      +4K      thinking₃ + final text (end_turn)
```

---

## Output Token Limits and Context Growth

`max_tokens` caps the **total output** per API call (thinking + text +
tool_use combined). Anthropic also offers `thinking.budget_tokens` to cap
thinking specifically.

Smaller output limits slow context growth per call, but there's a tradeoff:

### Single Large Output vs Many Small Outputs

Given the same total tokens added to context, the **cost** differs
dramatically:

```
Scenario A: One big tool result (1 round-trip)
  Call 1: send 20K  → receive 1K (thinking + tool_use)
  Call 2: send 50K  → receive 1K (thinking + text)

  Final context: ~51K
  Total input billed: 70K

Scenario B: Five small tool results (5 round-trips)
  Call 1: send 20K  → receive 1K      = 20K billed
  Call 2: send 26K  → receive 1K      = 26K billed
  Call 3: send 32K  → receive 1K      = 32K billed
  Call 4: send 38K  → receive 1K      = 38K billed
  Call 5: send 44K  → receive 1K      = 44K billed
  Call 6: send 50K  → receive 1K      = 50K billed

  Final context: ~51K (same!)
  Total input billed: 210K (3x more!)
```

Three separate concerns:

| Concern | What matters |
|---|---|
| **Context quality** | Final window size + composition. Same total = same degradation. |
| **Cost ($)** | Total input tokens across all calls. More round-trips = worse (re-sending is multiplicative). Prompt caching helps. |
| **Context velocity** | Tokens added per call. `max_tokens` helps here but increases number of calls needed. |

---

## How Context Lens Observes These Patterns

### Composition Analysis

Context Lens classifies every token in a request into categories:

- `system_prompt` — system instructions
- `tool_definitions` — tool schemas in `body.tools[]`
- `tool_results` — tool output (from client)
- `tool_calls` — tool_use blocks (from server, echoed)
- `thinking` — thinking blocks (from server, echoed)
- `assistant_text` — visible assistant text
- `user_text` — user messages
- `system_injections` — injected system reminders
- `images` — image data

### Health Audits

Five weighted audits score context health:

| Audit | Weight | What it measures |
|---|---|---|
| Context Utilization | 30 | How full the context window is |
| Tool Results | 25 | Proportion + largest single result |
| Tool Definitions | 20 | Overhead of tool schemas vs usage |
| Growth Rate | 15 | Per-call context growth speed |
| Thinking Overhead | 10 | Percentage of context consumed by thinking |

Tool results get heavier weight (25) than thinking (10) because:
- Tool results are **client-controlled** and actionable (truncate output)
- Tool results are **unbounded** in size
- Thinking is **server-controlled** and not directly actionable
- Thinking tends to be smaller per block

### Compaction Detection

Since the API is stateless and context should only grow (each call adds to
the conversation), a **decrease in token count** between consecutive same-agent
API calls means the client removed content — i.e., compacted the context.

Context Lens cannot directly observe the client performing compaction. It
infers it purely from the token count signal.

#### Detection: LHAR Record Building (`src/lhar/record.ts`)

At ingestion time, each entry is compared to the previous entry **from the
same agent** (main or subagent). The same-agent filter prevents false
positives from main/subagent context size differences:

```typescript
// Walk backwards to find previous entry with matching agentKey
let prevEntry: CapturedEntry | null = null;
for (let i = convoIndex - 1; i >= 0; i--) {
    if (convoEntries[i].agentKey === entry.agentKey) {
        prevEntry = convoEntries[i];
        break;
    }
}
const prevTokens = prevEntry ? prevEntry.contextInfo.totalTokens : 0;
const tokensAdded = prevEntry ? ci.totalTokens - prevTokens : null;
const compactionDetected = tokensAdded !== null && tokensAdded < 0;
```

Any decrease (`tokensAdded < 0`) sets `compaction_detected: true` on the
LHAR record. This is a strict check.

#### Health Audit: Growth Rate (`src/core/health.ts`)

The growth rate audit uses a **softer 30% threshold** to avoid flagging
small decreases from token estimation variance:

```typescript
if (currentTokens < previousTokens * 0.7) return 40;  // score of 40/100
```

A compaction scores 40 — not catastrophic, but a yellow flag. The
description reads: "Compaction detected — context was truncated or
summarized."

#### Session Analysis: Enrichment (`src/core/session-analysis.ts`)

`findCompactions()` consumes the boolean flag from the LHAR record and
enriches it with before/after metrics. For each compaction, it walks
backwards to find the peak token count before the drop:

```typescript
for (let j = i - 1; j >= 0; j--) {
    const prev = entries[j];
    if (agentRole(prev) !== role) continue;
    if (cumTokens(prev) >= after) {
        bestBefore = cumTokens(prev);
        break;
    }
}
```

This produces a `CompactionEvent`:

| Field | Description |
|---|---|
| `beforeTokens` | Peak context size before compaction |
| `afterTokens` | Context size after compaction |
| `tokensLost` | Absolute difference |
| `pctLost` | Percentage lost (e.g., 47.3%) |

#### Example

```
Entry  Tokens   Delta    Flag
─────  ──────   ──────   ─────────────────────
  1     25K       —
  2     35K     +10K
  3     52K     +17K
  4     78K     +26K
  5     95K     +17K     approaching limit
  6    110K     +15K
  7     58K     -52K     COMPACTION (110K → 58K, lost 47.3%)
  8     65K      +7K     growth resumes from new baseline
  9     80K     +15K
```

Entry 7 triggers because `58K - 110K = -52K < 0`. The session analysis
records `{beforeTokens: 110K, afterTokens: 58K, tokensLost: 52K,
pctLost: 47.3}`.

#### Why Same-Agent Filtering Matters

Without filtering by agent, a main agent entry at 80K followed by a
subagent entry at 10K (subagents have their own, smaller context) would
look like a 70K compaction. Comparing same-agent-to-same-agent avoids
these false positives.

#### Growth Blocks

Compaction events divide the session timeline into **growth blocks** —
periods of monotonically increasing context between compactions. Each
block tracks:

- Start/end token counts
- Number of entries in the block
- Tokens gained
- Average growth rate per entry (`ratePerTurn`)

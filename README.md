# Context Status Bar

A [pi](https://github.com/earendil-works/pi-coding-agent) TUI extension that replaces the footer with a visual bar showing how the context window is composed.

## Why this extension?

As conversations grow, the context window fills up with a mix of system prompts, user messages, LLM responses, tool call results, and summaries. **This extension gives you an at-a-glance view of what's consuming your context window**, which is valuable for:

### Debugging Agent Efficiency

| Scenario | What to look for | What it might mean |
|----------|-----------------|---------------------|
| **LLM dominates** | 🤖 > 60% of context | Agent is very verbose, or producing long responses. Consider adjusting temperature or adding output constraints. |
| **Tools dominate** | 🔧 > 40% of context | Too many tool calls. Each tool result (output + details) consumes tokens. Check if the agent is over-fetching or making redundant calls. |
| **User is tiny** | 👤 < 5% of context, but LLM is huge | Agent may be over-explaining or repeating itself. The user message is short but the agent's response is disproportionately long. |
| **Summary is large** | ◈ > 10% of context | Compaction summaries are bloated. Review compaction settings — summaries that are too long suggest the agent isn't condensing effectively. |
| **System is large** | ⚙ > 20% of context | Your system prompt, skills, or tool descriptions are heavy. This is fixed overhead — consider trimming `agent.md` or disabling unused skills. |

### Evaluating Compaction Quality

After compaction triggers, compare the **Summary** segment against the **LLM** segment:
- If Summary ≈ LLM, compaction is barely compressing — the agent is retaining too much detail
- If Summary ≪ LLM, compaction is working well

### Monitoring Cache Performance

The `R` token count in Line 1 shows cumulative **cache read tokens** from the API. A high R value means most of your context is being served from cache (good — saves cost and latency). A low or zero R value means the model is recomputing from scratch.

### Conversation Diagnostics

- **Input/Output delta (`↑` / `↓`)** — Shows the token balance of the *current turn*. A huge `↓` after a short `↑` means the agent produced a long response from a brief prompt.
- **Context utilization `%`** — When you hit > 80%, consider ending the conversation and starting a new one. The agent may start dropping old context.

## Status Bar Layout

### Line 1 — Proportion Bar + Utilization

```
[72%/50k R12k] ↑15k ↓35k [█████░░░░░] (gpt-4o)
```

| Part | Description |
|------|-------------|
| `[72%/50k R12k]` | Context window utilization — percentage used, window size, and optional cache-read tokens (`R`) |
| `↑15k ↓35k` | **Input / Output token delta** for the current turn — green `↑` for user/system/tool input, amber `↓` for LLM output |
| `[█████░░░░░]` | Color-coded proportion bar — each colored block's width is proportional to that segment's token share |
| `(gpt-4o)` | Model identifier (optional, shown when available) |

### Line 2 — Segment Breakdown

```
[⚙ 2k (4%)] [🤖 35k (70%)] [👤 1k (2%)] [🔧 1k (2%)] [◈ 1k (2%)]
```

Each bracketed segment shows:

| Element | Example | Meaning |
|---------|---------|---------|
| Icon | `⚙` | Segment type (see table below) |
| Tokens | `2k` | Estimated token count (e.g. `2k` = ~2,000) |
| Percentage | `(4%)` | Share of total context |

#### Segment Legend

| Icon | Label | Contents |
|------|-------|----------|
| ⚙ | System | System prompt, `agent.md`, skills, tool descriptions |
| 🤖 | LLM | Assistant / model response tokens |
| 👤 | User | User message tokens |
| 🔧 | Tools | Tool call results and bash execution outputs |
| ◈ | Summary | Compaction and branch summary tokens |
| ⊕ | Custom | Extension-injected messages |

## Installation

Copy `context-status-bar.ts` into your pi extensions directory:

```bash
cp context-status-bar.ts ~/.pi/agent/extensions/
```

Or if you're maintaining the repo in git, use a symlink:

```bash
ln -s ~/projects/pi-extensions/context-status-bar.ts ~/.pi/agent/extensions/
```

## Usage

Toggle the status bar on/off:

```
/context-bar
```

When enabled, the footer is replaced by the two-line status bar. When disabled, the default footer is restored.

### History Chart

View how context composition evolved during the session:

```
/context-bar history
```

This shows a mini bar chart with up to 10 snapshots (one per turn), each displaying:
- **Mini bar** — proportional token share per segment (color-coded)
- **Labels** — segment name, token count, and percentage (e.g. `System 1.2k(60%)`)

Example output:

```
 Context History  (4 snapshots, 4 turns)

#1 │ ████████████░░░░░░░░░░░░ System 1.2k(60%) LLM 0.8k(40%)
#2 │ ██████████████████░░░░░░ System 1.5k(45%) LLM 1.3k(40%) Tools 0.5k(15%)
#3 │ ██████████████████████░░ System 1.0k(30%) LLM 1.3k(40%) Tools 1.2k(30%)
#4 │ ████████████████████████ System 1.0k(25%) LLM 1.4k(35%) Tools 1.5k(40%)

─────────────────────────────────────────────────────►
  time →
```

This lets you spot trends like:
- **Tools growing** — agent is making many tool calls over time
- **LLM shrinking** — agent responses are getting more concise
- **System constant** — fixed overhead from your system prompt

#### How it works

Snapshots are captured automatically when the context changes — specifically when the **total token count** differs from the last snapshot. This means a snapshot is taken whenever:

| Event | Captures snapshot? |
|-------|-------------------|
| User sends a prompt | ✅ (user message + tool calls) |
| LLM responds (new assistant message) | ✅ (LLM tokens added) |
| Tool output arrives | ✅ (tool tokens added) |
| Compaction happens | ✅ (summary replaces old messages) |
| TUI redraws (no new messages) | ❌ (tokens unchanged, guard skips) |

The guard `totalTokens !== lastTotalTokens` prevents spamming snapshots on every TUI redraw tick. If the LLM is streaming (partial response), you may get multiple snapshots as tokens accumulate — the `MAX_HISTORY = 10` cap prevents unbounded growth.

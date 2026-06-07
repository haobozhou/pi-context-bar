# Context Status Bar

A [pi](https://github.com/earendil-works/pi-coding-agent) TUI extension that replaces the footer with a visual bar showing how the context window is composed.

## Overview

The status bar renders **two lines** of information:

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
[⚙ 2k (4%)] [🤖 35k (70%)] [◉ 1k (2%)] [⚡ 1k (2%)] [◈ 1k (2%)]
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

## Usage

Toggle the status bar on/off:

```
/context-bar
```

When enabled, the footer is replaced by the two-line status bar. When disabled, the default footer is restored.

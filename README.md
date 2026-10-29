# AI Total Recall

A memory cockpit for Claude Code. See what your assistant recalled, what it learned, and the rules it works under, live, while you work. Search memory from a sidebar without spending a single token.

Most Claude Code mods show you instruments: context meters, cost, file trees. This one shows you what the assistant actually knows about you and your project.

## What you get

- **A pane** beside the transcript with three tabs. **Recalled** lists every memory the assistant looked up this session, with importance, scope and a one-line summary. **Learned** lists what it saved. **Rules** lists the hard rules in force. Press Enter on any row to expand it, copy it, start a prompt about it, or find related memories.
- **A search box** in the pane. Type a query, press Enter, and the results come straight from your memory server. No model turn, no tokens.
- **A band above the prompt** with live counts, a pulse of memory activity per turn, and the last thing that happened ("recalled 5 for 'x402 billing'", "saved 'deploy path'").
- **Tidy transcript cards.** Every memory call in the transcript draws as one readable row with the subjects beneath it, instead of a block of JSON.
- **A toast** each time something is committed to memory, and a status line entry with the running counts.

Everything follows your Claude Code theme.

## Install

In a Claude Code terminal session:

```
/plugin install aitotalrecall --marketplace hifriendbot/aitotalrecall
```

Answer `y` to add the marketplace, then pick the user scope. The band appears above the prompt at once.

Requirements: Claude Code 2.1.296 or newer, and a memory server. AI Total Recall watches the [CogmemAi](https://hifriendbot.com/developer/) memory tools. If none is connected, the pane tells you and gives you the one-line setup:

```
npx cogmemai-mcp@latest setup
```

## Use

| Action | How |
| --- | --- |
| Open the pane | `/recall`, or click **Open** on the band |
| Switch tabs | `r` Recalled, `l` Learned, `u` Rules while the pane has the keyboard |
| Walk rows | `Tab`, then `Enter` to expand |
| Search memory | Tab to the search box, type, `Enter`. Also `/recall find <query>` |
| Hide or show the band | `/recall hide`, `/recall show` |
| Clear this session's lists | `/recall clear` |
| Check the memory server | `/recall setup` |
| Back to the prompt | `Esc` |

The long form of every command is `/aitotalrecall`, in case another plugin owns `/recall`.

## Privacy

The mod runs inside your Claude Code session and makes no network calls of its own. It reads the results of memory tool calls that are already happening in your session, and a pane search calls the same memory tool the assistant would. Nothing leaves your machine that was not leaving already.

## How it works

AI Total Recall is a Claude Code mod: a plugin of function hooks. It hooks the memory server's tool calls, parses their results into session state, and draws the pane, the band and the transcript cards from that state. The tool results themselves pass through untouched. Source is in `hooks/register.tsx`, about a thousand lines, with the tests beside it.

Run the checks yourself:

```
claude plugin validate .
claude plugin test .
```

## Roadmap

- Guard verdicts in the band when the memory server reviews a change
- One-key promote: turn a recalled memory into a rule
- Team memory view

## License

MIT. See `LICENSE`.

AI Total Recall is made by Scott Crawford. Memory is powered by CogmemAi.

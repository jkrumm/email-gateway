# Root AGENTS.md split ledger

The root `AGENTS.md` was 32,840 bytes against the 12,000-byte budget of `rules/writing-for-agents.md`. Every block of the original and where it went; the table follows the original line order. A moved block keeps its words verbatim; the root keeps a summary or a pointer where a block was split.

| Original lines | Bytes  | Entry                             | Destination                                                                           |
| -------------- | ------ | --------------------------------- | ------------------------------------------------------------------------------------- |
| 1-20           | 1,563  | Header and doc table              | root `AGENTS.md`, unchanged                                                           |
| 21-38          | 1,154  | Stack                             | root `AGENTS.md`, unchanged                                                           |
| 39-67          | 1,770  | Validate                          | root `AGENTS.md`, unchanged                                                           |
| 68-165         | 7,155  | Invariants that change a decision | `docs/invariants.md` (verbatim); root keeps a summary of the hard lines and a pointer |
| 166-197        | 1,999  | Deploy                            | root `AGENTS.md`, unchanged                                                           |
| 198-218        | 1,261  | Verify & Monitor                  | root `AGENTS.md`, unchanged                                                           |
| 219-232        | 898    | Local dev                         | root `AGENTS.md`, unchanged                                                           |
| 233-455        | 15,906 | File map                          | `docs/file-map.md` (verbatim); root keeps a pointer                                   |
| 456-464        | 478    | Conventions                       | root `AGENTS.md`, unchanged                                                           |
| 465-475        | 656    | Gotchas                           | root `AGENTS.md`, unchanged                                                           |

## Sizes

| File                 | Before | After  |
| -------------------- | ------ | ------ |
| `AGENTS.md`          | 32,840 | 11,066 |
| `docs/invariants.md` | new    | 7,177  |
| `docs/file-map.md`   | new    | 15,926 |

## Reach

Both moved docs are reached from a pointer the root names with its trigger: "Before changing a file under `src/`, Read `docs/file-map.md`" and "Before changing a send route, the SES webhook, IMAP sync, the job queue, a migration or the host gate, Read `docs/invariants.md`". The root summary repeats the hard lines so a task that never opens the doc still holds them.

Proof: a unique marker sat in each moved doc (`CANARY-FILEMAP-1932`, `CANARY-INVARIANTS-1932`). A cold reader given only `AGENTS.md`, asked to follow its pointers before a `src/` change and before a send-route change, opened both docs and reported both markers. The markers were removed afterwards.

Not yet a live session: the proof is one cold reader following the pointers, not a session that auto-loads the root file.

Pre-existing references in the root file that resolve outside this repo (`rules/agent-limits.md`, `rules/security.md`, the `vps/apps/email-gateway/` paths) were left as they were.

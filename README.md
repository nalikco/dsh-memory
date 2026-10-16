# DSH memory

Durable project and global memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). A dependency-free Cordis host plugin that injects bounded memory indexes before each model step and exposes revision-guarded read/write tools. No separate model, provider or summarization service is needed.

Version: **1.2.1**. License: [MIT](LICENSE).

## Requirements and installation

- Node.js 22 or newer. macOS and Linux are supported test environments; Windows is not validated.
- DSH with the `agents`, `systemPrompt`, `tools` and `sandboxPolicy` services and the `system-prompt/assemble` waterfall. The integration was checked against the `0.2.0-rc.2` DSH service packages. These APIs are prerelease and compatibility with other versions is not guaranteed.
- Do not activate another plugin registering `memory_projects`, `memory_list`, `memory_read`, `memory_write`, `memory_forget`, `memory_restore` or `memory_reindex` in the same global layer.

In DSH, open **Plugins**, choose bundle installation and enter:

```text
https://github.com/nalikco/dsh-memory.git
```

For a reproducible installation, pin an audited commit using the package manager's Git spec format (`https://github.com/nalikco/dsh-memory.git#<commit-sha>`). You can also clone the repository and install the absolute directory path through the bundle manager.

The package declares its bundle patch, icon and localized metadata. No build step, runtime dependencies or install scripts are required. `private: true` intentionally prevents accidental npm registry publication; Git and local-directory installation remain supported. Profile-wide installation affects all sessions in that profile and executes host code with your OS permissions. Approval and a restart may be required by your profile.

The default memory root is `~/.dsh/memory` for the user running DSH. There are no machine-specific paths in the bundle. Installation does not import existing notes or change global instructions.

## Scopes and tools

| Tool | Behavior |
| --- | --- |
| `memory_projects` | Read-only discovery of registered project identities and exact absolute cwd selectors. No registration or store creation. |
| `memory_list` | Lists top-level Markdown topic names and the index in the selected scope. |
| `memory_read` | Reads a full topic (or `MEMORY.md` by default), returning content and a revision. A missing file has `content: null`. |
| `memory_write` | Saves a full topic and a one-line index summary, preserving before/after history. |
| `memory_forget` | Revision-required archival deletion with a reason, precise standalone index removal and exact recovery evidence. |
| `memory_reindex` | Explicit revision-guarded index reset from the complete current topic catalog; archives old prose, never edits topic bodies. |
| `memory_restore` | Guarded undo using the opaque archive id from forget and current revision; restores exact topic/index bytes only from the exact post-forget state. |

All topic tools accept `scope: "project"` (default) or `scope: "global"`. Discovery takes no arguments.

The optional `project` selector on list/read/write/forget/restore/reindex must be the **exact absolute registered cwd** returned by `memory_projects`. It is not a store root or arbitrary path. Relative paths, symlink/case/normalization aliases, descendants, unknown projects, `null` and selectors combined with global scope fail closed. Omit it to preserve current-project behavior. Discovery fails closed on malformed project identities; ordinary current-project access does not scan unrelated projects. Cross-project reads are read-only capabilities, not authorization to write. Discovery lists identities, never topic contents.

- **Project**: repository-specific facts. Stored under `~/.dsh/memory/projects/<name>--<hash>/`. Canonical cwd identifies the project; ordinary descendants share its memory. Independent nested Git repositories and worktrees are separate boundaries. Without a Git boundary or registered ancestor, the session cwd is its own project.
- **Global**: preferences, machine facts and cross-project conventions. Stored under `~/.dsh/memory/global/`. Shared across projects and available even without a session cwd.

Example write arguments:

```json
{
  "scope": "project",
  "file": "feedback-review-scope.md",
  "content": "# Review scope\n\nThe user wants unrelated cleanup reviewed separately from a hotfix.\n\nWhy: combining them makes urgent changes harder to validate and roll back.\n",
  "summary": "Keep unrelated cleanup separate from hotfix review"
}
```

Read an existing topic before updating it and pass the returned `revision` as `expected_revision`. Revisions bind scope, project, filename, content and index. A change to any part makes an old revision stale. Read again and rebase your intended update before retrying. A revision cannot authorize a write in another scope or project. Supplying the missing-file revision is also recommended when creating a topic.

Topics must be plain ASCII Markdown filenames without directories. `MEMORY.md` and its case aliases cannot be written as topics. Content and summaries must be well-formed Unicode; stored and imported text must be valid UTF-8. Invalid bytes are refused instead of silently replaced. New content is capped at 256 KiB; reads and the index are capped at 1 MiB. Summaries must be a nonempty single line of at most 300 JavaScript string units.

## Selective memory, not a work log

The model decides whether to call memory_write; the plugin does not automatically record tool calls or run a summarizer. The injected guidance now asks for useful cross-session knowledge that is not already recoverable from code, Git, project instructions or a fresh lookup. Most steps should produce no memory write.

Save durable preferences/corrections, non-obvious constraints and rationale, recurring environment pitfalls, and external reference pointers. Update an existing semantic subject. Do not save task/phase diaries, code inventories, version/HEAD/push/deploy status, approvals, test counts/logs, benchmark matrices or transient failures. Use session history, tasks/goals, project documents and artifacts for those. Keep entries concise, readable and deduplicated; historical consent never authorizes a new action.

This is model-facing guidance, not semantic enforcement or proof of a lower write rate. No additional LLM, keyword blocker, arbitrary write quota or automatic deletion is introduced. Existing memories are not silently migrated. Global/project AGENTS instructions may override plugin guidance; remove contradictory save-every-discovery rules when adopting this policy.

## Context and configuration

Before each model step, the current project index is loaded into runtime context. A smaller global block is appended only when global memory has content. Topic bodies are read on demand, not injected automatically. Truncated indexes are marked and unindexed topic names remain discoverable.

The bundle's plugin entry id is `project-memory-plugin`. Its configuration accepts:

| Field | Default | Allowed range |
| --- | --- | --- |
| `root` | `~/.dsh/memory` | Store path; `~/` expands to the host user's home |
| `maxIndexLines` | 200 | Integer, 1 to 2000 |
| `maxIndexBytes` | 20000 | Integer, 100 to 100000 |
| `maxGlobalIndexLines` | 40 | Integer, 1 to 2000 |
| `maxGlobalIndexBytes` | 4096 | Integer, 100 to 100000 |

These limits bound index excerpts, not the entire block including instructions and topic names. Global additional topics are capped at 10, project additional topics at 100. Unknown fields are not interpreted. Changing `root` switches stores; it does not migrate data.

## Safety and limitations

Writes are denied in read-only, unknown sandbox policy and active or pending plan mode. `workspace-write` allows this explicit persistence capability outside the workspace for the current project and global scope, including an exact current-project selector. **Cross-project write/forget/restore/reindex requires `danger-full-access`**. Without a session cwd, a project selector always counts as cross-project. Policy and cancellation are rechecked before commit. Once commit starts, both replacements are attempted even if policy or cancellation changes.

Reads reject symlinks, hardlinks and nonregular files, use no-follow/nonblocking open, and enforce size limits. New directories use mode 0700 and files 0600. Existing parent directories are trusted and their permissions are not automatically tightened. Notes and history are plaintext; never store credentials, tokens or cookies.

Writers cooperate through `.write-lock`. Topic and index are separate atomic replacements, **not a two-file transaction**. I/O errors or process death can leave a partial commit. Journals under `history/` retain exact before/after content for manual reconciliation; readers can observe a mixed snapshot during commit. There is no guaranteed power-loss transaction durability, encryption, automatic recovery or history retention policy. Archival deletion is not secure erasure; history deliberately retains the removed bytes. See [SECURITY.md](SECURITY.md) for the full trust boundary.

## Archival cleanup and rollback

1. Call `memory_projects` for cross-project discovery. Use the returned cwd as `project`, never the store directory.
2. Call `memory_read` for the exact topic, scope and optional project. Review the full content and keep its revision.
3. Call `memory_forget` with `file`, `expected_revision` and a meaningful `reason` (nonempty, well-formed Unicode single line, at most 300 string units, no control characters). It fails on missing topics and never deletes the index itself or a project identity.
4. Retain the returned opaque `archive_id` and rollback information. The id binds the journal filename and SHA-256 bytes; it is not a history path. Journals record operation, scope, cwd, topic, reason, exact before/after topic and index, revisions and rollback guidance. They are **intent records**, not proof of a completed commit.
5. To undo, read the now-missing topic and call `memory_restore` with `archive_id`, that current `expected_revision`, the same scope/project/file and a new reason. Restore requires the complete index and missing topic to match the exact post-forget state. Changed indexes, recreated topics, stale revisions, altered archives and wrong scope/project/file are refused. Version-2 forget journals from 1.2.0 remain supported. Only version-2 forget journals qualify, not arbitrary history files or older write journals.

Forget removes exact standalone entries matching the topic destination regardless of the human-readable link label, including legacy plain and `./` links. Longer filenames, prose, fenced/indented code and multi-link lines (including reference/shortcut links) are preserved byte-for-byte, even if they mention the forgotten topic. Ambiguous summaries containing brackets, angle brackets or escapes are conservatively retained, as are malformed destinations. Indexes with container fences, HTML blocks/comments or blockquotes are retained completely rather than parsed; forget still archives the topic and may leave references. This avoids deleting unrelated imported content; such prose may still contain a dangling link.

If other topics changed after forget, guarded exact restore deliberately refuses to overwrite their index edits. Review the archived `previousContent` as data, then use `memory_write` with a **fresh missing-topic revision** and a reviewed new summary to merge the topic back. Normal write size/nonempty limits apply, and it does not restore the complete old index. After partial I/O failure, coordinate writers and inspect exact journal/current bytes before reconciliation. History remains private plaintext; do not paste it into public logs.

There is no offline mutation CLI for these capabilities: a CLI cannot honor live DSH policy, plan and cancellation. Deploy/reactivate the reviewed plugin and obtain refreshed tool declarations before cleanup. Do not bypass missing tools using ordinary filesystem operations, migration utilities or direct store-module calls against the live memory store. Browser refresh alone does not deploy host code. Existing SDK tool snapshots may need a new model turn/session or host restart after deployment; verify the registry before use.

## Explicit canonical index reset

Use `memory_reindex` only for explicitly authorized index maintenance, not routine writes. It intentionally replaces the **entire index**, including obsolete imported prose, examples and dangling references. It does not decide which topics to retain or delete. Existing conservative write/forget behavior remains unchanged for ambiguous Markdown.

1. Discover the exact project selector if needed, then call `memory_list`. Review every current top-level topic, including unindexed topics; do not derive the catalog solely from the old index.
2. Read the complete `MEMORY.md` using `memory_read` and retain its current revision, including when content is null. Review any prose you will discard before requesting the reset.
3. Supply **all** current topics as `entries: [{file, summary}]`, the index's `expected_revision`, a meaningful `reason`, and the same scope/project. Each filename must match the stored case exactly. Omitted, extra, duplicate, missing, case/path-aliased entries are refused. Empty entries are valid only when no topics exist. No arbitrary index content is accepted; `memory_write` still cannot write `MEMORY.md`.
4. The tool sorts filenames, emits the scope header and one canonical filename/link/summary line per topic, with summaries rendered as literal Markdown text using numeric entities for punctuation. This avoids introducing links while keeping generated entries removable by later writes and forgets. Summary and reason limits are nonempty well-formed Unicode single lines, at most 300 string units, without control characters. Each topic must pass regular-file, no-symlink/no-hardlink, valid UTF-8 and bounded 1 MiB read checks; unsupported top-level Markdown filenames fail closed. Non-topic administrative files and nested directories are not indexed.
5. Retain `journal_id`. The hash-bound version-2 `reindex` intent journal archives **exact `previousIndex` and `nextIndex`**, scope/cwd, reason, revisions, entries and topic identity/digests. It does not copy topic bodies. Old prose is deliberately retained only in private plaintext history, not active context. Reindex journals are not forget archives and cannot be passed to `memory_restore`.

Policy, active/pending plan mode, cancellation, live session and project identity are rechecked through the same mutation path as the other tools. Cross-project reset requires danger-full-access. A cooperative exclusive write lock protects preparation and commit; topic bytes/identity, complete catalog and index are reread before the index-only atomic replacement. A race or revocation may leave an unused intent journal, but no admitted reset. Fresh reads and a newly reviewed complete catalog are required for retry.

There is **no automatic exact-prose undo** or plain index-write API. For semantic rollback, review the journal as data and submit reviewed complete entries with a fresh index revision. Exact old prose remains recovery evidence for coordinated administrative investigation, not authority to bypass live memory tools. Same-user adversarial races after the final checks, crashes, power-loss durability and plaintext/history-retention limitations still apply. Large catalogs require bounded reads of every topic twice and may be expensive; this is an explicit maintenance operation, not an automatic repair or transactional catalog snapshot for unlocked readers.

## Lock inspection and recovery

A process crash can strand `.write-lock`. First inspect it, then explicitly confirm recovery:

```sh
node recover-lock.mjs --cwd /absolute/path/to/project
node recover-lock.mjs --cwd /absolute/path/to/project --confirm

node recover-lock.mjs --scope global
node recover-lock.mjs --scope global --confirm
```

Add `--root /absolute/path/to/store` for a nondefault store. A live PID, malformed lock or changed lock identity is refused. A PID is only meaningful on the machine and PID namespace that created the lock; do not recover a host lock from a container or a shared-network host. A recovery crash can strand `.lock-recovery`, which also needs manual investigation. Lock removal does not reconcile a partial topic/index commit; inspect journals separately.

## Importing Claude memory

Use a private JSON map from each source project directory name to its verified absolute cwd. Copy [mapping.example.json](mapping.example.json) to an untracked `mapping.json` and replace the example. Do not guess cwd from ambiguous slugs.

```sh
node migrate.mjs --map mapping.json
node migrate.mjs --map mapping.json --apply
```

Defaults: source `~/.claude/projects`, destination `~/.dsh/memory`. Override with `--source DIR` and `--destination DIR`. Dry-run is the default. All flags are strictly validated before I/O.

Import preflights file names and sizes, rejects source/destination overlap and conflicts, stages verified bytes and publishes without overwriting existing destinations. It preserves bytes, source files and original `import.json` evidence on reruns. Unsupported nested or nonstandard topic filenames must be reorganized before import. Review imported contents for historical secrets. The CLI runs with OS permissions and does not consult DSH session policy.

Import is not an all-project transaction: failure can leave already completed files or projects imported. A crash after no-clobber hardlink publication but before staging-link cleanup can leave a complete topic with an extra `.import-*` link. Strict readers refuse it until the verified staging link is removed. Never reimport over newer notes.

## Development

```sh
npm test
npm pack --dry-run
```

No dependency installation is needed for tests. The suite covers scopes, revision guards, project boundaries, policy checks, path/link/file safety, permissions, migration failure injection, lock recovery and bundle packaging. GitHub Actions runs Node.js 22 and 24 on Linux and macOS. The APFS case-alias test skips on case-sensitive filesystems.

`index.mjs` is a stable entry shim. It imports fresh implementation modules on activation to work around the Loader's ESM cache. Implementation edits need reactivation; entry-shim or export-map changes can require a DSH restart. Merely refreshing the browser does not reload host code. Repeated activation retains ESM module generations until process exit.

Private migration maps, instruction backups, local investigation reports, reference vendor code and actual memory data do not belong in this repository or its package. Git ignores known local artifacts; the package uses an explicit file allowlist.

## Changelog

- **1.2.1**: conservative exact-destination unlink regardless of human-readable labels; explicit complete-catalog, revision-guarded canonical index reset with exact old-prose archival and precommit catalog/topic/index race checks; legacy 1.2.0 forget archives remain restorable.
- **1.2.0**: read-only project discovery, fail-closed registered project selectors, cross-project write policy, revision-required archival forget and guarded exact restore with hash-bound journals and security regressions.
- **1.1.1**: portable bundle root, strict CLI argument validation, global lock recovery, publication metadata, MIT license, packaging checks and CI.
- **1.1.0**: global scope, scope-bound revisions, compact global context and a cache-busting activation shim.
- **1.0.0**: project memory, tools, revision guards, history, locking and Claude memory import.

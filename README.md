# DSH memory

Durable project and global memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). A dependency-free Cordis host plugin that injects bounded memory indexes before each model step and exposes revision-guarded read/write tools. No separate model, provider or summarization service is needed.

Version: **1.1.1**. License: [MIT](LICENSE).

## Requirements and installation

- Node.js 22 or newer. macOS and Linux are supported test environments; Windows is not validated.
- DSH with the `agents`, `systemPrompt`, `tools` and `sandboxPolicy` services and the `system-prompt/assemble` waterfall. The integration was checked against the `0.2.0-rc.2` DSH service packages. These APIs are prerelease and compatibility with other versions is not guaranteed.
- Do not activate another plugin registering `memory_list`, `memory_read` or `memory_write` in the same global layer.

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
| `memory_list` | Lists top-level Markdown topic names and the index in the selected scope. |
| `memory_read` | Reads a full topic (or `MEMORY.md` by default), returning content and a revision. A missing file has `content: null`. |
| `memory_write` | Saves a full topic and a one-line index summary, preserving before/after history. |

Every tool accepts `scope: "project"` (default) or `scope: "global"`.

- **Project**: repository-specific facts. Stored under `~/.dsh/memory/projects/<name>--<hash>/`. Canonical cwd identifies the project; ordinary descendants share its memory. Independent nested Git repositories and worktrees are separate boundaries. Without a Git boundary or registered ancestor, the session cwd is its own project.
- **Global**: preferences, machine facts and cross-project conventions. Stored under `~/.dsh/memory/global/`. Shared across projects and available even without a session cwd.

Example write arguments:

```json
{
  "scope": "project",
  "file": "architecture.md",
  "content": "# Architecture\n\nThe API uses PostgreSQL.\n",
  "summary": "API database and architecture conventions"
}
```

Read an existing topic before updating it and pass the returned `revision` as `expected_revision`. Revisions bind scope, project, filename, content and index. A change to any part makes an old revision stale. Read again and rebase your intended update before retrying. A revision cannot authorize a write in another scope or project. Supplying the missing-file revision is also recommended when creating a topic.

Topics must be plain ASCII Markdown filenames without directories. `MEMORY.md` and its case aliases cannot be written as topics. Content and summaries must be well-formed Unicode; stored and imported text must be valid UTF-8. Invalid bytes are refused instead of silently replaced. New content is capped at 256 KiB; reads and the index are capped at 1 MiB. Summaries must be a nonempty single line of at most 300 JavaScript string units.

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

Writes are denied in read-only, unknown sandbox policy and active or pending plan mode. `workspace-write` allows this explicit persistence capability outside the workspace. Policy and cancellation are rechecked before commit. Once commit starts, both replacements are attempted even if policy or cancellation changes.

Reads reject symlinks, hardlinks and nonregular files, use no-follow/nonblocking open, and enforce size limits. New directories use mode 0700 and files 0600. Existing parent directories are trusted and their permissions are not automatically tightened. Notes and history are plaintext; never store credentials, tokens or cookies.

Writers cooperate through `.write-lock`. Topic and index are separate atomic replacements, **not a two-file transaction**. I/O errors or process death can leave a partial commit. Journals under `history/` retain exact before/after content for manual reconciliation; readers can observe a mixed snapshot during commit. There is no guaranteed power-loss transaction durability, encryption, automatic recovery, deletion tool or history retention policy. See [SECURITY.md](SECURITY.md) for the full trust boundary.

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

- **1.1.1**: portable bundle root, strict CLI argument validation, global lock recovery, publication metadata, MIT license, packaging checks and CI.
- **1.1.0**: global scope, scope-bound revisions, compact global context and a cache-busting activation shim.
- **1.0.0**: project memory, tools, revision guards, history, locking and Claude memory import.

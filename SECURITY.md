# Security

## Reporting

Do not put credentials, private memory contents or sensitive paths into a public issue. Report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/nalikco/dsh-memory/security/advisories/new) if the repository has it enabled. If it is unavailable, contact the repository owner privately before disclosing details.

## Trust boundaries

- This is a host plugin. Installed code executes in the DSH process with the host user's permissions, not inside the session file sandbox. Install only reviewed code.
- Memory tools deliberately persist outside the workspace, in the two configured scopes. Writes, archival forget, restore and explicit reindex are denied in read-only, unknown policy and active or pending plan mode. Current-project/global mutation remains allowed in workspace-write, but selecting another registered project requires danger-full-access. Selectors are exact absolute registered cwd identities, never arbitrary filesystem/store paths; aliases and global-scope selectors fail closed. Policy, cancellation, session identity, project identity and topic/index revision (plus complete catalog and topic identity/digests for reindex) are rechecked before commit. Once admitted, both topic and index operations are attempted even if policy/cancellation changes. This does not constrain separate CLI utilities, which run with your OS permissions.
- Parent directories are trusted. Symlink, hardlink, nonregular-file and size checks are defense in depth, not a sandbox against a malicious process running as the same user.
- Notes are untrusted data, not higher-priority instructions. Verify stored claims before acting.
- Storage and history are plaintext. Do not store passwords, tokens, cookies or other secrets. Imported bytes may contain historical secrets. Review source data before importing, protect backups, and never publish memory stores.
- Topic and index replacement is not a two-file transaction. I/O errors or crashes can leave a partial commit; journals retain before/after bytes for manual recovery. Reads do not take the write lock and can observe a mixed snapshot during commit. Atomic rename and file fsync do not guarantee full power-loss durability.
- Archival deletion retains plaintext topic/index bytes in history and is not secure erasure. Guarded restore accepts only an opaque hash-bound id for a forget journal within the selected store, verifies scope/cwd/topic/revisions and requires the exact post-forget state. It cannot safely auto-reconcile changed indexes or partial commits. Journals record intent, not completion; failed/preempted operations can leave unused journals. There is no automatic lock stealing, encryption, retention policy or automatic recovery. History grows until managed separately. Never edit a live store without coordinating writers and preserving recovery evidence.

## Maintenance boundaries

- Discovery exposes registered project cwd and store directory names, not topic bodies. It is read-only, creates nothing and fails closed on corrupt identities. It does not authorize mutation.
- Exact standalone destination entries are removed regardless of human-readable label; imported prose, fenced/indented code, reference/shortcut links and ambiguous summaries are retained conservatively to avoid collateral deletion. This is not a full Markdown parser. Such content may retain dangling topic references.
- Explicit memory_reindex is a full index reset, not a prose-preserving Markdown repair: it requires a current MEMORY.md revision, reason and complete exact top-level catalog. It safely reads every topic, rejects omissions/extras/duplicates/aliases and unsafe members, escapes summary markup, and replaces only the index. Exact obsolete prose is retained in previousIndex history, not active context; no arbitrary index-content API or automatic prose restore is offered. Journals contain topic digests/identity, not bodies. Same-user races after final checks are outside the trusted-parent boundary.
- A journal hash detects changes relative to the returned id; it is not an authentication signature against a malicious same-user process. Protect the store and recovery ids. No arbitrary history path is accepted.
- No new offline maintenance mutation CLI is provided. Deploy tools before live cleanup; missing tools do not justify policy bypass via filesystem or direct module calls. Existing migration/recovery CLIs remain separate OS-permission administrative capabilities.

## Supported environments

Node.js 22 or newer on macOS and Linux. Windows is not validated. DSH service APIs are prerelease APIs; only the documented runtime version has been checked. Revalidate before upgrading DSH.

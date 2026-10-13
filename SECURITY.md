# Security

## Reporting

Do not put credentials, private memory contents or sensitive paths into a public issue. Report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/nalikco/dsh-memory/security/advisories/new) if the repository has it enabled. If it is unavailable, contact the repository owner privately before disclosing details.

## Trust boundaries

- This is a host plugin. Installed code executes in the DSH process with the host user's permissions, not inside the session file sandbox. Install only reviewed code.
- Memory tools deliberately persist outside the workspace, in the two configured scopes. Writes are denied in read-only, unknown policy and active or pending plan mode. This does not constrain separate CLI utilities, which run with your OS permissions.
- Parent directories are trusted. Symlink, hardlink, nonregular-file and size checks are defense in depth, not a sandbox against a malicious process running as the same user.
- Notes are untrusted data, not higher-priority instructions. Verify stored claims before acting.
- Storage and history are plaintext. Do not store passwords, tokens, cookies or other secrets. Imported bytes may contain historical secrets. Review source data before importing, protect backups, and never publish memory stores.
- Topic and index replacement is not a two-file transaction. I/O errors or crashes can leave a partial commit; journals retain before/after bytes for manual recovery. Reads do not take the write lock and can observe a mixed snapshot during commit. Atomic rename and file fsync do not guarantee full power-loss durability.
- There is no deletion tool, automatic lock stealing, encryption, retention policy or automatic recovery. History grows until managed separately. Never edit a live store without coordinating writers and preserving recovery evidence.

## Supported environments

Node.js 22 or newer on macOS and Linux. Windows is not validated. DSH service APIs are prerelease APIs; only the documented runtime version has been checked. Revalidate before upgrading DSH.

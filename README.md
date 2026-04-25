# Altair Vega

Altair Vega is an early-stage peer-to-peer transfer project for securely moving messages, files, and synced folder state across two otherwise isolated networks that only share common Internet access.

The project is built around `iroh` for robust peer connectivity and uses a short human-typable session code for fast, manual pairing without persistent user accounts.

## CLI Manual

Use `altair-vega help` for the full manual. It opens in the system pager when available; pass `--no-pager` for plain output.

Manual topics:

- `altair-vega help pair`
- `altair-vega help transfer`
- `altair-vega help sync`
- `altair-vega help serve`
- `altair-vega help runtime`
- `altair-vega help examples`

## Command Reference

Pairing:

- `altair-vega pair [CODE] [--room-url <URL>] [--mode one-off|persistent] [--naked] [--qr] [--inspect]`
- Omitting `CODE` hosts a session; providing `CODE` joins a session.
- `--naked` exposes or consumes a raw `iroh` endpoint ticket instead of short-code rendezvous.
- `--qr` renders printed codes or tickets as a terminal QR code.

Transfers:

- `altair-vega send text <MESSAGE> [CODE] [--room-url <URL>] [--pair-mode one-off|persistent] [--naked] [--qr]`
- `altair-vega receive text [CODE] [--room-url <URL>] [--pair-mode one-off|persistent] [--naked] [--qr]`
- `altair-vega send file <PATH> [CODE] [--room-url <URL>] [--pair-mode one-off|persistent] [--naked] [--qr] [--state-dir <DIR>]`
- `altair-vega receive file [CODE] [--output-dir <DIR>] [--room-url <URL>] [--pair-mode one-off|persistent] [--naked] [--state-dir <DIR>]`
- Transfer commands reuse saved pair state when `CODE` or the naked ticket is omitted.
- For `send file --naked`, the printed `file ticket` includes the raw blob ticket plus the original filename. Raw blob tickets are still accepted by `receive file --naked`, but they fall back to a generic filename.

Sync:

- `altair-vega sync <FOLDER> [KEY] [--room-url <URL>] [--pair-mode one-off|persistent] [--naked] [--join] [--qr] [--state-dir <DIR>] [--wait-ms <MS>] [--interval-ms <MS>]`
- Inferred `sync <FOLDER> [KEY]` defaults to host when `KEY` is omitted and read-only follow when `KEY` is provided. Use `--join` to explicitly publish local changes bidirectionally.
- `--naked` exposes or consumes a raw `iroh-docs` ticket instead of short-code rendezvous.
- Each hosting `sync <FOLDER>` process prints the current live docs ticket. Restarted hosts may print a new ticket; use the current ticket or saved pair state from the current run.
- Follow/join docs nodes and merge-base state are scoped by docs-ticket hash; host publish state is scoped by folder path.

Serve and runtime:

- `altair-vega serve browser-peer <CODE> [--room-url <URL>] [--output-dir <DIR>]`
- `altair-vega runtime inspect [--state-name <NAME>]`

## Pair State

Altair Vega saves the latest short code or naked ticket in `.altair-pair/pair-state.json`, under the runtime state root when `ALTAIR_VEGA_RUNTIME_ROOT` is set. Commands that omit `CODE` or a naked ticket reuse that state when possible.

## Rendezvous

The default rendezvous URL is compiled into the binary. Set `ALTAIR_VEGA_DEFAULT_RENDEZVOUS=<URL>` at build time to change the default, or pass `--room-url <URL>` at runtime.

## Disposable Native Launcher

Altair Vega now has a shared disposable-runtime contract in the Rust core plus platform launchers that feed it.

Launcher behavior:

- The POSIX launcher chooses `XDG_RUNTIME_DIR`, then `/dev/shm`, then the system temp directory.
- The PowerShell launcher chooses the Windows temp directory unless `-RuntimeParent` is provided.
- Sets `ALTAIR_VEGA_RUNTIME_ROOT` and `TMPDIR` for the launched process so default internal state can stay RAM-first when possible.
- Removes the fetched executable and runtime workspace on exit by default.
- Supports `--keep-runtime` or `-KeepRuntime` when you need to inspect the temp workspace after exit.

## Status

This repository is still pre-release. Milestone 7 remains in progress after native bidirectional sync, native LAN discovery, and native binary-size reduction passed; release-hardening work is pending and may move remaining functionality blockers back into Milestone 7 before Milestone 8 starts.

## License

This project currently includes the Unlicense. See `LICENSE` for the full text.

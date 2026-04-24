# Altair Vega

Altair Vega is an early-stage peer-to-peer transfer project for securely moving messages, files, and synced folder state across two otherwise isolated networks that only share common Internet access.

The project is built around `iroh` for robust peer connectivity and uses a short human-typable session code for fast, manual pairing without persistent user accounts.

## Disposable Native Launcher

Altair Vega now has a shared disposable-runtime contract in the Rust core plus platform launchers that feed it.

Launcher behavior:

- The POSIX launcher chooses `XDG_RUNTIME_DIR`, then `/dev/shm`, then the system temp directory.
- The PowerShell launcher chooses the Windows temp directory unless `-RuntimeParent` is provided.
- Sets `ALTAIR_VEGA_RUNTIME_ROOT` and `TMPDIR` for the launched process so default internal state can stay RAM-first when possible.
- Removes the fetched executable and runtime workspace on exit by default.
- Supports `--keep-runtime` or `-KeepRuntime` when you need to inspect the temp workspace after exit.

## Status

This repository is in early bootstrap. The implementation is just starting and should not yet be considered usable.

## License

This project currently includes the Unlicense. See `LICENSE` for the full text.

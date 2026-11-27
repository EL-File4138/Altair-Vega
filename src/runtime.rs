use anyhow::{Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const RUNTIME_ROOT_ENV: &str = "ALTAIR_VEGA_RUNTIME_ROOT";
pub const KEEP_RUNTIME_ENV: &str = "ALTAIR_VEGA_KEEP_RUNTIME";

pub struct DisposableRuntime {
    root: PathBuf,
    cleanup: bool,
}

impl DisposableRuntime {
    pub fn create(prefix: &str) -> Result<Self> {
        Self::create_in_with_cleanup(
            preferred_runtime_parent(),
            prefix,
            !keep_runtime_requested(),
        )
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    fn create_in_with_cleanup(
        parent: impl AsRef<Path>,
        prefix: &str,
        cleanup: bool,
    ) -> Result<Self> {
        let parent = parent.as_ref();
        fs::create_dir_all(parent)
            .with_context(|| format!("create runtime parent {}", parent.display()))?;

        let mut suffix_bytes = [0u8; 8];
        rand::fill(&mut suffix_bytes);
        let suffix = u64::from_be_bytes(suffix_bytes);
        let root = parent.join(format!("altair-vega-{prefix}-{suffix:016x}"));
        fs::create_dir_all(&root)
            .with_context(|| format!("create disposable runtime root {}", root.display()))?;

        Ok(Self { root, cleanup })
    }
}

impl Drop for DisposableRuntime {
    fn drop(&mut self) {
        if self.cleanup {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

pub fn keep_runtime_requested() -> bool {
    std::env::var_os(KEEP_RUNTIME_ENV)
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

pub fn runtime_root_from_env() -> Option<PathBuf> {
    std::env::var_os(RUNTIME_ROOT_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn resolve_runtime_state_dir(cli_value: Option<PathBuf>, default_name: &str) -> PathBuf {
    resolve_runtime_state_dir_with_root(
        cli_value,
        runtime_root_from_env().as_deref(),
        preferred_runtime_parent(),
        default_name,
    )
}

pub fn preferred_runtime_parent() -> PathBuf {
    preferred_runtime_parent_from(
        std::env::var_os("XDG_RUNTIME_DIR")
            .as_deref()
            .map(Path::new),
        Path::new("/dev/shm"),
        std::env::temp_dir(),
    )
}

fn resolve_runtime_state_dir_with_root(
    cli_value: Option<PathBuf>,
    runtime_root: Option<&Path>,
    fallback_parent: PathBuf,
    default_name: &str,
) -> PathBuf {
    if let Some(path) = cli_value {
        return path;
    }

    let default_name = visible_runtime_name(default_name);

    if let Some(root) = runtime_root {
        return root.join(&default_name);
    }

    fallback_parent.join("altair-vega").join(default_name)
}

fn visible_runtime_name(default_name: &str) -> String {
    default_name
        .trim_start_matches('.')
        .trim_start_matches(std::path::MAIN_SEPARATOR)
        .to_owned()
}

fn preferred_runtime_parent_from(
    xdg_runtime_dir: Option<&Path>,
    dev_shm: &Path,
    fallback_temp_dir: PathBuf,
) -> PathBuf {
    if let Some(path) = xdg_runtime_dir.filter(|path| path.is_dir()) {
        return path.to_path_buf();
    }

    if dev_shm.is_dir() {
        return dev_shm.to_path_buf();
    }

    fallback_temp_dir
}

#[cfg(test)]
mod tests {
    use super::{
        DisposableRuntime, preferred_runtime_parent_from, resolve_runtime_state_dir_with_root,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
    };
    use tempfile::TempDir;

    #[test]
    fn resolve_runtime_state_dir_prefers_explicit_cli_value() {
        let explicit = PathBuf::from("/tmp/altair-vega-explicit");
        let resolved = resolve_runtime_state_dir_with_root(
            Some(explicit.clone()),
            Some(Path::new("/runtime-root")),
            PathBuf::from("/fallback-root"),
            ".altair-sync-docs",
        );
        assert_eq!(resolved, explicit);
    }

    #[test]
    fn resolve_runtime_state_dir_uses_runtime_root_when_present() {
        let resolved = resolve_runtime_state_dir_with_root(
            None,
            Some(Path::new("/runtime-root")),
            PathBuf::from("/fallback-root"),
            ".altair-sync-docs",
        );
        assert_eq!(
            resolved,
            Path::new("/runtime-root").join("altair-sync-docs")
        );
    }

    #[test]
    fn resolve_runtime_state_dir_falls_back_to_temp_visible_default() {
        let resolved = resolve_runtime_state_dir_with_root(
            None,
            None,
            PathBuf::from("/fallback-root"),
            ".altair-sync-docs",
        );
        assert_eq!(
            resolved,
            Path::new("/fallback-root")
                .join("altair-vega")
                .join("altair-sync-docs")
        );
    }

    #[test]
    fn preferred_runtime_parent_prefers_xdg_runtime_dir() {
        let temp = TempDir::new().unwrap();
        let xdg_runtime_dir = temp.path().join("run-user-1000");
        fs::create_dir(&xdg_runtime_dir).unwrap();
        let fallback = temp.path().join("fallback-root");
        let resolved = preferred_runtime_parent_from(
            Some(&xdg_runtime_dir),
            &temp.path().join("dev-shm"),
            fallback,
        );
        assert_eq!(resolved, xdg_runtime_dir);
    }

    #[test]
    fn disposable_runtime_cleans_up_on_drop() {
        let root_parent = TempDir::new().unwrap();
        let runtime_path = {
            let runtime =
                DisposableRuntime::create_in_with_cleanup(root_parent.path(), "test", true)
                    .unwrap();
            let marker = runtime.path().join("marker.txt");
            fs::write(&marker, b"marker").unwrap();
            assert!(runtime.path().exists());
            runtime.path().to_path_buf()
        };

        assert!(!runtime_path.exists());
    }

    #[test]
    fn disposable_runtime_can_be_kept_for_debugging() {
        let root_parent = TempDir::new().unwrap();
        let runtime_path = {
            let runtime =
                DisposableRuntime::create_in_with_cleanup(root_parent.path(), "test", false)
                    .unwrap();
            runtime.path().to_path_buf()
        };

        assert!(runtime_path.exists());
        fs::remove_dir_all(runtime_path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn launcher_script_has_valid_posix_syntax() {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/startup.sh");
        let status = Command::new("sh").arg("-n").arg(&script).status().unwrap();
        assert!(
            status.success(),
            "shell syntax check failed for {}",
            script.display()
        );
    }

    #[cfg(unix)]
    #[test]
    fn launcher_script_reuses_verified_binary_until_explicit_cleanup() {
        let temp = TempDir::new().unwrap();
        let probe_dir = temp.path().join("probe");
        fs::create_dir_all(&probe_dir).unwrap();

        let stub = temp.path().join("stub.sh");
        fs::write(
            &stub,
            format!(
                "#!/bin/sh\nset -eu\nout_dir=\"$1\"\nprintf '%s\\n' \"$0\" > \"$out_dir/exe-path.txt\"\nprintf '%s\\n' \"${{{}:-}}\" > \"$out_dir/runtime-root.txt\"\ntouch \"${{{}}}/child-marker\"\nprintf '%s\\n' \"$2\" > \"$out_dir/payload.txt\"\n",
                super::RUNTIME_ROOT_ENV,
                super::RUNTIME_ROOT_ENV,
            ),
        )
        .unwrap();

        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&stub).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&stub, permissions).unwrap();
        write_sha256_sidecar(&stub);

        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/startup.sh");
        let file_url = format!("file://{}", stub.display());
        let status = Command::new("sh")
            .arg(&script)
            .arg("--url")
            .arg(&file_url)
            .arg("--runtime-parent")
            .arg(temp.path())
            .arg("--")
            .arg(&probe_dir)
            .arg("payload-ok")
            .status()
            .unwrap();

        assert!(status.success(), "launcher exited unsuccessfully");

        let exe_path = fs::read_to_string(probe_dir.join("exe-path.txt")).unwrap();
        let exe_path = PathBuf::from(exe_path.trim());
        let runtime_root = fs::read_to_string(probe_dir.join("runtime-root.txt")).unwrap();
        let runtime_root = PathBuf::from(runtime_root.trim());
        let payload = fs::read_to_string(probe_dir.join("payload.txt")).unwrap();

        assert_eq!(payload.trim(), "payload-ok");
        assert!(
            exe_path.exists(),
            "verified executable was unexpectedly removed"
        );
        assert!(
            runtime_root.exists(),
            "retryable runtime state was unexpectedly removed"
        );

        let cleanup = Command::new("sh")
            .env("XDG_CACHE_HOME", temp.path())
            .arg(&script)
            .arg("--runtime-parent")
            .arg(temp.path())
            .arg("--cleanup")
            .status()
            .unwrap();
        assert!(cleanup.success(), "launcher cleanup exited unsuccessfully");
        assert!(
            !exe_path.exists(),
            "explicit cleanup did not remove the executable"
        );
        assert!(
            !runtime_root.exists(),
            "explicit cleanup did not remove runtime state"
        );
    }

    #[cfg(unix)]
    #[test]
    fn launcher_script_can_be_sourced_for_session_path() {
        let temp = TempDir::new().unwrap();
        let probe_dir = temp.path().join("probe");
        fs::create_dir_all(&probe_dir).unwrap();

        let stub = temp.path().join("stub.sh");
        fs::write(
            &stub,
            format!(
                "#!/bin/sh\nset -eu\nout_dir=\"$1\"\nprintf '%s\\n' \"$0\" > \"$out_dir/exe-path.txt\"\nprintf '%s\\n' \"${{{}:-}}\" > \"$out_dir/runtime-root.txt\"\n",
                super::RUNTIME_ROOT_ENV,
            ),
        )
        .unwrap();

        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&stub).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&stub, permissions).unwrap();
        write_sha256_sidecar(&stub);

        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/startup.sh");
        let file_url = format!("file://{}", stub.display());
        let command = format!(
            "set -- --url '{}' --runtime-parent '{}'; . '{}' && altair-vega '{}'",
            file_url,
            temp.path().display(),
            script.display(),
            probe_dir.display()
        );
        let status = Command::new("sh").arg("-c").arg(command).status().unwrap();

        assert!(status.success(), "sourced launcher exited unsuccessfully");

        let exe_path = fs::read_to_string(probe_dir.join("exe-path.txt")).unwrap();
        let exe_path = PathBuf::from(exe_path.trim());
        let runtime_root = fs::read_to_string(probe_dir.join("runtime-root.txt")).unwrap();
        let runtime_root = PathBuf::from(runtime_root.trim());

        assert_eq!(exe_path.file_name().unwrap(), "altair-vega");
        assert_eq!(
            exe_path
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .file_name()
                .unwrap(),
            "binaries"
        );
        assert!(
            exe_path.exists(),
            "session executable was unexpectedly removed"
        );
        assert!(
            runtime_root.exists(),
            "session runtime root was unexpectedly removed"
        );
    }

    #[test]
    fn powershell_launcher_declares_runtime_contract() {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/startup.ps1");
        let contents = fs::read_to_string(&script).unwrap();
        assert!(contents.contains(super::RUNTIME_ROOT_ENV));
        assert!(contents.contains("Remove-Item"));
        assert!(contents.contains("Invoke-WebRequest"));
        assert!(contents.contains("Get-FileHash"));
        assert!(contents.contains("-Cleanup"));
        assert!(contents.contains("altair-vega-launcher-"));
        assert!(!contents.contains("Register-EngineEvent"));
        assert!(!contents.contains("$env:TMPDIR ="));
    }

    #[test]
    fn powershell_launcher_has_valid_syntax_when_pwsh_is_available() {
        if !pwsh_available() {
            return;
        }

        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/startup.ps1");
        let status = Command::new("pwsh")
            .arg("-NoProfile")
            .arg("-File")
            .arg(&script)
            .arg("-Help")
            .status()
            .unwrap();
        assert!(
            status.success(),
            "powershell syntax/help check failed for {}",
            script.display()
        );
    }

    fn pwsh_available() -> bool {
        Command::new("pwsh")
            .arg("-NoProfile")
            .arg("-Command")
            .arg("$PSVersionTable.PSVersion.ToString()")
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(unix)]
    fn write_sha256_sidecar(path: &Path) {
        let output = Command::new("sha256sum")
            .arg(path)
            .output()
            .or_else(|_| {
                Command::new("shasum")
                    .args(["-a", "256"])
                    .arg(path)
                    .output()
            })
            .expect("sha256sum or shasum must be available for launcher tests");
        assert!(output.status.success(), "checksum command failed");
        fs::write(format!("{}.sha256", path.display()), output.stdout).unwrap();
    }
}

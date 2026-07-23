use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=selection-helper/Cargo.toml");
    println!("cargo:rerun-if-changed=selection-helper/src/main.rs");
    println!("cargo:rerun-if-changed=src/selected_text.rs");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        build_selection_helper();
    }
    tauri_build::build()
}

/// 先在独立 target 目录构建 sidecar，再复制成 Tauri externalBin 要求的目标三元组文件名。
/// 独立目录可避免 build script 递归调用 Cargo 时争用主包的 target 锁。
fn build_selection_helper() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("缺少 CARGO_MANIFEST_DIR"));
    let target = env::var("TARGET").expect("缺少 TARGET");
    let helper_manifest = manifest_dir.join("selection-helper").join("Cargo.toml");
    let cargo = env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = Command::new(cargo)
        .arg("build")
        .arg("--manifest-path")
        .arg(&helper_manifest)
        .arg("--release")
        .arg("--locked")
        .status()
        .expect("无法启动 selection-helper 构建");
    assert!(status.success(), "selection-helper 构建失败");

    let source = manifest_dir
        .join("selection-helper")
        .join("target")
        .join("release")
        .join(executable_name("selection-helper"));
    let destination = manifest_dir
        .join("target")
        .join("release")
        .join(executable_name(&format!("selection-helper-{target}")));
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).expect("无法创建 sidecar 输出目录");
    }
    std::fs::copy(&source, &destination).unwrap_or_else(|error| {
        panic!(
            "复制 selection-helper 失败（{} -> {}）：{error}",
            source.display(),
            destination.display()
        )
    });
}

fn executable_name(stem: &str) -> PathBuf {
    if cfg!(windows) {
        Path::new(&format!("{stem}.exe")).to_path_buf()
    } else {
        Path::new(stem).to_path_buf()
    }
}

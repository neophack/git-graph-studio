    use super::*;
    use crate::store::bundled_dismissed_marker;
    use crate::vsix::*;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    #[test]
    fn page_bundle_flag_tracks_the_packers_bundle() {
        // The host's prewarm fetches `webview/index.js` only when the flag is set: for a
        // package that ships none the fetch was a guaranteed 404 — silent under the
        // desktop's ggs:// protocol, one red console line per package in a browser session.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let plain = make_vsix(tmp.path(), "plain", "acme", "1.0.0");
        assert!(
            !install_from_vsix_into(&exts, &plain, false)
                .unwrap()
                .page_bundle
        );

        let packed = tmp.path().join("acme.packed-1.0.0.vsix");
        let file = std::fs::File::create(&packed).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"packed","publisher":"acme","version":"1.0.0","main":"./out/extension.js","description":"test"}"#,
        )
        .unwrap();
        zip.start_file("extension/out/extension.js", options)
            .unwrap();
        zip.write_all(b"exports.activate = function() {};").unwrap();
        zip.start_file("extension/webview/index.js", options)
            .unwrap();
        zip.write_all(b"/* the packer's page bundle */").unwrap();
        zip.finish().unwrap();
        assert!(
            install_from_vsix_into(&exts, &packed, false)
                .unwrap()
                .page_bundle
        );

        // The listing carries the same truth.
        let listed = list_installed(&exts).unwrap();
        let by_flag: Vec<(bool, &str)> = listed
            .iter()
            .map(|info| (info.page_bundle, info.id.as_str()))
            .collect();
        assert_eq!(by_flag, [(true, "acme.packed"), (false, "acme.plain")]);
    }

    #[test]
    fn the_real_bundled_vsix_auto_installs() {
        // The packed git-graph-rs VSIX (no ggs key, an engine .node + a main): the exact
        // package the installer ships, through the exact auto-install entry.
        let packed = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../target/studio/bundled/app-resources/extensions/git-graph-rs.vsix");
        if !packed.is_file() {
            eprintln!("skipping: no packed bundled vsix");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let outcomes = install_missing_bundled_in(&exts, &[packed]);
        assert_eq!(outcomes.len(), 1);
        let outcome = &outcomes[0];
        assert!(outcome.is_ok(), "auto-install failed: {outcome:?}");
        // The install exists and its derived manifest carries a backend.
        let versions = find_installed(&exts, "neophack.git-graph-rs").unwrap();
        assert!(!versions.is_empty(), "the install landed");
        let manifest: StudioManifest = serde_json::from_str(
            &std::fs::read_to_string(
                exts.join(format!("neophack.git-graph-rs-{}", versions[0]))
                    .join("manifest.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(
            manifest.backend.is_some(),
            "the derived manifest declares a backend"
        );
    }

    #[test]
    fn the_bundled_package_auto_installs_once_and_respects_a_dismissal() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = make_vsix(tmp.path(), "demo", "acme", "1.0.0");
        let packages = vec![vsix.clone()];

        // First launch: the package installs.
        let outcomes = install_missing_bundled_in(&exts, &packages);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].is_ok(), "{outcomes:?}");
        assert!(find_installed(&exts, "acme.demo")
            .map(|versions| !versions.is_empty())
            .unwrap_or(false));

        // The second boot is a no-op — the install already exists.
        let again = install_missing_bundled_in(&exts, &packages);
        assert!(again.is_empty(), "already-installed must skip: {again:?}");

        // A deliberate uninstall drops the dismissal marker; the boot pass reads it and
        // never resurrects the package.
        let marker = bundled_dismissed_marker(&exts, "acme.demo");
        std::fs::write(&marker, b"uninstalled\n").unwrap();
        let _ = std::fs::remove_dir_all(exts.join("acme.demo-1.0.0"));
        let outcomes = install_missing_bundled_in(&exts, &packages);
        assert!(
            outcomes.is_empty(),
            "dismissed stays dismissed: {outcomes:?}"
        );
        assert!(!find_installed(&exts, "acme.demo")
            .map(|versions| !versions.is_empty())
            .unwrap_or(false));
    }

    /// A `.vsix` carrying `extension/package.json` + a compiled entry bundle, plus the OPC
    /// root files real packages ship (which the extractor must skip).
    fn make_vsix(dir: &Path, name: &str, publisher: &str, version: &str) -> PathBuf {
        let vsix = dir.join(format!("{publisher}.{name}-{version}.vsix"));
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest = format!(
            r#"{{"name":"{name}","publisher":"{publisher}","version":"{version}","main":"./out/extension.js","description":"test"}}"#
        );
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.start_file("extension/out/extension.js", options)
            .unwrap();
        zip.write_all(b"exports.activate = function() {};").unwrap();
        zip.start_file("[Content_Types].xml", options).unwrap();
        zip.write_all(b"<Types/>").unwrap();
        zip.finish().unwrap();
        vsix
    }

    #[test]
    fn install_list_and_uninstall() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = make_vsix(tmp.path(), "demo", "acme", "1.0.0");

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        assert_eq!(info.id, "acme.demo");
        assert_eq!(info.version, "1.0.0");
        assert_eq!(info.format, "vsix");
        // The entry bundle lands at the install root, the OPC files do not.
        assert!(Path::new(&info.path).join("out/extension.js").is_file());
        assert!(!Path::new(&info.path).join("[Content_Types].xml").exists());

        let list = list_installed(&exts).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            (list[0].id.as_str(), list[0].format.as_str()),
            ("acme.demo", "vsix")
        );

        uninstall(&exts, "acme.demo").unwrap();
        assert!(list_installed(&exts).unwrap().is_empty());
    }

    #[test]
    fn a_vsix_installs_with_its_own_identity_ignoring_any_extra_keys() {
        // Redundant or foreign keys in `package.json` (VS Code ignores them too) cannot
        // drift the install: the runtime manifest's identity is the package's own, and the
        // backend derives from the package's `main` and native binaries alone.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("acme.pages-2.0.0.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest = r#"{"name":"pages","publisher":"acme","version":"2.0.0","main":"./out/extension.js",
                "ggs":{"format":"ggs/2","id":"stale.drift","version":"0.0.1",
                        "pages":{"view":{"page":"web/view.html","title":"View","singleton":true}},
                        "backend":{"kind":"process","command":"backend/main","protocol":"ggs-ext/1"},
                        "activitybar":{"command":"acme.pages.open"},
                        "permissions":["repo:read"]}}"#;
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.start_file("extension/web/view.html", options).unwrap();
        zip.write_all(b"<html></html>").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        assert_eq!(info.format, "vsix");
        let ggx: StudioManifest = serde_json::from_str(
            &std::fs::read_to_string(Path::new(&info.path).join("manifest.json")).unwrap(),
        )
        .unwrap();
        // The identity is the package's own, not what the foreign key claimed.
        assert_eq!(ggx.id, "acme.pages");
        assert_eq!(ggx.version, "2.0.0");
        assert!(ggx.backend.is_none());
        // list_installed surfaces the generated capabilities.
        let listed = list_installed(&exts).unwrap().remove(0);
        assert!(listed.capabilities.is_some());
    }

    #[test]
    fn upgrades_are_forward_only() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        assert!(install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.0.0"),
            false
        )
        .is_ok());

        let same = install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.0.0"),
            false,
        );
        assert!(same.unwrap_err().contains("already installed"));
        let older = install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "0.9.0"),
            false,
        );
        assert!(older.unwrap_err().contains("is older"));

        let newer = install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.1.0"),
            false,
        );
        assert_eq!(newer.unwrap().version, "1.1.0");
        // The old directory is gone: one install per id.
        assert!(list_installed(&exts).unwrap().len() == 1);
    }

    #[test]
    fn a_newer_vsix_replaces_a_ggx_and_vice_versa() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = super::install_tests::make_vsix(tmp.path(), "demo", "acme", "1.0.0", false);
        assert!(install_from_vsix_into(&exts, &ggx, false).is_ok());

        // The newer VSIX of the same id wins; the format follows the newer package.
        let info = install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.1.0"),
            false,
        )
        .unwrap();
        assert_eq!(
            (info.version.as_str(), info.format.as_str()),
            ("1.1.0", "vsix")
        );
        let list = list_installed(&exts).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].format, "vsix");
    }

    #[test]
    fn not_a_vsix_or_missing_main_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let plain = tmp.path().join("plain.zip");
        std::fs::write(&plain, b"not a zip").unwrap();
        assert!(read_vsix_manifest(&plain)
            .unwrap_err()
            .contains("read VSIX"));

        // A zip without extension/package.json is not a VSIX.
        let noext = tmp.path().join("noext.vsix");
        let file = std::fs::File::create(&noext).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("package.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();
        assert!(read_vsix_manifest(&noext)
            .unwrap_err()
            .contains("not a VSIX"));

        // A bundle-less manifest cannot run in the frame host.
        // A VSIX with neither a bundle nor a backend is a valid install: the store's
        // static-contribution packages (themes, snippets, grammars) look exactly like this,
        // and maximum VSIX compatibility means they install rather than being rejected.
        let nobundle = tmp.path().join("nobundle.vsix");
        let file = std::fs::File::create(&nobundle).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(
            "extension/package.json",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(br#"{"name":"n","publisher":"p","version":"1.0.0"}"#)
            .unwrap();
        zip.finish().unwrap();
        assert!(read_vsix_manifest(&nobundle).is_ok());
    }

    #[test]
    fn an_oversized_main_derives_a_node_backend() {
        // A main-only VSIX whose entry is past the frame host's code-map ceiling
        // (8 MB single file) runs on ggs-node — the sidecar reads its files straight
        // from the install directory. Kimi Code's 8.8 MB extension.js was the case:
        // neither route carried it, and activation failed on a missing module.
        let dir = tempfile::tempdir().unwrap();
        let vsix = dir.path().join("big.vsix");
        {
            let file = std::fs::File::create(&vsix).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("extension/package.json", options).unwrap();
            zip.write_all(br#"{"name":"big","publisher":"acme","version":"1.0.0","main":"./dist/extension.js"}"#).unwrap();
            zip.start_file("extension/dist/extension.js", options)
                .unwrap();
            zip.write_all(&vec![b'x'; 9 * 1024 * 1024]).unwrap();
            zip.start_file("extension/dist/chunk.mjs", options).unwrap();
            zip.write_all(&vec![b'x'; 1024]).unwrap();
            zip.finish().unwrap();
        }
        let manifest = read_vsix_manifest(&vsix).unwrap();
        let derived = resolve_node_binaries(&manifest, &vsix, false).unwrap();
        assert!(
            derived.as_ref().is_some_and(
                |backend| backend.kind == "node" && backend.command == "./dist/extension.js"
            ),
            "the oversized main derives a ggs-node backend: {derived:?}"
        );

        // A small main stays on the frame host (no backend).
        let vsix_small = dir.path().join("small.vsix");
        {
            let file = std::fs::File::create(&vsix_small).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("extension/package.json", options).unwrap();
            zip.write_all(
                br#"{"name":"small","publisher":"acme","version":"1.0.0","main":"./extension.js"}"#,
            )
            .unwrap();
            zip.start_file("extension/extension.js", options).unwrap();
            zip.write_all(br#"exports.activate = () => {};"#).unwrap();
            zip.finish().unwrap();
        }
        let manifest = read_vsix_manifest(&vsix_small).unwrap();
        assert!(
            resolve_node_binaries(&manifest, &vsix_small, false)
                .unwrap()
                .is_none(),
            "a small main stays frame-hosted"
        );
    }

    #[test]
    fn the_asset_path_decoder_keeps_a_literal_plus() {
        // URI path semantics: `+` is a plus (form/query encoding is where it means a
        // space). Decoding it as a space 404'd every package asset named with a `+`.
        assert_eq!(
            ggs_base::fsx::percent_decode("scripts/c++/parser.js"),
            "scripts/c++/parser.js"
        );
        assert_eq!(ggs_base::fsx::percent_decode("a%2Bb.js"), "a+b.js");
        assert_eq!(ggs_base::fsx::percent_decode("a%20b.js"), "a b.js");
        assert_eq!(ggs_base::fsx::percent_decode("unicode%20%E4%BD%A0.js"), "unicode 你.js");
        // A dangling percent survives as itself (never a panic).
        assert_eq!(ggs_base::fsx::percent_decode("trail%"), "trail%");
        assert_eq!(ggs_base::fsx::percent_decode("trail%2"), "trail%2");
    }

    #[test]
    fn strip_trailing_commas_is_string_aware() {
        // A comma inside a string literal followed by `}` is content: `"\d{2,}"` keeps
        // its comma (the old stripper deleted it and silently rewrote the regex).
        assert_eq!(
            strip_trailing_commas(r#"{"a": "\d{2,}"}"#),
            r#"{"a": "\d{2,}"}"#
        );
        // Real trailing commas still strip; the string's own comma survives.
        assert_eq!(
            strip_trailing_commas("{\n  \"a\": 1,\n  \"b\": [2, 3,],\n  \"c\": \"x,\",\n}"),
            "{\n  \"a\": 1,\n  \"b\": [2, 3],\n  \"c\": \"x,\"\n}"
        );
        assert_eq!(
            strip_trailing_commas(r#"{"a": "\"quoted,\"", "b": [1,],}"#),
            r#"{"a": "\"quoted,\"", "b": [1]}"#
        );
    }

    #[test]
    fn a_jsonc_package_json_installs_like_a_strict_one() {
        // Hand-authored packages in the wild carry comments and trailing commas; VS Code's
        // manifest reader tolerates both, so the store's reader does too.
        let manifest = parse_jsonc_manifest(
            br#"{
                // the identity
                "name": "jsonc",
                "publisher": "acme", /* block comment */
                "version": "1.0.0",
                "displayName": "JSONC Demo",
                "description": "a comment says // not a comment inside strings, nor a, comma",
                "contributes": {},
            }"#
            .as_slice(),
        )
        .unwrap();
        assert_eq!(
            (manifest.name.as_str(), manifest.publisher.as_str()),
            ("jsonc", "acme")
        );
        assert_eq!(manifest.display_name.as_deref(), Some("JSONC Demo"));

        // Strict JSON still parses, and garbage still fails with the reason.
        assert!(parse_jsonc_manifest(br#"{"name":"x"}"#).is_err());
    }

    #[test]
    fn comment_stripping_preserves_multibyte_text_both_sides_of_a_string() {
        let text = r#"{"displayName":"演示 // 注释","description":"多语言","categories":[]}"#;
        let stripped = strip_jsonc_comments(text);
        assert_eq!(stripped, text);
    }

    #[test]
    fn load_code_reads_the_loadable_surface_of_an_install() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("acme.bundle-1.0.0.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(br#"{"name":"bundle","publisher":"acme","version":"1.0.0","main":"./out/extension.js"}"#).unwrap();
        zip.start_file("extension/out/extension.js", options)
            .unwrap();
        zip.write_all(b"module.exports = 1;").unwrap();
        zip.start_file("extension/node_modules/dep/package.json", options)
            .unwrap();
        zip.write_all(br#"{"name":"dep","main":"lib/dep.js"}"#)
            .unwrap();
        zip.start_file("extension/node_modules/dep/lib/dep.js", options)
            .unwrap();
        zip.write_all(b"module.exports = 2;").unwrap();
        zip.start_file("extension/assets/logo.png", options)
            .unwrap();
        zip.write_all(b"not code").unwrap();
        zip.start_file("extension/out/extension.js.map", options)
            .unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();
        install_from_vsix_into(&exts, &vsix, false).unwrap();

        let bundle = load_code_from(&installed_dir(&exts, "acme.bundle").unwrap()).unwrap();
        assert!(!bundle.truncated);
        let keys: Vec<&str> = bundle.files.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                // The runtime manifest rides in the map too: it is a `.json` beside the
                // package's own files.
                "manifest.json",
                "node_modules/dep/lib/dep.js",
                "node_modules/dep/package.json",
                "out/extension.js",
                "package.json",
                // The install's own metadata is a `.json` beside the package's files; it
                // rides in the map without affecting anything.
                "studio-ext.json"
            ]
        );
        assert_eq!(bundle.files["out/extension.js"], "module.exports = 1;");
    }

    #[test]
    fn load_code_flags_what_its_bounds_left_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ext");
        std::fs::create_dir_all(root.join("deep/nested/dir")).unwrap();
        // One oversized file: over the per-file bound, so the bundle is truncated without it.
        std::fs::write(root.join("deep/big.js"), vec![b'x'; 9 * 1024 * 1024]).unwrap();
        std::fs::write(root.join("main.js"), b"module.exports = 1;").unwrap();
        let bundle = load_code_from(&root).unwrap();
        assert!(bundle.truncated);
        assert!(bundle.files.contains_key("main.js"));
        assert!(!bundle.files.contains_key("deep/big.js"));
    }

    #[test]
    fn the_node_env_reports_node_words_for_this_host() {
        let env = node_env();
        assert!(matches!(
            env.platform.as_str(),
            "win32" | "darwin" | "linux"
        ));
        assert!(matches!(env.arch.as_str(), "x64" | "arm64" | _ if !env.arch.is_empty()));
        assert_eq!(env.eol, if cfg!(windows) { "\r\n" } else { "\n" });
        assert!(!env.homedir.is_empty());
    }

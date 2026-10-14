    use super::*;
    use crate::store::*;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    /// A package's own executable (claude-code's `resources/native-binary/claude`) keeps
    /// the mode its archive recorded — without it, the spawn fails with EACCES — while a
    /// plain data file stays non-executable.
    #[cfg(unix)]
    #[test]
    fn extraction_keeps_the_archives_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let vsix = tmp.path().join("modes.vsix");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&vsix).unwrap());
        let exec = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        let data = zip::write::SimpleFileOptions::default().unix_permissions(0o644);
        zip.start_file("extension/resources/native-binary/tool", exec)
            .unwrap();
        zip.write_all(b"#!/bin/sh\necho hi\n").unwrap();
        zip.start_file("extension/README.md", data).unwrap();
        zip.write_all(b"readme").unwrap();
        zip.finish().unwrap();
        let target = tmp.path().join("out");
        extract_vsix(&vsix, &target).unwrap();
        let mode = |rel: &str| {
            std::fs::metadata(target.join(rel))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode("resources/native-binary/tool"), 0o755);
        assert_eq!(mode("README.md") & 0o111, 0);
    }

    /// The start-path repair for pre-extractor-fix installs: a native CLI that landed 0644
    /// (the claude-code installs unpacked before the mode-keeping extractor) gets its exec
    /// bit back at its next backend start, stays put once correct, and a package without
    /// the layout is untouched.
    #[cfg(unix)]
    #[test]
    fn repair_exec_bits_restores_a_stale_install() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("resources/native-binary/claude");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
        repair_exec_bits(tmp.path());
        let mode = std::fs::metadata(&bin).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        // Idempotent: a correct install crosses the same hook at every boot untouched.
        repair_exec_bits(tmp.path());
        assert_eq!(
            std::fs::metadata(&bin).unwrap().permissions().mode() & 0o777,
            0o755
        );
        // A package without the native-binary layout (or a foreign path) is a no-op.
        let plain = tmp.path().join("out/extension.js");
        std::fs::create_dir_all(plain.parent().unwrap()).unwrap();
        std::fs::write(&plain, b"activate").unwrap();
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
        repair_exec_bits(plain.parent().unwrap());
        assert_eq!(
            std::fs::metadata(&plain).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    /// A `.vsix` with a package.json and a web page (an extra data file,
    /// optionally, to prove every entry lands). Visible to `vsix_tests`, which builds a
    /// same-id pair to prove upgrades share one install slot.
    pub(super) fn make_vsix(
        dir: &Path,
        name: &str,
        publisher: &str,
        version: &str,
        with_data: bool,
    ) -> PathBuf {
        let vsix = dir.join(format!("{publisher}.{name}-{version}.vsix"));
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        // The store's own shape: a package.json whose `ggs` key declares the pages — the
        // install generates the runtime manifest from exactly this.
        let package = format!(
            r#"{{"name":"{name}","publisher":"{publisher}","version":"{version}","description":"a test package","ggs":{{"format":"ggs/2","id":"{publisher}.{name}","version":"{version}","pages":{{"main":{{"page":"web/view.html"}}}}}}}}"#
        );
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(package.as_bytes()).unwrap();
        zip.start_file("extension/web/view.html", options).unwrap();
        zip.write_all(b"<html></html>").unwrap();
        if with_data {
            zip.start_file("extension/data/payload.bin", options)
                .unwrap();
            zip.write_all(b"payload").unwrap();
        }
        zip.finish().unwrap();
        vsix
    }

    /// The (runtime manifest, package manifest) pair of a VSIX — what the bundled scan and
    /// the refresh build from every package, in the shape the tests assert on.
    pub(super) fn bundled_of(vsix: &Path) -> Result<(StudioManifest, VsixManifest), String> {
        let manifest = read_vsix_manifest(vsix)?;
        let backend =
            resolve_node_binaries(&manifest, vsix, real_node_allowed())
                .ok()
                .flatten();
        Ok((
            StudioManifest {
                id: format!("{}.{}", manifest.publisher, manifest.name),
                version: manifest.version.clone(),
                backend,
            },
            manifest,
        ))
    }

    #[test]
    fn a_same_version_install_from_an_older_bundled_build_is_refreshed_once() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let old_build = tmp.path().join("old");
        std::fs::create_dir_all(&old_build).unwrap();
        // The install came from an older build of 1.0.0 (no data file, no stamp recorded).
        let stale = make_vsix(&old_build, "demo", "acme", "1.0.0", false);
        install_from_vsix_into(&exts, &stale, false).unwrap();
        let target = exts.join("acme.demo-1.0.0");
        assert!(!target.join("data/payload.bin").exists());

        // The app now ships a rebuilt 1.0.0: the boot pass replaces the stale files...
        let rebuilt = make_vsix(tmp.path(), "demo", "acme", "1.0.0", true);
        let (capabilities, manifest) = bundled_of(&rebuilt).unwrap();
        let packages = [BundledPackage {
            id: capabilities.id.clone(),
            path: rebuilt.clone(),
            manifest,
            capabilities,
        }];
        let outcomes = refresh_bundled_installs_in(&exts, &packages);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].is_ok(), "{outcomes:?}");
        assert!(target.join("data/payload.bin").exists());
        // ...and records the build, so the next boot leaves it alone.
        assert!(refresh_bundled_installs_in(&exts, &packages).is_empty());

        // A package that is not installed stays not installed (the refresh installs nothing).
        std::fs::remove_dir_all(&target).unwrap();
        assert!(refresh_bundled_installs_in(&exts, &packages).is_empty());
        assert!(!target.exists());
    }

    #[test]
    fn a_same_version_vsix_from_an_older_bundled_build_is_refreshed_with_a_generated_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The install came from a build of 1.0.0 whose package declared no capabilities.
        let stale = tmp.path().join("acme.pages-1.0.0-old.vsix");
        let file = std::fs::File::create(&stale).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"pages","publisher":"acme","version":"1.0.0","main":"./out/extension.js"}"#,
        )
        .unwrap();
        zip.finish().unwrap();
        let info = install_from_vsix_into(&exts, &stale, false).unwrap();
        // Every install carries the runtime manifest (identity plus the derived backend).
        assert!(Path::new(&info.path)
            .join("manifest.json")
            .metadata()
            .is_ok());

        // The app now ships a rebuilt 1.0.0 that declares a page and a backend: the boot
        // pass replaces the install, and the generated manifest.json arrives with it.
        let rebuilt = tmp.path().join("acme.pages-1.0.0-new.vsix");
        let file = std::fs::File::create(&rebuilt).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"pages","publisher":"acme","version":"1.0.0","main":"./out/extension.js",
                "ggs":{"format":"ggs/2","id":"acme.pages","version":"1.0.0",
                        "pages":{"view":{"page":"web/view.html"}},
                        "backend":{"kind":"process","command":"backend/main"}}}"#,
        )
        .unwrap();
        zip.start_file("extension/web/view.html", options).unwrap();
        zip.write_all(b"<html></html>").unwrap();
        zip.finish().unwrap();
        let (capabilities, manifest) = bundled_of(&rebuilt).unwrap();
        let packages = [BundledPackage {
            id: capabilities.id.clone(),
            path: rebuilt.clone(),
            manifest,
            capabilities,
        }];
        let outcomes = refresh_bundled_installs_in(&exts, &packages);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].is_ok(), "{outcomes:?}");
        let target = exts.join("acme.pages-1.0.0");
        let refreshed: StudioManifest =
            serde_json::from_str(&std::fs::read_to_string(target.join("manifest.json")).unwrap())
                .unwrap();
        // The rebuilt package declares no native binaries and opens no listening socket:
        // no backend is derived for it.
        assert!(refreshed.backend.is_none());
        // The next boot leaves it alone (the build is recorded).
        assert!(refresh_bundled_installs_in(&exts, &packages).is_empty());
    }

    #[test]
    fn an_install_older_than_the_bundled_package_is_upgraded_at_boot() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The app once shipped 1.0.0 and the user installed it (builtin, the way a one-click
        // install of a bundled offer lands).
        let old = make_vsix(tmp.path(), "demo", "acme", "1.0.0", false);
        install_from_vsix_into(&exts, &old, true).unwrap();
        assert!(exts.join("acme.demo-1.0.0").exists());

        // The app now ships 1.2.0: the boot pass upgrades the install forward-only, and the
        // new install lands under the new version's own directory name.
        let bundled = make_vsix(tmp.path(), "demo", "acme", "1.2.0", true);
        let (capabilities, manifest) = bundled_of(&bundled).unwrap();
        let packages = [BundledPackage {
            id: capabilities.id.clone(),
            path: bundled.clone(),
            manifest,
            capabilities,
        }];
        let outcomes = refresh_bundled_installs_in(&exts, &packages);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].is_ok(), "{outcomes:?}");
        assert!(exts.join("acme.demo-1.2.0/data/payload.bin").exists());
        assert!(!exts.join("acme.demo-1.0.0").exists());
        assert_eq!(
            installed_dir(&exts, "acme.demo").unwrap(),
            exts.join("acme.demo-1.2.0")
        );
        // The replaced install's builtin flag carries over: the upgrade does not make the
        // package uninstallable.
        let error = uninstall(&exts, "acme.demo").unwrap_err();
        assert!(error.contains("built into"), "{error}");
        // The next boot leaves it alone (the version now matches and the build is recorded).
        assert!(refresh_bundled_installs_in(&exts, &packages).is_empty());
    }

    #[test]
    fn an_install_newer_than_the_bundled_package_is_never_downgraded() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The user installed 2.0.0 from a file; the app ships 1.2.0 beside it.
        let installed = make_vsix(tmp.path(), "demo", "acme", "2.0.0", true);
        install_from_vsix_into(&exts, &installed, false).unwrap();
        let (ggx, _) = bundled_of(&installed).unwrap();
        let older_bundle = make_vsix(tmp.path(), "demo", "acme", "1.2.0", true);
        let (older, older_manifest) = bundled_of(&older_bundle).unwrap();
        let packages = [BundledPackage {
            id: ggx.id.clone(),
            path: older_bundle.clone(),
            manifest: older_manifest,
            capabilities: older,
        }];
        assert!(refresh_bundled_installs_in(&exts, &packages).is_empty());
        assert!(exts.join("acme.demo-2.0.0").exists());
        assert!(!exts.join("acme.demo-1.2.0").exists());
    }

    #[test]
    fn the_listing_resolves_nls_placeholders_through_the_packages_own_nls_file() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The shape the git-graph-rs package really ships: `package.json` carrying
        // `%displayName%` / `%description%`, `package.nls.json` resolving both.
        let ggx = tmp.path().join("acme.demo-1.0.0.vsix");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"demo","publisher":"acme","version":"1.0.0","displayName":"%displayName%","description":"%extension.description%","ggs":{"format":"ggs/2","id":"acme.demo","version":"1.0.0","pages":{}}}"#,
        ).unwrap();
        zip.start_file("extension/package.nls.json", options)
            .unwrap();
        zip.write_all(
            br#"{"displayName":"Demo (localized)","extension.description":"A localized demo."}"#,
        )
        .unwrap();
        zip.start_file("extension/README.md", options).unwrap();
        zip.write_all(b"# Demo\n\nThe readme.").unwrap();
        zip.finish().unwrap();

        install_from_vsix_into(&exts, &ggx, true).unwrap();
        let listed = list_installed(&exts).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            (
                listed[0].display_name.as_deref(),
                listed[0].description.as_str()
            ),
            (Some("Demo (localized)"), "A localized demo.")
        );
        // README.md ships in the package: the detail page's source for it is named.
        assert_eq!(listed[0].readme.as_deref(), Some("README.md"));
    }

    #[test]
    fn install_list_and_uninstall() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = make_vsix(tmp.path(), "demo", "acme", "1.0.0", false);

        let info = install_from_vsix_into(&exts, &ggx, false).unwrap();
        assert_eq!(
            (info.id.as_str(), info.version.as_str()),
            ("acme.demo", "1.0.0")
        );
        assert!(!info.builtin);

        let list = list_installed(&exts).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "acme.demo");

        uninstall(&exts, "acme.demo").unwrap();
        assert!(list_installed(&exts).unwrap().is_empty());
    }

    /// The uninstall marker is the boot pass's auto-install handbrake: a completed uninstall
    /// writes it (and nothing else sees it — the listing stays empty), a refused builtin
    /// uninstall does not, and the next explicit install clears it.
    #[test]
    fn rich_manifest_fields_and_docs_are_listed() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("rich.vsix");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"rich","publisher":"acme","version":"2.0.0",
            "displayName":"Rich Demo","description":"d","categories":["Other","SCM Providers"],
            "keywords":["git"],"repository":{"type":"git","url":"https://example.com/rich.git"},
            "license":"MIT","engines":{"vscode":"^1.80.0"},
            "extensionDependencies":["acme.base"],"extensionPack":["acme.pack"],
            "ggs":{"format":"ggs/2","id":"acme.rich","version":"2.0.0","pages":{}}}"#,
        )
        .unwrap();
        zip.start_file("extension/README.md", options).unwrap();
        zip.write_all(b"# Rich").unwrap();
        zip.start_file("extension/CHANGELOG.md", options).unwrap();
        zip.write_all(b"# Changelog").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &ggx, false).unwrap();
        assert_eq!(info.display_name.as_deref(), Some("Rich Demo"));
        assert_eq!(info.categories, vec!["Other", "SCM Providers"]);
        assert_eq!(info.keywords, vec!["git"]);
        assert_eq!(
            info.repository.as_deref(),
            Some("https://example.com/rich.git")
        );
        assert_eq!(info.license.as_deref(), Some("MIT"));
        assert_eq!(info.engines_vscode.as_deref(), Some("^1.80.0"));
        assert_eq!(info.extension_dependencies, vec!["acme.base"]);
        assert_eq!(info.extension_pack, vec!["acme.pack"]);
        assert!(info
            .readme
            .as_deref()
            .is_some_and(|f| f.eq_ignore_ascii_case("README.md")));
        assert!(info
            .changelog
            .as_deref()
            .is_some_and(|f| f.eq_ignore_ascii_case("CHANGELOG.md")));
    }

    #[test]
    fn an_install_lists_upgrades_and_refuses_downgrades() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        let ggx = make_vsix(tmp.path(), "demo", "acme", "1.0.0", true);
        let info = install_from_vsix_into(&exts, &ggx, true).unwrap();
        assert_eq!(
            (
                info.id.as_str(),
                info.version.as_str(),
                info.format.as_str(),
                info.builtin
            ),
            ("acme.demo", "1.0.0", "vsix", true)
        );
        assert!(exts
            .join("acme.demo-1.0.0")
            .join("web")
            .join("view.html")
            .is_file());
        assert!(exts
            .join("acme.demo-1.0.0")
            .join("data")
            .join("payload.bin")
            .is_file());

        // Installing the same package again is refused; a newer one replaces it.
        assert!(install_from_vsix_into(&exts, &ggx, false)
            .unwrap_err()
            .contains("already installed"));
        let newer = make_vsix(tmp.path(), "demo", "acme", "1.1.0", false);
        let info = install_from_vsix_into(&exts, &newer, false).unwrap();
        assert_eq!(info.version, "1.1.0");
        // The user package that replaced the bundled one is an ordinary uninstallable install.
        assert!(!info.builtin);
        assert_eq!(list_installed(&exts).unwrap().len(), 1);
        assert!(install_from_vsix_into(&exts, &ggx, false)
            .unwrap_err()
            .contains("is older"));
    }

    #[test]
    fn a_vsix_with_node_binaries_and_no_entry_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The store's ordinary native extension without a `main`: a compiled `.node` no
        // host here can load and no entry to derive a backend from. The install names the
        // file and the reason.
        let vsix = tmp.path().join("native.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(br#"{"name":"native","publisher":"acme","version":"1.0.0"}"#)
            .unwrap();
        zip.start_file("extension/native/dep.node", options)
            .unwrap();
        zip.write_all(b"MZ").unwrap();
        zip.finish().unwrap();

        let error = install_from_vsix_into(&exts, &vsix, false).unwrap_err();
        assert!(error.contains("native Node binaries"), "{error}");
        assert!(error.contains("`native/dep.node`"), "{error}");
        assert!(error.contains("declares no"), "{error}");
        assert!(!exts.join("acme.native-1.0.0").exists(), "nothing installs");
    }

    #[test]
    fn a_vsix_with_node_binaries_and_a_main_installs_with_a_derived_runtime_backend() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The store's ordinary native extension WITH a main: the pretend Node runtime
        // derives from it — the install goes through, and the generated manifest carries
        // the ggs-node backend so the boot pass starts it and the frame host's native-call
        // proxy reaches the loaded addon exactly as for a declared package.
        let vsix = tmp.path().join("native.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"native","publisher":"acme","version":"1.0.0","main":"./out/ext.js"}"#,
        )
        .unwrap();
        zip.start_file("extension/out/ext.js", options).unwrap();
        zip.write_all(b"require('../native/dep.node');").unwrap();
        zip.start_file("extension/native/dep.node", options)
            .unwrap();
        zip.write_all(b"MZ").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        let capabilities = info.capabilities.expect("the derived manifest");
        let backend = capabilities.backend.expect("the derived backend");
        assert_eq!(backend.kind, "node");
        assert_eq!(backend.command, "./out/ext.js");
    }

    #[test]
    fn an_engine_node_needs_a_main_and_one_with_it_installs_the_main_backend() {
        // The engine `.node` is native binary: it needs the package's own `main` to run it
        // (the JS entry loads it through the Node runtime's N-API host). Without a `main`
        // the install is refused with the named reason; with one, the backend is that entry.
        let node = engine_node_fixture();
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("engine.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"engine","publisher":"acme","version":"1.0.0","ggs":{"format":"ggs/2","id":"acme.engine","version":"1.0.0","pages":{"view":{"page":"web/view.html"}},"backend":{"kind":"node","host":"git-graph-backend","command":"native/win32-x64/engine.node"}}}"#,
        )
        .unwrap();
        zip.start_file("extension/web/view.html", options).unwrap();
        zip.write_all(b"<html></html>").unwrap();
        zip.start_file("extension/native/win32-x64/engine.node", options)
            .unwrap();
        zip.write_all(&node).unwrap();
        zip.finish().unwrap();

        let error = install_from_vsix_into(&exts, &vsix, false).unwrap_err();
        assert!(error.contains("no \"main\""), "{error}");

        // The same package with a `main`: the entry becomes the backend.
        let vsix_main = tmp.path().join("engine-main.vsix");
        let file = std::fs::File::create(&vsix_main).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"engine","publisher":"acme","version":"1.0.0","main":"./out/extension.js"}"#,
        )
        .unwrap();
        zip.start_file("extension/out/extension.js", options)
            .unwrap();
        zip.write_all(b"module.exports = {};").unwrap();
        zip.start_file("extension/native/win32-x64/engine.node", options)
            .unwrap();
        zip.write_all(&node).unwrap();
        zip.finish().unwrap();
        let info = install_from_vsix_into(&exts, &vsix_main, false).unwrap();
        let backend = info
            .capabilities
            .as_ref()
            .unwrap()
            .backend
            .as_ref()
            .unwrap();
        assert_eq!(backend.kind, "node");
        assert_eq!(backend.command, "./out/extension.js");
    }

    /// A byte blob that scans as a `.node` by name — the recognition reads names, never
    /// contents; any payload stands in for a real engine binary here.
    fn engine_node_fixture() -> Vec<u8> {
        b"engine-node-fixture".to_vec()
    }

    #[test]
    fn a_vsix_without_an_identity_or_without_package_json_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // Missing identity: the store's manifest needs a name and a publisher.
        let no_name = tmp.path().join("no-name.vsix");
        let file = std::fs::File::create(&no_name).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(br#"{"name":"","publisher":"acme","version":"1.0.0"}"#)
            .unwrap();
        zip.finish().unwrap();
        assert!(install_from_vsix_into(&exts, &no_name, false)
            .unwrap_err()
            .contains("name and a publisher"));

        // A plain zip is not a VSIX: no extension/package.json at all.
        let plain = tmp.path().join("plain.vsix");
        let file = std::fs::File::create(&plain).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("readme.txt", options).unwrap();
        zip.write_all(b"hi").unwrap();
        zip.finish().unwrap();
        assert!(install_from_vsix_into(&exts, &plain, false)
            .unwrap_err()
            .contains("not a VSIX"));
    }

    #[test]
    fn a_vsix_installs_whatever_its_package_json_carries_without_a_backend() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("pages.vsix");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"demo","publisher":"acme","version":"1.0.0","ggs":{"format":"ggs/2","id":"acme.demo","version":"1.0.0","pages":{"main":{"page":"web/view.html","title":"Demo"}},"backend":{"kind":"process","command":"bin/main.exe"}}}"#,
        )
        .unwrap();
        zip.start_file("extension/web/view.html", options).unwrap();
        zip.write_all(b"<html><head></head><body></body></html>")
            .unwrap();
        zip.start_file("extension/bin/main.exe", options).unwrap();
        zip.write_all(b"MZ").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &ggx, false).unwrap();
        // Anything extra a package.json carries is its own business: the install reads the
        // standard manifest alone — identity from it, and no backend (the JS entry is the
        // frame program's; the stray `bin/main.exe` is no native binary this host serves).
        let header = info.capabilities.as_ref().unwrap();
        assert_eq!(header.id, "acme.demo");
        assert_eq!(header.version, "1.0.0");
        assert!(header.backend.is_none());
        // The install lands where the process host and the ggs:// protocol will look.
        assert_eq!(
            installed_dir(&exts, "acme.demo").unwrap(),
            exts.join("acme.demo-1.0.0")
        );
    }

    #[test]
    fn a_backend_platform_map_resolves_and_falls_back_to_the_command() {
        let binaries = std::collections::BTreeMap::from([
            (
                "win32-x64".to_owned(),
                "backend/win32-x64/main.exe".to_owned(),
            ),
            (
                "darwin-arm64".to_owned(),
                "backend/darwin-arm64/main".to_owned(),
            ),
        ]);
        let backend = BackendDecl {
            kind: "node".to_owned(),
            command: "backend/win32-x64/main.exe".to_owned(),
            args: Vec::new(),

            protocol: Some("ggx-rpc/1".to_owned()),
            binaries: Some(binaries),
        };
        assert_eq!(
            backend.command_for("win32-x64"),
            "backend/win32-x64/main.exe"
        );
        assert_eq!(
            backend.command_for("darwin-arm64"),
            "backend/darwin-arm64/main"
        );
        // A platform not in the map falls back to `command`.
        assert_eq!(
            backend.command_for("linux-x64"),
            "backend/win32-x64/main.exe"
        );
        // The retired protocol name is still parsed off a packed manifest (the field is
        // kept for that read); the process host is what rejects it at start.
        assert_eq!(backend.protocol.as_deref(), Some("ggx-rpc/1"));
    }

    #[test]
    fn a_backend_of_an_unknown_kind_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("wasm.vsix");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"demo","publisher":"acme","version":"1.0.0","ggs":{"format":"ggs/2","id":"acme.demo","version":"1.0.0","backend":{"kind":"wasm","command":"main.wasm"}}}"#,
        )
        .unwrap();
        zip.finish().unwrap();

        // A foreign key the host never reads cannot break an install: the package is a
        // plain VS Code extension, and no backend is derived for it.
        let info = install_from_vsix_into(&exts, &ggx, false).unwrap();
        assert!(info.capabilities.as_ref().unwrap().backend.is_none());
    }

    #[test]
    fn a_main_that_opens_listening_sockets_derives_the_node_backend() {
        // A small main-only package whose entry starts a real server (Claude Remote's
        // shape — `http.createServer` for its LAN pairing server): the sandboxed frame
        // cannot accept a connection, so the install derives the ggs-node process, and
        // the derivation rides the runtime manifest — pure VSIX, no host-specific key.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("remote.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"remote","publisher":"ggs","version":"0.1.2","main":"./extension.js"}"#,
        )
        .unwrap();
        zip.start_file("extension/extension.js", options).unwrap();
        zip.write_all(
            b"const http = require('http');\nconst qr = require('./qrcode.js');\nconst server = http.createServer(() => {});\nmodule.exports = { activate: () => {} };",
        )
        .unwrap();
        zip.start_file("extension/qrcode.js", options).unwrap();
        zip.write_all(b"module.exports = {};").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        let backend = info
            .capabilities
            .as_ref()
            .unwrap()
            .backend
            .as_ref()
            .expect("the listening main derives the node backend");
        assert_eq!(backend.kind, "node");
        assert_eq!(backend.command, "./extension.js");
        // The runtime manifest on disk carries it — the listing (and through it the
        // workbench's backendHosted) decides frame or process by exactly this field.
        let manifest: StudioManifest = serde_json::from_str(
            &std::fs::read_to_string(exts.join("ggs.remote-0.1.2/manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.backend.as_ref().unwrap().kind, "node");
    }

    #[test]
    fn a_sibling_module_that_opens_listening_sockets_derives_the_node_backend() {
        // Claude Remote 0.2's shape: the entry is a thin loader and the LAN server lives
        // in a sibling module (`server.js` calls `http.createServer`). The socket scan
        // reads the package's whole loadable surface, not the entry alone — before it
        // did, this package installed with `backend: null`, landed in the sandboxed
        // frame, and its activation died on `Cannot find module './sessions.js'`.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("remote-split.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"remote","publisher":"ggs","version":"0.2.1","main":"./extension.js"}"#,
        )
        .unwrap();
        zip.start_file("extension/extension.js", options).unwrap();
        zip.write_all(
            b"const sessions = require('./sessions.js');\nconst server = require('./server.js');\nmodule.exports = { activate: () => server.start(sessions) };",
        )
        .unwrap();
        zip.start_file("extension/sessions.js", options).unwrap();
        zip.write_all(b"module.exports = {};").unwrap();
        zip.start_file("extension/server.js", options).unwrap();
        zip.write_all(
            b"const http = require('http');\nconst s = http.createServer(() => {});\nmodule.exports = { start: () => s.listen(0) };",
        )
        .unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        let backend = info
            .capabilities
            .as_ref()
            .unwrap()
            .backend
            .as_ref()
            .expect("a sibling's qualified server call derives the node backend");
        assert_eq!(backend.kind, "node");
        assert_eq!(backend.command, "./extension.js");
        let manifest: StudioManifest = serde_json::from_str(
            &std::fs::read_to_string(exts.join("ggs.remote-0.2.1/manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.backend.as_ref().unwrap().kind, "node");
    }

    #[test]
    fn a_minified_alias_of_create_server_stays_in_its_frame() {
        // The socket rule reads QUALIFIED calls only: a minified bundle aliases the
        // module (`l.createServer` — ms-python's named-pipe transport carries exactly
        // that) and must not flip a frame-hosted client extension onto ggs-node.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("client.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"client","publisher":"acme","version":"1.0.0","main":"./extension.js"}"#,
        )
        .unwrap();
        zip.start_file("extension/extension.js", options).unwrap();
        zip.write_all(b"const l = require('net'); const pipe = l.createServer(() => {}); module.exports = {};").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        assert!(
            info.capabilities.as_ref().unwrap().backend.is_none(),
            "an aliased call site is no qualified server call"
        );
    }

    use super::*;

    fn request_for(path: &str) -> String {
        path.to_owned()
    }

    fn home_with_demo_page() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("acme.demo-1.0.0").join("web");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("view.html"),
            b"<html><head><title>t</title></head><body></body></html>",
        )
        .unwrap();
        std::fs::write(dir.join("app.js"), b"console.log(1);").unwrap();
        tmp
    }

    #[test]
    fn a_page_is_served_with_the_bootstrap_composed_into_its_head() {
        let tmp = home_with_demo_page();
        let response =
            serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web/view.html"));
        assert_eq!(response.status(), http::StatusCode::OK);
        let body = String::from_utf8(response.body().to_vec()).unwrap();
        // The bootstrap is the head's FIRST script: a page's own scripts call acquireGgsApi()
        // the moment they parse, so it must precede every one of them.
        assert!(body.contains("acquireGgsApi"));
        assert!(body.find("acquireGgsApi").unwrap() < body.find("<title>").unwrap());
        assert!(body.contains("<title>t</title>"));
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn a_served_page_pins_the_file_root_worker_loaders_resolve_against() {
        // monaco-vscode-api bundles (claude-code's webview is one) resolve their
        // language-worker module ids against `globalThis._VSCODE_FILE_ROOT`; unset, the
        // loader's ESM path falls into its AMD branch and dies reading `require.toUrl`
        // of undefined. The composed boot pins it from the page's own URL, ahead of every
        // script the page itself declares.
        let tmp = home_with_demo_page();
        let response =
            serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web/view.html"));
        assert_eq!(response.status(), http::StatusCode::OK);
        let body = String::from_utf8(response.body().to_vec()).unwrap();
        assert!(body.contains("_VSCODE_FILE_ROOT"));
        assert!(body.find("_VSCODE_FILE_ROOT").unwrap() < body.find("<title>").unwrap());
    }

    #[test]
    fn a_percent_encoded_slash_in_the_package_path_still_serves_the_page() {
        // convertFileSrc composes the base with the trailing slash percent-encoded, so the
        // live requests carry the package segment and the page path as one encoded run.
        let tmp = home_with_demo_page();
        let response =
            serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0%2Fweb/view.html"));
        assert_eq!(response.status(), http::StatusCode::OK);
        assert!(String::from_utf8_lossy(response.body()).contains("acquireGgsApi"));
    }

    #[test]
    fn assets_pass_through_untouched_and_unknowns_are_404() {
        let tmp = home_with_demo_page();
        let js = serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web/app.js"));
        assert_eq!(js.body().as_slice(), b"console.log(1);");
        assert_eq!(
            serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web/missing.css"))
                .status(),
            http::StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn a_404_is_readable_cross_origin_like_a_served_file() {
        // The host's page-bundle prewarm fetches `webview/index.js` of every activation
        // (extHost.ts); a package that ships none answers 404, and without the allow-origin
        // header the browser blocks the response as a CORS violation - a console error per
        // such package instead of the prewarm's silent skip.
        let tmp = home_with_demo_page();
        let response = serve_ext_asset_from(
            tmp.path(),
            &request_for("/acme.demo-1.0.0/webview/index.js"),
        );
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "*"
        );
    }

    /// A scratch home whose one package (`acme.demo` 2.0.0) carries a manifest, so the
    /// retired-version fallback can resolve it: `web/logo.svg` and `web/view.html` exist.
    fn home_with_current_install() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("acme.demo-2.0.0").join("web");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            tmp.path().join("acme.demo-2.0.0").join("package.json"),
            br#"{"name": "demo", "publisher": "acme", "version": "2.0.0"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("view.html"),
            b"<html><head><title>t</title></head><body></body></html>",
        )
        .unwrap();
        std::fs::write(dir.join("logo.svg"), b"<svg xmlns='...'></svg>").unwrap();
        tmp
    }

    #[test]
    fn a_retired_versions_assets_are_served_from_the_current_install() {
        // Another instance upgraded the package in this shared store while a page of the old
        // version stayed open: the page's asset URLs still name the deleted directory
        // (claude-code's welcome art 404ing into a broken image), and the package's current
        // install answers for them.
        let tmp = home_with_current_install();
        let page = serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.9.0/web/view.html"));
        assert_eq!(page.status(), http::StatusCode::OK);
        assert!(String::from_utf8_lossy(page.body()).contains("acquireGgsApi"));
        let logo = serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.9.0/web/logo.svg"));
        assert_eq!(logo.status(), http::StatusCode::OK);
        assert_eq!(logo.body().as_slice(), b"<svg xmlns='...'></svg>");
        assert_eq!(logo.headers().get("content-type").unwrap(), "image/svg+xml");
        // An id nothing installed, and a missing file of a retired version, stay 404s.
        assert_eq!(
            serve_ext_asset_from(tmp.path(), &request_for("/other.pkg-1.0.0/web/logo.svg"))
                .status(),
            http::StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.9.0/web/missing.css"))
                .status(),
            http::StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn an_id_that_is_anothers_prefix_never_steals_the_fallback() {
        // `acme.demo` and `acme.demo.pro` are both installed; a retired `acme.demo.pro` must
        // resolve to its own install (the longest matching id), not to `acme.demo`'s.
        let tmp = home_with_current_install();
        let dir = tmp.path().join("acme.demo.pro-1.0.0").join("web");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            tmp.path().join("acme.demo.pro-1.0.0").join("package.json"),
            br#"{"name": "demo.pro", "publisher": "acme", "version": "1.0.0"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("logo.svg"), b"<svg>pro</svg>").unwrap();
        let pro = serve_ext_asset_from(
            tmp.path(),
            &request_for("/acme.demo.pro-0.9.0/web/logo.svg"),
        );
        assert_eq!(pro.body().as_slice(), b"<svg>pro</svg>");
    }

    #[test]
    fn traversal_is_confined_to_the_extensions_home() {
        let tmp = home_with_demo_page();
        for path in ["/../secrets.txt", "/acme.demo-1.0.0/../../secrets.txt"] {
            assert_eq!(
                serve_ext_asset_from(tmp.path(), &request_for(path)).status(),
                http::StatusCode::NOT_FOUND
            );
        }
    }

    #[test]
    fn percent_encoded_paths_decode_before_serving() {
        let tmp = home_with_demo_page();
        let response =
            serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web%2Fview.html"));
        assert_eq!(response.status(), http::StatusCode::OK);
    }

    #[test]
    fn a_page_without_a_head_still_gets_the_bootstrap_after_html() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("x-1").join("web");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("bare.html"),
            b"<!DOCTYPE html>\n<html lang=\"en\"><body>hi</body></html>",
        )
        .unwrap();
        let response = serve_ext_asset_from(tmp.path(), &request_for("/x-1/web/bare.html"));
        let body = String::from_utf8(response.body().to_vec()).unwrap();
        assert!(body.starts_with("<!DOCTYPE html>"));
        assert!(body.find("acquireGgsApi").unwrap() < body.find("<body>").unwrap());
    }

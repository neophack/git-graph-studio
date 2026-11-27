//! Standalone lightweight `ggs-mcp` CLI binary: serves a repository's persistent symbol
//! index, code analysis engine, and binary engineering parsers (CAN/DBC/ELF/DTS/DMP/CSV)
//! over MCP stdio without requiring the Tauri desktop shell or WebView runtime.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        eprintln!(
            "ggs-mcp {} — Git Graph Studio standalone MCP server\n\n\
             Usage:\n  ggs-mcp [repository-path]\n\n\
             Defaults to the current working directory when no path is given.",
            env!("CARGO_PKG_VERSION")
        );
        std::process::exit(0);
    }
    if args.iter().any(|a| a == "-V" || a == "--version") {
        println!("ggs-mcp {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }
    let folder = args
        .first()
        .cloned()
        .unwrap_or_else(|| ".".to_owned());
    match ggs_mcp::run(&folder) {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("[ggs-mcp] fatal: {err}");
            std::process::exit(1);
        }
    }
}

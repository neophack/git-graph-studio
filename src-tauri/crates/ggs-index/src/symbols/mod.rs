//! The workspace symbol index (plan M4): the shape of a symbol, the persistent per-root
//! databases behind Go-to-Definition / Find References / the Symbol Database page, and the
//! extraction layer. `parse` is the tree-sitter parser (plan M4.1, one `.scm` query per
//! language behind a `grammar-*` feature); `store` is the compact on-disk store in the
//! analyzed folder's hidden `.ggs/analysis/` database; `sidb` is the reference analysis
//! database (`si4-rea`'s si-lite format) written beside it; `sipb` is SI4's own project
//! volume format (`si4-rea`'s sip-vol container, a different format from `sidb`'s six
//! tables) byte-exact; `sipb_sig` generates the signature volumes' payload bytes (the
//! hash bloom behind `sipb`'s undecoded `signature` field, verified against the
//! snapshot); `cache` is the in-memory
//! whole-workspace rebuild the window before an index lands is served from; `index` owns
//! the per-root databases and the reference scan.

use serde::Serialize;

pub mod cache;
pub mod index;
pub mod mask;
pub mod parse;
pub mod relations;
pub mod rename;
pub mod sidb;
pub mod sipb;
pub mod sipb_sig;
pub mod store;

/// One declaration in the workspace index: what Go-to-Definition, Find References, Quick
/// Open's `@` / `#` modes, the Call Tree and the analysis tools all operate on.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSymbol {
    pub kind: String,
    pub name: String,
    /// Repo-relative, forward slashes.
    pub path: String,
    /// 0-based line of the declaration.
    pub line: usize,
    /// 0-based byte column of the name (the parser layer; 0 from the outline fallback).
    pub column: usize,
    /// 0-based line the declaration ends on (the parser layer; the start line as fallback).
    pub end_line: usize,
    /// The enclosing type of a method (`impl`/class/receiver), when the parser knows one.
    pub container: Option<String>,
}

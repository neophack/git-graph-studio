//! TEMP: the real-folder probe for the 2026-11-21 analysis-folder work — index a root
//! the way the app does, run the relation kinds on a named subject, and leave
//! the project analysis folder (`.ggs/`, the nine `project.ggs_*` volumes) standing for
//! external tooling to read back.
//!
//! ```text
//! cargo run -p ggs-index --example index_probe -- <root> [subject-name]
//! ```

use std::time::Instant;

use ggs_index::symbols::index::SymbolIndex;
use ggs_index::symbols::relations::{relation_children, RelationKind};

fn main() {
    let mut args = std::env::args().skip(1);
    let root = args.next().expect("usage: index_probe <root> [subject]");
    let subject = args.next().unwrap_or_else(|| "main".to_owned());

    // The probe's own index home, beside this repository's generated output.
    let home = std::env::current_dir()
        .unwrap()
        .join("../../target/studio/index-probe-home");
    std::fs::create_dir_all(&home).unwrap();
    let index = SymbolIndex::with_home(home);

    let started = Instant::now();
    index
        .ensure_blocking(None, &root)
        .expect("the index builds");
    println!(
        "[probe] index ready in {:.0} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );

    let status = index.status(&root);
    println!(
        "[probe] {} files, {} symbols, state {:?}",
        status.files, status.symbols, status.state
    );
    if let Some(kinds) = index.kind_counts(&root) {
        let mut counts: Vec<(String, usize)> = kinds
            .into_iter()
            .map(|(kind, count)| (kind.to_owned(), count))
            .collect();
        counts.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
        println!(
            "[probe] kinds: {}",
            counts
                .iter()
                .map(|(kind, count)| format!("{kind}={count}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    // The subject's declarations (it may have several: a prototype and a definition).
    let decls = index.lookup(&root, &subject).unwrap_or_default();
    println!(
        "[probe] subject {subject:?}: {} declarations — {}",
        decls.len(),
        decls
            .iter()
            .map(|d| format!("{} {}:{}#{}", d.kind, d.path, d.line + 1, d.end_line + 1))
            .collect::<Vec<_>>()
            .join("; ")
    );
    let Some(first) = decls.first() else {
        println!("[probe] nothing declares {subject:?}");
        return;
    };

    for (label, kind) in [
        ("Calls", RelationKind::Calls),
        ("Callers", RelationKind::Callers),
        ("Referenced by Functions", RelationKind::RefsTo),
        ("Referenced by Files", RelationKind::RefByFiles),
        ("Contains", RelationKind::Contains),
        ("Container", RelationKind::Container),
        ("Types Used", RelationKind::TypesUsed),
        ("Base Classes", RelationKind::BaseClasses),
        ("Derived Classes", RelationKind::DerivedClasses),
    ] {
        let subject_path = first.path.clone();
        let subject_line = first.line;
        let name = subject.clone();
        index
            .with_store(&root, |store| {
                let started = Instant::now();
                let answer = relation_children(&root, store, &name, &subject_path, subject_line, kind)
                    .expect("the relation answers");
                println!(
                    "[probe] {:<24} {} nodes{} in {:.0} ms{}",
                    label,
                    answer.nodes.len(),
                    if answer.truncated { " (truncated)" } else { "" },
                    started.elapsed().as_secs_f64() * 1000.0,
                    if answer.nodes.is_empty() {
                        String::new()
                    } else {
                        format!(
                            "\n          {}",
                            answer
                                .nodes
                                .iter()
                                .take(8)
                                .map(|n| format!(
                                    "{} {} ({}) {}:{} -> {}:{} [{}]",
                                    n.kind, n.name, n.container.as_deref().unwrap_or("-"),
                                    n.path, n.line + 1, n.edge_path, n.edge_line + 1, n.edge_kind
                                ))
                                .collect::<Vec<_>>()
                                .join("\n          ")
                        )
                    }
                );
            })
            .expect("the store is resident");
    }
}

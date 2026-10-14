//! The pretend Node runtime binary: a one-line shell over the ggs-node package.

/// Size-class free lists in front of the system heap (see `alloc`): a bundle load is
/// millions of small allocations, a third of its compile time on the system heap alone.
#[global_allocator]
static ALLOC: ggs_node::alloc::GgsAlloc = ggs_node::alloc::GgsAlloc;

fn main() {
    ggs_node::run();
}

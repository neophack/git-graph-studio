use super::VaryingOperand;
use boa_ast::scope::BindingLocatorScope;
use crate::{Context, JsResult, JsValue, vm::opcode::Operation};

pub(crate) mod class;
pub(crate) mod own_property;

pub(crate) use class::*;
pub(crate) use own_property::*;

/// `DefVar` implements the Opcode Operation for `Opcode::DefVar`
///
/// Operation:
///  - Declare `var` type variable.
#[derive(Debug, Clone, Copy)]
pub(crate) struct DefVar;

impl DefVar {
    #[inline(always)]
    pub(super) fn operation(index: VaryingOperand, context: &mut Context) {
        // TODO: spec specifies to return `empty` on empty vars, but we're trying to initialize.
        let binding_locator = context.vm.frame().code_block.bindings[usize::from(index)].clone();

        context.vm.environments.put_value_if_uninitialized(
            binding_locator.scope(),
            binding_locator.binding_index(),
            JsValue::undefined(),
        );
    }
}

impl Operation for DefVar {
    const NAME: &'static str = "DefVar";
    const INSTRUCTION: &'static str = "INST - DefVar";
    const COST: u8 = 3;
}

/// `DefInitVar` implements the Opcode Operation for `Opcode::DefInitVar`
///
/// Operation:
///  - Declare and initialize a function argument.
#[derive(Debug, Clone, Copy)]
pub(crate) struct DefInitVar;

impl DefInitVar {
    #[inline(always)]
    pub(super) fn operation(
        (value, index): (VaryingOperand, VaryingOperand),
        context: &mut Context,
    ) -> JsResult<()> {
        let value = context.vm.get_register(value.into()).clone();
        let frame = context.vm.frame();
        let strict = frame.code_block.strict();
        let mut binding_locator = frame.code_block.bindings[usize::from(index)].clone();
        context.find_runtime_binding(&mut binding_locator)?;
        context.set_binding(&binding_locator, value.clone(), strict)?;

        Ok(())
    }
}

impl Operation for DefInitVar {
    const NAME: &'static str = "DefInitVar";
    const INSTRUCTION: &'static str = "INST - DefInitVar";
    const COST: u8 = 3;
}

/// `PutLexicalValue` implements the Opcode Operation for `Opcode::PutLexicalValue`
///
/// Operation:
///  - Initialize a lexical binding.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PutLexicalValue;

impl PutLexicalValue {
    #[inline(always)]
    pub(super) fn operation(
        (value, index): (VaryingOperand, VaryingOperand),
        context: &mut Context,
    ) {
        let value = context.vm.get_register(value.into()).clone();
        // GGS patch: a miscompiled locator (the known Function-constructor compile
        // bug) panics inside put_lexical_value and would kill the whole runtime
        // thread. Degrade to skipping this one initialization instead, naming the code
        // block that carried the bad locator.
        let binding_locator = context.vm.frame().code_block.bindings[usize::from(index)].clone();
        let scope = binding_locator.scope();
        let binding_index = binding_locator.binding_index();
        let environments = &mut context.vm.environments;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            environments.put_lexical_value(scope, binding_index, value.clone());
        }));
        if std::env::var("GGS_SCOPE_TRACE").is_ok() {
            let n = binding_locator.name().to_std_string_escaped();
            if n == "Q" {
                let scope_desc = match scope {
                    BindingLocatorScope::Stack(i) => format!("Stack({i})"),
                    other => format!("{other:?}"),
                };
                std::eprintln!("[ggs-scope] PutLexicalValue Q -> {scope_desc} slot={binding_index} value={:?}", value.type_of());
            }
        }
        if outcome.is_err() {
            let name = context.vm.frame().code_block.name().to_std_string_escaped();
            std::eprintln!(
                "[ggs-boa] PutLexicalValue: locator out of range (binding {binding_index}) in code block {name} - initialization skipped",
            );
        }
    }
}
impl Operation for PutLexicalValue {
    const NAME: &'static str = "PutLexicalValue";
    const INSTRUCTION: &'static str = "INST - PutLexicalValue";
    const COST: u8 = 3;
}

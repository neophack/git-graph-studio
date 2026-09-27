//! Boa's implementation of ECMAScript's global `Error` object.
//!
//! Error objects are thrown when runtime errors occur.
//! The Error object can also be used as a base object for user-defined exceptions.
//!
//! More information:
//!  - [MDN documentation][mdn]
//!  - [ECMAScript reference][spec]
//!
//! [spec]: https://tc39.es/ecma262/#sec-error-objects
//! [mdn]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error

use crate::{
    Context, JsArgs, JsData, JsResult, JsString, JsValue,
    builtins::BuiltInObject,
    context::intrinsics::{Intrinsics, StandardConstructor, StandardConstructors},
    error::{IgnoreEq, JsNativeError},
    js_string,
    object::{JsObject, internal_methods::get_prototype_from_constructor},
    property::{Attribute, PropertyDescriptor},
    realm::Realm,
    string::StaticJsStrings,
    vm::shadow_stack::{Backtrace, ShadowEntry},
};
use boa_gc::{Finalize, Trace};
use boa_macros::js_str;

pub(crate) mod aggregate;
pub(crate) mod eval;
pub(crate) mod range;
pub(crate) mod reference;
pub(crate) mod syntax;
pub(crate) mod r#type;
pub(crate) mod uri;

#[cfg(test)]
mod tests;

pub(crate) use self::aggregate::AggregateError;
pub(crate) use self::eval::EvalError;
pub(crate) use self::range::RangeError;
pub(crate) use self::reference::ReferenceError;
pub(crate) use self::syntax::SyntaxError;
pub(crate) use self::r#type::TypeError;
pub(crate) use self::uri::UriError;

use super::{BuiltInBuilder, BuiltInConstructor, IntrinsicObject};

/// A tag of built-in `Error` object, [ECMAScript spec][spec].
///
/// [spec]: https://tc39.es/ecma262/#sec-error-objects
#[derive(Debug, Copy, Clone, Eq, PartialEq, Trace, Finalize, JsData)]
#[boa_gc(empty_trace)]
#[non_exhaustive]
pub enum ErrorKind {
    /// The `AggregateError` object type.
    ///
    /// More information:
    ///  - [ECMAScript reference][spec]
    ///
    /// [spec]: https://tc39.es/ecma262/#sec-aggregate-error-objects
    Aggregate,

    /// The `Error` object type.
    ///
    /// More information:
    ///  - [ECMAScript reference][spec]
    ///
    /// [spec]: https://tc39.es/ecma262/#sec-error-objects
    Error,

    /// The `EvalError` type.
    ///
    /// More information:
    ///  - [ECMAScript reference][spec]
    ///
    /// [spec]: https://tc39.es/ecma262/#sec-native-error-types-used-in-this-standard-evalerror
    Eval,

    /// The `TypeError` type.
    ///
    /// More information:
    ///  - [ECMAScript reference][spec]
    ///
    /// [spec]: https://tc39.es/ecma262/#sec-native-error-types-used-in-this-standard-typeerror
    Type,

    /// The `RangeError` type.
    ///
    /// More information:
    ///  - [ECMAScript reference][spec]
    ///
    /// [spec]: https://tc39.es/ecma262/#sec-native-error-types-used-in-this-standard-rangeerror
    Range,

    /// The `ReferenceError` type.
    ///
    /// More information:
    ///  - [ECMAScript reference][spec]
    ///
    /// [spec]: https://tc39.es/ecma262/#sec-native-error-types-used-in-this-standard-referenceerror
    Reference,

    /// The `SyntaxError` type.
    ///
    /// More information:
    ///  - [ECMAScript reference][spec]
    ///
    /// [spec]: https://tc39.es/ecma262/#sec-native-error-types-used-in-this-standard-syntaxerror
    Syntax,

    /// The `URIError` type.
    ///
    /// More information:
    ///  - [ECMAScript reference][spec]
    ///
    /// [spec]: https://tc39.es/ecma262/#sec-native-error-types-used-in-this-standard-urierror
    Uri,
}

/// A built-in `Error` object, per the [ECMAScript spec][spec].
///
/// This is used internally to convert between [`JsObject`] and
/// [`JsNativeError`] correctly, but it can also be used to manually create `Error`
/// objects. However, the recommended way to create them is to construct a
/// `JsNativeError` first, then call [`JsNativeError::to_opaque`],
/// which will assign its prototype, properties and kind automatically.
///
/// For a description of every error kind and its usage, see
/// [`JsNativeErrorKind`][crate::error::JsNativeErrorKind].
///
/// [spec]: https://tc39.es/ecma262/#sec-error-objects
#[derive(Debug, Clone, PartialEq, Eq, Trace, Finalize, JsData)]
pub struct Error {
    pub(crate) tag: ErrorKind,

    // The position of where the Error was created does not affect equality check.
    #[unsafe_ignore_trace]
    pub(crate) position: IgnoreEq<Option<ShadowEntry>>,

    // GGS-patch: the call stack at creation (V8's `Error.stack`), formatted on read by
    // the `Error.prototype.stack` accessor. None for errors built without a VM frame.
    #[unsafe_ignore_trace]
    pub(crate) backtrace: IgnoreEq<Option<Backtrace>>,
}

/// GGS-patch: the default `Error.stackTraceLimit` (V8's).
const DEFAULT_STACK_TRACE_LIMIT: usize = 10;

impl Error {
    /// Create a new [`Error`].
    #[inline]
    #[must_use]
    pub fn new(tag: ErrorKind) -> Self {
        Self {
            tag,
            position: IgnoreEq(None),
            backtrace: IgnoreEq(None),
        }
    }

    /// Create a new [`Error`] with the given optional [`ShadowEntry`].
    pub(crate) fn with_shadow_entry(tag: ErrorKind, entry: Option<ShadowEntry>) -> Self {
        Self {
            tag,
            position: IgnoreEq(entry),
            backtrace: IgnoreEq(None),
        }
    }

    /// Get the position from the last called function — and (GGS-patch) the call stack
    /// the error is created on, minus the constructor's own native frame.
    pub(crate) fn with_caller_position(tag: ErrorKind, context: &Context) -> Self {
        Self {
            tag,
            position: IgnoreEq(context.vm.shadow_stack.caller_position()),
            backtrace: IgnoreEq(Some(Self::current_backtrace(context))),
        }
    }

    /// GGS-patch: the live call stack, the newest native frame (the caller of this — a
    /// constructor or `captureStackTrace`) left out.
    pub(crate) fn current_backtrace(context: &Context) -> Backtrace {
        context
            .vm
            .shadow_stack
            .take(context.vm.runtime_limits.backtrace_limit(), context.vm.frame.pc)
            .without_newest_native()
    }

    /// GGS-patch: `Error.stackTraceLimit`, read off the constructor (V8 reads it the same
    /// way); a non-number or a negative one falls back to the default.
    fn stack_trace_limit(context: &mut Context) -> usize {
        let constructor = context.intrinsics().constructors().error().constructor();
        match constructor.get(js_string!("stackTraceLimit"), context) {
            Ok(value) => match value.as_number() {
                Some(limit) if limit >= 0.0 => limit.min(1_000.0) as usize,
                _ => DEFAULT_STACK_TRACE_LIMIT,
            },
            Err(_) => DEFAULT_STACK_TRACE_LIMIT,
        }
    }

    /// GGS-patch: the header (`Error.prototype.toString`) + the frames — V8's `stack`.
    fn stack_string(
        this: &JsValue,
        backtrace: &Backtrace,
        context: &mut Context,
    ) -> JsResult<JsString> {
        let header = Self::to_string(this, &[], context)?.to_string(context)?;
        let frames = backtrace.v8_frames(Self::stack_trace_limit(context));
        Ok(js_string!(&header, &JsString::from(frames.as_str())))
    }

    /// GGS-patch: `get Error.prototype.stack` — the creation-time stack, rendered with the
    /// error's current name and message (a subclass setting `this.name` after `super()`
    /// shows it, as in V8). Undefined on anything that is not an Error object.
    pub(crate) fn get_stack(
        this: &JsValue,
        _: &[JsValue],
        context: &mut Context,
    ) -> JsResult<JsValue> {
        let Some(object) = this.as_object() else {
            return Ok(JsValue::undefined());
        };
        let backtrace = match object.downcast_ref::<Self>() {
            Some(error) => error.backtrace.0.clone().unwrap_or_default(),
            None => return Ok(JsValue::undefined()),
        };
        Ok(Self::stack_string(this, &backtrace, context)?.into())
    }

    /// GGS-patch: `set Error.prototype.stack` — an own data property on the receiver, the
    /// way assigning `err.stack = …` behaves in V8.
    pub(crate) fn set_stack(
        this: &JsValue,
        args: &[JsValue],
        context: &mut Context,
    ) -> JsResult<JsValue> {
        if let Some(object) = this.as_object() {
            object.define_property_or_throw(
                js_string!("stack"),
                PropertyDescriptor::builder()
                    .value(args.get_or_undefined(0).clone())
                    .writable(true)
                    .enumerable(false)
                    .configurable(true),
                context,
            )?;
        }
        Ok(JsValue::undefined())
    }

    /// GGS-patch: `Error.captureStackTrace(targetObject[, constructorOpt])` — V8's API,
    /// which Node packages call unguarded in their error classes: an own `stack` on the
    /// target, the frames above `constructorOpt` left out.
    pub(crate) fn capture_stack_trace(
        _: &JsValue,
        args: &[JsValue],
        context: &mut Context,
    ) -> JsResult<JsValue> {
        let target = args.get_or_undefined(0);
        let Some(object) = target.as_object() else {
            return Err(JsNativeError::typ()
                .with_message("The \"targetObject\" argument must be of type object")
                .into());
        };
        let mut backtrace = Self::current_backtrace(context);
        if let Some(constructor) = args.get_or_undefined(1).as_object() {
            let name = constructor.get(js_string!("name"), context)?;
            if let Some(name) = name.as_string().filter(|name| !name.is_empty()) {
                backtrace = backtrace.above_frame_named(&name);
            }
        }
        let stack = Self::stack_string(target, &backtrace, context)?;
        object.define_property_or_throw(
            js_string!("stack"),
            PropertyDescriptor::builder()
                .value(stack)
                .writable(true)
                .enumerable(false)
                .configurable(true),
            context,
        )?;
        Ok(JsValue::undefined())
    }
}

impl IntrinsicObject for Error {
    fn init(realm: &Realm) {
        let attribute = Attribute::WRITABLE | Attribute::NON_ENUMERABLE | Attribute::CONFIGURABLE;
        // GGS-patch: V8's stack surface — the `stack` accessor, `captureStackTrace` and
        // `stackTraceLimit` (Node packages lean on all three).
        let get_stack = BuiltInBuilder::callable(realm, Self::get_stack)
            .name(js_string!("get stack"))
            .build();
        let set_stack = BuiltInBuilder::callable(realm, Self::set_stack)
            .name(js_string!("set stack"))
            .length(1)
            .build();
        let builder = BuiltInBuilder::from_standard_constructor::<Self>(realm)
            .property(js_string!("name"), Self::NAME, attribute)
            .property(js_string!("message"), js_string!(), attribute)
            .method(Self::to_string, js_string!("toString"), 0)
            .accessor(
                js_string!("stack"),
                Some(get_stack),
                Some(set_stack),
                Attribute::NON_ENUMERABLE | Attribute::CONFIGURABLE,
            )
            .static_method(
                Self::capture_stack_trace,
                js_string!("captureStackTrace"),
                2,
            )
            .static_property(
                js_string!("stackTraceLimit"),
                DEFAULT_STACK_TRACE_LIMIT as i32,
                Attribute::WRITABLE | Attribute::ENUMERABLE | Attribute::CONFIGURABLE,
            );

        #[cfg(feature = "experimental")]
        let builder = builder.static_method(Error::is_error, js_string!("isError"), 1);

        builder.build();
    }

    fn get(intrinsics: &Intrinsics) -> JsObject {
        Self::STANDARD_CONSTRUCTOR(intrinsics.constructors()).constructor()
    }
}

impl BuiltInObject for Error {
    const NAME: JsString = StaticJsStrings::ERROR;
}

impl BuiltInConstructor for Error {
    const CONSTRUCTOR_ARGUMENTS: usize = 1;
    // GGS-patch: + the `stack` accessor (2 slots), captureStackTrace and stackTraceLimit.
    const PROTOTYPE_STORAGE_SLOTS: usize = 5;
    const CONSTRUCTOR_STORAGE_SLOTS: usize = 3;

    const STANDARD_CONSTRUCTOR: fn(&StandardConstructors) -> &StandardConstructor =
        StandardConstructors::error;

    /// `Error( message [ , options ] )`
    ///
    /// Creates a new error object.
    fn constructor(
        new_target: &JsValue,
        args: &[JsValue],
        context: &mut Context,
    ) -> JsResult<JsValue> {
        // 1. If NewTarget is undefined, let newTarget be the active function object; else let newTarget be NewTarget.
        let new_target = &if new_target.is_undefined() {
            context
                .active_function_object()
                .unwrap_or_else(|| context.intrinsics().constructors().error().constructor())
                .into()
        } else {
            new_target.clone()
        };

        // 2. Let O be ? OrdinaryCreateFromConstructor(newTarget, "%Error.prototype%", « [[ErrorData]] »).
        let prototype =
            get_prototype_from_constructor(new_target, StandardConstructors::error, context)?;
        let o = JsObject::from_proto_and_data_with_shared_shape(
            context.root_shape(),
            prototype,
            Error::with_caller_position(ErrorKind::Error, context),
        );

        // 3. If message is not undefined, then
        let message = args.get_or_undefined(0);
        if !message.is_undefined() {
            // a. Let msg be ? ToString(message).
            let msg = message.to_string(context)?;

            // b. Perform CreateNonEnumerableDataPropertyOrThrow(O, "message", msg).
            o.create_non_enumerable_data_property_or_throw(js_string!("message"), msg, context);
        }

        // 4. Perform ? InstallErrorCause(O, options).
        Self::install_error_cause(&o, args.get_or_undefined(1), context)?;

        // 5. Return O.
        Ok(o.into())
    }
}

impl Error {
    pub(crate) fn install_error_cause(
        o: &JsObject,
        options: &JsValue,
        context: &mut Context,
    ) -> JsResult<()> {
        // 1. If Type(options) is Object and ? HasProperty(options, "cause") is true, then
        // 1.a. Let cause be ? Get(options, "cause").
        if let Some(options) = options.as_object()
            && let Some(cause) = options.try_get(js_string!("cause"), context)?
        {
            // b. Perform CreateNonEnumerableDataPropertyOrThrow(O, "cause", cause).
            o.create_non_enumerable_data_property_or_throw(js_string!("cause"), cause, context);
        }

        // 2. Return unused.
        Ok(())
    }

    /// `Error.prototype.toString()`
    ///
    /// The `toString()` method returns a string representing the specified Error object.
    ///
    /// More information:
    ///  - [MDN documentation][mdn]
    ///  - [ECMAScript reference][spec]
    ///
    /// [spec]: https://tc39.es/ecma262/#sec-error.prototype.tostring
    /// [mdn]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/toString
    #[allow(clippy::wrong_self_convention)]
    pub(crate) fn to_string(
        this: &JsValue,
        _: &[JsValue],
        context: &mut Context,
    ) -> JsResult<JsValue> {
        // 1. Let O be the this value.
        // 2. If Type(O) is not Object, throw a TypeError exception.
        let o = this
            .as_object()
            .ok_or_else(|| JsNativeError::typ().with_message("'this' is not an Object"))?;

        // 3. Let name be ? Get(O, "name").
        let name = o.get(js_string!("name"), context)?;

        // 4. If name is undefined, set name to "Error"; otherwise set name to ? ToString(name).
        let name = if name.is_undefined() {
            js_string!("Error")
        } else {
            name.to_string(context)?
        };

        // 5. Let msg be ? Get(O, "message").
        let msg = o.get(js_string!("message"), context)?;

        // 6. If msg is undefined, set msg to the empty String; otherwise set msg to ? ToString(msg).
        let msg = if msg.is_undefined() {
            js_string!()
        } else {
            msg.to_string(context)?
        };

        // 7. If name is the empty String, return msg.
        if name.is_empty() {
            return Ok(msg.into());
        }

        // 8. If msg is the empty String, return name.
        if msg.is_empty() {
            return Ok(name.into());
        }

        // 9. Return the string-concatenation of name, the code unit 0x003A (COLON),
        // the code unit 0x0020 (SPACE), and msg.
        Ok(js_string!(&name, js_str!(": "), &msg).into())
    }

    /// [`Error.isError`][spec].
    ///
    /// Returns a boolean indicating whether the argument is a built-in Error instance or not.
    ///
    /// [spec]: https://tc39.es/proposal-is-error/#sec-error.iserror
    #[cfg(feature = "experimental")]
    #[allow(clippy::unnecessary_wraps)]
    fn is_error(_: &JsValue, args: &[JsValue], _: &mut Context) -> JsResult<JsValue> {
        // 1. Return IsError(arg).

        // https://tc39.es/proposal-is-error/#sec-iserror

        // 1. If argument is not an Object, return false.
        // 2. If argument has an [[ErrorData]] internal slot, return true.
        // 3. Return false.
        Ok(args
            .get_or_undefined(0)
            .as_object()
            .is_some_and(|o| o.is::<Error>())
            .into())
    }
}

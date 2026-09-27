//! `path`: one honest platform implementation; the `posix`/`win32` aliases point at the
//! same code rather than lying about a second platform's rules.

use boa_engine::{Context, JsObject, JsResult, JsValue, NativeFunction};

use super::support::*;
use crate::node_runtime::{key, native_callable, text};

pub(super) fn path_module(context: &mut Context) -> JsResult<JsObject> {
    let module = JsObject::with_object_proto(context.intrinsics());
    let natives: &[(&str, usize, NativeFunction)] = &[
        ("join", 1, NativeFunction::from_fn_ptr(path_join)),
        ("resolve", 1, NativeFunction::from_fn_ptr(path_resolve)),
        ("normalize", 1, NativeFunction::from_fn_ptr(path_normalize)),
        ("dirname", 1, NativeFunction::from_fn_ptr(path_dirname)),
        ("basename", 1, NativeFunction::from_fn_ptr(path_basename)),
        ("extname", 1, NativeFunction::from_fn_ptr(path_extname)),
        ("relative", 2, NativeFunction::from_fn_ptr(path_relative)),
        (
            "isAbsolute",
            1,
            NativeFunction::from_fn_ptr(path_is_absolute),
        ),
    ];
    for (name, _length, function) in natives {
        module.set(
            key(name),
            native_callable(context, name, function.clone()),
            false,
            context,
        )?;
    }
    let sep = if cfg!(target_os = "windows") {
        "\\"
    } else {
        "/"
    };
    module.set(key("sep"), text(sep), false, context)?;
    module.set(
        key("delimiter"),
        text(if cfg!(target_os = "windows") {
            ";"
        } else {
            ":"
        }),
        false,
        context,
    )?;
    // One platform is the honest answer here; the posix/win32 aliases point at the same
    // implementation rather than lying about a second platform's rules.
    module.set(key("posix"), module.clone(), false, context)?;
    module.set(key("win32"), module.clone(), false, context)?;
    Ok(module)
}

fn path_parts(args: &[JsValue], context: &mut Context) -> Vec<String> {
    args.iter()
        .filter_map(|value| {
            value
                .to_string(context)
                .ok()
                .map(|s| s.to_std_string_escaped())
        })
        .collect()
}

fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/') || path.starts_with('\\') || path.as_bytes().get(1) == Some(&b':')
}

fn join_parts(parts: &[String]) -> String {
    let sep = if cfg!(target_os = "windows") {
        '\\'
    } else {
        '/'
    };
    let mut joined = String::new();
    for part in parts {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if !joined.is_empty() && !joined.ends_with(sep) && !joined.ends_with('/') {
            joined.push(sep);
        }
        joined.push_str(part);
    }
    joined
}

fn normalize_lexical(path: &str) -> String {
    let sep: char = if cfg!(target_os = "windows") {
        '\\'
    } else {
        '/'
    };
    // A Windows drive (`C:`) is its own root: no separator is prepended to it, and `..`
    // at the drive root clamps instead of climbing past it.
    let has_drive = path.as_bytes().get(1) == Some(&b':');
    let rooted = path.starts_with('/') || path.starts_with('\\');
    let mut stack: Vec<String> = Vec::new();
    for segment in path
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".")
    {
        if segment == ".." {
            let at_drive_root = has_drive && stack.len() == 1;
            if stack.last().is_some_and(|top| top != "..") && !at_drive_root {
                stack.pop();
            } else if !rooted && !has_drive {
                stack.push(segment.to_owned());
            }
        } else {
            stack.push(segment.to_owned());
        }
    }
    let joined = stack.join(&sep.to_string());
    if rooted && !has_drive {
        format!("{sep}{joined}")
    } else {
        joined
    }
}

fn path_join(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let parts = path_parts(args, context);
    Ok(text(normalize_lexical(&join_parts(&parts))))
}

fn path_resolve(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    // Node's order: the rightmost absolute argument is the start, everything before it is
    // discarded, and with none absolute the working directory leads.
    let parts = path_parts(args, context);
    let parts = match parts.iter().rposition(|part| is_absolute_path(part.trim())) {
        Some(at) => parts[at..].to_vec(),
        None => {
            let cwd = std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            std::iter::once(cwd).chain(parts).collect()
        }
    };
    Ok(text(normalize_lexical(&join_parts(&parts))))
}

fn path_normalize(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    Ok(text(normalize_lexical(&path)))
}

fn path_dirname(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rfind(['/', '\\']) {
        Some(0) => Ok(text(trimmed[..1].to_owned())),
        Some(at) => Ok(text(trimmed[..at].to_owned())),
        None => Ok(text(
            if trimmed == path && is_absolute_path(path.trim_end_matches(['/', '\\'])) {
                path.trim_end_matches(['/', '\\']).to_owned()
            } else {
                ".".to_owned()
            },
        )),
    }
}

fn path_basename(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let suffix = opt_string_arg(args, 1, context);
    let trimmed = path.trim_end_matches(['/', '\\']);
    let mut base = trimmed.rsplit(['/', '\\']).next().unwrap_or("").to_owned();
    if let Some(suffix) = suffix {
        if base.ends_with(&suffix) {
            base.truncate(base.len() - suffix.len());
        }
    }
    Ok(text(base))
}

fn path_extname(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let base = path.rsplit(['/', '\\']).next().unwrap_or("");
    let extension = base
        .rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .map(|(_, ext)| format!(".{ext}"))
        .unwrap_or_default();
    Ok(text(extension))
}

fn path_relative(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let from = string_arg(args, 0, context);
    let to = string_arg(args, 1, context);
    let from_parts: Vec<&str> = from
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    let to_parts: Vec<&str> = to
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    let mut common = 0;
    while common < from_parts.len()
        && common < to_parts.len()
        && from_parts[common].eq_ignore_ascii_case(to_parts[common])
    {
        common += 1;
    }
    let sep = if cfg!(target_os = "windows") {
        "\\"
    } else {
        "/"
    };
    let mut result: Vec<String> = Vec::new();
    for _ in common..from_parts.len() {
        result.push("..".to_owned());
    }
    for part in &to_parts[common..] {
        result.push((*part).to_owned());
    }
    Ok(text(if result.is_empty() {
        ".".to_owned()
    } else {
        result.join(sep)
    }))
}

fn path_is_absolute(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    Ok(JsValue::from(is_absolute_path(&path)))
}

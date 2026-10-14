//! JSONC — JSON with comments — stripping: a commented workspace or manifest file still
//! parses.

/// Strip `//` and `/* */` comments (outside strings, so a URL inside one survives).
pub fn strip(text: &str) -> String {
    // Kept ranges of the original string are emitted as slices, so multibyte characters
    // pass through untouched - only ASCII comment bytes are ever skipped.
    let bytes = text.as_bytes();
    let mut kept: Vec<&str> = Vec::new();
    let mut segment = 0;
    let mut at = 0;
    let mut in_string = false;
    while at < bytes.len() {
        let byte = bytes[at];
        if in_string {
            if byte == b'\\' && at + 1 < bytes.len() {
                at += 2;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            at += 1;
        } else if byte == b'"' {
            in_string = true;
            at += 1;
        } else if byte == b'/' && bytes.get(at + 1) == Some(&b'/') {
            kept.push(&text[segment..at]);
            while at < bytes.len() && bytes[at] != b'\n' {
                at += 1;
            }
            segment = at;
        } else if byte == b'/' && bytes.get(at + 1) == Some(&b'*') {
            kept.push(&text[segment..at]);
            at += 2;
            while at + 1 < bytes.len() && !(bytes[at] == b'*' && bytes[at + 1] == b'/') {
                at += 1;
            }
            at = (at + 2).min(bytes.len());
            segment = at;
        } else {
            at += 1;
        }
    }
    kept.push(&text[segment..]);
    kept.concat()
}

#[cfg(test)]
mod tests {
    use super::strip;

    #[test]
    fn strips_line_and_block_comments_outside_strings() {
        assert_eq!(strip("a // line\nb"), "a \nb");
        assert_eq!(strip("a /* block */ b"), "a  b");
        // A URL inside a string survives.
        assert_eq!(strip(r#""see https://example.com""#), r#""see https://example.com""#);
        assert_eq!(strip("/* unterminated"), "");
        assert_eq!(strip("// only"), "");
    }
}

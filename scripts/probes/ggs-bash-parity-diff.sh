#!/bin/bash
# Byte-diff a batch of parity commands between the real Git Bash tools and
# ggs-bash's own applets. Fixture files are created once, in a scratch dir.
set -u
# The repo root derived from this script's own location (scripts/probes/ → two up),
# so the probe runs from any checkout — the built sidecar it drives is
# target/studio/cargo/debug/ggs-bash (a plain `cargo test` build of the bin).
REPO=$(cd "$(dirname "$0")/../.." && pwd) || exit 1
GGS="$REPO/target/studio/cargo/debug/ggs-bash"
WORK=/tmp/parity-diff
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK" || exit 1

printf 'one\ntwo three\nfour\n' > a.txt
printf '1 one\n2 two\n4 four\n' > j1.txt
printf '1 first\n2 second\n3 third\n' > j2.txt
printf 'a b\nc d\n' > c1.txt
printf 'a x\nc y\nd z\n' > c2.txt
printf 'hello' > h.txt
printf 'ABCD' > b.bin
printf 'ABCD1234' > x.bin
printf 'ab        cd\n' > u.txt

pass=0; fail=0
check() {
  local name="$1"; shift
  local real ggs
  real=$(bash -c "$*" 2>&1)
  ggs=$("$GGS" -c "$*" 2>&1)
  if [ "$real" = "$ggs" ]; then
    pass=$((pass+1))
  else
    fail=$((fail+1))
    echo "DIFF: $name"
    echo "  git-bash: $(printf '%s' "$real" | head -3 | sed 's/^/    /')"
    echo "  ggs-bash: $(printf '%s' "$ggs" | head -3 | sed 's/^/    /')"
  fi
}

check "nl default"        "nl a.txt"
check "nl -ba"            "nl -ba a.txt"
check "nl -w3 -s sep"     "nl -w3 -s' :: ' a.txt"
check "tac"               "tac a.txt"
check "paste cols"        "paste c1.txt c2.txt"
check "paste -sd,"        "paste -sd, a.txt"
check "paste -d list"     "paste -d'|\\n' c1.txt c2.txt"
check "join default"      "join j1.txt j2.txt"
check "join -a1"          "join -a1 j1.txt j2.txt"
check "join -v 2"         "join -v 2 j1.txt j2.txt"
check "comm"              "comm c1.txt c2.txt"
check "comm -12 same"     "comm -12 a.txt a.txt"
check "fold -w7"          "printf 'aaa bbb ccc ddd\\n' | fold -w 7"
check "fold -w7 -s"       "printf 'aaa bbb ccc\\n' | fold -w7 -s"
check "expand -t 4,8"     "printf 'a\\tb\\tc\\n' | expand -t 4,8"
check "unexpand -a -t4,8" "unexpand -a -t 4,8 u.txt"
check "unexpand -t4 lead" "printf 'a   b\\n' | unexpand -t 4"
check "tsort"             "printf 'a b b c\\n' | tsort"
check "expr arith"        "expr 1 + 2 \\* 3"
check "expr match"        "expr abc : 'a\\(b\\)c'"
check "expr length"       "expr length hello"
check "expr index"        "expr index abcdef c"
check "expr substr"       "expr substr hello 2 3"
check "factor"            "factor 84"
check "numfmt iec"        "numfmt --to=iec 1536"
check "numfmt iec-i"      "numfmt --to=iec-i 1536"
check "numfmt si"         "numfmt --to=si 1536"
check "numfmt from iec"   "numfmt --from=iec 1.5K"
check "numfmt 1024"       "echo 1024 | numfmt --to=iec"
check "cksum"             "cksum h.txt"
check "sum bsd"           "sum h.txt"
check "sum sysv"          "sum -s h.txt"
check "sha224"            "sha224sum h.txt | cut -c1-20"
check "sha384"            "sha384sum h.txt | cut -c1-20"
check "sha512"            "sha512sum h.txt | cut -c1-20"
check "b2sum"             "b2sum h.txt | cut -c1-20"
check "od default"        "od b.bin"
check "od -c"             "od -c b.bin"
check "od -Ad -tx1"       "od -A d -t x1 b.bin"
check "od -tc newline"    "printf 'x\\ny\\n' | od -c | head -1"
check "od dedup"          "yes | head -40 | od -An | head -3"
check "xxd"               "xxd x.bin"
check "xxd -g1"           "xxd -g1 x.bin | head -1"
check "xxd -p"            "xxd -p x.bin"
check "base32"            "printf 'hi' | base32"
check "base32 -d"         "printf 'NBUQ====' | base32 -d"
check "column -t"         "printf 'a bb\\nccc d\\n' | column -t"
check "cmp differ"        "printf 'abc' > p1; printf 'abd' > p2; cmp p1 p2"
check "cmp -l"            "cmp -l p1 p2"
check "egrep"             "printf 'a1b\\n' | egrep 'a[0-9]b'"
check "fgrep"             "printf 'a.b\\n' | fgrep 'a.b'"
check "dir"               "dir a.txt"
check "split ladder"      "seq 1 5 > nums; split -l2 nums part_; cat part_aa part_ab part_ac"
check "split -d"          "split -l2 -d nums dp_; cat dp_aa dp_ab dp_ac 2>/dev/null || ls dp_*"
check "printf \\xHH"      "printf 'caf\\xc3\\xa9'"
check "printf \\101"      "printf '\\101'"
check "dircolors"         "dircolors -b | head -c 40"
check "shuf -e -n1"       "shuf -e a -n 1"
check "yes|head"          "yes hello | head -2"
check "iconv u16le"       "printf 'caf\\xc3\\xa9' | iconv -f utf-8 -t utf-16le | od -An -t x1"
check "iconv u16 bom"     "printf '\\xff\\xfeh\\x00i\\x00' | iconv -f utf-16 -t utf-8"
check "dos2unix"          "printf 'a\\r\\nb\\n' > cr.txt; dos2unix cr.txt 2>/dev/null; cat cr.txt"
check "unix2dos"          "printf 'a\\nb\\n' > lf.txt; unix2dos lf.txt 2>/dev/null; od -c lf.txt | head -1"
check "unix2mac"          "printf 'a\\r\\nb\\n' > mm.txt; unix2mac mm.txt 2>/dev/null; od -c mm.txt | head -1"
check "stat -c"           "stat -c '%s|%F|%a|%n' h.txt"
check "stat -c %A"        "stat -c '%A|%h' h.txt"
check "file text"         "file b.bin"
check "file script"       "printf '#!/bin/sh\\necho hi\\n' > s.sh; file s.sh"
check "truncate round"    "printf '12345678' > t.bin; truncate -s 4 t.bin; truncate -s +4 t.bin; wc -c < t.bin"
check "zcat round"        "gzip -c h.txt | zcat"
check "gzip -d -c"        "gzip -c h.txt | gzip -d -c"
check "nice passthru"     "nice echo nice-ok"
check "nohup"             "nohup echo nohup-ok"
check "printenv"          "printenv PATH | head -c 10"
check "two psubs"         "cat <(echo 1,x) <(echo 1,y)"
check "join two psubs"    "join -t, <(echo 1,x) <(echo 1,y)"
check "expr colon"        "expr 5 : '.'"

echo "=== pass=$pass fail=$fail"

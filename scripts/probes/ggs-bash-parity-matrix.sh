#!/bin/bash
# The exhaustive parity matrix: every ggs-bash applet (and the builtin-shaped
# commands Git Bash also ships in /usr/bin) run through BOTH a real Git Bash and
# the built ggs-bash, byte-comparing stdout, stderr and the exit code after a
# normalization pass (timings, temp names, timestamps). Machine-state commands
# (df/ps/free/mount/…) compare structure only. Interactive/OS-opening commands
# (start, editors, ssh) are skipped by design.
set -u
# The repo root derived from this script's own location (scripts/probes/ → two up),
# so the probe runs from any checkout — the built sidecar it drives is
# target/studio/cargo/debug/ggs-bash (a plain `cargo test` build of the bin).
REPO=$(cd "$(dirname "$0")/../.." && pwd) || exit 1
GGS="$REPO/target/studio/cargo/debug/ggs-bash"
ROOT=/tmp/parity-matrix
rm -rf "$ROOT" && mkdir -p "$ROOT/shared" "$ROOT/work" && cd "$ROOT/shared" || exit 1

# ---- The shared read-only fixtures (one copy, identical timestamps both sides) ----
printf 'one\ntwo three\nfour\n' > a.txt
printf '1 one\n2 two\n4 four\n' > j1.txt
printf '1 first\n2 second\n3 third\n' > j2.txt
printf 'a b\nc d\n' > c1.txt
printf 'a x\nc y\nd z\n' > c2.txt
printf 'b\na\na\nc\nb\n' > u.txt
printf 'hello' > h.txt
printf 'ABCD' > b.bin
printf 'ABCD1234' > x.bin
printf 'ab        cd\n' > un.txt
printf 'x1\nx2\nx3\nx4\nx5\n' > nums.txt
mkdir -p sub/deep && printf 'inner\n' > sub/deep/i.txt && printf 'root\n' > sub/r.txt
printf 'aB\ncD\n' > mixed.txt
printf '' > empty.txt
printf 'caf\xc3\xa9 \xe4\xb8\xad\n' > utf8.txt
printf 'a\r\nb\n' > crlf.txt
# A deterministic zip for unzip (PowerShell Compress-Archive) — best effort.
powershell.exe -NoProfile -Command "Compress-Archive -Path a.txt,j1.txt -DestinationPath pack.zip -Force" >/dev/null 2>&1 || true
# Fixed timestamps for everything (both shells see identical mtimes).
find . -exec touch -d "@1234567890" {} + 2>/dev/null || true

pass=0; fail=0; skipped=0
declare -a FAILNAMES

norm() {
  # Both sides pass through the same filter: timings, temp names, epochs,
  # timestamps in ls/stat/dd/gzip chatter, psub paths, pids.
  sed -E \
    -e 's/[0-9]+(\.[0-9]+)? s, [0-9.]+ [kMG]B\/s/TIME RATE/' \
    -e 's/[0-9]+ bytes copied, [0-9.]+ s, [0-9.]+ [kMG]B\/s/N bytes copied, TIME/' \
    -e 's/ggs-psub-[0-9]+-[0-9]+/PSUB/g' \
    -e 's/tmp\.[a-z0-9]{6,}/TMPNAME/g' \
    -e 's/run\.[a-z0-9]{6,}/RUNNAME/g' \
    -e 's/\b1[0-9]{9}\b/EPOCH/g' \
    -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)? \+[0-9]{4}/STAMPT/g' \
    -e 's/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +[0-9]{1,2} [0-9]{2}:[0-9]{2}/DATE/g' \
    -e 's/0x[0-9a-f]+/HEX/g' \
    -e 's/[0-9]+\.[0-9]{3}/SECS/g'
}

# run_ro NAME CMD        — both shells read the shared fixtures.
# run_rw NAME CMD        — fresh fixture copy per side; CMD may mutate.
run_ro() {
  local name="$1" cmd="$2"
  local ro re rs go ge gs
  ro=$(cd "$ROOT/shared" && bash -c "$cmd" 2>/tmp/pm.ro.err); rs=$?
  re=$(norm </tmp/pm.ro.err)
  ro=$(printf '%s' "$ro" | norm)
  go=$(cd "$ROOT/shared" && "$GGS" -c "$cmd" 2>/tmp/pm.go.err); gs=$?
  ge=$(norm </tmp/pm.go.err)
  go=$(printf '%s' "$go" | norm)
  if [ "$ro" = "$go" ] && [ "$re" = "$ge" ] && [ "$rs" = "$gs" ]; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); FAILNAMES+=("$name")
    echo "DIFF: $name  (rc git=$rs ggs=$gs)"
    [ "$ro" != "$go" ] && { echo "  out.git: $(printf '%s' "$ro" | head -4 | tr '\n' '|')"; echo "  out.ggs: $(printf '%s' "$go" | head -4 | tr '\n' '|')"; }
    [ "$re" != "$ge" ] && { echo "  err.git: $(printf '%s' "$re" | head -3 | tr '\n' '|')"; echo "  err.ggs: $(printf '%s' "$ge" | head -3 | tr '\n' '|')"; }
  fi
}

run_rw() {
  local name="$1" cmd="$2"
  local ro re rs go ge gs
  rm -rf "$ROOT/work/a" "$ROOT/work/b"
  cp -r "$ROOT/shared" "$ROOT/work/a"; cp -r "$ROOT/shared" "$ROOT/work/b"
  ro=$(cd "$ROOT/work/a" && bash -c "$cmd" 2>/tmp/pm.ro.err); rs=$?
  re=$(norm </tmp/pm.ro.err); ro=$(printf '%s' "$ro" | norm)
  go=$(cd "$ROOT/work/b" && "$GGS" -c "$cmd" 2>/tmp/pm.go.err); gs=$?
  ge=$(norm </tmp/pm.go.err); go=$(printf '%s' "$go" | norm)
  # Compare the after-state too (both sides normalized: mtimes).
  local ra ga
  ra=$(cd "$ROOT/work/a" && find . -type f | grep -Ev '\.(gz|tar|tgz)$|\.err$' | sort | while read -r f; do printf '%s ' "$f" | sed -E 's/(pre|tmp|run)\.[A-Za-z0-9]+/\1.RND/'; norm <"$f" | md5sum | cut -c1-8; done | norm)
  ga=$(cd "$ROOT/work/b" && find . -type f | grep -Ev '\.(gz|tar|tgz)$|\.err$' | sort | while read -r f; do printf '%s ' "$f" | sed -E 's/(pre|tmp|run)\.[A-Za-z0-9]+/\1.RND/'; norm <"$f" | md5sum | cut -c1-8; done | norm)
  if [ "$ro" = "$go" ] && [ "$re" = "$ge" ] && [ "$rs" = "$gs" ] && [ "$ra" = "$ga" ]; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); FAILNAMES+=("$name")
    echo "DIFF: $name  (rc git=$rs ggs=$gs)"
    [ "$ro" != "$go" ] && { echo "  out.git: $(printf '%s' "$ro" | head -4 | tr '\n' '|')"; echo "  out.ggs: $(printf '%s' "$go" | head -4 | tr '\n' '|')"; }
    [ "$re" != "$ge" ] && { echo "  err.git: $(printf '%s' "$re" | head -3 | tr '\n' '|')"; echo "  err.ggs: $(printf '%s' "$ge" | head -3 | tr '\n' '|')"; }
    [ "$ra" != "$ga" ] && { echo "  fs.git:  $(printf '%s' "$ra" | head -3 | tr '\n' '|')"; echo "  fs.ggs:  $(printf '%s' "$ga" | head -3 | tr '\n' '|')"; }
  fi
}

# shape NAME GITCMD GGSCMD — for machine-state commands: compare a derived shape.
shape() {
  local name="$1" gitcmd="$2" ggscmd="$3"
  local r g
  r=$(cd "$ROOT/shared" && bash -c "$gitcmd" 2>&1 | norm)
  g=$(cd "$ROOT/shared" && "$GGS" -c "$ggscmd" 2>&1 | norm)
  if [ "$r" = "$g" ]; then pass=$((pass+1)); else
    fail=$((fail+1)); FAILNAMES+=("$name")
    echo "DIFF(shape): $name"
    echo "  git: $(printf '%s' "$r" | head -3 | tr '\n' '|')"
    echo "  ggs: $(printf '%s' "$g" | head -3 | tr '\n' '|')"
  fi
}

## ================= coreutils: text =================
run_ro "cat plain"          "cat a.txt"
run_ro "cat multi"          "cat a.txt j1.txt"
run_ro "cat missing"        "cat nope.txt"
run_ro "cat dash stdin"     "printf 'z\n' | cat -"
run_ro "nl default"         "nl a.txt"
run_ro "nl -ba"             "nl -ba a.txt"
run_ro "nl -ba empty"       "nl -ba empty.txt"
run_ro "nl -v5"             "nl -v5 a.txt"
run_ro "nl -w2 -nrz -s,"    "nl -w2 -nrz -s, a.txt"
run_ro "tac"                "tac a.txt"
run_ro "tac empty"          "tac empty.txt"
run_ro "tac -s,"            "tac -s, j1.txt"
run_ro "head default"       "head nums.txt"
run_ro "head -n2"           "head -n2 nums.txt"
run_ro "head -n +2"         "head -n +2 nums.txt"
run_ro "head -c4"           "head -c4 a.txt"
run_ro "head multi"         "head -n1 a.txt j1.txt"
run_ro "tail -n2"           "tail -n2 nums.txt"
run_ro "tail -n +2"         "tail -n +2 nums.txt"
run_ro "tail -c5"           "tail -c5 a.txt"
run_ro "tail missing"       "tail nope.txt"
run_ro "wc default"         "wc a.txt"
run_ro "wc -l -w"           "wc -l -w a.txt"
run_ro "wc stdin"           "wc -l < a.txt"
run_ro "wc multi"           "wc a.txt j1.txt"
run_ro "wc empty"           "wc empty.txt"
run_ro "fold -w4"           "fold -w4 a.txt"
run_ro "fold -w4 -s"        "fold -w4 -s a.txt"
run_ro "fmt-like fold"      "printf 'aaa bbb ccc ddd\n' | fold -w 7 -s"
run_ro "expand -t4"         "printf 'a\tb\n' | expand -t 4"
run_ro "expand -t4,8"       "printf 'a\tb\tc\n' | expand -t 4,8"
run_ro "unexpand -t4,8"     "unexpand -t 4,8 un.txt"
run_ro "unexpand -a"        "printf 'a   b  c\n' | unexpand -a -t 3"
run_ro "column -t"          "printf 'a bb\nccc d\n' | column -t"
run_ro "column -s,"         "printf 'a,b|c\n' | column -t -s,"
run_ro "sort plain"         "sort u.txt"
run_ro "sort -r"            "sort -r u.txt"
run_ro "sort -u"            "sort -u u.txt"
run_ro "sort -n"            "printf '10\n2\n1\n' | sort -n"
run_ro "sort -k2"           "printf 'a 2\nb 1\n' | sort -k2"
run_ro "sort -k2,2 -n"      "printf 'a 10\nb 2\n' | sort -k2,2n"
run_ro "sort -t,"           "printf 'x,2\ny,1\n' | sort -t, -k2 -n"
run_ro "sort -f"            "printf 'b\nA\nc\n' | sort -f"
run_ro "sort -o out"        "sort -o s.o u.txt; md5sum < s.o"
run_ro "uniq -c"            "printf 'a\na\nb\n' | uniq -c"
run_ro "uniq -d"            "printf 'a\na\nb\n' | uniq -d"
run_ro "uniq -u"            "printf 'a\na\nb\n' | uniq -u"
run_ro "uniq -f1"           "printf 'x a\ny a\n' | uniq -f1"
run_ro "cut -c2"            "cut -c2 a.txt"
run_ro "cut -c2-3"          "cut -c2-3 a.txt"
run_ro "cut -d' ' -f2"      "cut -d' ' -f2 a.txt"
run_ro "cut -f2-"           "cut -d' ' -f2- a.txt"
run_ro "cut -s -f1"         "cut -s -d' ' -f1 j1.txt"
run_ro "tr set map"         "printf 'aBcD\n' | tr 'a-z' 'A-Z'"
run_ro "tr -d digits"       "printf 'a1b2\n' | tr -d 0-9"
run_ro "tr -s space"        "printf 'a   b\n' | tr -s ' '"
run_ro "tr -s multi"        "printf 'aaabbb\n' | tr -s ab"
run_ro "tr -d multi"        "printf 'aXbYc\n' | tr -d XY"
run_ro "tr squeeze translate" "printf 'a  b c\n' | tr -s ' ' ','"
run_ro "paste cols"         "paste c1.txt c2.txt"
run_ro "paste -d list"      "paste -d'|\\n' c1.txt c2.txt"
run_ro "paste -sd,"         "paste -sd, a.txt"
run_ro "paste stdin file"   "printf 'p\nq\n' | paste - nums.txt"
run_ro "join default"       "join j1.txt j2.txt"
run_ro "join -a1"           "join -a1 j1.txt j2.txt"
run_ro "join -a2"           "join -a2 j1.txt j2.txt"
run_ro "join -v1"           "join -v1 j1.txt j2.txt"
run_ro "join -t,"           "join -t, <(echo 1,x) <(echo 1,y)"
run_ro "join -1 2"          "join -1 2 -2 1 <(echo 'one 9') j2.txt"
run_ro "join -o spec"       "join -o '1.1,2.2,1.2' j1.txt j2.txt"
run_ro "join -e X -o"       "join -a1 -e X -o '0,1.2,2.2' j1.txt j2.txt"
run_ro "comm"               "comm c1.txt c2.txt"
run_ro "comm -12 same"      "comm -12 a.txt a.txt"
run_ro "comm -13"           "comm -13 c1.txt c2.txt"
run_ro "comm unsorted rc"   "comm u.txt u.txt; echo rc=\$?"
run_ro "tsort"              "printf 'a b b c\n' | tsort"
run_ro "tsort cycle"        "printf 'a b b a\n' | tsort; echo rc=\$?"
run_ro "expr arith"         "expr 1 + 2 \* 3"
run_ro "expr div"           "expr 10 / 3"
run_ro "expr cmp"           "expr 2 '<' 3"
run_ro "expr str"           "expr abc : 'a.c'; expr length hello; expr substr hello 2 3; expr index ch hello"
run_ro "expr empty"         "expr '' : '.*'"
run_ro "expr divzero"       "expr 1 / 0; echo rc=\$?"
run_ro "factor"             "factor 84; factor 97; factor 1"
run_ro "numfmt to iec"      "numfmt --to=iec 1536; numfmt --to=iec-i 1536; numfmt --to=si 1536"
run_ro "numfmt from iec"    "numfmt --from=iec 1.5K; numfmt --from=si 1.5k"
run_ro "numfmt round"       "echo 1024 | numfmt --to=iec; echo 1048576 | numfmt --to=iec"
run_ro "shuf -n"            "shuf -e a b c -n 3 | sort"
run_ro "shuf -i"            "shuf -i 1-1 -n 2"
run_ro "yes head"           "yes hello | head -2"
run_ro "echo forms"         "echo -n a; echo; echo -e 'b\\tc'; echo -- x"
run_ro "printf pct"         "printf '%5.2f|%x|%s\\n' 3.14159 255 hi"
run_ro "printf pctd"        "printf '%04d|%+d|%c\\n' 42 7 A"
run_ro "printf b"           "printf '%b\\n' 'a\\tb'"
run_ro "printf repeat"      "printf '%s\\n' a b c"
run_ro "printf hex"         "printf '\\x41\\102\\n'"

## ================= grep family =================
run_ro "grep plain"         "grep one a.txt"
run_ro "grep -i"            "grep -i ONE a.txt"
run_ro "grep -v"            "grep -v one a.txt"
run_ro "grep -c"            "grep -c o a.txt"
run_ro "grep -n"            "grep -n e a.txt"
run_ro "grep -o"            "grep -o 'o' a.txt"
run_ro "grep -l multi"      "grep -l four a.txt j1.txt"
run_ro "grep -w"            "grep -w one a.txt"
run_ro "grep -q rc"         "grep -q one a.txt; echo \$?; grep -q zz a.txt; echo \$?"
run_ro "grep -E"            "printf 'abc\nxyz\n' | grep -E 'a|z'"
run_ro "grep -F"            "printf 'a.b\n' | grep -F 'a.b'"
run_ro "egrep"              "printf 'a1\n' | egrep 'a[0-9]'"
run_ro "fgrep"              "printf 'a.b\n' | fgrep 'a.b'"
run_ro "grep -A"            "printf 'a\nb\nc\n' | grep -A1 a"
run_ro "grep -B"            "printf 'a\nb\nc\n' | grep -B1 c"
run_ro "grep -C"            "printf 'a\nb\nc\nd\n' | grep -C1 b"
run_ro "grep missing rc"    "grep x nope.txt; echo rc=\$?"
run_ro "grep -r"            "grep -r inner sub | sort"
run_ro "grep --include"     "grep -r --include='*.txt' inner sub | sort"

## ================= sed / awk =================
run_ro "sed s"              "printf 'aaa\n' | sed 's/a/X/'"
run_ro "sed sg"             "printf 'aaa\n' | sed 's/a/X/g'"
run_ro "sed addr line"      "sed '2d' nums.txt"
run_ro "sed addr re"        "sed '/x2/d' nums.txt"
run_ro "sed range"          "sed '2,3d' nums.txt"
run_ro "sed -n p"           "sed -n '2p' nums.txt"
run_ro "sed y"              "printf 'abc\n' | sed 'y/abc/ABC/'"
run_ro "sed multi -e"       "sed -e 's/x/Y/' -e 's/3/Z/' nums.txt"
run_ro "sed amp"            "printf 'ab\n' | sed 's/b/[&]/'"
run_ro "sed paren"          "printf 'ab\n' | sed 's/\(a\)\(b\)/\2\1/'"
run_ro "sed dollar"         "sed 's/\$//' a.txt; sed -n '\$p' nums.txt"
run_rw "sed -i"             "sed -i 's/one/1/' a.txt; cat a.txt"
run_ro "awk fields"         "awk '{print \$2}' a.txt"
run_ro "awk NF NR"          "awk '{print NR, NF}' a.txt"
run_ro "awk -F"             "awk -F, '{print \$1}' j1.txt"
run_ro "awk BEGIN END"      "awk 'BEGIN{print \"s\"} {s+=1} END{print s}' a.txt"
run_ro "awk array"          "awk '{c[\$1]++} END{for (k in c) print k, c[k]}' u.txt | sort"
run_ro "awk printf"         "awk '{printf \"%-4s|%03d\\n\", \$1, NR}' nums.txt"
run_ro "awk substr index"   "awk 'BEGIN{print substr(\"hello\",2,3), index(\"hello\",\"l\")}'"
run_ro "awk split sub"      "awk 'BEGIN{split(\"a b c\",p); sub(/a/,\"X\",p[1]); print p[1], p[2]}'"
run_ro "awk gsub length"    "awk '{gsub(/x/,\"Y\"); print length(\$0)}' nums.txt"
run_ro "awk -v OFS"         "awk -v OFS=: '{\$1=\$1; print}' c1.txt"
run_ro "awk cond exit"      "awk '{if (\$1==\"x3\") exit 5} END{}' nums.txt; echo rc=\$?"
run_ro "awk sprintf match"  "awk 'BEGIN{print sprintf(\"%d-%s\", 7, \"q\")}'"

## ================= find =================
run_ro "find name"          "find sub -name '*.txt' | sort"
run_ro "find type d"        "find sub -type d | sort"
run_ro "find type f"        "find sub -type f | sort"
run_ro "find exec"          "find sub -name r.txt -exec echo {} \\;"
run_ro "find exec +"        "find sub -name '*.txt' -exec echo {} + | sort"
run_ro "find or parens"     "find sub \\( -name i.txt -o -name r.txt \\) | sort"
run_ro "find not"           "find sub -type f ! -name '*.txt' | sort"
run_ro "find path"          "find sub -path '*deep*' | sort"
run_ro "find missing"       "find nope; echo rc=\$?"
run_rw "find -delete"       "find sub -name r.txt -delete; find sub -type f | sort"
run_ro "find mtime"         "find . -mtime +1000 | sort"

## ================= xargs / tee / diff / cmp =================
run_ro "xargs default"      "printf 'a b\\nc\\n' | xargs echo"
run_ro "xargs -n1"          "printf 'a b\\n' | xargs -n1 echo"
run_ro "xargs -I"           "printf 'a.txt\\n' | xargs -I{} cat {}"
run_ro "xargs -0"           "printf 'a\\0b\\n' | xargs -0 echo"
run_ro "xargs -r"           "printf '' | xargs -r echo ran"
run_ro "tee stdout"         "printf 't\\n' | tee t.o; cat t.o"
run_ro "tee -a"             "printf 't\\n' | tee t.o >/dev/null; printf 'u\\n' | tee -a t.o >/dev/null; cat t.o"
run_ro "diff same"          "diff a.txt a.txt; echo rc=\$?"
run_ro "diff differ"        "diff c1.txt c2.txt; echo rc=\$?"
run_ro "diff -u"            "diff -u c1.txt c2.txt"
run_ro "diff -q"            "diff -q c1.txt c2.txt"
run_ro "diff missing"       "diff a.txt nope; echo rc=\$?"
run_ro "cmp same"           "cmp a.txt a.txt; echo rc=\$?"
run_ro "cmp differ"         "cmp b.bin x.bin; echo rc=\$?"
run_ro "cmp -l"             "cmp -l b.bin x.bin"
run_ro "cmp -s"             "cmp -s b.bin x.bin; echo rc=\$?"

## ================= digests / encodings =================
run_ro "md5sum"             "md5sum a.txt h.txt"
run_ro "sha1sum"            "sha1sum h.txt"
run_ro "sha224sum"          "sha224sum h.txt"
run_ro "sha256sum"          "sha256sum h.txt"
run_ro "sha384sum"          "sha384sum h.txt"
run_ro "sha512sum"          "sha512sum h.txt"
run_ro "b2sum"              "b2sum h.txt"
run_ro "sums stdin"         "printf 'hello' | md5sum; printf 'hello' | b2sum"
run_ro "cksum"              "cksum a.txt h.txt empty.txt"
run_ro "sum bsd"            "sum a.txt h.txt"
run_ro "sum sysv"           "sum -s a.txt h.txt"
run_ro "sha -c ok"          "md5sum h.txt > m.l; md5sum -c m.l"
run_ro "sha -c bad"         "printf '00000000000000000000000000000000  h.txt\\n' > m.l; md5sum -c m.l; echo rc=\$?"
run_ro "sha -c star"        "printf 'aaf4c61ddcc5e8a2dabede0f3b482cd9 *h.txt\\n' > m.l; md5sum -c m.l"
run_ro "base64"             "base64 h.txt"
run_ro "base64 -d"          "printf 'aGVsbG8=' | base64 -d"
run_ro "base64 -w0"         "printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | base64 -w0"
run_ro "base32"             "printf 'hi' | base32"
run_ro "base32 -d"          "printf 'NBUQ====' | base32 -d"
run_ro "od default"         "od b.bin"
run_ro "od -c"              "od -c a.txt | head -2"
run_ro "od -t x1"           "od -A d -t x1 b.bin"
run_ro "od -t d2"           "od -t d2 b.bin"
run_ro "od -t u1"           "od -An -t u1 b.bin"
run_ro "od empty"           "od empty.txt"
run_ro "od dedup"           "yes | head -40 | od | head -3"
run_ro "od -N"              "od -N 2 b.bin"
run_ro "xxd"                "xxd x.bin"
run_ro "xxd -g1"            "xxd -g1 x.bin"
run_ro "xxd -g4"            "xxd -g4 x.bin | head -1"
run_ro "xxd -l"             "xxd -l 4 x.bin"
run_ro "xxd -p"             "xxd -p x.bin"
run_ro "xxd -r -p"          "printf '6869\\n' | xxd -r -p"
run_ro "xxd -c8"            "xxd -c 8 x.bin"

## ================= path tools =================
run_ro "basename"           "basename /a/b/c.txt; basename c.txt .txt; basename /a/b/"
run_ro "dirname"            "dirname /a/b/c.txt; dirname c.txt; dirname /a/b/"
run_ro "realpath"           "realpath sub/../a.txt"
run_ro "readlink -f"        "readlink -f a.txt"
run_ro "cygpath -u"         "cygpath -u 'C:\\\\Windows'"
run_ro "cygpath -w"         "cygpath -w /c/Windows"
run_ro "cygpath -m"         "cygpath -m /c/Windows"
shape "which cat rc" "which cat >/dev/null 2>&1; echo rc=$?" "which cat >/dev/null 2>&1; echo rc=$?"
shape "which missing rc" "which definitely-not-here-xyz >/dev/null 2>&1; echo rc=$?" "which definitely-not-here-xyz >/dev/null 2>&1; echo rc=$?"

## ================= file ops =================
run_rw "cp file"            "cp a.txt a.cp; cat a.cp"
run_rw "cp -r dir"          "cp -r sub sub2; find sub2 -type f | sort"
run_rw "cp multi dir"       "mkdir d; cp a.txt j1.txt d; ls d | sort"
run_rw "cp missing"         "cp nope x; echo rc=\$?"
run_rw "mv rename"          "mv a.txt b.mv; cat b.mv; test ! -e a.txt && echo moved"
run_rw "mv into dir"        "mkdir d; mv a.txt d; ls d | sort"
run_rw "rm file"            "rm a.txt; test ! -e a.txt && echo gone"
run_rw "rm -r"              "rm -r sub; test ! -e sub && echo gone"
run_rw "rm missing"         "rm nope; echo rc=\$?"
run_rw "rm -f missing"      "rm -f nope; echo rc=\$?"
run_rw "mkdir -p"           "mkdir -p x/y/z && echo ok"
run_rw "mkdir exists"       "mkdir sub; echo rc=\$?"
run_rw "rmdir"              "rmdir sub/deep && echo ok"
run_rw "rmdir nonempty"     "rmdir sub; echo rc=\$?"
run_rw "touch new"          "touch n.txt && echo ok"
run_rw "touch -c"           "touch -c noref && echo ok"
run_rw "ln -s"              "ln -s a.txt l.l; cat l.l"
run_rw "link hard"          "link a.txt h.l && echo ok"
run_rw "unlink"             "unlink a.txt; test ! -e a.txt && echo gone"
run_rw "chmod +x"           "chmod +x a.txt && echo ok"
run_rw "chmod 600"          "chmod 600 a.txt && echo ok"
run_ro "chmod missing"      "chmod +x nope; echo rc=\$?"
run_ro "chown refuse"       "chown user a.txt; echo rc=\$?"
run_ro "chgrp refuse"       "chown :grp a.txt; echo rc=\$?"
run_rw "truncate set"       "truncate -s 2 a.txt; wc -c < a.txt"
run_rw "truncate grow"      "truncate -s +2 a.txt; wc -c < a.txt"
run_rw "truncate rel"       "printf '12345678' > t8; truncate -s 50% t8 2>&1 | head -1; wc -c < t8"
run_rw "mktemp default"     "f=\$(mktemp); test -f \"\$f\" && echo file"
run_rw "mktemp -d"          "d=\$(mktemp -d); test -d \"\$d\" && echo dir"
run_rw "mktemp tmpl"        "f=\$(mktemp pre.XXXX); case \"\$f\" in *pre.*) echo shaped;; esac"
run_ro "mktemp few X"       "mktemp xx; echo rc=\$?"
run_rw "shred -u"           "printf 'secret' > s.z; shred -u s.z; test ! -e s.z && echo gone"
run_rw "install copy"       "install a.txt i.o && cat i.o"
run_rw "install -d"         "install -d q/w && echo ok"
run_rw "install -t"         "mkdir d; install -t d a.txt j1.txt; ls d | sort"
run_rw "dd bs count"        "dd bs=2 count=3 < a.txt 2>dd.e; echo rc=\$?; head -2 dd.e"
run_rw "dd if of"           "dd if=a.txt of=dd.o bs=1 count=4 status=none; cat dd.o; echo"
run_rw "dd skip"            "dd if=a.txt bs=1 skip=2 count=3 status=none; echo"
run_rw "dd seek"            "printf 'abcdef' > d6; dd if=x.bin of=d6 bs=1 seek=2 count=2 conv=notrunc status=none; cat d6; echo"
run_rw "split -l"           "split -l 2 nums.txt p_; cat p_aa p_ab p_ac | sort"
run_rw "split -b"           "split -b 3 -d a.txt q_; cat q_00 q_01 q_02; echo"
run_rw "split -suffix"      "split -l 1 -a 2 --additional-suffix=.x nums.txt r_; ls r_* | sort"

## ================= archives =================
run_rw "gzip round"         "gzip -k a.txt; gunzip -c a.txt.gz"
run_rw "gzip stdin"         "gzip -c a.txt | gunzip -c"
run_rw "gzip rm src"        "gzip a.txt; test ! -e a.txt && zcat a.txt.gz"
run_rw "zcat"               "gzip -k a.txt; zcat a.txt.gz"
run_rw "gunzip -t"          "gzip -k a.txt; gunzip -t a.txt.gz; echo rc=\$?"
run_rw "gzip -l"            "gzip -k a.txt; gzip -l a.txt.gz | awk '{print \$2, \$4}'"
run_ro "gunzip bad"         "printf 'zz' | gunzip 2>/dev/null; echo rc=\$?"
if [ -f pack.zip ]; then
  run_rw "unzip -l"         "unzip -l pack.zip | awk '{print \$1, \$4}' | sort"
  run_rw "unzip -o -d"      "mkdir uz; unzip -o pack.zip -d uz >/dev/null; cat uz/a.txt"
  run_ro "unzip missing"    "unzip -l nope.zip; echo rc=\$?"
else
  skipped=$((skipped+1))
fi
run_rw "tar create list"    "tar -cf t.tar sub; tar -tf t.tar | sort"
run_rw "tar extract"        "tar -cf t.tar -C sub .; mkdir tx; tar -xf t.tar -C tx; find tx -type f | sort"
run_rw "tar -z round"       "tar -czf t.tgz -C sub .; tar -tzf t.tgz | sort"
run_rw "tar missing"        "tar -tf nope.tar; echo rc=\$?"

## ================= converters =================
run_ro "iconv u16le"        "iconv -f utf-8 -t utf-16le utf8.txt | od -An -t x1 | tr -d ' '"
run_ro "iconv from u16"     "printf '\\xff\\xfeh\\x00i\\x00' | iconv -f utf-16 -t utf-8"
run_ro "iconv latin1"       "printf '\\xe9' | iconv -f latin1 -t utf-8 | od -An -c"
run_ro "iconv to ascii err" "printf 'caf\\xc3\\xa9' | iconv -t ascii; echo rc=\$?"
run_ro "iconv unknown"      "iconv -f utf-8 -t cp936 h.txt; echo rc=\$?"
run_ro "dos2unix"           "cat crlf.txt | dos2unix | od -c"
run_rw "dos2unix -n"        "dos2unix -n crlf.txt out.txt 2>/dev/null; od -c out.txt | head -1; echo rc0"
run_rw "unix2dos"           "printf 'a\\nb\\n' > l.txt; unix2dos l.txt >/dev/null 2>&1; od -c l.txt | head -1"
run_rw "unix2mac mac2unix"  "printf 'a\\r\\nb\\n' > m.txt; unix2mac m.txt >/dev/null 2>&1; od -c m.txt | head -1; mac2unix m.txt >/dev/null 2>&1; od -c m.txt | head -1"
run_ro "dircolors head"     "dircolors -b | head -c 30"

## ================= stat / file =================
run_ro "stat -c fmt"        "stat -c '%s|%F|%a|%n' a.txt sub j1.txt"
run_ro "stat -c A U"        "stat -c '%A|%h' a.txt"
run_ro "stat default"       "stat a.txt | grep -v Device | sed -E 's/[0-9]+/N/g' | head -6"
run_ro "stat missing"       "stat nope; echo rc=\$?"
run_ro "file text"          "file a.txt b.bin empty.txt utf8.txt"
run_ro "file script"        "printf '#!/bin/sh\\necho\\n' > s.sh; file s.sh"
run_ro "file python"        "printf '#!/usr/bin/env python3\\n' > p.py; file p.py"
run_ro "file pe"            "file /c/Windows/System32/notepad.exe | sed -E 's/[0-9]+//g'"
run_ro "file dir"           "file sub"
run_ro "file missing"       "file nope; echo rc=\$?"
run_ro "file -b"            "file -b a.txt"

## ================= seq / sleep / timeout =================
run_ro "seq 3"              "seq 3"
run_ro "seq range"          "seq 2 5; seq 1 2 7; seq 5 -1 3"
run_ro "seq -s"             "seq -s, 3"
run_ro "seq -w"             "seq -w 8 11"
run_ro "seq -f"             "seq -f 'a%g' 2"
run_ro "sleep 0"            "sleep 0; echo rc=\$?"
run_ro "timeout ok"         "timeout 2 echo t"
run_ro "timeout kill"       "timeout 1 sleep 5; echo rc=\$?"
run_ro "timeout missing"    "timeout 2 nope; echo rc=\$?"

## ================= shell-ish builtins with /usr/bin twins =================
run_ro "true false rc"      "true; echo \$?; false; echo \$?"
run_ro "test -f"            "test -f a.txt; echo \$?; test -d a.txt; echo \$?"
run_ro "test str"           "test abc = abc; echo \$?; test -z ''; echo \$?"
run_ro "test int"           "test 2 -lt 3; echo \$?; test 2 -gt 3; echo \$?"
run_ro "[ -e ]"             "[ -e a.txt ] && echo yes"
run_ro "pwd"                "pwd | sed 's|.*/||'"
run_ro "command -v cat"     "command -v cat >/dev/null && echo found"
run_ro "type cd"            "type cd | sed 's/.*/typed/'"

## ================= env / printenv =================
run_ro "env passthru"       "env X=1 printenv X"
run_ro "env -u"             "env -u PATH printenv PATH; echo rc=\$?"
run_ro "printenv miss"      "printenv GGS_NOPE; echo rc=\$?"
run_ro "printenv HOME shape" "printenv HOME >/dev/null && echo home"
run_ro "env rm cmd rc"      "env nope-cmd-xyz; echo rc=\$?"

## ================= OS surfaces (shape-only) =================
shape "df header"   "df | head -1 | awk '{print NF}'"                 "df | head -1 | awk '{print NF}'"
shape "ps header"   "ps | head -1 | awk '{print \$1, \$8, \$9}'"      "ps | head -1 | awk '{print \$1, \$8, \$9}'"
shape "ps has self" "ps | awk 'END{print NR>1}'"                      "ps | awk 'END{print NR>1}'"
shape "id shape"    "id | sed -E 's/[0-9]+/N/g'"                      "id | sed -E 's/[0-9]+/N/g'"
shape "id -u num"   "id -u | grep -c '^[0-9]*\$'"                     "id -u | grep -c '^[0-9]*\$'"
shape "uname -s"    "uname -s | cut -d_ -f1"                          "uname -s | cut -d_ -f1"
shape "uname -m"    "uname -m"                                         "uname -m"
shape "nproc num"   "nproc | grep -c '^[0-9]\+\$'"                    "nproc | grep -c '^[0-9]\+\$'"
shape "tty piped"   "printf '' | tty; echo rc=\$?"                    "printf '' | tty; echo rc=\$?"
shape "arch"        "arch"                                             "arch"
shape "logname lc"  "logname | tr 'A-Z' 'a-z'"                        "logname | tr 'A-Z' 'a-z'"
# groups: the error line rides stderr (a gid MSYS cannot name — machine-specific),
# so both streams fold through the digit normalizer.
shape "groups word" "groups 2>&1 | sed -E 's/[0-9]+/N/g'"           "groups 2>&1 | sed -E 's/[0-9]+/N/g'"
shape "whoami lc"   "whoami | tr 'A-Z' 'a-z'"                         "whoami | tr 'A-Z' 'a-z'"
shape "hostname lc" "hostname | tr 'A-Z' 'a-z'"                       "hostname | tr 'A-Z' 'a-z'"

## ================= date =================
run_ro "date -d epoch"      "date -d @1234567890 +%Y-%m-%d\\ %H:%M:%S\\ %z"
run_ro "date -r file"       "date -r a.txt +%Y-%m-%d"
run_ro "date fmt"           "date -d @100 +%A-%B-%j"
run_ro "date missing -d"    "date -d @1 +%s"

## ================= pagers / terminal =================
run_ro "less file"          "less a.txt"
run_ro "less stdin"         "printf 'p\\n' | less"
run_ro "tput cols num"      "tput cols | grep -c '^[0-9]\+\$'"
run_ro "tput setaf1"        "tput setaf 1 | od -An -c | tr -s ' '"
run_ro "tput sgr0"          "tput sgr0 | od -An -c | tr -s ' '"
run_ro "stty piped err"     "printf '' | stty size; echo rc=\$?"
run_ro "reset seq"          "reset | od -An -c | tr -s ' ' | head -1"

## ================= wrappers =================
run_ro "nice passthru"      "nice echo n"
run_ro "nice -n"            "nice -n 5 echo n5"
run_ro "nohup pipe"         "nohup echo nh 2>&1"
run_ro "stdbuf -oL"         "stdbuf -oL echo sb"
run_ro "nohup missing"      "nohup nope-cmd 2>&1 | sed 's/nope-cmd.*//'; echo rc=\$?"

## ================= dir listings =================
run_ro "ls plain"           "ls sub | sort"
run_ro "ls -a dot"          "ls -a | grep -c '^\\.\\.\$'"
run_ro "ls -1"              "ls -1 sub | sort"
run_ro "ls -d"              "ls -d sub"
run_ro "ls -F classify"     "ls -F sub | sort"
run_ro "ls missing"         "ls nope 2>&1 | sed 's/nope.*/nope/'; echo rc=\$?"
run_ro "ls -t shape"        "ls -t | head -1 >/dev/null && echo ok"
run_ro "dir cols"           "dir sub | sort"
run_ro "vdir long"          "vdir a.txt | awk '{print \$1, \$5}'"

## ================= misc gaps probe =================
run_ro "du -s"              "du -s sub"
run_ro "sync rc"            "sync; echo rc=\$?"

echo
echo "=== pass=$pass fail=$fail skipped=$skipped"
[ $fail -gt 0 ] && printf 'failed: %s\n' "${FAILNAMES[@]}"
exit 0

# shellcheck shell=bash
# Shared hook-payload reader for the bajzi hooks. SOURCE it, do not run it.
# Sourcing defines functions only: no output, no filesystem access, no variables.
#
# Used by routing-counter.sh (PostToolUse on Agent) and dispatch-guard.sh
# (PreToolUse on Agent), so both read the dispatch the same way. Change the
# parser here, never in a copy.
#
# json_fields <name>... reads a hook payload on stdin and prints one line per
# name, in the order given (an empty line when the field is absent):
#   cwd     the TOP-LEVEL cwd
#   <other> tool_input.<other>, a string directly under the top-level tool_input
#   _complete  "1" when the payload parsed as one whole JSON value (or the scan
#           stopped early after tool_input and cwd were both read), else "0":
#           a truncated or unterminated payload is 0
# It is a small JSON-aware awk scanner, not a regex over the payload: a key of
# the same name in tool_response, in a nested object, or inside a string value
# (a prompt that quotes JSON) is ignored, whatever the key order. The first
# occurrence wins.
#
# Values are flattened to ONE line: raw CR/LF/TAB and the escapes \n \r \t
# become a space, \uXXXX becomes "?", \b \f are dropped, any other \x becomes x.
# Each input character stays at most one output character, so a value's length
# in characters is preserved except for dropped \b \f. Callers still sanitize
# before logging.
#
# Malformed or truncated input prints whatever was found so far (ask for
# _complete to tell); the function never fails (awk errors are swallowed,
# status is always 0).
#
# DEPENDENCY-FREE: awk.

json_fields() {
    awk -v names="$*" '
function val(d, k, v) {
    gsub(/[\r\n\t]/, " ", v)
    if (d == 1 && k == "cwd" && !("cwd" in got)) { got["cwd"] = v }
    if (d == 2 && isobj[2] && parent[2] == "tool_input" && isobj[1] && k != "cwd" && (k in want) && !(k in got)) {
        got[k] = v
    }
}
BEGIN { nn = split(names, order, " "); for (x = 1; x <= nn; x++) want[order[x]] = 1 }
{ s = s $0 "\n" }
END {
    n = length(s); d = 0; i = 1
    while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\"") {
            j = i + 1; v = ""
            while (j <= n) {
                e = substr(s, j, 1)
                if (e == "\\") {
                    e2 = substr(s, j + 1, 1)
                    if (e2 == "n" || e2 == "r" || e2 == "t") v = v " "
                    else if (e2 == "u") { v = v "?"; j += 4 }
                    else if (e2 != "b" && e2 != "f") v = v e2
                    j += 2; continue
                }
                if (e == "\"") break
                v = v e; j++
            }
            if (j > n) unterminated = 1
            i = j + 1
            k = i
            while (k <= n && substr(s, k, 1) ~ /[ \t\r\n]/) k++
            if (d >= 1 && isobj[d] && substr(s, k, 1) == ":") { key[d] = v; i = k + 1; continue }
            val(d, key[d], v)
            continue
        }
        if (c == "{" || c == "[") {
            d++; opened = 1; isobj[d] = (c == "{"); parent[d] = key[d - 1]; key[d] = ""
        } else if (c == "}" || c == "]") {
            if (d == 2 && isobj[2] && parent[2] == "tool_input") ti_done = 1
            if (d > 0) d--
            if (ti_done && ("cwd" in got)) { early = 1; break }   # skip scanning a large tool_response
        }
        i++
    }
    got["_complete"] = (early || (opened && d == 0 && !unterminated)) ? "1" : "0"
    for (x = 1; x <= nn; x++) print got[order[x]]
}' 2>/dev/null
    return 0
}

#include "io_state_logic.h"

#include <ctype.h>
#include <stddef.h>

static bool ascii_iequals(const char *a, const char *b) {
    if (!a || !b) return false;
    while (*a && *b) {
        if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return false;
        a++;
        b++;
    }
    return *a == '\0' && *b == '\0';
}

bool hc_io_parse_bool_state(const char *state, bool fallback) {
    if (!state || state[0] == '\0') return fallback;
    if (ascii_iequals(state, "off") ||
        ascii_iequals(state, "inactive") ||
        ascii_iequals(state, "closed") ||
        ascii_iequals(state, "locked") ||
        ascii_iequals(state, "false") ||
        ascii_iequals(state, "0")) {
        return false;
    }
    if (ascii_iequals(state, "on") ||
        ascii_iequals(state, "active") ||
        ascii_iequals(state, "open") ||
        ascii_iequals(state, "unlocked") ||
        ascii_iequals(state, "true") ||
        ascii_iequals(state, "1")) {
        return true;
    }
    return fallback;
}

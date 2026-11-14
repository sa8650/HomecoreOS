#include <assert.h>
#include <stdio.h>
#include "../main/io_state_logic.h"

int main(void) {
    /* Explicit OFF/inactive/closed/locked states must return false even if fallback is true */
    assert(hc_io_parse_bool_state("off", true) == false);
    assert(hc_io_parse_bool_state("OFF", true) == false);
    assert(hc_io_parse_bool_state("inactive", true) == false);
    assert(hc_io_parse_bool_state("Inactive", true) == false);
    assert(hc_io_parse_bool_state("closed", true) == false);
    assert(hc_io_parse_bool_state("locked", true) == false);
    assert(hc_io_parse_bool_state("false", true) == false);
    assert(hc_io_parse_bool_state("0", true) == false);

    /* Explicit ON/active/open/unlocked states must return true even if fallback is false */
    assert(hc_io_parse_bool_state("on", false) == true);
    assert(hc_io_parse_bool_state("ON", false) == true);
    assert(hc_io_parse_bool_state("active", false) == true);
    assert(hc_io_parse_bool_state("Active", false) == true);
    assert(hc_io_parse_bool_state("open", false) == true);
    assert(hc_io_parse_bool_state("unlocked", false) == true);
    assert(hc_io_parse_bool_state("true", false) == true);
    assert(hc_io_parse_bool_state("1", false) == true);

    /* Unknown/null returns fallback */
    assert(hc_io_parse_bool_state(NULL, false) == false);
    assert(hc_io_parse_bool_state("", true) == true);
    assert(hc_io_parse_bool_state("idle", false) == false);

    printf("test_io_state_logic: all assertions passed.\n");
    return 0;
}

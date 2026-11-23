#include "../main/ble_protocol_logic.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

/* A realistic Security 1 Client Hello: [0x01][client_pub(65)] = 66 bytes. */
static void test_build_and_reassemble_client_hello(void) {
    uint8_t value[66];
    value[0] = 0x01;
    for (size_t i = 1; i < sizeof(value); i++) value[i] = (uint8_t)i;

    hc_ble_frag_rx_t rx;
    hc_ble_frag_reset(&rx);

    uint8_t frag[64];
    size_t offset = 0;
    int complete = 0;
    const uint8_t *out = NULL;
    size_t out_len = 0;

    /* 20-byte budget is the worst case the browser gives us. */
    while (offset < sizeof(value)) {
        size_t n = hc_ble_frag_build(frag, sizeof(frag), value, sizeof(value), offset, 20);
        assert(n > 0);
        assert(n <= 20 + HC_BLE_FRAG_HEADER);
        offset += n - HC_BLE_FRAG_HEADER;

        int rc = hc_ble_frag_accept(&rx, frag, n, &out, &out_len);
        assert(rc >= 0);
        complete = rc;
    }

    assert(complete == 1);
    assert(out_len == sizeof(value));
    assert(memcmp(out, value, sizeof(value)) == 0);
}

/* A 512-byte encrypted command (AES-GCM of a long repair payload). */
static void test_reassembles_largest_command(void) {
    uint8_t value[512];
    for (size_t i = 0; i < sizeof(value); i++) value[i] = (uint8_t)(i * 7u);

    hc_ble_frag_rx_t rx;
    hc_ble_frag_reset(&rx);

    uint8_t frag[256];
    size_t offset = 0;
    int complete = 0;
    const uint8_t *out = NULL;
    size_t out_len = 0;
    while (offset < sizeof(value)) {
        size_t n = hc_ble_frag_build(frag, sizeof(frag), value, sizeof(value), offset, 20);
        assert(n > 0);
        offset += n - HC_BLE_FRAG_HEADER;
        complete = hc_ble_frag_accept(&rx, frag, n, &out, &out_len);
        assert(complete >= 0);
    }
    assert(complete == 1);
    assert(out_len == sizeof(value));
    assert(memcmp(out, value, sizeof(value)) == 0);

    /* The receiver is reusable for the next logical value. */
    const uint8_t second[3] = {0x01, 0x02, 0x03};
    size_t n = hc_ble_frag_build(frag, sizeof(frag), second, sizeof(second), 0, 20);
    assert(n == HC_BLE_FRAG_HEADER + 3);
    assert(hc_ble_frag_accept(&rx, frag, n, &out, &out_len) == 1);
    assert(out_len == 3 && memcmp(out, second, 3) == 0);
}

static void test_rejects_gaps_overlaps_and_bad_lengths(void) {
    hc_ble_frag_rx_t rx;
    hc_ble_frag_reset(&rx);

    const uint8_t *out = NULL;
    size_t out_len = 0;

    /* Fragment claiming a length the board cannot hold. */
    uint8_t bad[8] = {HC_BLE_FRAG_WRITE_TAG, 0xFF, 0x7F, 0x00, 0x00, 1, 2, 3};
    assert(hc_ble_frag_accept(&rx, bad, sizeof(bad), &out, &out_len) == -1);

    /* Offset beyond the announced length. */
    uint8_t past[8] = {HC_BLE_FRAG_WRITE_TAG, 0x04, 0x00, 0x04, 0x00, 1};
    assert(hc_ble_frag_accept(&rx, past, 6, &out, &out_len) == -1);

    /* Empty fragment body. */
    uint8_t empty[5] = {HC_BLE_FRAG_WRITE_TAG, 0x04, 0x00, 0x00, 0x00};
    assert(hc_ble_frag_accept(&rx, empty, sizeof(empty), &out, &out_len) == -1);

    /* Second fragment without the first: discarded, never guessed. */
    uint8_t gap[7] = {HC_BLE_FRAG_WRITE_TAG, 0x08, 0x00, 0x04, 0x00, 9, 9};
    assert(hc_ble_frag_accept(&rx, gap, sizeof(gap), &out, &out_len) == -2);
    assert(rx.active == false);

    /* A duplicate fragment is an overlap, not a retry. */
    uint8_t f0[7] = {HC_BLE_FRAG_WRITE_TAG, 0x08, 0x00, 0x00, 0x00, 1, 2};
    assert(hc_ble_frag_accept(&rx, f0, sizeof(f0), &out, &out_len) == 0);
    uint8_t dup[7] = {HC_BLE_FRAG_WRITE_TAG, 0x08, 0x00, 0x00, 0x00, 1, 2};
    assert(hc_ble_frag_accept(&rx, dup, sizeof(dup), &out, &out_len) == 0); /* restarts at 0 */
    uint8_t too_much[8] = {HC_BLE_FRAG_WRITE_TAG, 0x03, 0x00, 0x02, 0x00, 4, 5, 6};
    assert(hc_ble_frag_accept(&rx, too_much, 8, &out, &out_len) == -2);
}

static void test_distinguishes_fragment_from_plain_value(void) {
    /* A Client Hello is 66 bytes starting 0x01: never mistaken for a fragment. */
    uint8_t hello[66];
    hello[0] = 0x01;
    assert(!hc_ble_frag_is_fragment(hello, sizeof(hello)));

    /* A short JSON command starts with '{'. */
    const uint8_t json[] = "{\"action\":\"wifi_only\"}";
    assert(!hc_ble_frag_is_fragment(json, sizeof(json) - 1));

    /* A tag byte with no room for the header is a plain value. */
    const uint8_t truncated[3] = {HC_BLE_FRAG_WRITE_TAG, 0x04, 0x00};
    assert(!hc_ble_frag_is_fragment(truncated, sizeof(truncated)));
}

static void test_read_windows(void) {
    const uint8_t value[130] = {0};
    uint8_t out[32];

    /* Whole value fits: one read. */
    assert(hc_ble_frag_read_window(value, sizeof(value), 0, 256, out, sizeof(out)) == 32);
    /* Successive windows walk the value. */
    assert(hc_ble_frag_read_window(value, sizeof(value), 0, 20, out, sizeof(out)) == 20);
    assert(hc_ble_frag_read_window(value, sizeof(value), 20, 20, out, sizeof(out)) == 20);
    assert(hc_ble_frag_read_window(value, sizeof(value), 120, 20, out, sizeof(out)) == 10);
    /* Past the end is an empty window, not an error. */
    assert(hc_ble_frag_read_window(value, sizeof(value), 130, 20, out, sizeof(out)) == 0);
    assert(hc_ble_frag_read_window(value, sizeof(value), 200, 20, out, sizeof(out)) == 0);
    /* Invalid arguments are rejected. */
    assert(hc_ble_frag_read_window(NULL, 10, 0, 20, out, sizeof(out)) == -1);
    assert(hc_ble_frag_read_window(value, 10, 0, 0, out, sizeof(out)) == -1);
}

static void test_budget_and_packing_guards(void) {
    assert(hc_ble_fragment_budget(23) == 20);
    assert(hc_ble_fragment_budget(247) == 244);
    assert(hc_ble_fragment_budget(0) == 20);
    assert(hc_ble_fragment_budget(20) == 20);
    assert(hc_ble_read_window_size(23) == 21);
    assert(hc_ble_read_window_size(247) == 245);
    assert(hc_ble_read_window_size(0) == 21);

    uint8_t out[32];
    const uint8_t value[4] = {1, 2, 3, 4};
    /* No room for the header. */
    assert(hc_ble_frag_build(out, 4, value, 4, 0, 20) == 0);
    /* No room for the payload. */
    assert(hc_ble_frag_build(out, HC_BLE_FRAG_HEADER, value, 4, 0, 20) == 0);
    /* Offset past the end. */
    assert(hc_ble_frag_build(out, sizeof(out), value, 4, 4, 20) == 0);
    /* Oversized value is refused rather than truncated. */
    uint8_t big[HC_BLE_FRAG_MAX + 1];
    memset(big, 0, sizeof(big));
    assert(hc_ble_frag_build(out, sizeof(out), big, sizeof(big), 0, 20) == 0);
    /* A whole value under the budget still gets a header (one round trip). */
    assert(hc_ble_frag_build(out, sizeof(out), value, 4, 0, 20) == HC_BLE_FRAG_HEADER + 4);
    assert(out[0] == HC_BLE_FRAG_WRITE_TAG && out[1] == 4 && out[3] == 0);
}

static void test_notification_fragments(void) {
    /* A 400-byte encrypted status: 25 fragments at MTU 23 (16-byte slices),
     * 2 at MTU 247 (240-byte slices). */
    assert(hc_ble_note_count(400, 20) == 25);
    assert(hc_ble_note_count(400, 244) == 2);
    assert(hc_ble_note_count(0, 20) == 0);
    assert(hc_ble_note_count(400, HC_BLE_NOTE_FRAG_HEADER) == 0);
    assert(hc_ble_note_count(HC_BLE_NOTE_MAX + 1, 244) == 0);

    uint8_t value[400];
    for (size_t i = 0; i < sizeof(value); i++) value[i] = (uint8_t)(i * 3u);
    uint8_t frag[32];

    /* Walking the fragments reassembles the payload exactly. */
    uint8_t rebuilt[400];
    size_t rebuilt_len = 0;
    const size_t total = hc_ble_note_count(sizeof(value), 20);
    for (size_t i = 0; i < total; i++) {
        size_t n = hc_ble_note_build(frag, sizeof(frag), value, sizeof(value), i, 20);
        assert(n > 4 && n <= 20);
        assert(hc_ble_note_is_fragment(frag, n));
        assert(frag[1] == i);
        assert((size_t)(frag[2] | (frag[3] << 8)) == total);
        memcpy(rebuilt + rebuilt_len, frag + HC_BLE_NOTE_FRAG_HEADER, n - HC_BLE_NOTE_FRAG_HEADER);
        rebuilt_len += n - HC_BLE_NOTE_FRAG_HEADER;
    }
    assert(rebuilt_len == sizeof(value));
    assert(memcmp(rebuilt, value, sizeof(value)) == 0);

    /* Index past the end and a too-small buffer are refused. */
    assert(hc_ble_note_build(frag, sizeof(frag), value, sizeof(value), total, 20) == 0);
    assert(hc_ble_note_build(frag, 4, value, sizeof(value), 0, 20) == 0);

    /* A whole encrypted payload is not mistaken for a fragment. */
    uint8_t whole[40];
    memset(whole, 0xAB, sizeof(whole));
    assert(!hc_ble_note_is_fragment(whole, sizeof(whole)));
    const uint8_t short_tag[3] = {HC_BLE_NOTE_FRAG_TAG, 0, 1};
    assert(!hc_ble_note_is_fragment(short_tag, sizeof(short_tag)));
}

int main(void) {
    test_build_and_reassemble_client_hello();
    test_reassembles_largest_command();
    test_rejects_gaps_overlaps_and_bad_lengths();
    test_distinguishes_fragment_from_plain_value();
    test_read_windows();
    test_budget_and_packing_guards();
    test_notification_fragments();
    printf("All BLE protocol framing C unit tests passed!\n");
    return 0;
}

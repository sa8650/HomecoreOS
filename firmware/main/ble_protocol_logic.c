#include "ble_protocol_logic.h"

#include <string.h>

void hc_ble_frag_reset(hc_ble_frag_rx_t *rx) {
    if (!rx) return;
    memset(rx, 0, sizeof(*rx));
}

bool hc_ble_frag_is_fragment(const uint8_t *buf, size_t len) {
    return buf && len >= HC_BLE_FRAG_HEADER && buf[0] == HC_BLE_FRAG_WRITE_TAG;
}

bool hc_ble_frag_parse_header(const uint8_t *buf, size_t len, hc_ble_frag_header_t *out) {
    if (!buf || !out || !hc_ble_frag_is_fragment(buf, len)) return false;
    const uint16_t total = (uint16_t)(buf[1] | ((uint16_t)buf[2] << 8));
    const uint16_t offset = (uint16_t)(buf[3] | ((uint16_t)buf[4] << 8));
    if (total == 0 || total > HC_BLE_FRAG_MAX) return false;
    if (offset >= total) return false;
    out->total = total;
    out->offset = offset;
    return true;
}

int hc_ble_frag_accept(hc_ble_frag_rx_t *rx, const uint8_t *buf, size_t len,
                       const uint8_t **out, size_t *out_len) {
    if (!rx || !out || !out_len) return -1;

    hc_ble_frag_header_t hdr;
    if (!hc_ble_frag_parse_header(buf, len, &hdr)) return -1;

    const uint8_t *payload = buf + HC_BLE_FRAG_HEADER;
    const size_t payload_len = len - HC_BLE_FRAG_HEADER;
    if (payload_len == 0) return -1;

    /* A new message always starts at offset 0; anything else at 0 is a
     * malformed fragment, and a fragment at 0 discards a half-received one. */
    if (hdr.offset == 0) {
        hc_ble_frag_reset(rx);
        rx->active = true;
        rx->len = hdr.total;
    } else if (!rx->active || rx->len != hdr.total) {
        hc_ble_frag_reset(rx);
        return -2;
    }

    if (hdr.offset != rx->received) {
        /* Gaps and overlaps are never guessed at: the browser restarts the
         * handshake, which is cheap and leaves no half-decrypted state. */
        hc_ble_frag_reset(rx);
        return -2;
    }
    if (rx->received + payload_len > rx->len) {
        hc_ble_frag_reset(rx);
        return -1;
    }

    memcpy(rx->buf + rx->received, payload, payload_len);
    rx->received += payload_len;

    if (rx->received < rx->len) return 0;

    *out = rx->buf;
    *out_len = rx->len;
    /* Keep the completed value intact; the caller consumes it immediately and
     * the next offset-0 fragment resets the receiver. */
    rx->active = false;
    return 1;
}

size_t hc_ble_frag_build(uint8_t *out, size_t cap, const uint8_t *value, size_t value_len,
                         size_t offset, size_t max_fragment) {
    if (!out || !value || value_len == 0 || value_len > HC_BLE_FRAG_MAX) return 0;
    if (max_fragment == 0) return 0;
    if (offset >= value_len) return 0;
    if (cap < HC_BLE_FRAG_HEADER) return 0;

    size_t slice = value_len - offset;
    if (slice > max_fragment) slice = max_fragment;
    if (cap < HC_BLE_FRAG_HEADER + slice) return 0;

    out[0] = HC_BLE_FRAG_WRITE_TAG;
    out[1] = (uint8_t)(value_len & 0xFF);
    out[2] = (uint8_t)((value_len >> 8) & 0xFF);
    out[3] = (uint8_t)(offset & 0xFF);
    out[4] = (uint8_t)((offset >> 8) & 0xFF);
    memcpy(out + HC_BLE_FRAG_HEADER, value + offset, slice);
    return HC_BLE_FRAG_HEADER + slice;
}

int hc_ble_frag_read_window(const uint8_t *value, size_t value_len, size_t offset, size_t max_len,
                            uint8_t *out, size_t cap) {
    if (!value || !out || max_len == 0 || cap == 0) return -1;
    if (offset >= value_len) return 0;

    size_t slice = value_len - offset;
    if (slice > max_len) slice = max_len;
    if (slice > cap) slice = cap;
    memcpy(out, value + offset, slice);
    return (int)slice;
}

size_t hc_ble_fragment_budget(unsigned mtu) {
    if (mtu < 23) return 20;
    return (size_t)mtu - 3;
}

size_t hc_ble_read_window_size(unsigned mtu) {
    /* ATT read response header is 1 byte, so mtu - 1 fits; one byte is kept
     * back so a stack that counts the handle does not truncate the frame. */
    if (mtu < 23) return 21;
    return (size_t)mtu - 2;
}

size_t hc_ble_note_count(size_t value_len, size_t max_fragment) {
    if (value_len == 0 || value_len > HC_BLE_NOTE_MAX) return 0;
    if (max_fragment <= HC_BLE_NOTE_FRAG_HEADER) return 0;
    const size_t payload = max_fragment - HC_BLE_NOTE_FRAG_HEADER;
    return (value_len + payload - 1) / payload;
}

size_t hc_ble_note_build(uint8_t *out, size_t cap, const uint8_t *value, size_t value_len,
                         size_t index, size_t max_fragment) {
    if (!out || !value || value_len == 0 || value_len > HC_BLE_NOTE_MAX) return 0;
    if (max_fragment <= HC_BLE_NOTE_FRAG_HEADER) return 0;

    const size_t payload = max_fragment - HC_BLE_NOTE_FRAG_HEADER;
    const size_t total = (value_len + payload - 1) / payload;
    if (index >= total || total > 0xFFFF) return 0;

    const size_t offset = index * payload;
    size_t slice = value_len - offset;
    if (slice > payload) slice = payload;
    if (cap < HC_BLE_NOTE_FRAG_HEADER + slice) return 0;

    out[0] = HC_BLE_NOTE_FRAG_TAG;
    out[1] = (uint8_t)(index & 0xFF);
    out[2] = (uint8_t)(total & 0xFF);
    out[3] = (uint8_t)((total >> 8) & 0xFF);
    memcpy(out + HC_BLE_NOTE_FRAG_HEADER, value + offset, slice);
    return HC_BLE_NOTE_FRAG_HEADER + slice;
}

bool hc_ble_note_is_fragment(const uint8_t *buf, size_t len) {
    return buf && len >= HC_BLE_NOTE_FRAG_HEADER && buf[0] == HC_BLE_NOTE_FRAG_TAG;
}

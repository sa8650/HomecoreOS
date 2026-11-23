#pragma once

/**
 * HomecoreOS BLE provisioning — pure framing logic (no ESP-IDF dependencies).
 *
 * The browser can only move ATT_MTU - 3 bytes per GATT operation, and the
 * value it gets is *not* guaranteed to be larger than the 20 bytes that the
 * default ATT_MTU of 23 allows. Chrome on Windows in particular routinely
 * refuses a `writeValue()` longer than 20 bytes with the unhelpful
 * "GATT operation failed for unknown reason", and older Android builds do the
 * same for reads.
 *
 * The Security 1 handshake and the encrypted command payloads are much larger
 * than 20 bytes, so both sides must be able to fall back to an explicit,
 * *application-level* framing instead of the ATT long-write / read-blob
 * procedures:
 *
 *   write  : the handshake/command characteristic accumulates the fragments
 *            of one logical value and dispatches it once it is complete
 *   read   : the characteristic returns fragment `n` of the pending response,
 *            selected by a small offset marker the browser writes first
 *
 * Both the fragmentation and the offset arithmetic live here so the host test
 * suite in CI exercises exactly the code the firmware links.
 *
 * Wire form (all values little-endian free, single byte markers):
 *
 *   Handshake / command write, chunked:
 *     [0x10][total_len:2 LE][offset:2 LE][fragment…]
 *   Handshake / command write, unfragmented: whatever the value is (first
 *   byte 0x01..0x09), i.e. byte-for-byte what the protocol always was.
 *
 *   Response read, chunked:
 *     [0x20][total_len:2 LE][offset:2 LE][fragment…]
 *   Response read of the whole value: the value itself.
 *
 * The offset marker is chosen so an application value can never be confused
 * with it: handshake messages start with 0x01..0x04 and JSON starts with '{'.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Marker introducing a fragmented handshake/command write. */
#define HC_BLE_FRAG_WRITE_TAG 0x10
/** Marker introducing a response fragment. */
#define HC_BLE_FRAG_READ_TAG 0x20
/** Marker introducing a status-notification fragment. */
#define HC_BLE_NOTE_FRAG_TAG 0x30
/** [tag][len_lo][len_hi][off_lo][off_hi] */
#define HC_BLE_FRAG_HEADER 5
/** Largest logical value either side may reassemble. */
#define HC_BLE_FRAG_MAX 640
/** [tag][index][total_lo][total_hi] */
#define HC_BLE_NOTE_FRAG_HEADER 4
/** Hard ceiling for one notification message (1024-byte protocol response +
 * 12-byte IV + 16-byte tag is 1052; keep room for the framing header). */
#define HC_BLE_NOTE_MAX 1120

typedef struct {
    uint8_t buf[HC_BLE_FRAG_MAX];
    size_t len;      /**< logical length announced by the first fragment */
    size_t received; /**< contiguous bytes accumulated so far */
    bool active;     /**< a fragmented write is in progress */
} hc_ble_frag_rx_t;

typedef struct {
    uint16_t total;
    uint16_t offset;
} hc_ble_frag_header_t;

/** Resets a receiver (also used on connect/disconnect). */
void hc_ble_frag_reset(hc_ble_frag_rx_t *rx);

/**
 * True when `buf` starts with the fragment tag and the header is well formed.
 * A value that merely *starts* with 0x10 but is too short to carry a header is
 * not a fragment and is treated as a normal value.
 */
bool hc_ble_frag_is_fragment(const uint8_t *buf, size_t len);

/** Parses the fragment header. Returns false when it is malformed. */
bool hc_ble_frag_parse_header(const uint8_t *buf, size_t len, hc_ble_frag_header_t *out);

/**
 * Accumulates one fragment.
 *
 * Returns  1  the logical value is complete (`*out`/`*out_len` point into `rx`)
 *          0  more fragments are needed
 *         -1  malformed fragment / announced length too large
 *         -2  out-of-order or overlapping fragment (receiver is reset)
 */
int hc_ble_frag_accept(hc_ble_frag_rx_t *rx, const uint8_t *buf, size_t len,
                       const uint8_t **out, size_t *out_len);

/**
 * Builds one fragment of `value` into `out`.
 *
 * Returns the number of bytes written, or 0 when it does not fit / arguments
 * are invalid. `max_fragment` is the payload budget per write (ATT_MTU - 3);
 * the function never writes more than `max_fragment + HC_BLE_FRAG_HEADER`.
 */
size_t hc_ble_frag_build(uint8_t *out, size_t cap, const uint8_t *value, size_t value_len,
                         size_t offset, size_t max_fragment);

/**
 * Copies the `offset`-th window of a pending response into `out`.
 *
 * Returns the number of bytes written (0 at/after the end), or -1 when the
 * arguments are invalid.
 */
int hc_ble_frag_read_window(const uint8_t *value, size_t value_len, size_t offset, size_t max_len,
                            uint8_t *out, size_t cap);

/**
 * Bytes of value that fit in one GATT operation for a negotiated ATT MTU.
 * Falls back to the 20-byte default for anything smaller than 23.
 */
size_t hc_ble_fragment_budget(unsigned mtu);

/**
 * Value bytes per read window.
 *
 * A read response has one byte less overhead than a notification, but on some
 * stacks (Chrome on Windows among them) a long read is refused outright, so
 * windows are kept small enough to always fit one ATT packet. The window is
 * deliberately allowed to be larger than the *write* budget: nothing about a
 * window has to match what the browser can write.
 */
size_t hc_ble_read_window_size(unsigned mtu);

/* ---------------------------------------------------------------------------
 * Status-notification framing
 *
 * A GATT notification can carry only ATT_MTU - 3 bytes, and NimBLE silently
 * truncates anything longer. At the default MTU of 23 that is 20 bytes, far
 * less than one encrypted status payload, so the payload is split into
 * self-describing pieces the browser concatenates *before* it decrypts:
 *
 *   [0x30][index:1][total:2 LE][slice…]
 * ------------------------------------------------------------------------- */

/** Number of fragments needed for `value_len` at `max_fragment` bytes each. */
size_t hc_ble_note_count(size_t value_len, size_t max_fragment);

/**
 * Builds notification fragment `index` into `out`.
 * Returns the bytes written, or 0 when nothing fits / arguments are invalid.
 */
size_t hc_ble_note_build(uint8_t *out, size_t cap, const uint8_t *value, size_t value_len,
                         size_t index, size_t max_fragment);

/** True when `buf` is a notification fragment (rather than a whole payload). */
bool hc_ble_note_is_fragment(const uint8_t *buf, size_t len);

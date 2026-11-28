/**
 * Receiver-side fact ring for the per-board live Log.
 *
 * See board_log.h for the rationale. Everything here is plain C: no ESP-IDF,
 * no allocation, no flash. The ring is a fixed array of fixed-size entries,
 * so the RAM cost is known at compile time and can never grow at runtime.
 *
 * The facts are kept ordered oldest first: index 0 is the oldest fact. That
 * keeps the serialization, the eviction and the "remove what was reported"
 * step trivial and free of allocation.
 */

#include "board_log.h"

#include <stdio.h>
#include <string.h>

#define HC_BOARD_LOG_SEQ_MAX 0xFFFFFFFEu

static hc_board_log_fact_t s_facts[HC_BOARD_LOG_RING_SIZE];
/** Number of stored facts. s_facts[0] is the oldest one. */
static uint8_t s_count = 0;
static uint32_t s_seq = 0;
static uint32_t s_age = 0;
static uint32_t s_session_id = 0;

/**
 * Fact priority. A rare but important event (a command the board received or
 * executed) must not be pushed out of the ring by a stream of routine link
 * facts, so the ring evicts the oldest fact of the lowest priority.
 */
static uint8_t fact_priority(const char *kind) {
    if (!kind) return 0;
    if (strcmp(kind, HC_BOARD_LOG_KIND_COMMAND) == 0) return 3;
    if (strcmp(kind, HC_BOARD_LOG_KIND_SYSTEM) == 0) return 2;
    if (strcmp(kind, HC_BOARD_LOG_KIND_DEVICE) == 0) return 2;
    if (strcmp(kind, HC_BOARD_LOG_KIND_COMM) == 0) return 1;
    return 0;
}

static void copy_field(char *dst, size_t dst_len, const char *src) {
    if (!dst || dst_len == 0) return;
    dst[0] = '\0';
    if (!src) return;
    size_t i = 0;
    for (; i + 1 < dst_len && src[i] != '\0'; ++i) {
        /* Only printable ASCII travels: a fact must never carry binary or a
         * payload, and this keeps the JSON always valid. */
        unsigned char c = (unsigned char)src[i];
        dst[i] = (c >= 0x20 && c <= 0x7e) ? (char)c : ' ';
    }
    dst[i] = '\0';
}

void hc_board_log_init(uint32_t session_id) {
    s_count = 0;
    s_seq = 0;
    s_age = 0;
    s_session_id = session_id;
    memset(s_facts, 0, sizeof(s_facts));
}

uint32_t hc_board_log_session_id(void) {
    return s_session_id;
}

/**
 * Finds the slot to overwrite when the ring is full.
 *
 * The victim is the oldest fact whose priority is lower than the incoming
 * fact's. When every stored fact is at least as important, the oldest fact
 * goes instead — the ring stays bounded either way.
 */
static uint8_t find_victim(uint8_t incoming_priority) {
    uint8_t oldest = 0;
    bool have_oldest = false;
    bool have_lower = false;
    uint8_t lower_priority_oldest = 0;

    for (uint8_t i = 0; i < s_count; ++i) {
        uint8_t priority = fact_priority(s_facts[i].kind);
        if (!have_oldest) {
            have_oldest = true;
            oldest = i;
        }
        if (priority < incoming_priority && !have_lower) {
            /* The array is ordered oldest first, so the first match is the
             * oldest fact of the lowest priority. */
            have_lower = true;
            lower_priority_oldest = i;
        }
    }
    if (!have_oldest) return 0;
    if (have_lower) return lower_priority_oldest;
    return oldest;
}

/** Removes the fact at `index` and keeps the oldest-first order intact. */
static void remove_at(uint8_t index) {
    if (index >= s_count) return;
    if (index + 1 < s_count) {
        memmove(&s_facts[index], &s_facts[index + 1],
                (size_t)(s_count - index - 1) * sizeof(s_facts[0]));
    }
    s_count--;
    memset(&s_facts[s_count], 0, sizeof(s_facts[0]));
}

void hc_board_log_record(const char *kind,
                         const char *status,
                         const char *method,
                         const char *target,
                         const char *detail,
                         const char *command_id) {
    if (!kind || !status) return;

    if (s_count >= HC_BOARD_LOG_RING_SIZE) {
        /* Full: drop one fact (the oldest of the lowest priority when the
         * incoming fact matters more), then append the new fact. */
        remove_at(find_victim(fact_priority(kind)));
    }

    hc_board_log_fact_t *fact = &s_facts[s_count];
    s_count++;
    memset(fact, 0, sizeof(*fact));
    copy_field(fact->kind, sizeof(fact->kind), kind);
    copy_field(fact->status, sizeof(fact->status), status);
    copy_field(fact->method, sizeof(fact->method), method);
    copy_field(fact->target, sizeof(fact->target), target);
    copy_field(fact->detail, sizeof(fact->detail), detail);
    copy_field(fact->command_id, sizeof(fact->command_id), command_id);
    s_seq = (s_seq >= HC_BOARD_LOG_SEQ_MAX) ? 1u : s_seq + 1u;
    fact->seq = s_seq;
    /* The age counter gives the true insertion order even when a fact was
     * written into a slot that is not the oldest one. */
    s_age = (s_age >= UINT32_MAX) ? 1u : s_age + 1u;
    fact->age = s_age;
}

uint8_t hc_board_log_pending(void) {
    return s_count;
}

bool hc_board_log_has_pending(void) {
    return s_count > 0;
}

static size_t append_json_string(char *out, size_t out_len, size_t pos, const char *value) {
    if (!value || value[0] == '\0') return pos;
    if (pos + 1 >= out_len) return pos;
    out[pos++] = '"';
    for (size_t i = 0; value[i] != '\0'; ++i) {
        if (pos + 1 >= out_len) break;
        char c = value[i];
        if (c == '"' || c == '\\') {
            if (pos + 2 >= out_len) break;
            out[pos++] = '\\';
            out[pos++] = c;
            continue;
        }
        out[pos++] = c;
    }
    if (pos + 1 >= out_len) return pos;
    out[pos++] = '"';
    return pos;
}

/**
 * Length of a field once it is written as a JSON string: a quote or a
 * backslash is escaped and therefore takes two bytes.
 */
static size_t escaped_len(const char *value) {
    size_t len = 0;
    if (!value) return 0;
    for (size_t i = 0; value[i] != '\0'; ++i) {
        char c = value[i];
        len += (c == '"' || c == '\\') ? 2u : 1u;
    }
    return len;
}

/**
 * Serializes one fact on its own.
 *
 * Returns the number of bytes written, or 0 when the fact does not fit into
 * `out_len`. A fact is never written partially: a truncated fact would
 * corrupt the whole batch.
 */
static size_t serialize_fact(const hc_board_log_fact_t *fact, char *out, size_t out_len) {
    size_t pos = 0;

    /* The exact size is computed up front (escaping included) so a fact that
     * cannot fit is rejected before a single byte is written. */
    size_t needed = 1;                                            /* '{' */
    needed += 6 + escaped_len(fact->kind);                        /* "k":"..." */
    needed += 7 + escaped_len(fact->status);                      /* ,"s":"..." */
    if (fact->method[0] != '\0') needed += 7 + escaped_len(fact->method);
    if (fact->target[0] != '\0') needed += 7 + escaped_len(fact->target);
    if (fact->command_id[0] != '\0') needed += 7 + escaped_len(fact->command_id);
    if (fact->detail[0] != '\0') needed += 7 + escaped_len(fact->detail);
    needed += 16;                                                 /* ,"ts":4294967295 */
    needed += 1;                                                  /* '}' */
    if (needed > out_len) return 0;

    out[pos++] = '{';
    pos = append_json_string(out, out_len, pos, "k");
    if (pos + 1 >= out_len) return 0;
    out[pos++] = ':';
    pos = append_json_string(out, out_len, pos, fact->kind);
    if (pos + 1 >= out_len) return 0;
    out[pos++] = ',';
    pos = append_json_string(out, out_len, pos, "s");
    if (pos + 1 >= out_len) return 0;
    out[pos++] = ':';
    pos = append_json_string(out, out_len, pos, fact->status);
    if (fact->method[0] != '\0') {
        if (pos + 1 >= out_len) return 0;
        out[pos++] = ',';
        pos = append_json_string(out, out_len, pos, "m");
        if (pos + 1 >= out_len) return 0;
        out[pos++] = ':';
        pos = append_json_string(out, out_len, pos, fact->method);
    }
    if (fact->target[0] != '\0') {
        if (pos + 1 >= out_len) return 0;
        out[pos++] = ',';
        pos = append_json_string(out, out_len, pos, "t");
        if (pos + 1 >= out_len) return 0;
        out[pos++] = ':';
        pos = append_json_string(out, out_len, pos, fact->target);
    }
    if (fact->command_id[0] != '\0') {
        if (pos + 1 >= out_len) return 0;
        out[pos++] = ',';
        pos = append_json_string(out, out_len, pos, "c");
        if (pos + 1 >= out_len) return 0;
        out[pos++] = ':';
        pos = append_json_string(out, out_len, pos, fact->command_id);
    }
    if (fact->detail[0] != '\0') {
        if (pos + 1 >= out_len) return 0;
        out[pos++] = ',';
        pos = append_json_string(out, out_len, pos, "d");
        if (pos + 1 >= out_len) return 0;
        out[pos++] = ':';
        pos = append_json_string(out, out_len, pos, fact->detail);
    }
    if (pos + 16 >= out_len) return 0;
    pos += (size_t)snprintf(out + pos, out_len - pos, ",\"ts\":%lu", (unsigned long)fact->seq);
    if (pos + 1 >= out_len) return 0;
    out[pos++] = '}';
    out[pos] = '\0';
    return pos;
}

size_t hc_board_log_write_json(char *out, size_t out_len, uint8_t *written_count) {
    if (written_count) *written_count = 0;
    if (!out || out_len < 4) return 0;
    if (s_count == 0) {
        out[0] = '\0';
        return 0;
    }

    size_t pos = 0;
    out[pos++] = '[';
    uint8_t written = 0;

    /* The facts are walked in true insertion order (oldest first), so the
     * Worker sees them in the order the board produced them. */
    for (uint8_t i = 0; i < s_count; ++i) {
        char fact_json[HC_BOARD_LOG_FACT_JSON_MAX];
        size_t fact_len = serialize_fact(&s_facts[i], fact_json, sizeof(fact_json));
        if (fact_len == 0) break;
        /* The fact must fit completely, including the separating comma. */
        size_t extra = fact_len + (written > 0 ? 1u : 0u);
        if (pos + extra + 1u >= out_len) break;
        if (written > 0) out[pos++] = ',';
        memcpy(out + pos, fact_json, fact_len);
        pos += fact_len;
        written++;
    }

    if (pos + 2 >= out_len) {
        /* Not even the closing bracket fits: report nothing rather than
         * writing a broken array. */
        out[0] = '\0';
        return 0;
    }
    out[pos++] = ']';
    out[pos] = '\0';
    if (written_count) *written_count = written;
    return pos;
}

void hc_board_log_commit_sent(uint8_t count) {
    if (count == 0) return;
    if (count > s_count) count = s_count;
    if (count < s_count) {
        memmove(&s_facts[0], &s_facts[count],
                (size_t)(s_count - count) * sizeof(s_facts[0]));
    }
    memset(&s_facts[s_count - count], 0, (size_t)count * sizeof(s_facts[0]));
    s_count = (uint8_t)(s_count - count);
}

void hc_board_log_clear(void) {
    s_count = 0;
    memset(s_facts, 0, sizeof(s_facts));
}

void hc_board_log_reset(void) {
    hc_board_log_clear();
    s_seq = 0;
    s_age = 0;
    s_session_id = 0;
}

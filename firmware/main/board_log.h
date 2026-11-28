#pragma once

/**
 * Receiver-side fact ring for the per-board live Log.
 *
 * The board never publishes a log message of its own: there is no extra MQTT
 * topic, no extra task and no flash write. Instead the board keeps a tiny
 * fixed-size ring of facts in RAM and ships them inside the heartbeat it
 * already sends. The Worker turns those facts into log rows.
 *
 * Why this matters: only the receiving side can prove that a command was
 * *received*, *acknowledged* or *executed*. A publish on the Worker side is
 * never treated as proof of receipt, so the facts recorded here are the only
 * source for those states.
 *
 * The module is deliberately free of ESP-IDF so the host test suite can
 * exercise the ring (firmware/test/test_board_log.c).
 *
 * Bounds:
 *   - fixed ring of HC_BOARD_LOG_RING_SIZE entries (bounded RAM)
 *   - fixed field lengths, so one fact never grows the JSON payload
 *   - no NVS / flash write, ever
 *   - priority-aware eviction: a rare but important command fact is never
 *     pushed out by a stream of routine link facts
 *   - the serialized batch is always valid JSON: a fact that does not fit is
 *     simply left in the ring for the next heartbeat
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Number of facts kept in RAM. The oldest fact is overwritten when full. */
#define HC_BOARD_LOG_RING_SIZE 12

/** Maximum size of the serialized fact array (all facts, worst case). */
#define HC_BOARD_LOG_JSON_MAX 900

/** Maximum size of a single serialized fact (all fields at their limit). */
#define HC_BOARD_LOG_FACT_JSON_MAX 384

/* Field limits. Short on purpose: the payload travels over a slow link. */
#define HC_BOARD_LOG_KIND_LEN 8
#define HC_BOARD_LOG_STATUS_LEN 20
#define HC_BOARD_LOG_METHOD_LEN 10
/* A board instance id is a 36 character UUID. The buffer must hold it plus the
 * terminating NUL, otherwise the peer id of every ESP-NOW fact would lose its
 * last character and no longer match the id the Worker knows. */
#define HC_BOARD_LOG_TARGET_LEN 40
#define HC_BOARD_LOG_DETAIL_LEN 32
#define HC_BOARD_LOG_COMMAND_LEN 44

/** Fact kinds. */
#define HC_BOARD_LOG_KIND_COMMAND "cmd"
#define HC_BOARD_LOG_KIND_COMM "comm"
#define HC_BOARD_LOG_KIND_DEVICE "dev"
#define HC_BOARD_LOG_KIND_SYSTEM "sys"

/** Fact statuses. */
#define HC_BOARD_LOG_STATUS_RECEIVED "received"
#define HC_BOARD_LOG_STATUS_ACKNOWLEDGED "acknowledged"
#define HC_BOARD_LOG_STATUS_EXECUTED "executed"
#define HC_BOARD_LOG_STATUS_FAILED "failed"
#define HC_BOARD_LOG_STATUS_REJECTED "rejected"
#define HC_BOARD_LOG_STATUS_DUPLICATE "duplicate"
#define HC_BOARD_LOG_STATUS_SENT "sent"
#define HC_BOARD_LOG_STATUS_TIMEOUT "timeout"
#define HC_BOARD_LOG_STATUS_LINK_UP "link_established"
#define HC_BOARD_LOG_STATUS_LINK_DOWN "link_lost"
/** Reported once, right after the ring is initialised on a boot. */
#define HC_BOARD_LOG_STATUS_BOOT "boot"

/** Transport methods. */
#define HC_BOARD_LOG_METHOD_MQTT "mqtt"
#define HC_BOARD_LOG_METHOD_ESPNOW "espnow"

/**
 * How a command ended on the board that received it.
 *
 * The three outcomes are genuinely different events and the Log keeps them
 * apart: a command the board refused (unknown switch, malformed payload) is
 * `rejected`, one it accepted but could not apply (GPIO write failed) is
 * `failed`, and one it applied is `executed`. Collapsing them into `failed`
 * would make an invalid command look like a hardware problem.
 */
typedef enum {
    HC_CMD_APPLIED = 0,
    HC_CMD_REJECTED = 1,
    HC_CMD_FAILED = 2,
} hc_cmd_outcome_t;

/** The Log status string for a command outcome. */
static inline const char *hc_cmd_outcome_status(hc_cmd_outcome_t outcome) {
    if (outcome == HC_CMD_APPLIED) return HC_BOARD_LOG_STATUS_EXECUTED;
    if (outcome == HC_CMD_REJECTED) return HC_BOARD_LOG_STATUS_REJECTED;
    return HC_BOARD_LOG_STATUS_FAILED;
}

typedef struct {
    char kind[HC_BOARD_LOG_KIND_LEN];
    char status[HC_BOARD_LOG_STATUS_LEN];
    char method[HC_BOARD_LOG_METHOD_LEN];
    char target[HC_BOARD_LOG_TARGET_LEN];
    char detail[HC_BOARD_LOG_DETAIL_LEN];
    char command_id[HC_BOARD_LOG_COMMAND_LEN];
    uint32_t seq;
    /** Monotonic insertion counter; defines the true order of the facts. */
    uint32_t age;
} hc_board_log_fact_t;

/**
 * Prepares the ring. `session_id` namespaces the fact sequence so a reboot
 * can never collide with the facts of the previous session.
 */
void hc_board_log_init(uint32_t session_id);

/** The current session id (also reported in the heartbeat). */
uint32_t hc_board_log_session_id(void);

/**
 * Records one fact. Any argument may be NULL or empty; empty fields are
 * omitted from the serialized output. The ring never grows: when it is full
 * the oldest fact of the lowest priority is dropped.
 */
void hc_board_log_record(const char *kind,
                         const char *status,
                         const char *method,
                         const char *target,
                         const char *detail,
                         const char *command_id);

/** Number of facts waiting to be reported. */
uint8_t hc_board_log_pending(void);

/** True when at least one fact is waiting to be reported. */
bool hc_board_log_has_pending(void);

/**
 * Writes the waiting facts as a compact JSON array (no surrounding key).
 *
 * The facts are written oldest first and only while they fit: the result is
 * always valid JSON. When the buffer is too small for the next fact, the
 * remaining facts stay in the ring and are reported with the next heartbeat.
 * The facts are NOT dropped here — `hc_board_log_commit_sent()` removes them
 * once the board knows the report reached the Worker, so a failed report is
 * retried instead of being lost.
 *
 * `written_count` (optional) receives the number of facts that were written.
 *
 * Returns the number of bytes written, or 0 when there is nothing to report.
 */
size_t hc_board_log_write_json(char *out, size_t out_len, uint8_t *written_count);

/**
 * Removes the `count` oldest facts from the ring. Called after a successful
 * report, with the number of facts that were actually written.
 */
void hc_board_log_commit_sent(uint8_t count);

/** Drops every waiting fact (full reset of the ring). */
void hc_board_log_clear(void);

/** Test seam: drops the ring and resets the sequence counter. */
void hc_board_log_reset(void);

#ifdef __cplusplus
}
#endif

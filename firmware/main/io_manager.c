#include "homecore_config.h"

#include <math.h>
#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "hc_io";

typedef struct {
    bool active;
    char trigger_kind[16];     // "sensor_value" | "device_state"
    char trigger_id[48];
    char op[8];                // "gt" | "gte" | "lt" | "lte" | "eq" | "neq"
    double threshold;
    bool expected_bool;
    char expected_str[32];
    char action_type[16];      // "switch_on" | "switch_off" | "device_state"
    char target_id[48];
    bool target_state;
    bool last_matched;
} hc_local_rule_t;

static hc_io_entry_t s_entries[HOMECORE_MAX_IO_ITEMS];
static size_t s_entry_count = 0;
static hc_local_rule_t s_local_rules[HOMECORE_MAX_LOCAL_RULES];
static size_t s_local_rule_count = 0;
static SemaphoreHandle_t s_io_mutex = NULL;
static uint32_t s_applied_revision = 0;
static char s_applied_hash[32] = {0};
static uint16_t s_heartbeat_interval_sec = HOMECORE_DEFAULT_HEARTBEAT_SEC;

uint32_t hc_io_get_config_revision(void) {
    return s_applied_revision;
}

const char *hc_io_get_config_hash(void) {
    return s_applied_hash;
}

uint16_t hc_io_get_heartbeat_interval_sec(void) {
    return s_heartbeat_interval_sec >= 30 ? s_heartbeat_interval_sec : HOMECORE_DEFAULT_HEARTBEAT_SEC;
}

bool hc_io_is_safe_gpio(uint8_t pin) {
    if (!GPIO_IS_VALID_GPIO((gpio_num_t)pin)) {
        return false;
    }
#if defined(CONFIG_IDF_TARGET_ESP32S3)
    // Reject SPI0/1 Flash (26-32), Octal PSRAM (33-37), and native USB D-/D+ (19-20)
    if (pin >= 26 && pin <= 32) return false;
#if defined(CONFIG_SPIRAM_MODE_OCT)
    if (pin >= 33 && pin <= 37) return false;
#endif
    if (pin == 19 || pin == 20) return false;
#elif defined(CONFIG_IDF_TARGET_ESP32S2)
    // Reject SPI Flash/PSRAM bus (26-32) and USB D-/D+ (19-20)
    if (pin >= 26 && pin <= 32) return false;
    if (pin == 19 || pin == 20) return false;
#elif defined(CONFIG_IDF_TARGET_ESP32)
    // Reject internal SPI Flash pins (6-11)
    if (pin >= 6 && pin <= 11) return false;
#elif defined(CONFIG_IDF_TARGET_ESP32C3)
    // Reject internal SPI Flash (12-17) and USB D-/D+ (18-19)
    if (pin >= 12 && pin <= 17) return false;
    if (pin == 18 || pin == 19) return false;
#elif defined(CONFIG_IDF_TARGET_ESP32C6)
    // Reject internal SPI Flash (24-30) and USB D-/D+ (12-13)
    if (pin >= 24 && pin <= 30) return false;
    if (pin == 12 || pin == 13) return false;
#elif defined(CONFIG_IDF_TARGET_ESP32C2)
    // Reject internal SPI Flash (11-17)
    if (pin >= 11 && pin <= 17) return false;
#elif defined(CONFIG_IDF_TARGET_ESP32C5)
    // Reject native USB D-/D+ (13-14)
    if (pin == 13 || pin == 14) return false;
#elif defined(CONFIG_IDF_TARGET_ESP32C61)
    // Reject native USB D-/D+ (12-13)
    if (pin == 12 || pin == 13) return false;
#elif defined(CONFIG_IDF_TARGET_ESP32H2)
    // Reject internal SPI Flash (15-21) and USB D-/D+ (26-27)
    if (pin >= 15 && pin <= 21) return false;
    if (pin == 26 || pin == 27) return false;
#endif
    return true;
}

static void apply_hardware_level(const hc_io_entry_t *entry) {
    if (!hc_io_is_safe_gpio(entry->gpio_pin)) return;
    if (entry->kind == HC_IO_KIND_SENSOR) return;
    if (!GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)entry->gpio_pin)) return;
    int level = entry->state ? 1 : 0;
    if (entry->inverted) level = level ? 0 : 1;
    gpio_set_level((gpio_num_t)entry->gpio_pin, level);
}

static void configure_entry_gpio(const hc_io_entry_t *entry) {
    if (!hc_io_is_safe_gpio(entry->gpio_pin)) {
        ESP_LOGW(TAG, "Skipping unsafe/reserved GPIO %u on %s", entry->gpio_pin, HOMECORE_BOARD_SLUG);
        return;
    }

    if (entry->kind == HC_IO_KIND_SENSOR) {
        gpio_config_t in_cfg = {
            .pin_bit_mask = (1ULL << entry->gpio_pin),
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        gpio_config(&in_cfg);
    } else {
        if (!GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)entry->gpio_pin)) {
            ESP_LOGW(TAG, "Skipping input-only GPIO %u for output binding", entry->gpio_pin);
            return;
        }
        gpio_config_t out_cfg = {
            .pin_bit_mask = (1ULL << entry->gpio_pin),
            .mode = GPIO_MODE_OUTPUT,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        gpio_config(&out_cfg);
        apply_hardware_level(entry);
    }
}

static void parse_local_automations_locked(cJSON *root) {
    s_local_rule_count = 0;
    cJSON *rules = cJSON_GetObjectItem(root, "localAutomations");
    if (!cJSON_IsArray(rules)) return;

    cJSON *rule = NULL;
    cJSON_ArrayForEach(rule, rules) {
        if (s_local_rule_count >= HOMECORE_MAX_LOCAL_RULES) break;
        cJSON *trig = cJSON_GetObjectItem(rule, "trigger_config");
        cJSON *acts = cJSON_GetObjectItem(rule, "actions_config");
        if (!cJSON_IsObject(trig) || !cJSON_IsArray(acts)) continue;

        cJSON *t_type = cJSON_GetObjectItem(trig, "type");
        cJSON *first_act = cJSON_GetArrayItem(acts, 0);
        if (!cJSON_IsString(t_type) || !cJSON_IsObject(first_act)) continue;

        hc_local_rule_t *r = &s_local_rules[s_local_rule_count];
        memset(r, 0, sizeof(*r));
        hc_copy_str(r->trigger_kind, sizeof(r->trigger_kind), t_type->valuestring);

        if (strcmp(r->trigger_kind, "sensor_value") == 0) {
            cJSON *sid = cJSON_GetObjectItem(trig, "sensorId");
            cJSON *op = cJSON_GetObjectItem(trig, "operator");
            cJSON *thr = cJSON_GetObjectItem(trig, "threshold");
            if (!cJSON_IsString(sid) || !cJSON_IsString(op) || !cJSON_IsNumber(thr)) continue;
            hc_copy_str(r->trigger_id, sizeof(r->trigger_id), sid->valuestring);
            hc_copy_str(r->op, sizeof(r->op), op->valuestring);
            r->threshold = thr->valuedouble;
        } else if (strcmp(r->trigger_kind, "device_state") == 0) {
            cJSON *swid = cJSON_GetObjectItem(trig, "switchId");
            cJSON *did = cJSON_GetObjectItem(trig, "deviceId");
            cJSON *exp = cJSON_GetObjectItem(trig, "expectedState");
            if (cJSON_IsString(swid)) {
                hc_copy_str(r->trigger_id, sizeof(r->trigger_id), swid->valuestring);
            } else if (cJSON_IsString(did)) {
                hc_copy_str(r->trigger_id, sizeof(r->trigger_id), did->valuestring);
            } else {
                continue;
            }
            if (cJSON_IsBool(exp)) {
                r->expected_bool = cJSON_IsTrue(exp);
            } else if (cJSON_IsString(exp)) {
                hc_copy_str(r->expected_str, sizeof(r->expected_str), exp->valuestring);
                r->expected_bool = hc_io_parse_bool_state(exp->valuestring, false);
            }
        } else {
            continue;
        }

        cJSON *act_type = cJSON_GetObjectItem(first_act, "type");
        if (!cJSON_IsString(act_type)) continue;
        hc_copy_str(r->action_type, sizeof(r->action_type), act_type->valuestring);
        if (strcmp(r->action_type, "switch_on") == 0 || strcmp(r->action_type, "switch_off") == 0) {
            cJSON *tid = cJSON_GetObjectItem(first_act, "switchId");
            if (!cJSON_IsString(tid)) continue;
            hc_copy_str(r->target_id, sizeof(r->target_id), tid->valuestring);
            r->target_state = (strcmp(r->action_type, "switch_on") == 0);
        } else if (strcmp(r->action_type, "device_state") == 0) {
            cJSON *tid = cJSON_GetObjectItem(first_act, "deviceId");
            cJSON *tst = cJSON_GetObjectItem(first_act, "targetState");
            if (!cJSON_IsString(tid) || !cJSON_IsString(tst)) continue;
            hc_copy_str(r->target_id, sizeof(r->target_id), tid->valuestring);
            r->target_state = hc_io_parse_bool_state(tst->valuestring, false);
        } else {
            continue;
        }

        r->active = true;
        s_local_rule_count++;
    }
}

esp_err_t hc_io_apply_config_json(const char *json, bool *out_changed) {
    if (out_changed) *out_changed = false;
    if (!json || strlen(json) == 0) return ESP_OK;

    cJSON *root = cJSON_Parse(json);
    if (!root) return ESP_ERR_INVALID_ARG;

    if (!s_io_mutex) {
        s_io_mutex = xSemaphoreCreateMutex();
    }

    cJSON *unchanged_j = cJSON_GetObjectItem(root, "unchanged");
    if (cJSON_IsBool(unchanged_j) && cJSON_IsTrue(unchanged_j)) {
        cJSON_Delete(root);
        return ESP_OK;
    }

    cJSON *rev_j = cJSON_GetObjectItem(root, "revision");
    cJSON *hash_j = cJSON_GetObjectItem(root, "hash");
    uint32_t incoming_rev = cJSON_IsNumber(rev_j) ? (uint32_t)rev_j->valuedouble : 0;
    const char *incoming_hash = cJSON_IsString(hash_j) && hash_j->valuestring ? hash_j->valuestring : "";

    xSemaphoreTake(s_io_mutex, portMAX_DELAY);
    if (incoming_rev > 0 && incoming_rev == s_applied_revision &&
        strlen(incoming_hash) > 0 && strcmp(incoming_hash, s_applied_hash) == 0) {
        xSemaphoreGive(s_io_mutex);
        cJSON_Delete(root);
        ESP_LOGD(TAG, "Ignoring unchanged consolidated snapshot (rev=%u)", (unsigned)incoming_rev);
        return ESP_OK;
    }

    cJSON *settings_j = cJSON_GetObjectItem(root, "settings");
    if (cJSON_IsObject(settings_j)) {
        cJSON *hb_j = cJSON_GetObjectItem(settings_j, "heartbeatIntervalSec");
        if (cJSON_IsNumber(hb_j)) {
            int hb = hb_j->valueint;
            if (hb >= 30 && hb <= 300) {
                s_heartbeat_interval_sec = (uint16_t)hb;
            }
        }
    }

    s_entry_count = 0;

    const char *sections[3] = { "switches", "devices", "sensors" };
    hc_io_kind_t kinds[3] = { HC_IO_KIND_SWITCH, HC_IO_KIND_DEVICE, HC_IO_KIND_SENSOR };

    for (int s = 0; s < 3; s++) {
        cJSON *arr = cJSON_GetObjectItem(root, sections[s]);
        if (!cJSON_IsArray(arr)) continue;

        cJSON *item = NULL;
        cJSON_ArrayForEach(item, arr) {
            if (s_entry_count >= HOMECORE_MAX_IO_ITEMS) break;
            cJSON *id_j = cJSON_GetObjectItem(item, "id");
            cJSON *pin_j = cJSON_GetObjectItem(item, "gpio_pin");
            if (!cJSON_IsString(id_j) || !cJSON_IsNumber(pin_j)) continue;

            hc_io_entry_t *e = &s_entries[s_entry_count++];
            memset(e, 0, sizeof(*e));
            hc_copy_str(e->id, sizeof(e->id), id_j->valuestring);
            e->kind = kinds[s];
            e->gpio_pin = (uint8_t)pin_j->valueint;

            cJSON *inv_j = cJSON_GetObjectItem(item, "inverted");
            e->inverted = cJSON_IsBool(inv_j) && cJSON_IsTrue(inv_j);

            cJSON *on_j = cJSON_GetObjectItem(item, "is_on");
            cJSON *st_j = cJSON_GetObjectItem(item, "state");
            if (cJSON_IsBool(on_j)) {
                e->state = cJSON_IsTrue(on_j);
            } else if (cJSON_IsString(st_j)) {
                e->state = hc_io_parse_bool_state(st_j->valuestring, false);
            }

            cJSON *drv_j = cJSON_GetObjectItem(item, "sensor_type");
            if (cJSON_IsString(drv_j)) {
                hc_copy_str(e->driver_type, sizeof(e->driver_type), drv_j->valuestring);
            }

            configure_entry_gpio(e);
        }
    }

    parse_local_automations_locked(root);
    if (incoming_rev > 0) s_applied_revision = incoming_rev;
    if (strlen(incoming_hash) > 0) hc_copy_str(s_applied_hash, sizeof(s_applied_hash), incoming_hash);

    xSemaphoreGive(s_io_mutex);
    cJSON_Delete(root);
    hc_nvs_save_io_json(json);
    if (out_changed) *out_changed = true;
    ESP_LOGI(TAG, "Applied rev=%u (%u IO bindings, %u local rules, hb=%us)",
        (unsigned)s_applied_revision,
        (unsigned)s_entry_count,
        (unsigned)s_local_rule_count,
        (unsigned)s_heartbeat_interval_sec);
    return ESP_OK;
}

esp_err_t hc_io_init(const char *initial_json) {
    if (!s_io_mutex) {
        s_io_mutex = xSemaphoreCreateMutex();
    }
    return hc_io_apply_config_json(initial_json, NULL);
}

esp_err_t hc_io_set_output(const char *target_id, bool state) {
    if (!target_id || !s_io_mutex) return ESP_ERR_INVALID_ARG;
    esp_err_t res = ESP_ERR_NOT_FOUND;

    xSemaphoreTake(s_io_mutex, portMAX_DELAY);
    for (size_t i = 0; i < s_entry_count; i++) {
        if (strcmp(s_entries[i].id, target_id) == 0 && s_entries[i].kind != HC_IO_KIND_SENSOR) {
            s_entries[i].state = state;
            apply_hardware_level(&s_entries[i]);
            res = ESP_OK;
            break;
        }
    }
    xSemaphoreGive(s_io_mutex);
    return res;
}

esp_err_t hc_io_drive_pin(
    const char *target_id,
    hc_io_kind_t kind,
    uint8_t gpio_pin,
    bool inverted,
    bool state
) {
    if (!target_id || !hc_io_is_safe_gpio(gpio_pin) || !s_io_mutex) {
        return ESP_ERR_INVALID_ARG;
    }
    if (kind != HC_IO_KIND_SENSOR && !GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)gpio_pin)) {
        return ESP_ERR_INVALID_ARG;
    }

    xSemaphoreTake(s_io_mutex, portMAX_DELAY);
    hc_io_entry_t *found = NULL;
    for (size_t i = 0; i < s_entry_count; i++) {
        if (strcmp(s_entries[i].id, target_id) == 0) {
            found = &s_entries[i];
            break;
        }
    }

    if (!found && s_entry_count < HOMECORE_MAX_IO_ITEMS) {
        found = &s_entries[s_entry_count++];
        memset(found, 0, sizeof(*found));
        hc_copy_str(found->id, sizeof(found->id), target_id);
    }

    if (found) {
        bool pin_changed = (found->gpio_pin != gpio_pin) || (found->kind != kind);
        found->kind = kind;
        found->gpio_pin = gpio_pin;
        found->inverted = inverted;
        found->state = state;
        if (pin_changed) {
            configure_entry_gpio(found);
        } else {
            apply_hardware_level(found);
        }
    }
    xSemaphoreGive(s_io_mutex);
    return found ? ESP_OK : ESP_ERR_NO_MEM;
}

static bool eval_numeric_op(double val, const char *op, double threshold) {
    if (strcmp(op, "gt") == 0) return val > threshold;
    if (strcmp(op, "gte") == 0) return val >= threshold;
    if (strcmp(op, "lt") == 0) return val < threshold;
    if (strcmp(op, "lte") == 0) return val <= threshold;
    if (strcmp(op, "eq") == 0) return fabs(val - threshold) < 0.0001;
    if (strcmp(op, "neq") == 0) return fabs(val - threshold) >= 0.0001;
    return false;
}

bool hc_io_evaluate_local_rules(void) {
    if (!s_io_mutex || s_local_rule_count == 0) return false;
    bool changed = false;

    xSemaphoreTake(s_io_mutex, portMAX_DELAY);
    for (size_t r = 0; r < s_local_rule_count; r++) {
        hc_local_rule_t *rule = &s_local_rules[r];
        if (!rule->active) continue;

        hc_io_entry_t *trig_entry = NULL;
        hc_io_entry_t *targ_entry = NULL;
        for (size_t i = 0; i < s_entry_count; i++) {
            if (strcmp(s_entries[i].id, rule->trigger_id) == 0) trig_entry = &s_entries[i];
            if (strcmp(s_entries[i].id, rule->target_id) == 0) targ_entry = &s_entries[i];
        }
        if (!trig_entry || !targ_entry || targ_entry->kind == HC_IO_KIND_SENSOR) continue;

        bool matched = false;
        if (strcmp(rule->trigger_kind, "sensor_value") == 0 && trig_entry->kind == HC_IO_KIND_SENSOR) {
            double val = hc_io_is_safe_gpio(trig_entry->gpio_pin)
                ? (double)gpio_get_level((gpio_num_t)trig_entry->gpio_pin)
                : 0.0;
            matched = eval_numeric_op(val, rule->op, rule->threshold);
        } else if (strcmp(rule->trigger_kind, "device_state") == 0 && trig_entry->kind != HC_IO_KIND_SENSOR) {
            matched = (trig_entry->state == rule->expected_bool);
        }

        if (matched && !rule->last_matched) {
            if (targ_entry->state != rule->target_state) {
                targ_entry->state = rule->target_state;
                apply_hardware_level(targ_entry);
                changed = true;
                ESP_LOGI(TAG, "Local offline automation actuated target %s -> %s", targ_entry->id, targ_entry->state ? "ON" : "OFF");
            }
        }
        rule->last_matched = matched;
    }
    xSemaphoreGive(s_io_mutex);
    return changed;
}

void hc_io_build_telemetry_json(char *out_buf, size_t out_len) {
    cJSON *root = cJSON_CreateObject();
    cJSON *sensors_arr = cJSON_CreateArray();
    cJSON *switches_arr = cJSON_CreateArray();
    cJSON *devices_arr = cJSON_CreateArray();

    xSemaphoreTake(s_io_mutex, portMAX_DELAY);
    for (size_t i = 0; i < s_entry_count; i++) {
        hc_io_entry_t *e = &s_entries[i];
        if (e->kind == HC_IO_KIND_SENSOR) {
            int raw = hc_io_is_safe_gpio(e->gpio_pin) ? gpio_get_level((gpio_num_t)e->gpio_pin) : 0;
            cJSON *s_item = cJSON_CreateObject();
            cJSON_AddStringToObject(s_item, "sensorId", e->id);
            cJSON_AddNumberToObject(s_item, "value", raw);
            cJSON_AddItemToArray(sensors_arr, s_item);
        } else if (e->kind == HC_IO_KIND_SWITCH) {
            cJSON *sw_item = cJSON_CreateObject();
            cJSON_AddStringToObject(sw_item, "switchId", e->id);
            cJSON_AddBoolToObject(sw_item, "isOn", e->state);
            cJSON_AddItemToArray(switches_arr, sw_item);
        } else {
            cJSON *d_item = cJSON_CreateObject();
            cJSON_AddStringToObject(d_item, "deviceId", e->id);
            cJSON_AddStringToObject(d_item, "state", e->state ? "on" : "off");
            cJSON_AddItemToArray(devices_arr, d_item);
        }
    }
    xSemaphoreGive(s_io_mutex);

    cJSON_AddItemToObject(root, "sensors", sensors_arr);
    cJSON_AddItemToObject(root, "switches", switches_arr);
    cJSON_AddItemToObject(root, "devices", devices_arr);
    char *printed = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);

    if (printed) {
        hc_copy_str(out_buf, out_len, printed);
        cJSON_free(printed);
    } else if (out_len > 2) {
        strcpy(out_buf, "{}");
    }
}

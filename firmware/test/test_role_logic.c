#include "../main/role_logic.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static hc_role_input_t node_input(void) {
    hc_role_input_t in = {
        .role = HC_ROLE_NODE,
        .has_wifi = true,
        .has_espnow = true,
        .assigned = true,
        .controller_online = true,
        .mqtt_connected = false,
        .ota_window = false,
        .ms_since_controller = 0,
    };
    return in;
}

static void test_role_names_and_parsing(void) {
    assert(strcmp(hc_role_name(HC_ROLE_CONTROLLER), "controller") == 0);
    assert(strcmp(hc_role_name(HC_ROLE_NODE), "node") == 0);
    assert(hc_role_from_string("node") == HC_ROLE_NODE);
    assert(hc_role_from_string("NODE") == HC_ROLE_NODE);
    assert(hc_role_from_string(" Node ") == HC_ROLE_CONTROLLER); /* trimmed by caller */
    assert(hc_role_from_string("controller") == HC_ROLE_CONTROLLER);
    /* Anything unknown keeps the legacy behaviour: a Controller. */
    assert(hc_role_from_string(NULL) == HC_ROLE_CONTROLLER);
    assert(hc_role_from_string("") == HC_ROLE_CONTROLLER);
    assert(hc_role_from_string("espnow-node") == HC_ROLE_CONTROLLER);

    assert(strcmp(hc_node_link_name(HC_NODE_LINKED), "linked") == 0);
    assert(strcmp(hc_node_link_name(HC_NODE_CONTROLLER_LOST), "controller_lost") == 0);
    assert(strcmp(hc_node_link_name(HC_NODE_STANDALONE), "standalone") == 0);
    assert(strcmp(hc_node_link_name(HC_NODE_UNASSIGNED), "unassigned") == 0);
}

static void test_node_linked_keeps_only_espnow(void) {
    hc_role_state_t st;
    hc_role_state_init(&st, HC_ROLE_NODE);
    hc_role_input_t in = node_input();

    uint32_t act = hc_role_node_step(&st, &in, 500);
    assert(st.link == HC_NODE_LINKED);
    assert((act & HC_ROLE_ACT_ESPNOW_SEEK) != 0);
    assert((act & HC_ROLE_ACT_KEEP_WIFI) != 0);
    /* Normal operation runs no independent MQTT session. */
    assert((act & HC_ROLE_ACT_START_MQTT) == 0);
    assert((act & HC_ROLE_ACT_STOP_MQTT) != 0);
    assert(st.standalone == false);
}

static void test_node_unassigned_uses_cloud(void) {
    hc_role_state_t st;
    hc_role_state_init(&st, HC_ROLE_NODE);
    hc_role_input_t in = node_input();
    in.assigned = false;

    uint32_t act = hc_role_node_step(&st, &in, 500);
    assert(st.link == HC_NODE_UNASSIGNED);
    assert((act & HC_ROLE_ACT_START_MQTT) != 0);
    assert((act & HC_ROLE_ACT_ESPNOW_SEEK) == 0);
}

static void test_controller_loss_retries_before_fallback(void) {
    hc_role_state_t st;
    hc_role_state_init(&st, HC_ROLE_NODE);
    hc_role_input_t in = node_input();

    assert(hc_role_node_step(&st, &in, 500) ==
           (HC_ROLE_ACT_KEEP_WIFI | HC_ROLE_ACT_ESPNOW_SEEK | HC_ROLE_ACT_STOP_MQTT));

    /* Controller stops answering. */
    in.controller_online = false;
    in.ms_since_controller = HC_ROLE_LINK_TIMEOUT_MS + 1000u;

    uint32_t act = hc_role_node_step(&st, &in, 500);
    assert(st.link == HC_NODE_CONTROLLER_LOST);
    assert((act & HC_ROLE_ACT_REPORT_STATE) != 0);
    /* Still retrying the assigned Controller: no Wi-Fi/MQTT fallback yet. */
    assert((act & HC_ROLE_ACT_START_MQTT) == 0);

    /* Keep ticking inside the reconnection window. */
    uint32_t elapsed = 500;
    while (elapsed < HC_ROLE_RECONNECT_WINDOW_MS - 1000u) {
        act = hc_role_node_step(&st, &in, 500);
        elapsed += 500;
        assert(st.link == HC_NODE_CONTROLLER_LOST);
        assert((act & HC_ROLE_ACT_START_MQTT) == 0);
    }
    assert(st.standalone == false);
}

static void test_controller_loss_falls_back_to_standalone_node(void) {
    hc_role_state_t st;
    hc_role_state_init(&st, HC_ROLE_NODE);
    hc_role_input_t in = node_input();
    hc_role_node_step(&st, &in, 500);

    in.controller_online = false;
    in.ms_since_controller = 60000u;

    uint32_t elapsed = 0;
    uint32_t act = 0;
    bool saw_standalone = false;
    while (elapsed <= HC_ROLE_RECONNECT_WINDOW_MS + 5000u) {
        act = hc_role_node_step(&st, &in, 500);
        elapsed += 500;
        if (st.link == HC_NODE_STANDALONE) {
            saw_standalone = true;
            break;
        }
    }
    assert(saw_standalone);
    assert(st.standalone == true);
    assert((act & HC_ROLE_ACT_START_MQTT) != 0);
    assert((act & HC_ROLE_ACT_KEEP_WIFI) != 0);
    assert((act & HC_ROLE_ACT_REPORT_STATE) != 0);

    /* The device is still a Node: no role promotion happens on the device. */
    assert(in.role == HC_ROLE_NODE);
}

static void test_standalone_node_reconnects_when_controller_returns(void) {
    hc_role_state_t st;
    hc_role_state_init(&st, HC_ROLE_NODE);
    hc_role_input_t in = node_input();
    hc_role_node_step(&st, &in, 500);

    in.controller_online = false;
    in.ms_since_controller = 60000u;
    uint32_t elapsed = 0;
    uint32_t act = 0;
    while (st.link != HC_NODE_STANDALONE && elapsed < HC_ROLE_RECONNECT_WINDOW_MS + 10000u) {
        act = hc_role_node_step(&st, &in, 500);
        elapsed += 500;
    }
    assert(st.link == HC_NODE_STANDALONE);

    /* It keeps probing the Controller while standalone. */
    bool probed = false;
    for (int i = 0; i < 60; i++) {
        act = hc_role_node_step(&st, &in, 500);
        if ((act & HC_ROLE_ACT_ESPNOW_SEEK) != 0) probed = true;
    }
    assert(probed);

    /* Controller returns: back to normal ESP-NOW operation, MQTT dropped. */
    const uint16_t epoch_before = st.epoch;
    in.controller_online = true;
    in.ms_since_controller = 100u;
    act = hc_role_node_step(&st, &in, 500);
    assert(st.link == HC_NODE_LINKED);
    assert(st.standalone == false);
    assert(st.lost_ms == 0);
    assert((act & HC_ROLE_ACT_STOP_MQTT) != 0);
    assert((act & HC_ROLE_ACT_REPORT_STATE) != 0);
    assert(st.epoch != epoch_before);
}

static void test_node_without_espnow_stays_cloud_connected(void) {
    hc_role_state_t st;
    hc_role_state_init(&st, HC_ROLE_NODE);
    hc_role_input_t in = node_input();
    in.has_espnow = false;

    uint32_t act = hc_role_node_step(&st, &in, 500);
    assert(st.link == HC_NODE_STANDALONE);
    assert((act & HC_ROLE_ACT_START_MQTT) != 0);
    assert((act & HC_ROLE_ACT_ESPNOW_SEEK) == 0);
}

static void test_node_without_wifi_is_honest(void) {
    hc_role_state_t st;
    hc_role_state_init(&st, HC_ROLE_NODE);
    hc_role_input_t in = node_input();
    in.has_wifi = false;
    in.has_espnow = false;

    uint32_t act = hc_role_node_step(&st, &in, 500);
    assert(st.link == HC_NODE_UNASSIGNED);
    assert((act & HC_ROLE_ACT_KEEP_WIFI) != 0); /* no radio: nothing to tear down */
    assert((act & HC_ROLE_ACT_ESPNOW_SEEK) == 0);
}

static void test_ota_window_opens_and_closes_mqtt(void) {
    hc_role_state_t st;
    hc_role_state_init(&st, HC_ROLE_NODE);
    hc_role_input_t in = node_input();
    hc_role_node_step(&st, &in, 500);

    /* OTA is authorised over EMQX: the Node keeps its Wi-Fi session up while the
       download runs, then returns to plain ESP-NOW. */
    in.ota_window = true;
    uint32_t act = hc_role_node_step(&st, &in, 500);
    assert((act & HC_ROLE_ACT_START_MQTT) != 0);
    assert((act & HC_ROLE_ACT_OTA_WINDOW) != 0);
    assert(st.ota_window_open == true);
    assert(st.link == HC_NODE_LINKED);

    in.ota_window = false;
    act = hc_role_node_step(&st, &in, 500);
    assert((act & HC_ROLE_ACT_STOP_MQTT) != 0);
    assert((act & HC_ROLE_ACT_OTA_WINDOW) == 0);
    assert(st.ota_window_open == false);
}

static void test_controller_step_hosts_nodes_and_cloud(void) {
    hc_role_state_t st;
    hc_role_state_init(&st, HC_ROLE_CONTROLLER);
    hc_role_input_t in = node_input();
    in.role = HC_ROLE_CONTROLLER;

    uint32_t act = hc_role_controller_step(&st, &in);
    assert((act & HC_ROLE_ACT_START_MQTT) != 0);
    assert((act & HC_ROLE_ACT_ESPNOW_HOST) != 0);
    assert((act & HC_ROLE_ACT_ESPNOW_SEEK) == 0);
    assert(st.standalone == false);

    /* Feeding a Controller through the Node entry point keeps it a Controller. */
    act = hc_role_node_step(&st, &in, 500);
    assert((act & HC_ROLE_ACT_ESPNOW_HOST) != 0);
    assert((act & HC_ROLE_ACT_START_MQTT) != 0);
}

static void test_node_staleness(void) {
    assert(hc_role_node_is_stale(HC_ROLE_NODE_STALE_MS + 1u, 0));
    assert(!hc_role_node_is_stale(HC_ROLE_NODE_STALE_MS - 1u, 0));
    /* Clock wrap / reboot: a "future" stamp is not stale. */
    assert(!hc_role_node_is_stale(1000u, 5000u));
}

static void test_role_change_guards(void) {
    /* Free promotion and free demotion when nothing depends on the Controller. */
    assert(hc_role_can_change(HC_ROLE_NODE, HC_ROLE_CONTROLLER, 0, false, true));
    assert(hc_role_can_change(HC_ROLE_CONTROLLER, HC_ROLE_NODE, 0, false, true));
    assert(hc_role_can_change(HC_ROLE_CONTROLLER, HC_ROLE_CONTROLLER, 5, false, true));

    /* A Controller hosting Nodes may not be demoted silently. */
    assert(!hc_role_can_change(HC_ROLE_CONTROLLER, HC_ROLE_NODE, 3, false, true));
    assert(hc_role_can_change(HC_ROLE_CONTROLLER, HC_ROLE_NODE, 3, true, true));

    /* Boards without ESP-NOW/Wi-Fi can never be Controllers. */
    assert(!hc_role_can_change(HC_ROLE_NODE, HC_ROLE_CONTROLLER, 0, false, false));
}

static void test_command_dedupe_across_transitions(void) {
    uint16_t last_epoch = 0;
    uint32_t last_seq = 0;

    assert(hc_role_accept_command(1, 10, &last_epoch, &last_seq));
    /* Duplicate delivery of the same command must not run twice. */
    assert(!hc_role_accept_command(1, 10, &last_epoch, &last_seq));
    assert(!hc_role_accept_command(1, 9, &last_epoch, &last_seq));
    assert(hc_role_accept_command(1, 11, &last_epoch, &last_seq));

    /* A new link epoch re-opens the window even for a lower sequence number. */
    assert(hc_role_accept_command(2, 1, &last_epoch, &last_seq));
    /* Late packets from the previous transport are dropped. */
    assert(!hc_role_accept_command(1, 99, &last_epoch, &last_seq));
    assert(hc_role_accept_command(2, 2, &last_epoch, &last_seq));
}

static void test_epoch_bump_reopens_command_window(void) {
    hc_role_state_t st;
    hc_role_state_init(&st, HC_ROLE_CONTROLLER);
    assert(st.epoch == 1);

    uint16_t last_epoch = 0;
    uint32_t last_seq = 0;
    /* The Controller sent up to seq 500 before it rebooted. */
    assert(hc_role_accept_command(1, 500, &last_epoch, &last_seq));
    /* After the reboot the sequence restarts at 1: only a new epoch saves it. */
    assert(!hc_role_accept_command(1, 1, &last_epoch, &last_seq));

    hc_role_bump_epoch(&st);
    assert(st.epoch == 2);
    assert(hc_role_accept_command(st.epoch, 1, &last_epoch, &last_seq));
    assert(!hc_role_accept_command(st.epoch, 1, &last_epoch, &last_seq));

    /* Wraparound never produces epoch 0. */
    st.epoch = 65535;
    hc_role_bump_epoch(&st);
    assert(st.epoch == 1);
    hc_role_bump_epoch(NULL); /* safe */
}

int main(void) {
    test_role_names_and_parsing();
    test_node_linked_keeps_only_espnow();
    test_node_unassigned_uses_cloud();
    test_controller_loss_retries_before_fallback();
    test_controller_loss_falls_back_to_standalone_node();
    test_standalone_node_reconnects_when_controller_returns();
    test_node_without_espnow_stays_cloud_connected();
    test_node_without_wifi_is_honest();
    test_ota_window_opens_and_closes_mqtt();
    test_controller_step_hosts_nodes_and_cloud();
    test_node_staleness();
    test_role_change_guards();
    test_command_dedupe_across_transitions();
    test_epoch_bump_reopens_command_window();
    printf("test_role_logic: all assertions passed\n");
    return 0;
}

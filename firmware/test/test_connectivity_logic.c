#include "../main/connectivity_logic.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static hc_connectivity_caps_t wifi_caps(void) {
    hc_connectivity_caps_t caps = {
        .has_wifi = true,
        .has_mqtt = true,
        .has_espnow = true,
        .can_controller = true,
        .can_node = true,
        .espnow_mtu_bytes = 200,
        .espnow_peer_limit = 8,
        .max_controller_nodes = 4,
        .keepalive_ms = 2000,
        .link_timeout_ms = 10000,
        .recovery_window_ms = 45000,
        .discovery_interval_ms = 15000,
    };
    return caps;
}

static hc_connectivity_input_t node_input(void) {
    hc_connectivity_input_t in;
    memset(&in, 0, sizeof(in));
    in.assigned = true;
    in.binding = HC_BINDING_ASSIGNED;
    in.generation = 4;
    in.peer_generation = 0;
    in.telemetry_fresh = true;
    in.node_mqtt_healthy = true;
    return in;
}

static void test_capability_is_not_inferred(void) {
    hc_connectivity_state_t st;
    hc_connectivity_caps_t none;
    memset(&none, 0, sizeof(none));
    hc_connectivity_init(&st, &none);
    hc_connectivity_input_t in = node_input();
    hc_connectivity_output_t out = hc_connectivity_step(&st, &in, 500);
    assert(out.espnow == HC_ESPNOW_UNAVAILABLE);
    assert(out.cloud == HC_CLOUD_UNAVAILABLE);
    assert(!out.start_espnow);
    assert(!out.keep_node_mqtt);
}

static void test_assignment_never_closes_working_mqtt(void) {
    hc_connectivity_state_t st;
    hc_connectivity_caps_t caps = wifi_caps();
    hc_connectivity_init(&st, &caps);
    hc_connectivity_input_t in = node_input();

    for (int i = 0; i < 30; ++i) {
        hc_connectivity_output_t out = hc_connectivity_step(&st, &in, 500);
        assert(out.keep_node_mqtt);
        assert(out.cloud == HC_CLOUD_DIRECT_NODE_MQTT);
    }
    in.binding = HC_BINDING_VERIFIED;
    in.espnow_ack_verified = true;
    in.peer_generation = in.generation;
    in.controller_mqtt_healthy = true;
    in.in_roster = true;
    for (int i = 0; i < 10; ++i) {
        hc_connectivity_output_t out = hc_connectivity_step(&st, &in, 500);
        /* relay exists but is not confirmed -> MQTT stays up */
        assert(out.cloud == HC_CLOUD_CONTROLLER_MQTT);
        assert(out.keep_node_mqtt);
    }
}

static void test_confirmed_relay_closes_mqtt_only_after_handoff(void) {
    hc_connectivity_state_t st;
    hc_connectivity_caps_t caps = wifi_caps();
    hc_connectivity_init(&st, &caps);
    hc_connectivity_input_t in = node_input();
    in.binding = HC_BINDING_VERIFIED;
    in.espnow_ack_verified = true;
    in.peer_generation = in.generation;
    in.controller_mqtt_healthy = true;
    in.in_roster = true;

    hc_connectivity_step(&st, &in, 500);
    hc_connectivity_confirm_route(&st, in.generation, HC_CLOUD_CONTROLLER_MQTT);
    hc_connectivity_output_t out = hc_connectivity_step(&st, &in, 500);
    assert(out.cloud == HC_CLOUD_CONTROLLER_MQTT);
    assert(!out.keep_node_mqtt);

    /* Controller cloud fails: direct MQTT is restored without re-pairing. */
    in.controller_mqtt_healthy = false;
    out = hc_connectivity_step(&st, &in, 500);
    assert(out.cloud == HC_CLOUD_DIRECT_NODE_MQTT);
    assert(out.keep_node_mqtt);
    assert(st.generation == 4);
}

static void test_link_loss_keeps_direct_route(void) {
    hc_connectivity_state_t st;
    hc_connectivity_caps_t caps = wifi_caps();
    hc_connectivity_init(&st, &caps);
    hc_connectivity_input_t in = node_input();
    in.espnow_ack_verified = true;
    in.peer_generation = in.generation;
    hc_connectivity_step(&st, &in, 500);
    in.espnow_ack_verified = false;
    in.peer_generation = 0;

    hc_connectivity_output_t out = hc_connectivity_step(&st, &in, 500);
    assert(out.espnow == HC_ESPNOW_LOST);
    assert(out.keep_node_mqtt);
    assert(out.cloud == HC_CLOUD_DIRECT_NODE_MQTT);

    for (int i = 0; i < 100; ++i) out = hc_connectivity_step(&st, &in, 500);
    assert(out.espnow == HC_ESPNOW_SEARCHING);
    assert(out.keep_node_mqtt);
}

static void test_cloud_only_node_never_seeks(void) {
    hc_connectivity_state_t st;
    hc_connectivity_caps_t caps = wifi_caps();
    caps.has_espnow = false;
    hc_connectivity_init(&st, &caps);
    hc_connectivity_input_t in = node_input();
    in.espnow_ack_verified = true;
    hc_connectivity_output_t out = hc_connectivity_step(&st, &in, 500);
    assert(out.espnow == HC_ESPNOW_UNAVAILABLE);
    assert(!out.start_espnow);
    assert(out.cloud == HC_CLOUD_DIRECT_NODE_MQTT);
}

static void test_controller_keeps_services_independent(void) {
    hc_connectivity_state_t st;
    hc_connectivity_caps_t caps = wifi_caps();
    hc_connectivity_init(&st, &caps);
    hc_connectivity_input_t in;
    memset(&in, 0, sizeof(in));
    in.is_controller = true;
    in.controller_mqtt_healthy = false;
    hc_connectivity_output_t out = hc_connectivity_step(&st, &in, 500);
    assert(out.host_espnow);
    assert(out.espnow == HC_ESPNOW_LINKED);
    assert(out.cloud == HC_CLOUD_UNAVAILABLE);
}

static void test_generation_authority(void) {
    hc_connectivity_state_t st;
    hc_connectivity_init(&st, NULL);
    st.generation = 7;
    assert(hc_connectivity_accept_generation(&st, 7, "b-7", "b-7"));
    assert(!hc_connectivity_accept_generation(&st, 6, "b-6", "b-7"));
    assert(!hc_connectivity_accept_generation(&st, 8, "b-8", "b-7"));
    assert(!hc_connectivity_accept_generation(&st, 7, "b-6", "b-7"));
}

static void test_dedupe_ring_is_bounded(void) {
    hc_command_dedupe_t ring;
    hc_command_dedupe_reset(&ring);
    assert(hc_command_dedupe_accept(&ring, 2, "cmd-1"));
    assert(!hc_command_dedupe_accept(&ring, 2, "cmd-1"));
    assert(hc_command_dedupe_accept(&ring, 3, "cmd-1")); /* new generation */
    for (int i = 0; i < 100; ++i) {
        char id[16];
        snprintf(id, sizeof(id), "c%d", i);
        assert(hc_command_dedupe_accept(&ring, 3, id));
    }
    assert(ring.count == HC_DEDUPE_RING_SIZE);
}

static void test_route_selection_rules(void) {
    assert(hc_select_cloud_route(false, true, true, true, true) == HC_CLOUD_UNAVAILABLE);
    assert(hc_select_cloud_route(true, true, false, false, false) == HC_CLOUD_DIRECT_NODE_MQTT);
    assert(hc_select_cloud_route(true, true, true, true, true) == HC_CLOUD_CONTROLLER_MQTT);
    assert(hc_select_cloud_route(true, false, true, false, false) == HC_CLOUD_UNAVAILABLE);
}

int main(void) {
    test_capability_is_not_inferred();
    test_assignment_never_closes_working_mqtt();
    test_confirmed_relay_closes_mqtt_only_after_handoff();
    test_link_loss_keeps_direct_route();
    test_cloud_only_node_never_seeks();
    test_controller_keeps_services_independent();
    test_generation_authority();
    test_dedupe_ring_is_bounded();
    test_route_selection_rules();
    puts("connectivity_logic tests passed");
    return 0;
}

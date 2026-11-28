# Compile-time board capability profile. The canonical JSON registry is
# generated into this build directory for the exact CONFIG_HOMECORE_BOARD_SLUG,
# so a firmware image can never use another board's radio limits or roles.
set(HC_GENERATED_DIR "${CMAKE_CURRENT_BINARY_DIR}/generated")
file(MAKE_DIRECTORY "${HC_GENERATED_DIR}")
set(HC_SELECTED_BOARD_SLUG "${CONFIG_HOMECORE_BOARD_SLUG}")
if(NOT HC_SELECTED_BOARD_SLUG)
    set(HC_SELECTED_BOARD_SLUG "esp32-s3-devkitc-1-n16r8")
endif()
execute_process(
    COMMAND python3 "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/generate_board_capabilities.py"
            --slug "${HC_SELECTED_BOARD_SLUG}" --out-dir "${HC_GENERATED_DIR}"
    RESULT_VARIABLE HC_CAPABILITY_GEN_RESULT
    OUTPUT_VARIABLE HC_CAPABILITY_GEN_OUTPUT
    ERROR_VARIABLE HC_CAPABILITY_GEN_ERROR
)
if(NOT HC_CAPABILITY_GEN_RESULT EQUAL 0)
    message(FATAL_ERROR "Board capability generation failed: ${HC_CAPABILITY_GEN_ERROR}")
endif()

set(HC_REQUIRES
    nvs_flash
    esp_netif
    esp_event
    esp_http_server
    esp_http_client
    esp_https_ota
    mqtt
    json
    driver
    esp_adc
    app_update
    mbedtls
    esp_timer
)

if(NOT IDF_TARGET STREQUAL "esp32h2")
    # ESP-NOW (esp_now.h / esp_now_* symbols) is built into the esp_wifi
    # component in ESP-IDF v5.x; there is no separate "esp_now" component, and
    # requiring one makes CMake fail to resolve the component for every Wi-Fi
    # target while the H2 build still passes.
    list(APPEND HC_REQUIRES esp_wifi)
endif()

if(NOT IDF_TARGET STREQUAL "esp32s2")
    list(APPEND HC_REQUIRES bt)
endif()

idf_component_register(
    SRCS
        "main.c"
        "nvs_store.c"
        "wifi_portal.c"
        "ble_provisioning.c"
        "ble_protocol_logic.c"
        "provisioning_logic.c"
        "pairing_client.c"
        "io_manager.c"
        "io_state_logic.c"
        "sensor_driver_logic.c"
        "sensor_drivers.c"
        "ota_boot_logic.c"
        "ota_manager.c"
        "mqtt_manager.c"
        "board_log.c"
        "role_logic.c"
        "role_runtime.c"
        "connectivity_logic.c"
        "transport.c"
        "espnow_link.c"
        "recovery_logic.c"
        "recovery_console.c"
    INCLUDE_DIRS "." "${HC_GENERATED_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}/generated"
    REQUIRES ${HC_REQUIRES}
)

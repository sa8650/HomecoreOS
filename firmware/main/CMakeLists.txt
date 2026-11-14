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
    app_update
    mbedtls
    esp_timer
)

if(NOT IDF_TARGET STREQUAL "esp32h2")
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
        "provisioning_logic.c"
        "pairing_client.c"
        "io_manager.c"
        "io_state_logic.c"
        "ota_boot_logic.c"
        "ota_manager.c"
        "mqtt_manager.c"
    INCLUDE_DIRS "."
    REQUIRES ${HC_REQUIRES}
)

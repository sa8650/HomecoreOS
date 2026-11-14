cmake_minimum_required(VERSION 3.16)

if(DEFINED HOMECORE_FW_VERSION AND NOT "${HOMECORE_FW_VERSION}" STREQUAL "")
    set(PROJECT_VER "${HOMECORE_FW_VERSION}")
elseif(DEFINED ENV{HOMECORE_FW_VERSION} AND NOT "$ENV{HOMECORE_FW_VERSION}" STREQUAL "")
    set(PROJECT_VER "$ENV{HOMECORE_FW_VERSION}")
else()
    set(PROJECT_VER "1.2.0")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(homecoreos)

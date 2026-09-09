cmake_minimum_required(VERSION 3.22.1)

project(tachi_qnn_probe LANGUAGES CXX)

add_library(tachi_qnn_probe SHARED qnn_probe.cpp)

target_include_directories(tachi_qnn_probe PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/qnn_include
    ${CMAKE_CURRENT_SOURCE_DIR}/qnn_include/QNN
    ${CMAKE_CURRENT_SOURCE_DIR}/qnn_include/QNN/HTP
)

target_compile_features(tachi_qnn_probe PRIVATE cxx_std_17)
target_compile_options(tachi_qnn_probe PRIVATE -fvisibility=hidden -Wall -Wextra -Werror=return-type)
target_link_libraries(tachi_qnn_probe PRIVATE log dl)

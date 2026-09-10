cmake_minimum_required(VERSION 3.22.1)

project(tachi_qnn_probe LANGUAGES CXX)

add_library(tachi_qnn_probe SHARED qnn_probe.cpp)
set(QNN_INCLUDE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/qnn_include" CACHE PATH "Headers from the deployed QAIRT release")

target_include_directories(tachi_qnn_probe PRIVATE
    ${QNN_INCLUDE_ROOT}
    ${QNN_INCLUDE_ROOT}/QNN
    ${QNN_INCLUDE_ROOT}/QNN/HTP
)

target_compile_features(tachi_qnn_probe PRIVATE cxx_std_17)
target_compile_options(tachi_qnn_probe PRIVATE -fvisibility=hidden -Wall -Wextra -Werror=return-type)
target_link_libraries(tachi_qnn_probe PRIVATE log dl)

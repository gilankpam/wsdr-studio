# SPDX-License-Identifier: GPL-2.0-only
# wsdr-studio: backend (wsdr-studiod) + tests. The web UI (web/) is built with npm and served by the
# backend. wifi-sdr (and through it devourer) comes in as a pinned submodule.
cmake_minimum_required(VERSION 3.21)
project(wsdr_studio CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

if(NOT EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/external/wifi-sdr/CMakeLists.txt)
  message(FATAL_ERROR "external/wifi-sdr missing: git submodule update --init external/wifi-sdr && "
                      "git -C external/wifi-sdr submodule update --init external/devourer")
endif()
add_subdirectory(external/wifi-sdr wifi-sdr EXCLUDE_FROM_ALL)

find_package(PkgConfig REQUIRED)
pkg_check_modules(FFTW3F REQUIRED IMPORTED_TARGET fftw3f)
find_package(nlohmann_json 3 REQUIRED)
find_package(Boost 1.74 REQUIRED CONFIG COMPONENTS headers)
find_package(Threads REQUIRED)

# FFT backend: FFTW here; pocketfft (header-only, external/pocketfft) is what the web build uses, and
# test_core_pocketfft runs the same tests against it.
set(WSDR_FFT "fftw" CACHE STRING "FFT backend: fftw | pocketfft")
include(src/sources.cmake)
function(studio_core_lib name fft)
  add_library(${name} STATIC ${STUDIO_CORE_SOURCES} src/fft_${fft}.cpp)
  target_include_directories(${name} PUBLIC src)
  target_link_libraries(${name} PUBLIC wsdrcore iqdsp nlohmann_json::nlohmann_json Threads::Threads)
  if(fft STREQUAL "fftw")
    target_link_libraries(${name} PRIVATE PkgConfig::FFTW3F)
  else()
    target_include_directories(${name} PRIVATE external/pocketfft)
  endif()
  target_compile_options(${name} PRIVATE -Wall -Wextra)
endfunction()
studio_core_lib(studio_core ${WSDR_FFT})

add_executable(wsdr-studiod src/main.cpp src/server.cpp)
target_link_libraries(wsdr-studiod studio_core Boost::headers)
target_compile_definitions(wsdr-studiod PRIVATE WSDR_STUDIO_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(wsdr-studiod PRIVATE -Wall -Wextra)
install(TARGETS wsdr-studiod RUNTIME DESTINATION bin)
install(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/web/dist/ DESTINATION share/wsdr-studio/web OPTIONAL)

add_executable(test_core tests/test_core.cpp)
target_link_libraries(test_core studio_core)
enable_testing()
add_test(NAME core COMMAND test_core)
if(NOT WSDR_FFT STREQUAL "pocketfft")
  studio_core_lib(studio_core_pocketfft pocketfft)
  add_executable(test_core_pocketfft tests/test_core.cpp)
  target_link_libraries(test_core_pocketfft studio_core_pocketfft)
  add_test(NAME core_pocketfft COMMAND test_core_pocketfft)
endif()

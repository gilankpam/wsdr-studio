# SPDX-License-Identifier: GPL-2.0-only
# The web build: the wifi-sdr receive core (and devourer) compiled to WebAssembly, talking to the dongle
# through WebUSB via libusb's Emscripten backend.
#   wsdr-core.{js,wasm}   the app's engine (src/, studio::Studio) behind a worker (wasm/core.cpp); jspi only
#   wsdr-probe.{js,wasm}  the spike's probe: list adapters, bring one up, stream, report (wasm/README.md)
cmake_minimum_required(VERSION 3.21)
project(wsdr_wasm C CXX)
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "configure with emcmake (see wasm/build.sh)")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# JSPI (Chrome's JS Promise Integration) or ASYNCIFY: how blocking libusb calls wait for WebUSB promises.
set(WSDR_ASYNC "jspi" CACHE STRING "jspi | asyncify")
# JSPI cannot suspend through the JS invoke_* wrappers of JS-based exceptions: it needs wasm exceptions.
# Asyncify does not support wasm exceptions. -pthread: libusb's Emscripten event loop uses wasm atomics,
# so memory is shared (the page must be cross-origin isolated); no thread is ever started.
if(WSDR_ASYNC STREQUAL "jspi")
  set(WSDR_EXC_FLAGS -fwasm-exceptions -pthread)
  set(WSDR_ASYNC_LINK -sJSPI)
  set(WSDR_PROBE_ASYNC -sJSPI_EXPORTS=probe_list,probe_stream,probe_usb3,probe_rx)
else()
  set(WSDR_EXC_FLAGS -fexceptions -pthread)
  set(WSDR_ASYNC_LINK -sASYNCIFY -sASYNCIFY_STACK_SIZE=262144)
endif()
add_compile_options(${WSDR_EXC_FLAGS})
# Every web target: a fixed heap (growth + pthreads slows every JS heap access, the USB copies among
# them), threads from a pool (the engine starts ~12), 1 MB pthread stacks (the 64 KB default is tight).
set(WSDR_WEB_LINK ${WSDR_EXC_FLAGS} ${WSDR_ASYNC_LINK} -lembind -sENVIRONMENT=web,worker -sMODULARIZE -sEXPORT_ES6
    -sINITIAL_MEMORY=512MB -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB -sPTHREAD_POOL_SIZE=16)

add_subdirectory(../external/wifi-sdr wifi-sdr EXCLUDE_FROM_ALL)
# The thread-free Receiver helpers (channel_for, igi_for, ...) live in receiver.cpp, part of wsdrcore.

add_executable(wsdr-probe probe.cpp)
target_link_libraries(wsdr-probe wsdrcore)
# pkg-config's imported libusb target loses its -L under Emscripten's find-root rules
set(LIBUSB_PREFIX "" CACHE PATH "where wasm/libusb installed libusb-1.0.a")
target_link_directories(wsdr-probe PRIVATE ${LIBUSB_PREFIX}/lib)
target_link_options(wsdr-probe PRIVATE ${WSDR_WEB_LINK} ${WSDR_PROBE_ASYNC} -sEXPORT_NAME=createProbe
  -sEXPORTED_FUNCTIONS=_probe_list,_probe_stream,_probe_usb3,_probe_rx,_main -sEXPORTED_RUNTIME_METHODS=ccall)
set_target_properties(wsdr-probe PROPERTIES SUFFIX ".js")

if(WSDR_ASYNC STREQUAL "jspi")
  include(../src/sources.cmake)
  set(NLOHMANN_INCLUDE "" CACHE PATH "directory holding nlohmann/json.hpp (wasm/build.sh fetches it)")
  add_executable(wsdr-core core.cpp usb_abort.cpp ${STUDIO_CORE_SOURCES} ../src/fft_pocketfft.cpp)
  target_include_directories(wsdr-core PRIVATE ../src ../external/pocketfft ${NLOHMANN_INCLUDE})
  target_link_libraries(wsdr-core wsdrcore iqdsp)
  target_link_directories(wsdr-core PRIVATE ${LIBUSB_PREFIX}/lib)
  target_compile_options(wsdr-core PRIVATE -Wall -Wextra)
  # usb_abort.cpp: WebUSB cannot cancel a transfer; a stopped stream's reads are aborted instead
  target_link_options(wsdr-core PRIVATE ${WSDR_WEB_LINK} -sWASMFS -sEXPORT_NAME=createCore
    -Wl,--wrap=libusb_cancel_transfer -Wl,--wrap=libusb_submit_transfer
    -sEXPORTED_FUNCTIONS=_core_start,_core_client_open,_core_text,_malloc,_free
    -sEXPORTED_RUNTIME_METHODS=stringToNewUTF8)
  set_target_properties(wsdr-core PROPERTIES SUFFIX ".js")

  # tests/test_core.cpp (the DSP and Wi-Fi decoder on synthetic data) as WebAssembly, run under Node:
  # the engine's maths in the web build, checked where no live 20/40 MS/s stream is available.
  add_executable(wsdr-test-core ../tests/test_core.cpp usb_abort.cpp ${STUDIO_CORE_SOURCES} ../src/fft_pocketfft.cpp)
  target_include_directories(wsdr-test-core PRIVATE ../src ../external/pocketfft ${NLOHMANN_INCLUDE})
  target_link_libraries(wsdr-test-core wsdrcore iqdsp)
  target_link_directories(wsdr-test-core PRIVATE ${LIBUSB_PREFIX}/lib)
  # 1.5 GB: the tests synthesise long captures (natively they peak at ~600 MB); the engine needs far less
  target_link_options(wsdr-test-core PRIVATE ${WSDR_EXC_FLAGS} ${WSDR_ASYNC_LINK} -lembind -sENVIRONMENT=node,worker
    -sINITIAL_MEMORY=1536MB -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB -sPTHREAD_POOL_SIZE=16 -sWASMFS
    -sPROXY_TO_PTHREAD -sEXIT_RUNTIME -sNODERAWFS=0
    -Wl,--wrap=libusb_cancel_transfer -Wl,--wrap=libusb_submit_transfer)
  set_target_properties(wsdr-test-core PROPERTIES SUFFIX ".js")
endif()

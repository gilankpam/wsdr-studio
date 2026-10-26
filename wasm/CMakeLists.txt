# SPDX-License-Identifier: GPL-2.0-only
# Spike: the wifi-sdr receive core (and devourer) compiled to WebAssembly, talking to the dongle through
# WebUSB via libusb's Emscripten backend. Builds wsdr-probe.{js,wasm}: list adapters, bring one up,
# stream at a rate and report what arrived. See wasm/README.md.
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
  set(WSDR_ASYNC_LINK -sJSPI -sJSPI_EXPORTS=probe_list,probe_stream,probe_usb3,probe_rx)
else()
  set(WSDR_EXC_FLAGS -fexceptions -pthread)
  set(WSDR_ASYNC_LINK -sASYNCIFY -sASYNCIFY_STACK_SIZE=262144)
endif()
add_compile_options(${WSDR_EXC_FLAGS})

add_subdirectory(../external/wifi-sdr wifi-sdr EXCLUDE_FROM_ALL)
# The thread-free Receiver helpers (channel_for, igi_for, ...) live in receiver.cpp, part of wsdrcore.

add_executable(wsdr-probe probe.cpp)
target_link_libraries(wsdr-probe wsdrcore)
# pkg-config's imported libusb target loses its -L under Emscripten's find-root rules
set(LIBUSB_PREFIX "" CACHE PATH "where wasm/libusb installed libusb-1.0.a")
target_link_directories(wsdr-probe PRIVATE ${LIBUSB_PREFIX}/lib)
target_link_options(wsdr-probe PRIVATE
  ${WSDR_EXC_FLAGS} ${WSDR_ASYNC_LINK}
  -lembind
  -sENVIRONMENT=web,worker
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createProbe
  -sINITIAL_MEMORY=256MB -sSTACK_SIZE=1MB -sPTHREAD_POOL_SIZE=4 # fixed heap: growth + pthreads slows every JS heap access (the USB copies)
  -sEXPORTED_FUNCTIONS=_probe_list,_probe_stream,_probe_usb3,_probe_rx,_main
  -sEXPORTED_RUNTIME_METHODS=ccall)
set_target_properties(wsdr-probe PROPERTIES SUFFIX ".js")

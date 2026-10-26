# The engine's sources (without the FFT backend: fft_fftw.cpp or fft_pocketfft.cpp), shared by the native
# build (CMakeLists.txt) and the web build (wasm/CMakeLists.txt).
set(STUDIO_CORE_SOURCES
  ${CMAKE_CURRENT_LIST_DIR}/dsp.cpp ${CMAKE_CURRENT_LIST_DIR}/protocol.cpp ${CMAKE_CURRENT_LIST_DIR}/device_scan.cpp
  ${CMAKE_CURRENT_LIST_DIR}/recorder.cpp ${CMAKE_CURRENT_LIST_DIR}/engine.cpp ${CMAKE_CURRENT_LIST_DIR}/wifi.cpp
  ${CMAKE_CURRENT_LIST_DIR}/studio.cpp)

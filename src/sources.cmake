# The engine's sources (without the FFT backend: fft_fftw.cpp or fft_pocketfft.cpp), shared by the native
# build (CMakeLists.txt) and the web build (wasm/CMakeLists.txt).
set(STUDIO_CORE_SOURCES
  ${CMAKE_CURRENT_LIST_DIR}/dsp.cpp ${CMAKE_CURRENT_LIST_DIR}/protocol.cpp ${CMAKE_CURRENT_LIST_DIR}/device_scan.cpp
  ${CMAKE_CURRENT_LIST_DIR}/recorder.cpp ${CMAKE_CURRENT_LIST_DIR}/engine.cpp ${CMAKE_CURRENT_LIST_DIR}/wifi.cpp
  ${CMAKE_CURRENT_LIST_DIR}/signals.cpp ${CMAKE_CURRENT_LIST_DIR}/studio.cpp)
# The finder's complex arithmetic without Annex G: no NaN/Inf recovery (nothing there relies on it),
# so a complex product is four multiplies instead of a library call per sample (GCC 11 made every one).
# (Source properties are per directory: set here, in whichever build includes this file.)
set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/wifi.cpp ${CMAKE_CURRENT_LIST_DIR}/signals.cpp
                            PROPERTIES COMPILE_OPTIONS -fcx-limited-range)

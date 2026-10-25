// SPDX-License-Identifier: GPL-2.0-only
// Engine: the app's model. Owns the Receiver (one adapter), the bank ring, the DSP thread and the
// recorder, and executes commands on its own command thread (bring-up blocks for ~5 s; commands that
// arrive meanwhile queue up behind it).
//
// Threads: command thread (open/close/set/record, and every recorder start/stop), stream thread
// (inside Receiver: copies banks into the ring), DSP thread (unpack, FFT, rows, recorder feed; it only
// *requests* recorder stops). Rows and events go out through callbacks, which must not block.
#pragma once

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "device_scan.h"
#include "dsp.h"
#include "receiver.h"
#include "recorder.h"
#include "ring.h"

namespace studio {

using json = nlohmann::json;

class Engine {
public:
  struct Callbacks {
    std::function<void(std::vector<uint8_t> &&frame)> row;  // binary row frame (protocol.h)
    std::function<void(const json &event)> event;           // JSON event for all clients
  };
  Engine(Callbacks cb, std::string record_dir);
  ~Engine();

  // A command from a client ({"cmd": ..., ...}); `reply` gets {"type":"ack"|"error", ...}. Non-blocking.
  void submit(json cmd, std::function<void(const json &)> reply);
  // Call periodically (any thread): notices a lost adapter and closes it.
  void poll();
  json status() const;   // {"type":"status", ...}
  json settings() const; // {"type":"settings", rx, dsp}
  json caps() const;     // {"type":"caps", ...} (open:false if closed)
  static json devices_json(const std::vector<DeviceInfo> &d);

  uint64_t rows_emitted() const { return _rows; }
  uint64_t ring_dropped() const { return _ring.dropped(); }
  double dsp_load() const { return _dsp_load; }

private:
  void cmd_loop();
  void dsp_loop();
  json run(const json &c); // on the command thread; throws -> error reply
  void open_adapter(uint16_t pid, const json &c);
  void close_adapter();
  void stop_recording(const std::string &why);
  std::shared_ptr<wsdr::Receiver> rx() const {
    std::lock_guard<std::mutex> l(_rxm);
    return _rx;
  }

  Callbacks _cb;
  mutable std::mutex _rxm;
  std::shared_ptr<wsdr::Receiver> _rx; // replaced on the command thread, read anywhere via rx()
  BankRing _ring{512};
  Recorder _rec;

  std::mutex _qm;
  std::condition_variable _qcv;
  std::deque<std::pair<json, std::function<void(const json &)>>> _q;
  bool _quit = false;
  std::thread _cmd, _dsp;

  mutable std::mutex _dm; // DSP settings handoff (command thread -> DSP thread)
  DspConfig _dsp_cfg;
  bool _dsp_dirty = true;
  std::atomic<bool> _dsp_quit{false};

  std::atomic<bool> _recording{false}; // DSP thread feeds the recorder while set
  std::atomic<int> _rec_path{0};       // path fixed when the recording started
  std::atomic<uint32_t> _rec_gen{0}, _rec_cfg{0}; // the stream run the file belongs to
  std::atomic<uint64_t> _rec_id{0};               // counts recordings: stale stop requests are ignored
  std::atomic<bool> _rec_stop_requested{false}, _lost_requested{false};

  mutable std::mutex _sm; // status strings
  std::string _state = "closed", _error, _adapter;
  int _open_bus = -1;     // the open device (caps: which adapter is open)
  std::string _open_port;
  wsdr::RxCaps _caps;

  std::atomic<uint64_t> _rows{0};
  std::atomic<double> _dsp_load{0};
};

} // namespace studio

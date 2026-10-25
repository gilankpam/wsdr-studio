// SPDX-License-Identifier: GPL-2.0-only
// Bounded queue of raw LA banks between the stream thread (producer: the libusb event thread, which
// must never block) and the DSP thread. Buffers are preallocated; when full, the oldest bank is
// dropped and counted, so a slow consumer never back-pressures the chip.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <mutex>
#include <vector>

#include "receiver.h"

namespace studio {

struct Bank {
  std::vector<uint8_t> data;
  size_t bytes = 0;
  wsdr::BankMeta meta;
};

class BankRing {
public:
  explicit BankRing(size_t slots, size_t bank_bytes = 65536) {
    _pool.resize(slots);
    for (auto &b : _pool) {
      b.data.resize(bank_bytes);
      _free.push_back(&b);
    }
  }

  // Producer: copy one bank in. Never blocks; drops the oldest queued bank if no buffer is free.
  void push(const uint8_t *p, size_t n, const wsdr::BankMeta &m) {
    std::unique_lock<std::mutex> l(_m);
    Bank *b;
    if (!_free.empty()) {
      b = _free.back();
      _free.pop_back();
    } else {
      b = _q.front();
      _q.pop_front();
      _dropped++;
    }
    n = std::min(n, b->data.size());
    std::memcpy(b->data.data(), p, n);
    b->bytes = n;
    b->meta = m;
    _q.push_back(b);
    l.unlock();
    _cv.notify_one();
  }

  // Consumer: next bank or nullptr on timeout / wake(). Call release() when done with it.
  Bank *pop(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> l(_m);
    _cv.wait_for(l, timeout, [&] { return !_q.empty() || _woken; });
    _woken = false;
    if (_q.empty())
      return nullptr;
    Bank *b = _q.front();
    _q.pop_front();
    return b;
  }
  void release(Bank *b) {
    std::lock_guard<std::mutex> l(_m);
    _free.push_back(b);
  }
  void wake() {
    {
      std::lock_guard<std::mutex> l(_m);
      _woken = true;
    }
    _cv.notify_all();
  }
  void clear() {
    std::lock_guard<std::mutex> l(_m);
    while (!_q.empty()) {
      _free.push_back(_q.front());
      _q.pop_front();
    }
  }
  uint64_t dropped() const { return _dropped; }

private:
  std::mutex _m;
  std::condition_variable _cv;
  std::vector<Bank> _pool;
  std::vector<Bank *> _free;
  std::deque<Bank *> _q;
  std::atomic<uint64_t> _dropped{0};
  bool _woken = false;
};

} // namespace studio

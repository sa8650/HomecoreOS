// Minimal Arduino shim so the firmware headers can be compiled on the host.
#pragma once
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <string>
namespace Arduino {
class String {
 public:
  String() = default;
  String(const char *s) : s_(s ? s : "") {}
  const char *c_str() const { return s_.c_str(); }
  size_t length() const { return s_.size(); }
  bool equalsIgnoreCase(const String &o) const {
    if (s_.size() != o.s_.size()) return false;
    for (size_t i = 0; i < s_.size(); ++i) {
      char a = s_[i], b = o.s_[i];
      if (a >= 'A' && a <= 'Z') a = static_cast<char>(a - 'A' + 'a');
      if (b >= 'A' && b <= 'Z') b = static_cast<char>(b - 'A' + 'a');
      if (a != b) return false;
    }
    return true;
  }
  void reserve(size_t n) { s_.reserve(n); }
  String &operator+=(const String &o) { s_ += o.s_; return *this; }
  String &operator+=(const char *o) { s_ += o; return *this; }
  String &operator+=(char o) { s_ += o; return *this; }
  std::string s_;
};
}
using Arduino::String;

#pragma once
#include "engine.hpp"
#include "text.hpp"
#include <charconv>
namespace mini {
inline bool reserved_counter_key(const std::string &key) {
    return key.rfind("@counter:", 0) == 0 || key.rfind("@event:", 0) == 0;
}
inline int64_t counter_integer(const std::string &s) {
    int64_t n = 0;
    auto r = std::from_chars(s.data(), s.data() + s.size(), n);
    if (r.ec != std::errc() || r.ptr != s.data() + s.size() || n < 0 || std::to_string(n) != s)
        throw std::runtime_error("invalid counter integer");
    return n;
}
struct IncrementRecord {
    std::string event, delta, result;
};
inline bool valid_event_id(const std::string &event) {
    return event.size() == 64 && std::all_of(event.begin(), event.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}
inline IncrementRecord increment_record(const std::string &s) {
    auto a = s.find('\n'), b = s.find('\n', a == std::string::npos ? 0 : a + 1);
    if (a == std::string::npos || b == std::string::npos)
        throw std::runtime_error("invalid increment record");
    IncrementRecord r{s.substr(0, a), s.substr(a + 1, b - a - 1), s.substr(b + 1)};
    if (!valid_event_id(r.event) || counter_integer(r.delta) == 0)
        throw std::runtime_error("invalid increment event");
    (void)counter_integer(r.result);
    return r;
}
inline auto prepare_increment(Keyspace &ks, const std::string &key, const std::string &payload) {
    if (!valid_key(key) || key.rfind("@counter:", 0) != 0 || key.size() == 9)
        throw std::runtime_error("invalid counter key");
    auto r = increment_record(payload);
    auto *old = ks.get(key);
    int64_t value = old ? counter_integer(old->value) : 0, delta = counter_integer(r.delta);
    if (ks.get("@event:" + r.event) || value > INT64_MAX - delta ||
        value + delta != counter_integer(r.result))
        throw std::runtime_error("inconsistent increment record");
    return ks.prepare_pair(key, r.result, "@event:" + r.event,
                           key + "\n" + r.delta + "\n" + r.result);
}
} // namespace mini

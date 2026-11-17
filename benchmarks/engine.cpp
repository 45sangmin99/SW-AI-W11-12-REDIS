#include "../src/engine.hpp"
#include <iomanip>
#include <iostream>
#include <limits>
using namespace mini;

namespace {
struct Migration {
    uint64_t longest_ns;
    uint64_t total_ns;
};

Migration measure_migration(size_t buckets, bool incremental) {
    Keyspace ks;
    const auto entries = buckets * 3 / 4;
    for (size_t i = 0; i < entries; ++i) {
        ks.put("existing-" + std::to_string(i), "probe");
        ks.step();
    }
    if (ks.buckets() != buckets || ks.new_buckets())
        throw std::logic_error("Unexpected initial bucket count");
    ks.put("new-0", "insert");
    if (ks.new_buckets() != buckets * 2)
        throw std::logic_error("Insertion did not start a resize");

    const auto moved = ks.moved;
    ks.max_step_ns = 0;
    const auto unlimited = std::numeric_limits<size_t>::max();
    const auto start = std::chrono::steady_clock::now();
    while (ks.new_buckets())
        ks.step(incremental ? 4 : unlimited, incremental ? 8 : unlimited);
    const auto total = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - start).count();
    if (ks.moved - moved != entries || ks.buckets() != buckets * 2 ||
        !ks.get("existing-0") || !ks.get("new-0"))
        throw std::logic_error("Unexpected migration result");
    ks.validate();
    return {ks.max_step_ns, static_cast<uint64_t>(total)};
}

uint64_t median(std::vector<uint64_t> values) {
    std::sort(values.begin(), values.end());
    return values[values.size() / 2];
}

void compare_rehash() {
    constexpr int repeats = 11;
    std::cout << "{\"repeats\":" << repeats << ",\"sizes\":[";
    for (const size_t buckets : {512, 65536}) {
        if (buckets != 512)
            std::cout << ',';
        std::vector<uint64_t> peaks[2], totals[2];
        for (int i = 0; i < repeats; ++i) {
            for (int j = 0; j < 2; ++j) {
                const int mode = (i + j) % 2;
                const auto result = measure_migration(buckets, mode == 0);
                peaks[mode].push_back(result.longest_ns);
                totals[mode].push_back(result.total_ns);
            }
        }
        std::cout << "{\"nodes\":" << buckets * 3 / 4
                  << ",\"incremental\":{\"peakNs\":" << median(peaks[0])
                  << ",\"totalNs\":" << median(totals[0])
                  << "},\"allAtOnce\":{\"peakNs\":" << median(peaks[1])
                  << ",\"totalNs\":" << median(totals[1]) << "}}";
    }
    std::cout << "]}\n";
}

void compare_ttl_lookup() {
    constexpr size_t keys = 50000;
    constexpr int repeats = 11;
    Keyspace ks;
    std::vector<const Entry *> entries;
    entries.reserve(keys);
    for (size_t i = 0; i < keys; ++i) {
        const auto key = "ttl-probe-" + std::to_string(i);
        ks.put(key, "v");
        ks.step();
        entries.push_back(ks.get(key));
    }
    const auto &first_key = entries.front()->key;
    const auto &last_key = entries.back()->key;
    const auto deadline = wall_ms() + 60000;
    std::vector<uint64_t> scan_times, heap_times;
    for (int i = 0; i < repeats; ++i) {
        ks.put(first_key, "v", deadline + i % 2);
        ks.put(last_key, "v", deadline + (i + 1) % 2);
        const auto *expected = i % 2 ? entries.back() : entries.front();
        for (int j = 0; j < 2; ++j) {
            const bool scan = (i + j) % 2 == 0;
            const auto start = std::chrono::steady_clock::now();
            const Entry *found = nullptr;
            if (scan) {
                for (auto *entry : entries)
                    if (entry->expiry && (!found || entry->expiry < found->expiry))
                        found = entry;
            } else {
                found = ks.heap_root();
            }
            const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - start).count();
            if (found != expected)
                throw std::logic_error("Incorrect TTL candidate");
            (scan ? scan_times : heap_times).push_back(elapsed);
        }
    }
    std::cout << "{\"keys\":" << keys << ",\"ttlKeys\":" << ks.heap_size()
              << ",\"repeats\":" << repeats
              << ",\"scan\":{\"checks\":" << keys << ",\"ns\":" << median(scan_times)
              << "},\"heap\":{\"checks\":1,\"ns\":" << median(heap_times) << "}}\n";
}
} // namespace

int main(int argc, char **argv) {
    if (argc == 2 && std::string_view(argv[1]) == "--compare-rehash") {
        compare_rehash();
        return 0;
    }
    if (argc == 2 && std::string_view(argv[1]) == "--compare-ttl-lookup") {
        compare_ttl_lookup();
        return 0;
    }
    for (bool rehash : {false, true}) {
        Keyspace ks;
        std::vector<std::string> keys;
        for (int i = 0; i < 256; ++i) {
            keys.push_back("read" + std::to_string(i));
            ks.put(keys.back(), std::string(64, 'v'));
            ks.step();
        }
        while (ks.new_buckets())
            ks.step();
        std::vector<double> samples;
        samples.reserve(10000);
        size_t checksum = 0;
        for (int i = 0; i < 10000; ++i) {
            if (rehash && i % 16 == 0)
                ks.put("write" + std::to_string(i), "v");
            ks.step();
            auto a = std::chrono::steady_clock::now();
            for (int j = 0; j < 64; ++j) {
                auto *e = ks.get(keys[(i * 64 + j) % keys.size()]);
                if (!e)
                    return 1;
                checksum += e->value.size();
            }
            auto b = std::chrono::steady_clock::now();
            samples.push_back(std::chrono::duration_cast<std::chrono::nanoseconds>(b - a).count() /
                              64.0);
        }
        ks.validate();
        std::sort(samples.begin(), samples.end());
        std::cout << (rehash ? "rehash" : "baseline") << " requests=" << samples.size() * 64
                  << " batch=64 samples=" << samples.size() << " p50_ns=" << samples[4999]
                  << " p95_ns=" << samples[9499] << " p99_ns=" << samples[9899]
                  << " max_ns=" << samples.back() << " starts=" << ks.starts
                  << " moved=" << ks.moved << " checksum=" << checksum << "\n";
    }
}

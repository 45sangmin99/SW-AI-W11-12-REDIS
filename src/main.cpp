#include "aof.hpp"
#include "http.hpp"
#include <arpa/inet.h>
#include <csignal>
#include <poll.h>
#include <sys/socket.h>
#include <utility>
using namespace mini;
namespace {
volatile sig_atomic_t stopping = 0;
void stop(int) { stopping = 1; }
struct Fd {
    int n = -1;
    explicit Fd(int fd = -1) : n(fd) {}
    ~Fd() {
        if (n >= 0)
            close(n);
    }
    Fd(const Fd &) = delete;
};
template <class T> T option_number(const std::string &text) {
    T out{};
    auto result = std::from_chars(text.data(), text.data() + text.size(), out);
    if (result.ec != std::errc() || result.ptr != text.data() + text.size())
        throw std::runtime_error("invalid numeric option");
    return out;
}
void nonblock(int fd) {
    if (fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) < 0)
        throw std::runtime_error("nonblock");
}
struct Conn {
    int fd = -1;
    std::string input, output;
    std::optional<Request> deferred;
    bool closing = false, eof = false;
    std::chrono::steady_clock::time_point activity = std::chrono::steady_clock::now();
    ~Conn() {
        if (fd >= 0)
            close(fd);
    }
};
struct PendingWrite {
    Conn &client;
    bool close;
    Keyspace::Prepared put;
    Entry *del;
    std::future<void> appended;

    Entry *pinned() const { return del ? del : put.existing; }

    void commit(Keyspace &ks) {
        appended.get();
        if (del)
            ks.commit_delete(del);
        else
            ks.commit(std::move(put));
    }
};
std::string execute(const Request &r, Conn &client, Keyspace &ks, Aof &aof,
                    std::optional<PendingWrite> &pending, bool fail_prepare) {
    if (r.path.rfind("/keys/", 0) != 0)
        throw HttpError(404, "route");
    std::string segment = r.path.substr(6);
    bool ttl = false;
    auto slash = segment.find('/');
    if (slash != std::string::npos) {
        if (segment.substr(slash) != "/ttl")
            throw HttpError(404, "route");
        ttl = true;
        segment.resize(slash);
    }
    if (segment.find('?') != std::string::npos || segment.find('#') != std::string::npos)
        throw HttpError(400, "query unsupported");
    auto key = decode(segment);
    if (r.method != "GET" && r.method != "PUT" && r.method != "DELETE")
        throw HttpError(405, "method");
    if (ttl && r.method != "GET")
        throw HttpError(405, "method");
    if (r.method != "PUT" && !r.body.empty())
        throw HttpError(400, "unexpected body");
    if (r.method == "PUT") {
        auto [value, seconds] = Json(r.body).parse();
        int64_t now = wall_ms();
        if (seconds && seconds > (INT64_MAX - now) / 1000)
            throw HttpError(400, "TTL range");
        int64_t expiry = seconds ? now + seconds * 1000 : 0;
        if (fail_prepare)
            throw std::bad_alloc();
        auto prepared = ks.prepare(key, std::move(value), expiry);
        auto result = aof.submit('P', std::move(key), prepared.node->value, expiry);
        pending.emplace(PendingWrite{client, r.close, std::move(prepared), nullptr,
                                     std::move(result)});
        return {};
    }
    auto *e = ks.get(key, pending ? pending->pinned() : nullptr);
    if (!e)
        throw HttpError(404, "key not found");
    if (r.method == "DELETE") {
        auto result = aof.submit('D', std::move(key), "", 0);
        pending.emplace(PendingWrite{client, r.close, {}, e, std::move(result)});
        return {};
    }
    if (ttl) {
        int64_t remain = e->expiry ? remaining_seconds(e->expiry, wall_ms()) : 0;
        if (e->expiry && remain <= 0)
            throw HttpError(404, "key not found");
        return response(200,
                        "{\"ttl_seconds\":" + (e->expiry ? std::to_string(remain) : "null") + "}",
                        r.close);
    }
    return response(200, "{\"value\":" + quote(e->value) + "}", r.close);
}
} // namespace
int main(int argc, char **argv) {
    try {
        std::string host = "127.0.0.1", path = "appendonly.aof";
        int port = 6380, idle = 10;
        size_t max_connections = 256, memory = 64 * 1024 * 1024;
        Hooks hooks;
        bool test = false;
        for (int i = 1; i < argc; ++i) {
            std::string arg = argv[i];
            if (arg == "--test-hooks") {
                test = true;
                continue;
            }
            if (i + 1 == argc)
                throw std::runtime_error("missing option value");
            std::string v = argv[++i];
            if (arg == "--host")
                host = v;
            else if (arg == "--port")
                port = option_number<int>(v);
            else if (arg == "--aof-path")
                path = v;
            else if (arg == "--memory-limit")
                memory = option_number<size_t>(v);
            else if (arg == "--max-connections")
                max_connections = option_number<size_t>(v);
            else if (arg == "--idle-seconds")
                idle = option_number<int>(v);
            else if (arg == "--append-delay-ms")
                hooks.append_delay = option_number<int>(v);
            else if (arg == "--sync-delay-ms")
                hooks.sync_delay = option_number<int>(v);
            else if (arg == "--repair-delay-ms")
                hooks.repair_delay = option_number<int>(v);
            else if (arg == "--fail-write-after")
                hooks.fail_write_after = option_number<int>(v);
            else if (arg == "--fail-sync")
                hooks.fail_sync = option_number<int>(v);
            else if (arg == "--write-chunk-size")
                hooks.write_chunk = option_number<int>(v);
            else if (arg == "--fail-prepare")
                hooks.fail_prepare = option_number<int>(v);
            else if (arg == "--events")
                hooks.events = v;
            else
                throw std::runtime_error("unknown option: " + arg);
        }
        if (port < 1 || port > 65535 || idle < 1 || max_connections < 1 ||
            max_connections > 100000 || hooks.append_delay < 0 || hooks.sync_delay < 0 ||
            hooks.write_chunk < 0 || hooks.repair_delay < 0 || hooks.fail_write_after < -1)
            throw std::runtime_error("option range");
        if (!test && (hooks.append_delay || hooks.sync_delay || hooks.repair_delay ||
                      hooks.fail_write_after != -1 || hooks.fail_sync || hooks.fail_prepare ||
                      hooks.write_chunk || !hooks.events.empty()))
            throw std::runtime_error("injection requires --test-hooks");
        Keyspace ks(memory);
        int completion[2];
        if (pipe(completion) < 0)
            throw std::runtime_error("AOF completion pipe");
        Fd completion_read(completion[0]), completion_write(completion[1]);
        Aof aof(path, ks, completion_write.n, hooks);
        Fd listener(socket(AF_INET, SOCK_STREAM, 0));
        if (listener.n < 0)
            throw std::runtime_error("socket");
        int yes = 1;
        setsockopt(listener.n, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);
        if (inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1 ||
            bind(listener.n, (sockaddr *)&addr, sizeof addr) < 0 || listen(listener.n, 128) < 0)
            throw std::runtime_error("bind/listen");
        nonblock(listener.n);
        signal(SIGPIPE, SIG_IGN);
        signal(SIGINT, stop);
        signal(SIGTERM, stop);
        std::vector<std::unique_ptr<Conn>> clients;
        // shortcut: one mutation in flight, batch only if write throughput requires it.
        std::optional<PendingWrite> pending;
        auto finish_write = [&] {
            bool committed = false;
            try {
                pending->commit(ks);
                committed = !aof.failed;
            } catch (const std::exception &e) {
                std::cerr << "write rejected: " << e.what() << "\n";
            }
            auto &client = pending->client;
            if (!client.closing) {
                client.output += committed
                    ? response(204, "", pending->close)
                    : response(503, "{\"error\":\"write unavailable\"}", pending->close);
                client.closing = pending->close || (client.eof && client.input.empty());
                client.activity = std::chrono::steady_clock::now();
            }
            pending.reset();
        };
        std::cerr << "ready " << host << ":" << port << "\n";
        uint64_t last_starts = ks.starts, last_finishes = ks.finishes;
        while (!stopping) {
            // A prepared update/delete may still reference this entry after it expires.
            ks.expire(64, pending ? pending->pinned() : nullptr);
            ks.step(4, 8);
            if (ks.starts != last_starts || ks.finishes != last_finishes) {
                std::cerr << wall_ms() << " rehash starts=" << ks.starts
                          << " finishes=" << ks.finishes << " moved=" << ks.moved
                          << " old=" << ks.buckets() << " new=" << ks.new_buckets()
                          << " scanned=" << ks.scanned << " max_scans=" << ks.max_step_scans
                          << " max_nodes=" << ks.max_step_nodes << " max_ns=" << ks.max_step_ns
                          << "\n";
                last_starts = ks.starts;
                last_finishes = ks.finishes;
            }
            std::vector<pollfd> fds{{listener.n, POLLIN, 0}, {completion_read.n, POLLIN, 0}};
            for (auto &c : clients)
                fds.push_back(
                    {c->closing && c->output.empty() ? -1 : c->fd,
                     short((!c->closing && !c->eof && !c->deferred &&
                            (!pending || &pending->client != c.get()) &&
                            c->output.size() < 2 * 1048576 ? POLLIN : 0) |
                           (!c->output.empty() ? POLLOUT : 0)),
                     0});
            int ready = poll(fds.data(), fds.size(), 10);
            if (ready < 0 && errno != EINTR)
                throw std::runtime_error("poll");
            if (fds[1].revents & POLLIN) {
                char byte;
                ssize_t n;
                do {
                    n = read(completion_read.n, &byte, 1);
                } while (n < 0 && errno == EINTR);
                if (n != 1)
                    throw std::runtime_error("AOF completion read");
                finish_write();
            }
            if (fds[0].revents & POLLIN)
                for (int n = 0; n < 16; ++n) {
                    int fd = accept(listener.n, nullptr, nullptr);
                    if (fd < 0)
                        break;
                    if (clients.size() >= max_connections) {
                        close(fd);
                        continue;
                    }
                    Fd accepted(fd);
                    nonblock(fd);
                    auto c = std::make_unique<Conn>();
                    c->fd = fd;
                    accepted.n = -1;
                    clients.push_back(std::move(c));
                }
            size_t commands = 0;
            for (size_t i = 0; i + 2 < fds.size(); ++i) {
                auto &c = *clients[i];
                auto re = fds[i + 2].revents;
                if (re & (POLLERR | POLLNVAL)) {
                    c.closing = true;
                    c.output.clear();
                }
                try {
                    if ((re & POLLIN) && !c.closing && !c.deferred &&
                        (!pending || &pending->client != &c)) {
                        char buf[16384];
                        for (int n = 0; n < 4; ++n) {
                            auto z = recv(c.fd, buf, sizeof buf, 0);
                            if (z > 0) {
                                c.activity = std::chrono::steady_clock::now();
                                c.input.append(buf, z);
                                if (c.input.size() > 1100000)
                                    throw HttpError(413, "input limit");
                            } else {
                                if (z == 0)
                                    c.eof = true;
                                else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)
                                    c.closing = true;
                                break;
                            }
                        }
                    }
                    for (int n = 0;
                         n < 4 && !c.closing && commands < 64 && c.output.size() < 2 * 1048576 &&
                         (!pending || &pending->client != &c);
                         ++n) {
                        if (c.deferred && pending)
                            break;
                        auto r = c.deferred ? std::exchange(c.deferred, std::nullopt)
                                            : request(c.input);
                        if (!r) {
                            if (c.eof) {
                                if (!c.input.empty())
                                    throw HttpError(400, "incomplete request");
                                c.closing = true;
                            }
                            break;
                        }
                        if (pending && (r->method == "PUT" || r->method == "DELETE")) {
                            c.deferred = std::move(r);
                            break;
                        }
                        ++commands;
                        try {
                            c.output += execute(*r, c, ks, aof, pending, hooks.fail_prepare);
                        } catch (const HttpError &e) {
                            c.output +=
                                response(e.status, "{\"error\":" + quote(e.what()) + "}", r->close);
                        } catch (const std::length_error &e) {
                            std::cerr << "resource rejected: " << e.what() << "\n";
                            c.output += response(503, "{\"error\":\"resource limit\"}", r->close);
                        } catch (const std::logic_error &) {
                            throw; // Broken invariants are fatal, never continue with a damaged
                                   // keyspace.
                        } catch (const std::exception &e) {
                            std::cerr << "write rejected: " << e.what() << "\n";
                            c.output +=
                                response(503, "{\"error\":\"write unavailable\"}", r->close);
                        }
                        if (pending && &pending->client == &c)
                            break;
                        c.closing = r->close || (c.eof && c.input.empty());
                        ks.step();
                    }
                    if ((re & POLLOUT) && !c.output.empty()) {
                        auto z = send(c.fd, c.output.data(),
                                      std::min<size_t>(65536, c.output.size()), 0);
                        if (z > 0) {
                            c.output.erase(0, z);
                            c.activity = std::chrono::steady_clock::now();
                        } else if (z < 0 && errno != EAGAIN && errno != EWOULDBLOCK &&
                                   errno != EINTR) {
                            c.closing = true;
                            c.output.clear();
                        }
                    }
                } catch (const HttpError &e) {
                    c.output += response(e.status, "{\"error\":" + quote(e.what()) + "}", true);
                    c.closing = true;
                    c.input.clear();
                }
                if (std::chrono::steady_clock::now() - c.activity > std::chrono::seconds(idle)) {
                    c.closing = true;
                    c.output.clear();
                }
                if (re & POLLHUP) {
                    c.closing = true;
                    if (c.output.empty())
                        c.input.clear();
                }
            }
            clients.erase(std::remove_if(clients.begin(), clients.end(),
                                         [&](auto &c) {
                                             return c->closing && c->output.empty() &&
                                                    (!pending || &pending->client != c.get());
                                         }),
                          clients.end());
            if (clients.size() > 1)
                std::rotate(clients.begin(), clients.begin() + 1, clients.end());
        }
        if (pending)
            finish_write();
        ks.validate();
        std::cerr << "shutdown appended=" << aof.appended << " synced=" << aof.synced
                  << " moved=" << ks.moved << " scanned=" << ks.scanned
                  << " max_scans=" << ks.max_step_scans << " max_nodes=" << ks.max_step_nodes
                  << " max_ns=" << ks.max_step_ns << "\n";
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "fatal: " << e.what() << "\n";
        return 1;
    }
}

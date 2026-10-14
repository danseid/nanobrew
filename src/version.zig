const std = @import("std");

/// Compare two version strings using numeric segment comparison.
/// Splits on '.', '_' (Homebrew's revision separator) and '-'.
/// Debian package versions need compareDebVersions instead.
/// Returns .lt, .eq, or .gt indicating if `a` is less than, equal to, or greater than `b`.
pub fn compareVersions(a: []const u8, b: []const u8) std.math.Order {
    // Fast path: identical strings
    if (std.mem.eql(u8, a, b)) return .eq;

    var it_a = SegmentIterator.init(a);
    var it_b = SegmentIterator.init(b);

    while (true) {
        const seg_a = it_a.next();
        const seg_b = it_b.next();

        // Both exhausted → equal
        if (seg_a == null and seg_b == null) return .eq;

        // Shorter version with no more segments is less (e.g., "10.47" < "10.47_1")
        const sa = seg_a orelse "";
        const sb = seg_b orelse "";

        // If one side is exhausted, its segment is effectively "0"
        if (seg_a == null) {
            // a is exhausted; if b's remaining segment is > 0, a < b
            const nb_val = parseNumeric(sb);
            if (nb_val) |val| {
                if (val > 0) return .lt;
                // val == 0 means this segment doesn't matter, continue
            } else {
                // non-numeric remaining segment in b → a < b
                return .lt;
            }
            continue;
        }
        if (seg_b == null) {
            const na_val = parseNumeric(sa);
            if (na_val) |val| {
                if (val > 0) return .gt;
            } else {
                return .gt;
            }
            continue;
        }

        // Both segments present — try numeric comparison first
        const na = parseNumeric(sa);
        const nb = parseNumeric(sb);

        if (na != null and nb != null) {
            // Both numeric
            if (na.? < nb.?) return .lt;
            if (na.? > nb.?) return .gt;
            // Equal numerically, continue to next segment
        } else {
            // At least one is non-numeric → lexicographic comparison
            const order = std.mem.order(u8, sa, sb);
            if (order != .eq) return order;
        }
    }
}

/// Returns true if version `a` is strictly newer than version `b`.
pub fn isNewer(a: []const u8, b: []const u8) bool {
    return compareVersions(a, b) == .gt;
}

/// Trim whitespace and a single leading release-tag `v`/`V` prefix.
pub fn normalizeVersion(v: []const u8) []const u8 {
    const trimmed = std.mem.trim(u8, v, " \t\r\n");
    if (trimmed.len > 0 and (trimmed[0] == 'v' or trimmed[0] == 'V')) return trimmed[1..];
    return trimmed;
}

/// Returns true only when `latest` is strictly newer than `current`.
pub fn isUpdateAvailable(current: []const u8, latest: []const u8) bool {
    const current_norm = normalizeVersion(current);
    const latest_norm = normalizeVersion(latest);
    if (current_norm.len == 0 or latest_norm.len == 0) return false;
    return isNewer(latest_norm, current_norm);
}

/// Compare Debian package versions with dpkg semantics:
/// `[epoch:]upstream[-revision]`, where `~` sorts before everything, even the
/// end of the string, and letters sort before other punctuation.
pub fn compareDebVersions(a: []const u8, b: []const u8) std.math.Order {
    const pa = DebVersion.parse(a);
    const pb = DebVersion.parse(b);
    if (pa.epoch != pb.epoch) return std.math.order(pa.epoch, pb.epoch);
    const upstream = dpkgCompare(pa.upstream, pb.upstream);
    if (upstream != .eq) return upstream;
    return dpkgCompare(pa.revision, pb.revision);
}

const DebVersion = struct {
    epoch: u64,
    upstream: []const u8,
    revision: []const u8,

    fn parse(v: []const u8) DebVersion {
        var rest = std.mem.trim(u8, v, " \t\r\n");
        var epoch: u64 = 0;
        if (std.mem.indexOfScalar(u8, rest, ':')) |colon| {
            epoch = std.fmt.parseInt(u64, rest[0..colon], 10) catch 0;
            rest = rest[colon + 1 ..];
        }
        if (std.mem.lastIndexOfScalar(u8, rest, '-')) |dash| {
            return .{ .epoch = epoch, .upstream = rest[0..dash], .revision = rest[dash + 1 ..] };
        }
        return .{ .epoch = epoch, .upstream = rest, .revision = "" };
    }
};

fn dpkgOrder(c: ?u8) i32 {
    const ch = c orelse return 0;
    if (std.ascii.isDigit(ch)) return 0;
    if (std.ascii.isAlphabetic(ch)) return ch;
    if (ch == '~') return -1;
    return @as(i32, ch) + 256;
}

/// dpkg's verrevcmp: alternate non-digit runs (compared with dpkgOrder) and
/// digit runs (compared numerically, ignoring leading zeros).
fn dpkgCompare(a: []const u8, b: []const u8) std.math.Order {
    var i: usize = 0;
    var j: usize = 0;
    while (i < a.len or j < b.len) {
        while ((i < a.len and !std.ascii.isDigit(a[i])) or (j < b.len and !std.ascii.isDigit(b[j]))) {
            const ac = dpkgOrder(if (i < a.len) a[i] else null);
            const bc = dpkgOrder(if (j < b.len) b[j] else null);
            if (ac != bc) return std.math.order(ac, bc);
            i += 1;
            j += 1;
        }
        while (i < a.len and a[i] == '0') i += 1;
        while (j < b.len and b[j] == '0') j += 1;
        var first_diff: std.math.Order = .eq;
        while (i < a.len and j < b.len and std.ascii.isDigit(a[i]) and std.ascii.isDigit(b[j])) {
            if (first_diff == .eq) first_diff = std.math.order(a[i], b[j]);
            i += 1;
            j += 1;
        }
        if (i < a.len and std.ascii.isDigit(a[i])) return .gt;
        if (j < b.len and std.ascii.isDigit(b[j])) return .lt;
        if (first_diff != .eq) return first_diff;
    }
    return .eq;
}

fn parseNumeric(s: []const u8) ?u64 {
    if (s.len == 0) return 0;
    return std.fmt.parseInt(u64, s, 10) catch null;
}

const SegmentIterator = struct {
    data: []const u8,
    pos: usize,

    fn init(data: []const u8) SegmentIterator {
        return .{ .data = data, .pos = 0 };
    }

    fn next(self: *SegmentIterator) ?[]const u8 {
        if (self.pos >= self.data.len) return null;

        const start = self.pos;
        while (self.pos < self.data.len) : (self.pos += 1) {
            if (self.data[self.pos] == '.' or self.data[self.pos] == '_' or self.data[self.pos] == '-') {
                const seg = self.data[start..self.pos];
                self.pos += 1; // skip delimiter
                return seg;
            }
        }
        return self.data[start..self.pos];
    }
};

// ============================================================
// Tests
// ============================================================

test "compareVersions: revision makes newer" {
    // 10.47_1 > 10.47
    try std.testing.expectEqual(std.math.Order.gt, compareVersions("10.47_1", "10.47"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("10.47", "10.47_1"));
}

test "compareVersions: leading zeros / different digit counts" {
    // 0.1.067 > 0.1.06  (67 > 6)
    try std.testing.expectEqual(std.math.Order.gt, compareVersions("0.1.067", "0.1.06"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("0.1.06", "0.1.067"));
}

test "compareVersions: numeric segment ordering" {
    // 1.10 > 1.9  (10 > 9, not lexicographic)
    try std.testing.expectEqual(std.math.Order.gt, compareVersions("1.10", "1.9"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.9", "1.10"));
}

test "compareVersions: major version difference" {
    // 2.0 > 1.99
    try std.testing.expectEqual(std.math.Order.gt, compareVersions("2.0", "1.99"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.99", "2.0"));
}

test "compareVersions: equal versions" {
    try std.testing.expectEqual(std.math.Order.eq, compareVersions("1.2.3", "1.2.3"));
    try std.testing.expectEqual(std.math.Order.eq, compareVersions("0.1.068", "0.1.068"));
    try std.testing.expectEqual(std.math.Order.eq, compareVersions("10.47_1", "10.47_1"));
}

test "compareVersions: empty and edge cases" {
    try std.testing.expectEqual(std.math.Order.eq, compareVersions("", ""));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("", "1.0"));
    try std.testing.expectEqual(std.math.Order.gt, compareVersions("1.0", ""));
}

test "compareVersions: non-numeric suffixes" {
    // alpha < beta (lexicographic)
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.0.alpha", "1.0.beta"));
    try std.testing.expectEqual(std.math.Order.gt, compareVersions("1.0.beta", "1.0.alpha"));
}

test "isNewer: convenience function" {
    try std.testing.expect(isNewer("10.47_1", "10.47"));
    try std.testing.expect(isNewer("0.1.067", "0.1.06"));
    try std.testing.expect(isNewer("1.10", "1.9"));
    try std.testing.expect(isNewer("2.0", "1.99"));
    try std.testing.expect(!isNewer("1.0", "1.0"));
    try std.testing.expect(!isNewer("1.0", "2.0"));
}

test "isUpdateAvailable rejects downgrades and equal versions" {
    try std.testing.expect(!isUpdateAvailable("0.1.192", "0.1.191"));
    try std.testing.expect(!isUpdateAvailable("0.1.192", "0.1.192"));
    try std.testing.expect(isUpdateAvailable("0.1.191", "0.1.192"));
}

test "isUpdateAvailable normalizes release tag prefixes and whitespace" {
    try std.testing.expect(isUpdateAvailable("0.1.191", " v0.1.192\n"));
    try std.testing.expect(!isUpdateAvailable("v0.1.192", "0.1.191"));
}

test "compareVersions: dash-separated segments compare numerically" {
    try std.testing.expectEqual(std.math.Order.gt, compareVersions("1.2-10", "1.2-3"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("2024-01-09", "2024-01-10"));
}

test "compareDebVersions follows dpkg ordering" {
    const cases = [_]struct { a: []const u8, b: []const u8, want: std.math.Order }{
        .{ .a = "1:1.0", .b = "2.0", .want = .gt },
        .{ .a = "1.0~rc1", .b = "1.0", .want = .lt },
        .{ .a = "1.0~rc1", .b = "1.0~rc2", .want = .lt },
        .{ .a = "1.0-10", .b = "1.0-3", .want = .gt },
        .{ .a = "2.36-9+deb12u4", .b = "2.36-9", .want = .gt },
        .{ .a = "2.36-9+deb12u10", .b = "2.36-9+deb12u4", .want = .gt },
        .{ .a = "1.0a", .b = "1.0", .want = .gt },
        .{ .a = "1.0", .b = "1.0+b1", .want = .lt },
        .{ .a = "1.0", .b = "1.0-0", .want = .eq },
        .{ .a = "0:1.0-1", .b = "1.0-1", .want = .eq },
        .{ .a = "1.2.3-1ubuntu1", .b = "1.2.3-1", .want = .gt },
    };
    for (cases) |c| {
        try std.testing.expectEqual(c.want, compareDebVersions(c.a, c.b));
        try std.testing.expectEqual(c.want.invert(), compareDebVersions(c.b, c.a));
    }
}

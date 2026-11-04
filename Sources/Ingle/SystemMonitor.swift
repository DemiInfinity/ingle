import SwiftUI
import Darwin
import IOKit

/// Reads CPU, memory and GPU usage. Polled every couple of seconds while the card is on screen.
@MainActor @Observable
final class SystemMonitor {
    var cpu: Double = 0          // 0–100
    var gpu: Double?             // 0–100, nil if unavailable
    var memUsedGB: Double = 0
    var memTotalGB: Double = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824
    var gpuHistory: [Double] = []

    private var lastTicks: (UInt32, UInt32, UInt32, UInt32)?

    func sample() {
        if let c = Self.cpuTicks() {
            if let p = lastTicks {
                let user = Double(c.0 &- p.0), system = Double(c.1 &- p.1)
                let idle = Double(c.2 &- p.2), nice = Double(c.3 &- p.3)
                let total = user + system + idle + nice
                if total > 0 { cpu = (user + system + nice) / total * 100 }
            }
            lastTicks = c
        }
        if let used = Self.memoryUsedBytes() { memUsedGB = used / 1_073_741_824 }
        gpu = Self.gpuUtilisation()
        gpuHistory.append(gpu ?? 0)
        if gpuHistory.count > 40 { gpuHistory.removeFirst(gpuHistory.count - 40) }
    }

    // MARK: Readers

    private static func cpuTicks() -> (UInt32, UInt32, UInt32, UInt32)? {
        var info = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info_data_t>.stride / MemoryLayout<integer_t>.stride)
        let result = withUnsafeMutablePointer(to: &info) { ptr in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        let t = info.cpu_ticks   // user, system, idle, nice
        return (t.0, t.1, t.2, t.3)
    }

    /// Same idea as Activity Monitor's "Memory Used": app memory + wired + compressed.
    private static func memoryUsedBytes() -> Double? {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
        let result = withUnsafeMutablePointer(to: &stats) { ptr in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        let page = Double(vm_kernel_page_size)
        let app = Double(stats.internal_page_count) - Double(stats.purgeable_count)
        let pages = max(0, app) + Double(stats.wire_count) + Double(stats.compressor_page_count)
        return pages * page
    }

    /// Apple Silicon reports GPU load on the IOAccelerator service; no admin rights needed.
    private static func gpuUtilisation() -> Double? {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &iterator) == KERN_SUCCESS else {
            return nil
        }
        defer { IOObjectRelease(iterator) }
        var best: Double?
        var entry = IOIteratorNext(iterator)
        while entry != 0 {
            var props: Unmanaged<CFMutableDictionary>?
            if IORegistryEntryCreateCFProperties(entry, &props, kCFAllocatorDefault, 0) == KERN_SUCCESS,
               let dict = props?.takeRetainedValue() as? [String: Any],
               let perf = dict["PerformanceStatistics"] as? [String: Any] {
                let raw = perf["Device Utilization %"] ?? perf["GPU Activity(%)"] ?? perf["Renderer Utilization %"]
                if let n = raw as? NSNumber { best = max(best ?? 0, n.doubleValue) }
            }
            IOObjectRelease(entry)
            entry = IOIteratorNext(iterator)
        }
        return best
    }
}

/// The little card in the sidebar.
struct SystemCard: View {
    @State private var monitor = SystemMonitor()

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("This Mac")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Ember.secondary)
                Spacer()
                Sparkline(values: monitor.gpuHistory)
                    .frame(width: 64, height: 14)
            }
            MeterRow(label: "CPU", fraction: monitor.cpu / 100, value: String(format: "%.0f%%", monitor.cpu))
            MeterRow(label: "Memory", fraction: monitor.memUsedGB / max(monitor.memTotalGB, 1),
                     value: String(format: "%.1f / %.0f GB", monitor.memUsedGB, monitor.memTotalGB))
            MeterRow(label: "GPU", fraction: (monitor.gpu ?? 0) / 100,
                     value: monitor.gpu.map { String(format: "%.0f%%", $0) } ?? "–")
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
        .task {
            while !Task.isCancelled {
                monitor.sample()
                try? await Task.sleep(for: .seconds(2))
            }
        }
        .help("Live CPU, memory and GPU use on this Mac. The line shows GPU over the last 80 seconds.")
    }
}

private struct MeterRow: View {
    let label: String
    let fraction: Double
    let value: String

    private var clamped: Double { min(max(fraction, 0), 1) }
    private var tint: Color { clamped > 0.85 ? Ember.danger : clamped > 0.6 ? Ember.warn : Ember.accent }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label).font(.system(size: 11)).foregroundStyle(Ember.text.opacity(0.85))
                Spacer()
                Text(value).font(.system(size: 11).monospacedDigit()).foregroundStyle(Ember.secondary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule().fill(tint).frame(width: max(3, geo.size.width * clamped))
                }
            }
            .frame(height: 4)
            .animation(.easeOut(duration: 0.6), value: clamped)
        }
    }
}

private struct Sparkline: View {
    let values: [Double]

    var body: some View {
        Canvas { ctx, size in
            guard values.count > 1 else { return }
            let step = size.width / CGFloat(max(values.count - 1, 1))
            var path = Path()
            for (i, v) in values.enumerated() {
                let point = CGPoint(x: CGFloat(i) * step,
                                    y: size.height - CGFloat(min(max(v, 0), 100) / 100) * size.height)
                if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }
            ctx.stroke(path, with: .color(Ember.accent.opacity(0.85)),
                       style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
        }
    }
}

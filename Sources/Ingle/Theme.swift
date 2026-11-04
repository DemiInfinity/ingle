import SwiftUI
import AppKit

/// Ingle's palette, taken from the app icon: warm plum darks, cream text, ember accent.
enum Ember {
    static let bg = Color(hex: 0x1C1618)
    static let sidebar = Color(hex: 0x251C20)
    static let surface = Color(hex: 0x2D2327)
    static let raised = Color(hex: 0x3A2C31)
    static let bubble = Color(hex: 0x3E2E31)
    static let code = Color(hex: 0x141113)
    static let text = Color(hex: 0xF3E6DE)
    static let secondary = Color(hex: 0xA8999D)
    static let tertiary = Color(hex: 0x7A6C70)
    static let accent = Color(hex: 0xFF9F6B)
    static let onAccent = Color(hex: 0x2A1F24)
    static let warn = Color(hex: 0xFFC861)
    static let danger = Color(hex: 0xFF7A6B)
    static let hairline = Color.white.opacity(0.07)
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: opacity)
    }
}

/// The three-node network mark, drawn in a 16×16 grid.
struct NetworkMark: View {
    var top = true
    var sides = false
    var dashed = false
    var stroke: Color = Ember.text
    var lit: Color = Ember.accent
    var lineWidth: CGFloat = 1.2

    var body: some View {
        Canvas { ctx, size in
            let s = min(size.width, size.height) / 16
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }
            var links = Path()
            links.move(to: p(6.9, 5.5)); links.addLine(to: p(4.7, 9.9))
            links.move(to: p(9.1, 5.5)); links.addLine(to: p(11.3, 9.9))
            links.move(to: p(5.6, 11.6)); links.addLine(to: p(10.4, 11.6))
            let style = StrokeStyle(lineWidth: lineWidth * s, lineCap: .round,
                                    dash: dashed ? [1.4 * s, 1.6 * s] : [])
            ctx.stroke(links, with: .color(stroke), style: style)
            let nodes: [(CGPoint, Bool)] = [(p(8, 3.8), top), (p(3.6, 11.6), sides), (p(12.4, 11.6), sides)]
            for (c, on) in nodes {
                let r = 2 * s
                let circle = Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
                if on { ctx.fill(circle, with: .color(lit)) }
                ctx.stroke(circle, with: .color(on ? lit : stroke), lineWidth: lineWidth * s)
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

/// Menu-bar icon: the mark plus “AI”, as a template image so macOS tints it for light/dark.
enum MenuIcon {
    static func image(state: ModelState, text: String) -> NSImage {
        let font = NSFont.systemFont(ofSize: 13, weight: .medium)
        let textSize = (text as NSString).size(withAttributes: [.font: font])
        let size = NSSize(width: 20 + ceil(textSize.width), height: 16)
        let dim = state == .off || state == .offline
        let image = NSImage(size: size, flipped: true) { _ in
            let color = NSColor.black.withAlphaComponent(dim ? 0.5 : 1)
            color.setStroke()
            color.setFill()
            let links = NSBezierPath()
            links.lineWidth = 1.3
            links.lineCapStyle = .round
            links.move(to: NSPoint(x: 6.9, y: 5.5)); links.line(to: NSPoint(x: 4.7, y: 9.9))
            links.move(to: NSPoint(x: 9.1, y: 5.5)); links.line(to: NSPoint(x: 11.3, y: 9.9))
            links.move(to: NSPoint(x: 5.6, y: 11.6)); links.line(to: NSPoint(x: 10.4, y: 11.6))
            if dim {
                let pattern: [CGFloat] = [1.4, 1.6]
                links.setLineDash(pattern, count: 2, phase: 0)
            }
            links.stroke()
            func node(_ x: CGFloat, _ y: CGFloat, _ filled: Bool) {
                let o = NSBezierPath(ovalIn: NSRect(x: x - 2, y: y - 2, width: 4, height: 4))
                o.lineWidth = 1.3
                if filled { o.fill() }
                o.stroke()
            }
            node(8, 3.8, !dim)
            node(3.6, 11.6, state == .hard)
            node(12.4, 11.6, state == .hard)
            let y = (16 - textSize.height) / 2
            (text as NSString).draw(at: NSPoint(x: 20, y: y),
                                    withAttributes: [.font: font, .foregroundColor: color])
            return true
        }
        image.isTemplate = true
        return image
    }
}

/// Small borderless icon button with a hover background.
struct IconButtonStyle: ButtonStyle {
    func makeBody(configuration: ButtonStyleConfiguration) -> some View {
        IconButtonBody(configuration: configuration)
    }
}

private struct IconButtonBody: View {
    let configuration: ButtonStyleConfiguration
    @State private var hover = false

    var body: some View {
        configuration.label
            .padding(.horizontal, 10)
            .frame(minWidth: 30, minHeight: 28)
            .background(RoundedRectangle(cornerRadius: 6)
                .fill(Color.white.opacity(configuration.isPressed ? 0.12 : hover ? 0.07 : 0)))
            .contentShape(Rectangle())
            .onHover { hover = $0 }
    }
}

/// Rounded pill button used for toggles like Think and Mac access.
struct PillToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            configuration.label
                .font(.system(size: 12.5, weight: .medium))
                .padding(.horizontal, 14)
                .frame(height: 30)
                .foregroundStyle(configuration.isOn ? Ember.onAccent : Ember.secondary)
                .background(Capsule().fill(configuration.isOn ? Ember.accent : Color.white.opacity(0.06)))
        }
        .buttonStyle(.plain)
    }
}

import AppKit

/// Ingle lives in the menu bar. It shows in the Dock (icon and dot) only while one of its windows is open —
/// close the chat and Settings and it drops out of the Dock and the ⌘-Tab switcher, but keeps the menu item.
@MainActor
final class DockPresence {
    static let shared = DockPresence()
    private var observers: [NSObjectProtocol] = []

    func start() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { note in
            MainActor.assumeIsolated {
                if let window = note.object as? NSWindow, DockPresence.isAppWindow(window) { DockPresence.shared.show() }
            }
        })
        observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { note in
            let closing = note.object as? NSWindow
            // Let the window finish closing before counting what's left.
            DispatchQueue.main.async {
                MainActor.assumeIsolated { DockPresence.shared.update(ignoring: closing) }
            }
        })
        update(ignoring: nil)
    }

    /// Real windows (chat, Settings) — not the menu bar extra's panel, popovers or tooltips.
    static func isAppWindow(_ w: NSWindow) -> Bool {
        w.styleMask.contains(.titled) && !(w is NSPanel) && w.level == .normal
    }

    private func show() {
        guard NSApp.activationPolicy() != .regular else { return }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func update(ignoring closing: NSWindow?) {
        let open = NSApp.windows.contains { $0 !== closing && $0.isVisible && Self.isAppWindow($0) }
        let wanted: NSApplication.ActivationPolicy = open ? .regular : .accessory
        if NSApp.activationPolicy() != wanted { NSApp.setActivationPolicy(wanted) }
    }
}

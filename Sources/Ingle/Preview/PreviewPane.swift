import SwiftUI
import UniformTypeIdentifiers

/// The preview pane to the right of the chat (⌥⌘P): tabs of rendered files, Preview / Source / Split for text.
struct PreviewPane: View {
    @State private var store = PreviewStore.shared
    @State private var dropping = false

    var body: some View {
        VStack(spacing: 0) {
            tabBar
            Rectangle().fill(Ember.hairline).frame(height: 1)
            if let tab = store.current {
                PreviewTabView(tab: tab).id(tab.id)
            } else {
                empty
            }
        }
        .background(Ember.bg)
        .onExitCommand { store.hide() }   // Esc while the pane's controls have focus
        .overlay {
            if dropping {
                RoundedRectangle(cornerRadius: 10).strokeBorder(Ember.accent, style: StrokeStyle(lineWidth: 2, dash: [6]))
                    .padding(6)
                    .allowsHitTesting(false)
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            let files: [URL] = urls.filter { $0.isFileURL }
            files.forEach { store.open($0) }
            return !files.isEmpty
        } isTargeted: { dropping = $0 }
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(store.tabs) { tab in
                        PreviewTabChip(tab: tab, selected: tab.id == store.current?.id,
                                       select: { store.selected = tab.id }, close: { store.close(tab.id) })
                    }
                }
                .padding(.horizontal, 6)
            }
            Button { store.hide() } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(IconButtonStyle())
            .foregroundStyle(Ember.secondary)
            .help("Close the preview (Esc, ⌥⌘P). Its tabs come back with ⌥⌘P.")
            .accessibilityLabel("Close preview")
            .padding(.trailing, 4)
        }
        .frame(height: 36)
        .background(Ember.sidebar)
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Image(systemName: "eye").font(.system(size: 26)).foregroundStyle(Ember.tertiary)
            Text("Drop a file here to preview it")
                .font(.system(size: 13, weight: .medium)).foregroundStyle(Ember.text)
            Text("Or type /preview and a path, or click Open on a plan or a file link.")
                .font(.system(size: 12)).foregroundStyle(Ember.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct PreviewTabChip: View {
    let tab: PreviewTab
    let selected: Bool
    let select: () -> Void
    let close: () -> Void
    @State private var hover = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: PreviewTabView.icon(tab.kind)).font(.system(size: 10.5))
                .foregroundStyle(selected ? Ember.accent : Ember.tertiary)
            Text(tab.name).font(.system(size: 11.5)).lineLimit(1).truncationMode(.middle)
                .foregroundStyle(selected ? Ember.text : Ember.secondary)
                .frame(maxWidth: 160)
            Button(action: close) { Image(systemName: "xmark").font(.system(size: 8.5, weight: .semibold)) }
                .buttonStyle(.plain)
                .foregroundStyle(Ember.tertiary)
                .opacity(selected || hover ? 1 : 0)
                .help("Close")
        }
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(RoundedRectangle(cornerRadius: 7).fill(selected ? Ember.raised : hover ? Color.white.opacity(0.05) : .clear))
        .contentShape(Rectangle())
        .onTapGesture(perform: select)
        .onHover { hover = $0 }
        .help(tab.url.path)
    }
}

struct PreviewTabView: View {
    @Bindable var tab: PreviewTab

    static func icon(_ kind: PreviewKind) -> String {
        switch kind {
        case .markdown: return "doc.richtext"
        case .html: return "globe"
        case .svg, .image: return "photo"
        case .pdf: return "doc"
        case .csv, .tsv: return "tablecells"
        case .json, .yaml: return "list.bullet.indent"
        case .code: return "chevron.left.forwardslash.chevron.right"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            if tab.kind == .html { banner }
            if let error = tab.saveError ?? tab.problem {
                Text(error).font(.system(size: 11.5)).foregroundStyle(Ember.danger)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if tab.missing {
                Text("\(tab.name) isn’t there any more. It reappears here if the file comes back.")
                    .font(.system(size: 12.5)).foregroundStyle(Ember.secondary)
                    .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                switch tab.mode {
                case .preview: rendered
                case .source: source
                case .split:
                    HSplitView {
                        source.frame(minWidth: 160)
                        rendered.frame(minWidth: 160)
                    }
                }
            }
        }
    }

    private var toolbar: some View {
        HStack(spacing: 6) {
            if tab.kind.isText {
                Picker("", selection: $tab.mode) {
                    ForEach(PreviewTab.Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .controlSize(.small)
            }
            Spacer(minLength: 4)
            Button { tab.reload() } label: { Image(systemName: "arrow.clockwise").font(.system(size: 11)) }
                .help("Reload from disk")
            Button { ChangesPanel.openInEditor(tab.url.path) } label: { Image(systemName: "arrow.up.forward.app").font(.system(size: 11)) }
                .help(ChangesPanel.editorName.map { "Open in \($0)" } ?? "Open in the default app")
            Button { NSWorkspace.shared.activateFileViewerSelecting([tab.url]) } label: { Image(systemName: "folder").font(.system(size: 11)) }
                .help("Show in Finder")
        }
        .buttonStyle(IconButtonStyle())
        .foregroundStyle(Ember.secondary)
        .padding(.horizontal, 8)
        .frame(height: 34)
    }

    /// HTML runs code: say what's allowed, and let the user switch scripts off (or on).
    private var banner: some View {
        HStack(spacing: 8) {
            Image(systemName: tab.javaScript ? "curlybraces" : "nosign").font(.system(size: 10.5))
            Text("JavaScript \(tab.javaScript ? "on" : "off") · network blocked")
            if tab.fromWeb { Text("· downloaded from the web").foregroundStyle(Ember.warn) }
            Spacer(minLength: 4)
            Toggle("JavaScript", isOn: $tab.javaScript)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .help("Run this page’s scripts. It still can’t reach the network or other files.")
        }
        .font(.system(size: 11))
        .foregroundStyle(Ember.secondary)
        .padding(.horizontal, 12)
        .frame(height: 26)
        .background(Ember.surface)
    }

    @ViewBuilder private var rendered: some View {
        if tab.kind == .pdf {
            PreviewPDFView(url: tab.url, stamp: tab.stamp)
        } else {
            PreviewWebView(tab: tab, stamp: tab.stamp, javaScript: tab.javaScript)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var source: some View {
        SourceTextView(text: $tab.draft)
            .background(Ember.code)
            .onDisappear { tab.flushSave() }
            .background {
                Button("") { tab.flushSave() }.keyboardShortcut("s").hidden()
            }
    }
}

/// A plain-text editor for Source mode: monospaced, no smart quotes or dashes (they would change code).
struct SourceTextView: NSViewRepresentable {
    @Binding var text: String

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: SourceTextView
        init(_ parent: SourceTextView) { self.parent = parent }
        func textDidChange(_ note: Notification) {
            guard let view = note.object as? NSTextView else { return }
            parent.text = view.string
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        guard let view = scroll.documentView as? NSTextView else { return scroll }
        view.delegate = context.coordinator
        view.font = .monospacedSystemFont(ofSize: 12.5, weight: .regular)
        view.textColor = NSColor(Ember.text)
        view.insertionPointColor = NSColor(Ember.accent)
        view.drawsBackground = false
        view.isRichText = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.textContainerInset = NSSize(width: 10, height: 10)
        view.string = text
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView, view.string != text else { return }
        // The file changed on disk: show it, keeping the cursor where it was if it still fits.
        let selection: [NSValue] = view.selectedRanges
        view.string = text
        let length: Int = (text as NSString).length
        view.selectedRanges = selection.map { NSValue(range: NSRange(location: min($0.rangeValue.location, length), length: 0)) }
    }
}

/// The chat with the preview pane to its right and a divider to drag. (An HStack rather than HSplitView, so the chat
/// is offered its real width and the message bar can switch to its compact row.)
struct PreviewSplit<Chat: View>: View {
    /// Called when a drag would squeeze the chat below its minimum: true if room was made (the sidebar folded).
    var needRoom: () -> Bool = { false }
    @ViewBuilder let chat: () -> Chat
    @State private var store = PreviewStore.shared
    @AppStorage("previewWidth") private var width: Double = 440
    @State private var dragStart: Double?

    var body: some View {
        GeometryReader { geo in
            // The chat keeps at least 420 points, so the pane can't crush it.
            let maxWidth: Double = max(280, Double(geo.size.width) - 420)
            let shown: Double = min(max(width, 280), maxWidth)
            HStack(spacing: 0) {
                // An exact width, so the chat lays out for the room it really has.
                chat()
                    .frame(width: store.visible ? max(Double(geo.size.width) - shown - 1, 0) : Double(geo.size.width))
                    .frame(maxHeight: .infinity)
                    .clipped()
                if store.visible {
                    Rectangle()
                        .fill(Ember.hairline)
                        .frame(width: 1)
                        .overlay {
                            Color.clear
                                .frame(width: 9)
                                .contentShape(Rectangle())
                                .onHover { inside in
                                    if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                                }
                                .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                                    .onChanged { g in
                                        let start: Double = dragStart ?? shown
                                        dragStart = start
                                        let wanted: Double = start - Double(g.translation.width)
                                        if wanted > maxWidth + 24, needRoom() { dragStart = nil }
                                        width = min(max(wanted, 280), maxWidth)
                                    }
                                    .onEnded { _ in dragStart = nil })
                        }
                    PreviewPane()
                        .frame(width: shown)
                        .frame(maxHeight: .infinity)
                }
            }
        }
    }
}

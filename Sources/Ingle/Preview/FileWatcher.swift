import Foundation

/// Calls `changed` (on the main queue) when a file changes on disk: written in place, replaced by an atomic save
/// (rename into the folder), deleted or recreated. Watches the file and its folder with kqueue, so there's no polling.
final class FileWatcher {
    private let path: String
    private let changed: () -> Void
    private var fileSource: DispatchSourceFileSystemObject?
    private var dirSource: DispatchSourceFileSystemObject?
    private var pending: DispatchWorkItem?

    init(path: String, changed: @escaping () -> Void) {
        self.path = path
        self.changed = changed
        watchFolder()
        watchFile()
    }

    deinit { stop() }

    func stop() {
        pending?.cancel()
        fileSource?.cancel()
        dirSource?.cancel()
        fileSource = nil
        dirSource = nil
    }

    private func watchFolder() {
        let dir: String = (path as NSString).deletingLastPathComponent
        let fd: Int32 = open(dir, O_EVTONLY)
        guard fd >= 0 else { return }
        let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write], queue: .main)
        s.setEventHandler { [weak self] in self?.fire(reopen: true) }
        s.setCancelHandler { close(fd) }
        s.resume()
        dirSource = s
    }

    private func watchFile() {
        fileSource?.cancel()
        fileSource = nil
        let fd: Int32 = open(path, O_EVTONLY)
        guard fd >= 0 else { return }
        let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend, .delete, .rename, .attrib], queue: .main)
        s.setEventHandler { [weak self, weak s] in
            let replaced: Bool = s.map { !$0.data.intersection([.delete, .rename]).isEmpty } ?? false
            self?.fire(reopen: replaced)
        }
        s.setCancelHandler { close(fd) }
        s.resume()
        fileSource = s
    }

    /// Several events arrive for one save; wait a moment and report once.
    private func fire(reopen: Bool) {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            // An atomic save swaps the file for a new one: watch the new one.
            if reopen || self.fileSource == nil { self.watchFile() }
            self.changed()
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    }
}

import AppKit
import ApplicationServices
import Foundation

// Bootstrap access to Claude's own session manager through its built-in
// Developer menu. Only native menu items are operated; chat inputs are untouched.
func attribute(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(e,key as CFString,&value) == .success ? value : nil
}
func text(_ e: AXUIElement, _ key: String) -> String { attribute(e,key) as? String ?? "" }
func element(_ e: AXUIElement, _ key: String) -> AXUIElement? {
    guard let value=attribute(e,key),CFGetTypeID(value)==AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value,to:AXUIElement.self)
}
func descendants(_ e: AXUIElement) -> [AXUIElement] {
    var queue=[e],i=0
    while i<queue.count && i<1500 {
        queue.append(contentsOf:attribute(queue[i],kAXChildrenAttribute) as? [AXUIElement] ?? []);i+=1
    }
    return queue
}
func menuItem(_ app: NSRunningApplication, _ title: String) -> AXUIElement? {
    let ax=AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(ax,2)
    guard let menu=element(ax,kAXMenuBarAttribute) else { return nil }
    return descendants(menu).first { text($0,kAXRoleAttribute)==kAXMenuItemRole && text($0,kAXTitleAttribute)==title }
}
func emit(_ result: [String:Any]) {
    if let data=try? JSONSerialization.data(withJSONObject:result) {
        if let i=CommandLine.arguments.firstIndex(of:"--result"),i+1<CommandLine.arguments.count {
            let file=CommandLine.arguments[i+1]
            try? data.write(to:URL(fileURLWithPath:file),options:.atomic)
            try? FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file)
        } else {
            FileHandle.standardOutput.write(data);FileHandle.standardOutput.write(Data([10]))
        }
    }
}
func wait(_ seconds: Double,_ condition: ()->Bool) -> Bool {
    let deadline=Date().addingTimeInterval(seconds)
    repeat {
        if condition() { return true }
        RunLoop.current.run(until:Date().addingTimeInterval(0.08))
    } while Date()<deadline
    return false
}
func closeOpenedInspectorTab() -> Bool {
    guard let chrome=NSRunningApplication.runningApplications(withBundleIdentifier:"com.google.Chrome").first else { return false }
    let ax=AXUIElementCreateApplication(chrome.processIdentifier)
    _=AXUIElementSetAttributeValue(ax,"AXManualAccessibility" as CFString,kCFBooleanTrue)
    guard let window=element(ax,kAXMainWindowAttribute) else { return false }
    let inspector=descendants(window).contains {
        guard text($0,kAXRoleAttribute)=="AXWebArea" else { return false }
        let raw=attribute($0,kAXURLAttribute)
        let url=(raw as? URL)?.absoluteString ?? raw as? String ?? ""
        return url=="chrome://inspect/" || url.hasPrefix("chrome://inspect/#")
    }
    guard inspector,let close=menuItem(chrome,"Close Tab") else { return false }
    return AXUIElementPerformAction(close,kAXPressAction as CFString) == .success
}
let bundle="com.anthropic.claudefordesktop"
let front=NSWorkspace.shared.frontmostApplication
let app=NSRunningApplication.runningApplications(withBundleIdentifier:bundle).first
if CommandLine.arguments.contains("--request-access") {
    let key=kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    emit(["ok":true,"accessibility":AXIsProcessTrustedWithOptions([key:true] as CFDictionary)]);exit(0)
}
if CommandLine.arguments.contains("--info") {
    emit(["ok":true,"running":app != nil,"pid":app?.processIdentifier ?? 0,"accessibility":AXIsProcessTrusted()]);exit(0)
}
guard let app,!app.isTerminated else { emit(["ok":false,"reason":"desktop_closed"]);exit(0) }
guard AXIsProcessTrusted() else { emit(["ok":false,"reason":"accessibility_required"]);exit(0) }
var item: AXUIElement?
guard wait(15,{
    if app.isTerminated { return true }
    item=menuItem(app,"Enable Main Process Debugger");return item != nil
}),let item,!app.isTerminated else {
    emit(["ok":false,"reason":app.isTerminated ? "desktop_closed" : "developer_control_unavailable"]);exit(0)
}
guard AXUIElementPerformAction(item,kAXPressAction as CFString) == .success else {
    emit(["ok":false,"reason":"developer_control_failed"]);exit(0)
}
// Claude opens chrome://inspect along with its debugger. Close that specific
// new tab and return focus if Chrome or Claude came forward.
_=wait(4,closeOpenedInspectorTab)
if let front,let current=NSWorkspace.shared.frontmostApplication,
   current.processIdentifier != front.processIdentifier,
   [bundle,"com.google.Chrome"].contains(current.bundleIdentifier ?? "") {
    front.activate(options:[])
}
emit(["ok":true,"pid":app.processIdentifier])

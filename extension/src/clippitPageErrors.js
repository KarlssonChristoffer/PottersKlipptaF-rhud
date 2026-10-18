// Runs in the page's own world, on localhost pages only (see manifest.json): catches uncaught errors,
// unhandled promise rejections and console.error, and hands them to the extension's content script with
// postMessage, which passes them on to Clippit. It only listens; the page behaves exactly as before.

(() => {
    if (window.__clippitPageErrors) return;
    window.__clippitPageErrors = true;
    let sent = 0;
    const text = v => {
        if (v instanceof Error) return (v.stack && v.stack.includes(v.message) ? v.stack : `${v.name}: ${v.message}\n${v.stack || ""}`);
        if (typeof v === "string") return v;
        try { return JSON.stringify(v); } catch (e) { return String(v); }
    };
    const post = (kind, message, stack, source) => {
        if (sent++ > 20) return;                 // a page stuck in an error loop gets 20, not thousands
        window.postMessage({ __clippit: "page-error", kind, message: String(message).slice(0, 2000),
            stack: String(stack || "").slice(0, 4000), source: source || "" }, "*");
    };
    window.addEventListener("error", e => {
        if (!e.error && !e.message) return;          // a broken <img> and the like
        post("error", e.message, e.error && e.error.stack, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : "");
    });
    window.addEventListener("unhandledrejection", e => post("unhandled rejection", text(e.reason).split("\n")[0], text(e.reason)));
    const original = console.error;
    console.error = function (...args) {
        try { post("console.error", args.map(text).join(" ").split("\n")[0], args.map(text).join(" ")); } catch (e) { /* never break the page */ }
        return original.apply(this, args);
    };
})();

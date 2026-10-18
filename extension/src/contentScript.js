import GDPRConfig from "./GDPRConfig.js";
import ConsentEngine from "./ConsentEngine.js";
import clippitConsent, { isCmpFrame } from "./clippitFallback.js";

// When no rule knew the page, Clippit has a go himself, in the top frame or a consent manager's own iframe:
// every two seconds for a minute,
// the reject / "only necessary" button of any cookie box, else its settings with everything off, else
// close or hide it. Never accept.
function clippitFallback() {
    if ((window !== window.top && !isCmpFrame()) || window.__clippitFallback) return;
    const started = Date.now();
    window.__clippitFallback = setInterval(() => {
        let res;
        // Popups drawn in an iframe get ten seconds for the rules and Clippit inside that frame; after
        // that the top frame may hide the frame's container.
        try { res = JSON.parse(clippitConsent({ framed: Date.now() - started > 10000 })); } catch (e) { return; }
        if (ConsentEngine.debugValues && ConsentEngine.debugValues.debugLog) console.log("Clippit fallback:", location.host + location.pathname, res.action, res.how);
        if (["rejected", "closed", "hidden"].includes(res.action)) {
            clearInterval(window.__clippitFallback);
            chrome.runtime.sendMessage("ClippitHandled|" + JSON.stringify(res));
        } else if (res.how === "nothing found on this page" || res.how === "already handled") {
            clearInterval(window.__clippitFallback);
        }
    }, 2000);
}

async function contentScriptRunner() {
    if (document.contentType!=="text/html") return;

    // Figure out the URL
    let url = location.href;
    let insideIframe = window !== window.parent;
    if(insideIframe) {
        //We are inside an iframe, request the actual tab url to check if we are active
        url = await new Promise((resolve, reject)=>{
            chrome.runtime.sendMessage("GetTabUrl", (response)=>{
                resolve(response);
            });
        });
    }
    const urlObj = new URL(url);
    url = urlObj.host;

    const settings = await GDPRConfig.getGeneralSettings();
    if (settings.enabled === false) return;

    GDPRConfig.isActive(url).then(async (active) => {
        if (active) {
            chrome.runtime.sendMessage("GetRuleList", (fetchedRules)=>{
                if (!fetchedRules) {
                    console.log("Failed to connect with service worker for getRuleList msg", fetchedRules);
                } else {
                    GDPRConfig.getCustomRuleLists().then((customRules)=>{
                        fetchedRules.forEach((ruleObj)=>{
                            delete ruleObj["$schema"];
                        });
                        delete customRules["$schema"];
        
                        // Concat rule-lists to engine config in order
                        let config = Object.assign({}, ...fetchedRules, customRules);
        
                        GDPRConfig.getConsentValues().then((consentTypes)=>{
                            GDPRConfig.getDebugValues().then((debugValues)=>{
                                GDPRConfig.getGeneralSettings().then((generalSettings)=>{
                                    if(debugValues.debugLog) {
                                        console.log("FetchedRules:", fetchedRules);
                                        console.log("CustomRules:", customRules);
                                    }
                    
                                    ConsentEngine.debugValues = debugValues;
                                    ConsentEngine.generalSettings = generalSettings;
                                    ConsentEngine.topFrameUrl = url;
            
                                    chrome.runtime.sendMessage("Searching");
                                    let engine = new ConsentEngine(config, consentTypes, (evt)=>{
                                        let result = {
                                            "handled": evt.handled
                                        };
    
                                        if(evt.handled) {
                                            result.cmp = evt.cmpName;
                                            result.clicks = evt.clicks;
                                            result.url = url;
        
                                            chrome.runtime.sendMessage("HandledCMP|"+JSON.stringify(result));
                                            // A rule that ran without clicking anything didn't really manage (old
                                            // layouts, like Sourcepoint's on Blocket): Clippit tries himself.
                                            if (!(evt.clicks > 0) && generalSettings.clippitFallback !== false) clippitFallback();
                                        } else if(evt.error) {
                                            chrome.runtime.sendMessage("CMPError");
                                            if (generalSettings.clippitFallback !== false) clippitFallback();
                                        } else {
                                            chrome.runtime.sendMessage("NothingFound");
                                            if (generalSettings.clippitFallback !== false) clippitFallback();
                                        }
                                    });
            
                                    ConsentEngine.singleton = engine;
            
                                    if(debugValues.debugLog) {
                                        console.log("ConsentEngine loaded " + engine.cmps.length + " of " + Object.keys(config).length + " rules");
                                    }
                                });
                            });
                        });
                    });
                }
            });
        }
    });
}

window.consentScrollBehaviours = {};
function getCalculatedStyles() {
    ["html","html body"].forEach(element=>{
        let node = document.querySelector(element);
        if (node) {
            let styles = window.getComputedStyle(node);
            window.consentScrollBehaviours[element+".consent-scrollbehaviour-override"] = ["position","overflow","overflow-y"].map(property=>{
                return {property:property, value:styles[property]}
            });
        }
    });
}

// Observe styles in order to temporarily restore them if a popup kills them
let topContentTag = document.querySelector("html");
if (topContentTag){
    let observer = new MutationObserver((mutations)=>{
        mutations.forEach((mutation)=>{
            mutation.addedNodes.forEach((node)=>{
                if(node.matches != null && node.matches("body")) {
                    getCalculatedStyles();
                    observer.disconnect();
                }
            })
        });
    });

    observer.observe(topContentTag, {
        childList: true
    });
}
window.addEventListener("message", (event)=>{
    try {
        if(event.data?.enforceScrollBehaviours != null) {
            ConsentEngine.enforceScrollBehaviours(event.data.enforceScrollBehaviours);
        }
    }catch(e) {
        console.error("Error inside message listener:", e);
    }
});

// Keep the background (and with it the line to the Clippit app) awake while you use the browser: a nudge
// when a page shows or gets focus, and at most every 20 seconds while you move, type or scroll.
if (window === window.top) {
    let last = 0;
    const nudge = () => {
        if (document.visibilityState !== "visible" || Date.now() - last < 20000) return;
        last = Date.now();
        try { chrome.runtime.sendMessage("ClippitNudge"); } catch (e) { /* extension reloaded */ }
    };
    nudge();
    for (const ev of ["visibilitychange", "focus", "pointermove", "keydown", "scroll"]) window.addEventListener(ev, nudge, { passive: true, capture: true });
}

contentScriptRunner().catch((e)=>{
    console.error(e);
});

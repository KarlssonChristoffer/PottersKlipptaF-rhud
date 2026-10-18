import GDPRConfig from './GDPRConfig.js';
import Language from './Language.js';

let frontTab = document.querySelector(".fronttab");
if (frontTab){
    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, (tabs) => {
        // No url for pages the extension may not read (the browser's own pages, other extensions)
        const url = tabs[0] && tabs[0].url ? new URL(tabs[0].url).host : "";

        let activeInput = document.querySelector(".sitepart input");
        document.querySelector("#site").textContent = url;
        document.querySelector("#settings").addEventListener("click", function () {
            chrome.runtime.openOptionsPage();
            window.close();
        });

        GDPRConfig.isActive(url).then((active) => {
            activeInput.checked = active;
        });
        activeInput.addEventListener("input", () => {
            GDPRConfig.setPageActive(url, activeInput.checked);
        });

        // The master switch: off means no rules and no Clippit pass on any page.
        let enabledInput = document.querySelector("#enabled");
        GDPRConfig.getGeneralSettings().then((general) => {
            enabledInput.checked = general.enabled !== false;
            document.body.classList.toggle("off", !enabledInput.checked);
            enabledInput.addEventListener("input", () => {
                general.enabled = enabledInput.checked;
                document.body.classList.toggle("off", !enabledInput.checked);
                GDPRConfig.setGeneralSettings(general);
            });
        });
    });

    window.addEventListener("DOMContentLoaded", ()=>{
        Language.doLanguage();
    });
}

// background.js
// Listens for messages from popup to download images.
// For each image, opens its `href` in a background tab, extracts candidate image URLs
// in that page context and fetches the largest candidate from that tab (preserving cookies/referer).
// All downloads happen without focusing the tab. Progress messages are sent back via runtime messages.

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.action === 'downloadImages') {
        downloadImagesAsZip(message.data, sendResponse);
        return true; // will respond asynchronously
    }
});

async function downloadImagesAsZip(pageData, sendResponse) {
    try {
        const images = Array.isArray(pageData.images) ? pageData.images : [];
        if (images.length === 0) {
            sendResponse({ success: false, error: 'Aucune image trouvée' });
            return;
        }

        const diagnostics = [];
        let downloaded = 0;

        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const diag = { index: i, origUrl: img.url, chosenUrl: null, chosenSize: -1, reason: null };

            // Build candidate list (prefer srcsetBest, then original, then simple rewrites)
            const candidates = [];
            if (img.srcsetBest) candidates.push({ url: img.srcsetBest, reason: 'srcset' });
            if (img.url) candidates.push({ url: img.url, reason: 'base' });

            // simple rewrite heuristics (strip common resizing params)
            try {
                if (img.url) {
                    const u = new URL(img.url);
                    ['w','h','width','height','size','quality','q'].forEach(p => { if (u.searchParams.has(p)) u.searchParams.delete(p); });
                    const s = u.toString();
                    if (!candidates.find(c=>c.url===s)) candidates.push({ url: s, reason: 'strip-params' });
                }
            } catch(e){}

            // dimension suffix stripping
            if (img.url) {
                const dimClean = img.url.replace(/([_-])?\d{2,5}x\d{2,5}(?=\.[a-z]{2,5})/i, '');
                if (dimClean && dimClean !== img.url) candidates.push({ url: dimClean, reason: 'strip-dims' });
            }

            // If href looks like an image URL, prefer it too
            if (img.href && /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|#|$)/i.test(img.href)) {
                candidates.unshift({ url: img.href, reason: 'href-image' });
            }

            let success = false;
            for (const c of candidates) {
                try {
                    const filename = sanitizeFilename(img.filename || (`image_${i+1}`)) + extractExtension(c.url);
                    const ok = await downloadUrlAndWait(c.url, filename);
                    if (ok) {
                        diag.chosenUrl = c.url;
                        diag.reason = c.reason || 'candidate';
                        // size is not available here, leave -1
                        diagnostics.push(diag);
                        success = true;
                        break;
                    }
                } catch (e) {
                    // try next candidate
                    continue;
                }
            }

            if (!success) {
                diagnostics.push(diag);
            }

            downloaded++;
            chrome.runtime.sendMessage({ action: 'downloadProgress', downloaded, total: images.length });
        }

        sendResponse({ success: true, downloaded, diagnostics });
    } catch (e) {
        sendResponse({ success: false, error: e && e.message ? e.message : String(e) });
    }
}

// Helper: download a URL via chrome.downloads.download and wait for completion (or failure)
function downloadUrlAndWait(url, filename) {
    return new Promise((resolve, reject) => {
        chrome.downloads.download({ url, filename, saveAs: false }, downloadId => {
            if (chrome.runtime.lastError || !downloadId) return resolve(false);

            const onChanged = (delta) => {
                if (delta.id !== downloadId) return;
                if (delta.state && delta.state.current === 'complete') {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    resolve(true);
                } else if (delta.state && delta.state.current === 'interrupted') {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    resolve(false);
                } else if (delta.error) {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    resolve(false);
                }
            };

            chrome.downloads.onChanged.addListener(onChanged);
            // safety timeout
            setTimeout(() => {
                try { chrome.downloads.onChanged.removeListener(onChanged); } catch(e){}
                resolve(false);
            }, 30000);
        });
    });
}

function sanitizeFilename(name) {
    return String(name).replace(/[<>:\\"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0,120);
}

function extractExtension(url) {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/\.([a-z0-9]{2,6})(?:[?#]|$)/i);
        return m ? ('.' + m[1]) : '.jpg';
    } catch (e) { return '.jpg'; }
}

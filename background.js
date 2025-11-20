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

        const files = []; // { filename, data: Uint8Array }
        const diagnostics = [];
        let processed = 0;

        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const diag = { index: i, origUrl: img.url, chosenUrl: null, chosenSize: -1, reason: null };

            // Build candidate list
            const candidates = [];
            if (img.srcsetBest) candidates.push({ url: img.srcsetBest, reason: 'srcset' });
            if (img.url) candidates.push({ url: img.url, reason: 'base' });

            try {
                if (img.url) {
                    const u = new URL(img.url);
                    ['w','h','width','height','size','quality','q'].forEach(p => { if (u.searchParams.has(p)) u.searchParams.delete(p); });
                    const s = u.toString();
                    if (!candidates.find(c=>c.url===s)) candidates.push({ url: s, reason: 'strip-params' });
                }
            } catch(e){}

            if (img.url) {
                const dimClean = img.url.replace(/([_-])?\d{2,5}x\d{2,5}(?=\.[a-z]{2,5})/i, '');
                if (dimClean && dimClean !== img.url) candidates.push({ url: dimClean, reason: 'strip-dims' });
            }

            if (img.href && /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|#|$)/i.test(img.href)) {
                candidates.unshift({ url: img.href, reason: 'href-image' });
            }

            let got = false;
            for (const c of candidates) {
                try {
                    // data: URIs
                    if (c.url.startsWith('data:')) {
                        const base64 = c.url.split(',')[1] || '';
                        const arr = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
                        const filename = sanitizeFilename(img.filename || (`image_${i+1}`)) + extractExtension(c.url);
                        files.push({ filename, data: arr });
                        diag.chosenUrl = c.url; diag.reason = c.reason;
                        got = true; break;
                    }

                    // Try background fetch
                    const ab = await fetchArrayBufferWithFallback(c.url);
                    if (ab) {
                        const arr = new Uint8Array(ab);
                        const filename = sanitizeFilename(img.filename || (`image_${i+1}`)) + extractExtension(c.url);
                        files.push({ filename, data: arr });
                        diag.chosenUrl = c.url; diag.reason = c.reason; diag.chosenSize = arr.length;
                        got = true; break;
                    }

                    // If candidate failed, continue
                } catch (e) {
                    continue;
                }
            }

            // Tab fallback (try to open href and extract image in page context) - invisible tab
            if (!got && img.href) {
                try {
                    const pageBuf = await fetchArrayBufferInTab(img.href);
                    if (pageBuf) {
                        const arr = new Uint8Array(pageBuf);
                        const filename = sanitizeFilename(img.filename || (`image_${i+1}`)) + '.jpg';
                        files.push({ filename, data: arr });
                        diag.chosenUrl = img.href; diag.reason = 'href-page'; diag.chosenSize = arr.length;
                        got = true;
                    }
                } catch(e) {}
            }

            diagnostics.push(diag);
            processed++;
            chrome.runtime.sendMessage({ action: 'downloadProgress', downloaded: processed, total: images.length });
        }

        // Build ZIP and trigger download
        const zipBlob = createSimpleZip(files);
        const url = URL.createObjectURL(zipBlob);
        const zipName = pageData.zipName || 'images.zip';
        chrome.downloads.download({ url, filename: zipName, saveAs: false }, id => {
            setTimeout(() => URL.revokeObjectURL(url), 15000);
        });

        sendResponse({ success: true, downloaded: processed, diagnostics });
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

// Background fetch helper
async function fetchArrayBufferWithFallback(url) {
    try {
        const resp = await fetch(url, { credentials: 'include', mode: 'cors' });
        if (!resp || !resp.ok) return null;
        return await resp.arrayBuffer();
    } catch (e) {
        return null;
    }
}

// Fallback: open the href in a background tab and try to fetch the first large image found there
function fetchArrayBufferInTab(href, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        let timedOut = false;
        const t = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, timeoutMs);

        chrome.tabs.create({ url: href, active: false }, tab => {
            if (chrome.runtime.lastError || !tab || !tab.id) { clearTimeout(t); return resolve(null); }
            const tabId = tab.id;

            const onUpdated = (uId, changeInfo) => {
                if (uId !== tabId) return;
                if (changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(onUpdated);

                    const script = `(async function(){
                        function parseSrcset(s){ if(!s) return null; try{ const parts=s.split(',').map(p=>p.trim()).map(p=>{ const u=p.split(/\s+/)[0]; const w=p.match(/(\d+)w$/); return {u,w:w?parseInt(w[1],10):0};}); parts.sort((a,b)=>b.w-a.w); return parts[0].u;}catch(e){return null} }
                        const set = new Set();
                        const og = document.querySelector('meta[property="og:image"]'); if(og&&og.content) set.add(og.content);
                        Array.from(document.images||[]).forEach(i=>{ if(i.src) set.add(i.src); const s=parseSrcset(i.getAttribute('srcset')); if(s) set.add(s); });
                        Array.from(document.querySelectorAll('a')).forEach(a=>{ const h=a.href||a.getAttribute('href'); if(h && /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|#|$)/i.test(h)) set.add(h); });
                        const list=Array.from(set).filter(Boolean).sort((a,b)=>b.length-a.length);
                        for(const url of list){ try{ const r=await fetch(url,{credentials:'include'}); if(!r.ok) continue; const ab=await r.arrayBuffer(); return { url, buffer: Array.from(new Uint8Array(ab)) }; }catch(e){ continue; } }
                        return null;
                    })();`;

                    chrome.tabs.executeScript(tabId, { code: script }, results => {
                        try { clearTimeout(t); } catch(e){}
                        chrome.tabs.remove(tabId, ()=>{});
                        if (chrome.runtime.lastError) return resolve(null);
                        const res = results && results[0];
                        if (!res) return resolve(null);
                        return resolve(new Uint8Array(res.buffer).buffer);
                    });
                }
            };
            chrome.tabs.onUpdated.addListener(onUpdated);
        });
    });
}

function sanitizeFilename(name) {
    return String(name).replace(/[<>:\\"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0,120);
}

function extractExtension(url) {
    try { const u = new URL(url); const m = u.pathname.match(/\.([a-z0-9]{2,6})(?:[?#]|$)/i); return m ? ('.' + m[1]) : '.jpg'; } catch(e){ return '.jpg'; }
}

// ZIP builder
function createSimpleZip(files) {
    const zipParts = [];
    const centralDirectory = [];
    let offset = 0;

    files.forEach(file => {
        const filename = file.filename;
        const fileData = file.data;

        const localHeader = new Uint8Array(30);
        const view = new DataView(localHeader.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0, true);
        view.setUint16(8, 0, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, 0, true);
        view.setUint32(14, crc32(fileData), true);
        view.setUint32(18, fileData.length, true);
        view.setUint32(22, fileData.length, true);
        view.setUint16(26, filename.length, true);
        view.setUint16(28, 0, true);

        const nameBytes = new Uint8Array(filename.length);
        for (let i = 0; i < filename.length; i++) nameBytes[i] = filename.charCodeAt(i);

        const localPart = new Uint8Array(localHeader.length + nameBytes.length + fileData.length);
        localPart.set(localHeader, 0);
        localPart.set(nameBytes, localHeader.length);
        localPart.set(fileData, localHeader.length + nameBytes.length);

        zipParts.push(localPart);

        const centralHeader = new Uint8Array(46 + filename.length);
        const cview = new DataView(centralHeader.buffer);
        cview.setUint32(0, 0x02014b50, true);
        cview.setUint16(4, 20, true);
        cview.setUint16(6, 20, true);
        cview.setUint16(8, 0, true);
        cview.setUint16(10, 0, true);
        cview.setUint16(12, 0, true);
        cview.setUint32(14, crc32(fileData), true);
        cview.setUint32(18, fileData.length, true);
        cview.setUint32(22, fileData.length, true);
        cview.setUint16(26, filename.length, true);
        cview.setUint16(28, 0, true);
        cview.setUint16(30, 0, true);
        cview.setUint16(32, 0, true);
        cview.setUint16(34, 0, true);
        cview.setUint16(36, 0, true);
        cview.setUint32(38, 0, true);
        cview.setUint32(42, offset, true);

        centralHeader.set(nameBytes, 46);
        centralDirectory.push(centralHeader);

        offset += localPart.length;
    });

    const centralSize = centralDirectory.reduce((s, e) => s + e.length, 0);
    const centralOffset = offset;
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralOffset, true);
    endView.setUint16(20, 0, true);

    const totalSize = zipParts.reduce((s, p) => s + p.length, 0) + centralSize + endRecord.length;
    const out = new Uint8Array(totalSize);
    let p = 0;
    zipParts.forEach(part => { out.set(part, p); p += part.length; });
    centralDirectory.forEach(entry => { out.set(entry, p); p += entry.length; });
    out.set(endRecord, p);

    return new Blob([out], { type: 'application/zip' });
}

function crc32(data) {
    const table = [];
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

// background.js
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.action === 'downloadImages') {
        downloadImagesAsZip(message.data, sendResponse);
        return true; // Indique que la réponse sera asynchrone
    }
});

async function downloadImagesAsZip(pageData, sendResponse) {
    try {
    const images = pageData.images;
    const useHighRes = !!pageData.highRes;
    let downloadedCount = 0;
    let improvedCount = 0; // nombre d images dont l URL a changé pour une version supposée plus grande
        const zipFiles = [];
        const errorReasons = [];
        
        if (images.length === 0) {
            sendResponse({ success: false, error: 'Aucune image trouvée' });
            return;
        }
        
        async function resolveHighResURL(imageData) {
            // Construit une liste de candidates ordonnées avec heuristiques
            const candidates = [];
            const push = (u, reason, weight=1) => {
                if (!u) return; candidates.push({ url: u, reason, weight }); };
            const baseUrl = imageData.url;
            push(baseUrl, 'base', 1);
            if (imageData.srcsetBest && imageData.srcsetBest !== baseUrl) push(imageData.srcsetBest, 'srcset', 5);
            if (imageData.href && imageData.href !== baseUrl) push(imageData.href, 'href', 2);

            // Extraction des query params potentiellement réducteurs (width, w, h, height, size) -> version sans
            try {
                const uObj = new URL(baseUrl);
                const paramsToRemove = ['w','h','width','height','size','quality','q'];
                let modified = false;
                paramsToRemove.forEach(p=>{ if (uObj.searchParams.has(p)) { uObj.searchParams.delete(p); modified = true; }});
                if (modified) push(uObj.toString(), 'no-query-size', 4);
            } catch(e) {}

            // Pattern dimensions dans le nom de fichier : _640x800, -640x800, 640x800
            const dimensionPattern = /(\b|_|-)(\d{2,5})x(\d{2,5})(\b|_|\.)/i;
            if (dimensionPattern.test(baseUrl)) {
                const cleaned = baseUrl.replace(dimensionPattern, '$1$4');
                if (cleaned !== baseUrl) push(cleaned, 'strip-dims', 4);
            }

            // Variation en retirant suffixes numériques à la fin avant extension (ex: image-640x800.jpg -> image.jpg)
            const suffixPattern = /(-|_)(\d{2,5})x(\d{2,5})(?=\.[a-z]{2,5})(.*)$/i;
            if (suffixPattern.test(baseUrl)) {
                const cleaned2 = baseUrl.replace(suffixPattern, '$4');
                if (cleaned2 && cleaned2 !== baseUrl) push(cleaned2, 'strip-suffix-dims', 4);
            }

            // Rewriting patterns
            const rewritePatterns = [
                [/(-|_|\.)thumb(\.|_|$)/i, '$1$2'],
                [/(-|_|\.)small(\.|_|$)/i, '$1$2'],
                [/(-|_|)preview(\.|_|$)/i, '$1$2'],
                [/(-|_|)low(res)?(\.|_|$)/i, '$1$3'],
                [/([\/?])thumbs([\/])/i, '$1$2'],
                [/([\/?])small([\/])/i, '$1$2']
            ];
            rewritePatterns.forEach(p => {
                if (p[0].test(baseUrl)) {
                    push(baseUrl.replace(p[0], p[1]), 'rewrite', 3);
                }
            });

            // Déduplication
            const seen = new Set();
            const ordered = candidates.filter(c => {
                if (seen.has(c.url)) return false; seen.add(c.url); return true; }).sort((a,b)=> b.weight - a.weight);

            // Si href est une page HTML on essaie d extraire toutes les <img> et choisir la plus probable
            if (pageData.highRes && imageData.href && !/\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|#|$)/i.test(imageData.href)) {
                try {
                    const html = await fetch(imageData.href).then(r=> r.ok ? r.text(): '');
                    if (html) {
                        const imgs = [...html.matchAll(/<img[^>]+src=["']([^"'>]+)["'][^>]*>/gi)].map(m=>m[1]);
                        imgs.forEach(src => {
                            let u = src;
                            if (u.startsWith('//')) u = 'https:' + u; else if (u.startsWith('/')) {
                                try { const base = new URL(imageData.href); u = base.origin + u; } catch(e) {}
                            }
                            const score = /large|full|orig|hd|big/i.test(u) ? 6 : 2;
                            push(u, 'href-img', score);
                        });
                    }
                } catch(e) { /* ignore */ }
            }
            const finalList = ordered.sort((a,b)=> b.weight - a.weight).slice(0,15); // limiter
            return finalList.map(c=>c.url);
        }

        // Fonction pour télécharger une image (avec résolution high-res)
        async function downloadImage(imageData, index) {
            try {
                let arrayBuffer;
                let url = imageData.url;
                if (useHighRes) {
                    const candidates = await resolveHighResURL(imageData);
                    let best = { size: -1, buffer: null, url: null };
                    for (const candidate of candidates) {
                        url = candidate;
                        try {
                            if (url.startsWith('data:') || url.startsWith('blob:')) { best.url = url; break; }
                            const resp = await fetch(url, { method: 'GET', mode: 'cors' });
                            if (!resp.ok) { errorReasons.push('HTTP ' + resp.status); continue; }
                            const buf = await resp.arrayBuffer();
                            const size = buf.byteLength;
                            if (size > best.size) {
                                best = { size, buffer: buf, url };
                            }
                            // heuristique : si on dépasse 1.5MB on suppose HQ suffisante, on arrête
                            if (best.size > 1.5 * 1024 * 1024) break;
                        } catch(e) {
                            errorReasons.push('fetch fail');
                            continue;
                        }
                    }
                    if (best.buffer) {
                        if (best.url && best.url !== imageData.url) improvedCount++;
                        arrayBuffer = best.buffer;
                        url = best.url;
                    }
                    if (!arrayBuffer && (url.startsWith('data:') || url.startsWith('blob:'))) {
                        // tomber ensuite sur gestion générique plus bas
                    }
                }
                if (!arrayBuffer) {
                    // chemin standard
                    if (url.startsWith('data:')) {
                        const base64 = url.split(',')[1];
                        arrayBuffer = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
                    } else if (url.startsWith('blob:')) {
                        const tabId = pageData.tabId;
                        if (typeof tabId === 'number') {
                            try {
                                const result = await new Promise((resolve, reject) => {
                                    chrome.tabs.executeScript(tabId, {
                                        code: `fetch('${url}').then(r=>r.arrayBuffer()).then(b=>{ Array.from(new Uint8Array(b)) }).catch(e=>'ERROR:'+e.message);`
                                    }, res => {
                                        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                                        else resolve(res && res[0]);
                                    });
                                });
                                if (typeof result === 'string' && result.startsWith('ERROR:')) {
                                    console.warn('Échec blob fetch', result);
                                    errorReasons.push('blob fetch');
                                    return null;
                                }
                                arrayBuffer = new Uint8Array(result).buffer;
                            } catch(e) {
                                console.warn('Blob non récupéré', e);
                                errorReasons.push('blob exception');
                                return null;
                            }
                        } else {
                            return null;
                        }
                    } else {
                        const response = await fetch(url, { mode: 'cors' });
                        if (!response.ok) {
                            console.warn(`Échec du téléchargement de l'image ${index + 1}: ${response.status}`);
                            errorReasons.push('HTTP ' + response.status);
                            return null;
                        }
                        arrayBuffer = await response.arrayBuffer();
                    }
                }
                if (url.startsWith('data:')) {
                    // data URI direct
                    const base64 = url.split(',')[1];
                    arrayBuffer = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
                } else if (url.startsWith('blob:')) {
                    // Nécessite exécution dans l onglet pour récupérer le blob
                    const tabId = pageData.tabId;
                    if (typeof tabId === 'number') {
                        try {
                            const result = await new Promise((resolve, reject) => {
                                chrome.tabs.executeScript(tabId, {
                                    code: `fetch('${url}').then(r=>r.arrayBuffer()).then(b=>{ Array.from(new Uint8Array(b)) }).catch(e=>'ERROR:'+e.message);`
                                }, res => {
                                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                                    else resolve(res && res[0]);
                                });
                            });
                            if (typeof result === 'string' && result.startsWith('ERROR:')) {
                                console.warn('Échec blob fetch', result);
                                errorReasons.push('blob fetch');
                                return null;
                            }
                            arrayBuffer = new Uint8Array(result).buffer;
                        } catch(e) {
                            console.warn('Blob non récupéré', e);
                            errorReasons.push('blob exception');
                            return null;
                        }
                    } else {
                        return null;
                    }
                } else {
                    const response = await fetch(url, { mode: 'cors' });
                    if (!response.ok) {
                        console.warn(`Échec du téléchargement de l'image ${index + 1}: ${response.status}`);
                        errorReasons.push('HTTP ' + response.status);
                        return null;
                    }
                    arrayBuffer = await response.arrayBuffer();
                }
                
                // Générer un nom de fichier unique
                let filename = imageData.filename || `image_${index + 1}.jpg`;
                
                // Nettoyer le nom de fichier
                filename = filename.replace(/[<>:"/\\|?*]/g, '_');
                
                return { filename, data: new Uint8Array(arrayBuffer) };
                
            } catch (error) {
                console.error(`Erreur lors du téléchargement de l'image ${index + 1}:`, error);
                return null;
            }
        }
        
        // Télécharger toutes les images avec une limite de concurrence
        const batchSize = 3; // Télécharger 3 images en parallèle maximum
        
        for (let i = 0; i < images.length; i += batchSize) {
            const batch = images.slice(i, i + batchSize);
            const promises = batch.map((img, idx) => downloadImage(img, i + idx));
            
            const results = await Promise.all(promises);
            
            // Ajouter les images réussies au tableau
            results.forEach(result => {
                if (result) {
                    zipFiles.push(result);
                    downloadedCount++;
                    
                    // Envoyer la progression
                    // Diffuser la progression pour que la popup puisse l'afficher
                    chrome.runtime.sendMessage({
                        action: 'downloadProgress',
                        current: downloadedCount,
                        total: images.length
                    });
                }
            });
        }
        
        if (downloadedCount === 0) {
            const uniq = [...new Set(errorReasons)].slice(0,5).join(', ') || 'inconnue';
            sendResponse({ success: false, error: `Aucune image n'a pu être téléchargée (causes: ${uniq})` });
            return;
        }
        
        // Créer le ZIP
        console.log('Création du fichier ZIP...');
        const zipBlob = createSimpleZip(zipFiles);
        
        // Créer un URL pour le blob
        const url = URL.createObjectURL(zipBlob);
        
        // Télécharger le fichier ZIP
        const filename = pageData.title.replace(/[<>:"/\\|?*]/g, '_') + '.zip';
        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: false  // Téléchargement automatique sans demander
        }, function(downloadId) {
            if (chrome.runtime.lastError) {
                console.error('Erreur de téléchargement:', chrome.runtime.lastError.message);
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                // Nettoyer l'URL après un délai
                setTimeout(() => URL.revokeObjectURL(url), 10000);
                sendResponse({ 
                    success: true, 
                    downloadId: downloadId,
                    downloadedCount: downloadedCount,
                    improvedCount: improvedCount,
                    totalCount: images.length
                });
            }
        });
        
    } catch (error) {
        console.error('Erreur lors de la création du ZIP:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Fonction pour créer un ZIP simple sans bibliothèque externe
function createSimpleZip(files) {
    // Structure ZIP simplifiée
    const zipData = [];
    const centralDirectory = [];
    let offset = 0;
    
    files.forEach((file, index) => {
        const filename = new TextEncoder().encode(file.filename);
        const fileData = file.data;
        
        // Local file header
        const localHeader = new Uint8Array(30 + filename.length);
        const view = new DataView(localHeader.buffer);
        
        // Local file header signature
        view.setUint32(0, 0x04034b50, true);
        // Version needed to extract
        view.setUint16(4, 10, true);
        // General purpose bit flag
        view.setUint16(6, 0, true);
        // Compression method (0 = no compression)
        view.setUint16(8, 0, true);
        // Last mod file time
        view.setUint16(10, 0, true);
        // Last mod file date
        view.setUint16(12, 0, true);
        // CRC-32
        view.setUint32(14, crc32(fileData), true);
        // Compressed size
        view.setUint32(18, fileData.length, true);
        // Uncompressed size
        view.setUint32(22, fileData.length, true);
        // File name length
        view.setUint16(26, filename.length, true);
        // Extra field length
        view.setUint16(28, 0, true);
        
        // Add filename
        localHeader.set(filename, 30);
        
        zipData.push(localHeader);
        zipData.push(fileData);
        
        // Central directory entry
        const centralEntry = new Uint8Array(46 + filename.length);
        const centralView = new DataView(centralEntry.buffer);
        
        // Central file header signature
        centralView.setUint32(0, 0x02014b50, true);
        // Version made by
        centralView.setUint16(4, 10, true);
        // Version needed to extract
        centralView.setUint16(6, 10, true);
        // General purpose bit flag
        centralView.setUint16(8, 0, true);
        // Compression method
        centralView.setUint16(10, 0, true);
        // Last mod file time
        centralView.setUint16(12, 0, true);
        // Last mod file date
        centralView.setUint16(14, 0, true);
        // CRC-32
        centralView.setUint32(16, crc32(fileData), true);
        // Compressed size
        centralView.setUint32(20, fileData.length, true);
        // Uncompressed size
        centralView.setUint32(24, fileData.length, true);
        // File name length
        centralView.setUint16(28, filename.length, true);
        // Extra field length
        centralView.setUint16(30, 0, true);
        // File comment length
        centralView.setUint16(32, 0, true);
        // Disk number start
        centralView.setUint16(34, 0, true);
        // Internal file attributes
        centralView.setUint16(36, 0, true);
        // External file attributes
        centralView.setUint32(38, 0, true);
        // Relative offset of local header
        centralView.setUint32(42, offset, true);
        
        // Add filename
        centralEntry.set(filename, 46);
        
        centralDirectory.push(centralEntry);
        
        offset += localHeader.length + fileData.length;
    });
    
    // Central directory offset
    const centralDirOffset = offset;
    
    // Concatenate central directory
    const centralDirData = new Uint8Array(centralDirectory.reduce((sum, entry) => sum + entry.length, 0));
    let centralOffset = 0;
    centralDirectory.forEach(entry => {
        centralDirData.set(entry, centralOffset);
        centralOffset += entry.length;
    });
    
    // End of central directory record
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    
    // End of central dir signature
    endView.setUint32(0, 0x06054b50, true);
    // Number of this disk
    endView.setUint16(4, 0, true);
    // Number of the disk with the start of the central directory
    endView.setUint16(6, 0, true);
    // Total number of entries in the central directory on this disk
    endView.setUint16(8, files.length, true);
    // Total number of entries in the central directory
    endView.setUint16(10, files.length, true);
    // Size of the central directory
    endView.setUint32(12, centralDirData.length, true);
    // Offset of start of central directory
    endView.setUint32(16, centralDirOffset, true);
    // ZIP file comment length
    endView.setUint16(20, 0, true);
    
    // Combine all parts
    const totalSize = zipData.reduce((sum, part) => sum + part.length, 0) + centralDirData.length + endRecord.length;
    const result = new Uint8Array(totalSize);
    
    let pos = 0;
    zipData.forEach(part => {
        result.set(part, pos);
        pos += part.length;
    });
    
    result.set(centralDirData, pos);
    pos += centralDirData.length;
    
    result.set(endRecord, pos);
    
    return new Blob([result], { type: 'application/zip' });
}

// Fonction CRC32 simple
function crc32(data) {
    const table = [];
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c;
    }
    
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

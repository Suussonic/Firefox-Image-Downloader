    // THEME SWITCH
    const themeBtn = document.getElementById('themeSwitchBtn');
    const themeIcon = document.getElementById('themeIcon');
    function setTheme(dark) {
        document.body.classList.toggle('dark', dark);
        if (dark) {
            themeIcon.innerHTML = '<circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2m11-11h-2M3 12H1m16.95 7.07l-1.41-1.41M6.34 6.34L4.93 4.93m12.02 0l-1.41 1.41M6.34 17.66l-1.41 1.41"/>';
        } else {
            themeIcon.innerHTML = '<circle cx="12" cy="12" r="10" fill="#fff"/><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 109.79 9.79z"/>';
        }
        try { localStorage.setItem('imgdl_theme', dark ? 'dark' : 'light'); } catch(e) {}
    }
    // Charger le thème au démarrage
    (function() {
        let dark = false;
        try {
            dark = localStorage.getItem('imgdl_theme') === 'dark';
        } catch(e) {}
        setTheme(dark);
    })();
    themeBtn.onclick = function() {
        setTheme(!document.body.classList.contains('dark'));
    };
// popup.js
document.addEventListener('DOMContentLoaded', function() {
    const loadingDiv = document.getElementById('loading');
    const contentDiv = document.getElementById('content');
    const imageCountSpan = document.getElementById('imageCount');
    const siteNameSpan = document.getElementById('siteName');
    const zipNameSpan = document.getElementById('zipName');
    const zipTitleSelect = document.getElementById('zipTitleSelect');
    const downloadBtn = document.getElementById('downloadBtn');
    const statusDiv = document.getElementById('status');
    const progressDiv = document.getElementById('progress');
    const progressBar = document.getElementById('progressBar');

    let pageData = null;
    let allTagImages = {};
    let tagList = ['img', 'picture', 'figure'];
    let currentTagIdx = 0;
    let currentImgIdx = 0;

    // Analyser la page active
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const currentTab = tabs[0];
        chrome.tabs.executeScript(currentTab.id, {
            code: `
                (function() {
                    const titles = [];
                    if (document.title) titles.push(document.title.trim());
                    document.querySelectorAll('span:not([class]):not([id])').forEach(e => {
                        if (e.textContent && e.textContent.trim().length > 0) {
                            titles.push(e.textContent.trim());
                        }
                    });
                    const cleanTitles = titles.map(t => t.replace(/[<>:"/\\|?*]/g, '_').replace(/\\s+/g, '_'));

                    // Pour chaque balise d'image courante, récupérer les images visibles
                    const tagList = ['img', 'picture', 'figure'];
                    const tagImages = {};
                    tagList.forEach(tag => {
                        let elements = Array.from(document.querySelectorAll(tag));
                        if (tag === 'img') {
                            elements = elements.filter(img => img.offsetParent !== null && img.src);
                        }
                        tagImages[tag] = elements.map((el, idx) => {
                            let url = '';
                            if (tag === 'img') url = el.src;
                            else if (tag === 'picture') {
                                const img = el.querySelector('img');
                                url = img && img.src ? img.src : '';
                            } else if (tag === 'figure') {
                                const img = el.querySelector('img');
                                url = img && img.src ? img.src : '';
                            }
                            if (url.startsWith('//')) url = 'https:' + url;
                            else if (url.startsWith('/')) url = window.location.origin + url;
                            return {
                                url: url,
                                filename: (el.alt ? el.alt.replace(/[<>:"/\\|?*]/g, '_') : (tag + '_' + idx + '.jpg')),
                                thumbnail: url
                            };
                        }).filter(img => img.url);
                    });

                    return {
                        title: cleanTitles[0] || 'Images_Page',
                        titles: cleanTitles,
                        tagImages: tagImages,
                        url: window.location.href
                    };
                })();
            `
        }, function(results) {
            if (chrome.runtime.lastError) {
                showError('Erreur lors de l\'analyse de la page: ' + chrome.runtime.lastError.message);
                return;
            }
            if (results && results[0]) {
                pageData = results[0];
                allTagImages = pageData.tagImages;
                displayPageInfo();
            } else {
                showError('Impossible d\'analyser la page');
            }
        });
    });

    function displayPageInfo() {
        loadingDiv.style.display = 'none';
        contentDiv.style.display = 'block';
        siteNameSpan.textContent = new URL(pageData.url).hostname;
        zipTitleSelect.innerHTML = '';
        (pageData.titles || [pageData.title]).forEach((t, i) => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            if (i === 0) opt.selected = true;
            zipTitleSelect.appendChild(opt);
        });
        zipNameSpan.textContent = zipTitleSelect.value + '.zip';
        zipTitleSelect.onchange = function() {
            zipNameSpan.textContent = zipTitleSelect.value + '.zip';
        };
        updateImagePreview();
        updateTagLabel();
        updateImageCount();
    }

    function updateImagePreview() {
        const tag = tagList[currentTagIdx];
        const imgs = allTagImages[tag] || [];
        const previewImg = document.getElementById('previewImg');
        if (imgs.length === 0) {
            previewImg.src = '';
            previewImg.alt = 'Aucune image';
        } else {
            if (currentImgIdx >= imgs.length) currentImgIdx = 0;
            previewImg.src = imgs[currentImgIdx].thumbnail;
            previewImg.alt = imgs[currentImgIdx].filename;
        }
    }

    function updateTagLabel() {
        document.getElementById('currentTagLabel').textContent = 'Balise: ' + tagList[currentTagIdx];
    }

    function updateImageCount() {
        const tag = tagList[currentTagIdx];
        const imgs = allTagImages[tag] || [];
        imageCountSpan.textContent = imgs.length;
    }

    document.getElementById('prevImgBtn').onclick = function() {
        const tag = tagList[currentTagIdx];
        const imgs = allTagImages[tag] || [];
        if (imgs.length > 0) {
            currentImgIdx = (currentImgIdx - 1 + imgs.length) % imgs.length;
            updateImagePreview();
        }
    };
    document.getElementById('nextImgBtn').onclick = function() {
        const tag = tagList[currentTagIdx];
        const imgs = allTagImages[tag] || [];
        if (imgs.length > 0) {
            currentImgIdx = (currentImgIdx + 1) % imgs.length;
            updateImagePreview();
        }
    };
    document.getElementById('changeTagBtn').onclick = function() {
        currentTagIdx = (currentTagIdx + 1) % tagList.length;
        currentImgIdx = 0;
        updateTagLabel();
        updateImagePreview();
        updateImageCount();
    };

    function showError(message) {
        loadingDiv.style.display = 'none';
        contentDiv.style.display = 'block';
        statusDiv.textContent = message;
        statusDiv.className = 'status error';
        statusDiv.style.display = 'block';
        downloadBtn.disabled = true;
    }

    function showStatus(message, type = 'info') {
        statusDiv.textContent = message;
        statusDiv.className = 'status ' + type;
        statusDiv.style.display = 'block';
    }

    function updateProgress(current, total) {
        const percentage = Math.round((current / total) * 100);
        progressBar.style.width = percentage + '%';
        showStatus(`Téléchargement en cours... ${current}/${total} (${percentage}%)`, 'info');
    }

    downloadBtn.addEventListener('click', function() {
        if (!pageData || pageData.images.length === 0) {
            showError('Aucune image à télécharger');
            return;
        }

        downloadBtn.disabled = true;
        progressDiv.style.display = 'block';
        showStatus('Préparation du téléchargement...', 'info');

        // Envoyer la demande de téléchargement au background script
        chrome.runtime.sendMessage({
            action: 'downloadImages',
            data: pageData
        }, function(response) {
            if (response && response.success) {
                showStatus(`ZIP téléchargé avec succès! ${response.downloadedCount}/${response.totalCount} images`, 'success');
                progressBar.style.width = '100%';
            } else {
                showError('Erreur lors du téléchargement: ' + (response ? response.error : 'Erreur inconnue'));
                downloadBtn.disabled = false;
            }
        });
    });

    // Écouter les mises à jour de progression
    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
        if (message.action === 'downloadProgress') {
            updateProgress(message.current, message.total);
        }
    });
});

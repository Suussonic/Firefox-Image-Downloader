// content.js
// Ce script s'exécute dans le contexte de la page web
// Il peut être utilisé pour des fonctionnalités supplémentaires si nécessaire

console.log('Image Downloader - Content script chargé');

// Écouter les messages du popup
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.action === 'downloadProgress') {
        // Transférer le message au popup s'il est ouvert
        return true;
    }
});

// Observer les changements de DOM pour les pages dynamiques
const observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
        if (mutation.type === 'childList') {
            // Vérifier si de nouvelles images ont été ajoutées
            const addedNodes = mutation.addedNodes;
            for (let node of addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList && node.classList.contains('post__thumbnail')) {
                        console.log('Nouvelle image détectée');
                    }
                }
            }
        }
    });
});

// Commencer l'observation
observer.observe(document.body, {
    childList: true,
    subtree: true
});

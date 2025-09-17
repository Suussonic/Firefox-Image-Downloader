# Firefox-Image-Downloader
Extension Firefox permettant de télécharger toutes les images d'un site de façon trier dans un ZIP.

## Fonctionnalités principales

- **Détection automatique** de toutes les images affichées sur n'importe quel site
- **Menu déroulant** pour choisir le nom du fichier ZIP à partir des titres (`<title>`, `<span>`, etc.)
- **Navigation** entre les images détectées (flèches gauche/droite)
- **Filtrage** par balise d'image (`img`, `picture`, `figure`, etc.)
- **Téléchargement groupé** de toutes les images dans un fichier ZIP
- **Interface responsive** avec thème clair/sombre
- **Barre de progression** et gestion des erreurs

## Technologies utilisées

- **HTML5 / CSS3** : Interface utilisateur moderne et responsive
- **JavaScript (ES6)** : Logique de l'extension, manipulation DOM, communication entre scripts
- **JSZip** : Génération du fichier ZIP côté client
- **API WebExtension** : Compatibilité Firefox et Chrome (manifest v2)
- **Chrome/Firefox APIs** : Gestion des onglets, téléchargements, stockage local

## Installation (développement)

1. Clonez ou téléchargez ce repository
2. Ouvrez Firefox ou Chrome
3. Allez dans `about:debugging` (Firefox) ou `chrome://extensions` (Chrome)
4. Chargez le dossier de l'extension (fichier `manifest.json`)

## Utilisation

1. Naviguez sur une page contenant des images
2. Cliquez sur l'icône de l'extension
3. Vérifiez les images détectées, choisissez le nom du ZIP
4. Naviguez/filtrez si besoin, puis lancez le téléchargement

## Structure du projet

- `manifest.json` : Configuration de l'extension (permissions, scripts, popup)
- `popup.html` / `popup.js` : Interface utilisateur et logique du popup
- `background.js` : Téléchargement des images et création du ZIP
- `content.js` : Analyse du contenu de la page web
- `jszip.min.js` : Librairie JSZip pour la création de fichiers ZIP

## Permissions requises

- `activeTab` : Accès à l'onglet actif
- `downloads` : Téléchargement de fichiers
- `storage` : Sauvegarde des préférences (thème, etc.)
- `<all_urls>` : Analyse de toutes les pages web

## Limitations

- Fonctionne sur Firefox et Chrome (manifest v2)
- Téléchargement groupé uniquement (pas de téléchargement individuel)
- Peut ne pas détecter certaines images générées dynamiquement
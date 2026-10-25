Tu es un expert en développement d'extensions Visual Studio Code, en TypeScript, en Node.js et en architecture de Webviews. 

Je souhaite créer une extension VS Code nommée **f4datadashb** pour gérer et visualiser des dashboards de données locaux de manière décentralisée.

Voici les spécifications techniques et fonctionnelles exactes à respecter :

### 1. Gestion Multilingue (Français & Anglais)
- L'extension doit détecter la langue de l'utilisateur via `vscode.env.language` (ex: `fr`, `en`).
- Provoir un module de traduction simple (`i18n.ts`) supportant au minimum le **Français** et l'**Anglais** (par défaut en Anglais si la langue n'est pas reconnue).
- Tous les textes affichés dans l'interface (notifications `window.showInformationMessage`, boîtes de dialogue, erreurs, menus contextuels de la Sidebar) doivent s'adapter dynamiquement à la langue de l'utilisateur.

### 2. Définition, Validation et Chemins Robustes d'un Dashboard
- **Validation :** Un dossier est un dashboard valide s'il contient directement un fichier `package.json`, un sous-dossier `data/` (DuckDB/CSV/Parquet) et un sous-dossier `vue/` (`index.html`).
- **Robustesse des Chemins :** Utiliser systématiquement `path.resolve`, `path.join` et `path.normalize` (ou les objets `vscode.Uri`) pour garantir une compatibilité parfaite des chemins de fichiers entre Windows (`\`), macOS et Linux (`/`).

### 3. Logique d'Analyse des Dossiers (Performance)
Pour éviter de parcourir inutilement toute l'arborescence lors d'un import :
- **Cas A :** Le dossier sélectionné est lui-même un dashboard valide. On l'ajoute.
- **Cas B :** Le dossier sélectionné est un dossier parent. On scanne **uniquement le premier niveau de ses sous-dossiers direct** (`fs.readdirSync` avec `withFileTypes: true`). Si un sous-dossier est un dashboard valide, on l'ajoute (pas de recherche récursive profonde).

### 4. Barre Latérale (Primary Sidebar) & Actions (Ajout & Suppression)
- Implémenter un `TreeDataProvider` personnalisé pour afficher la liste des dashboards enregistrés (persistance des dossiers importés hors-workspace via `context.globalState`).
- **En-tête de la Vue :** Un bouton d'action (icône `folder-opened` ou `plus`) pour déclencher la commande d'importation (`f4datadashb.importDashboard`).
- **Menu Contextuel / Clic Droit & Suppression :** 
  - Assigner un `contextValue` spécifique aux éléments du TreeView (ex: `f4datadashb.dashboardItem`).
  - Ajouter une commande de suppression (`f4datadashb.removeDashboard`) accessible par clic droit sur un dashboard dans la sidebar ("Supprimer / Retirer ce dashboard" ou "Remove this dashboard"). 
  - Cette action doit retirer proprement le chemin du `globalState` et rafraîchir la vue.
- **Affichage :** Chaque élément affiche son `displayName` et sa `description` du `package.json`. Un clic gauche ouvre sa Webview.

### 5. Commandes d'Importation et de Création
#### A. Importation (`f4datadashb.importDashboard`) :
- Ouvre `vscode.window.showOpenDialog` (`canSelectFolders: true`, `canSelectMany: true`).
- Applique la règle d'analyse de premier niveau, normalise les chemins, met à jour le `globalState` et rafraîchit la Sidebar.

#### B. Création (`f4datadashb.createDashboard`) :
- Demande le nom technique et le titre via `showInputBox`.
- Génère la structure complète du dashboard :
  - Les dossiers `data/`, `vue/`, `src/`.
  - Le fichier `package.json` et le `vite.config.js` (pointant vers `../vue`).
  - Un template de base React (`App.jsx`).
  - **Génération automatique du Skill / Guide :** Créer également un fichier `SKILL_GUIDE.md` à la racine du nouveau dashboard généré, contenant les instructions obligatoires pour le développeur (gestion de `acquireVsCodeApi()`, double mode navigateur/VS Code via `npm run dev`, communication bidirectionnelle, et les 4 états UI obligatoires : chargement, erreur, vide, nominal).

### 6. Gestion de la Webview, de DuckDB, du Cache et du Double Watcher
- **Ouverture de la Webview & Requêtage DuckDB :**
  - Lire le fichier `index.html` du dossier `vue/` et configurer `localResourceRoots`.
  - **Gestion du Cache & Connexions :** Stocker en mémoire le résultat des dernières requêtes DuckDB pour optimiser l'affichage des fichiers volumineux.
  - *Règle critique DuckDB :* À chaque exécution de requête, ouvrir proprement la connexion, exécuter la requête, **puis fermer impérativement la connexion et l'instance de la base (`db.close()`)** pour libérer le fichier et éviter les fuites de mémoire.
  - Envoyer les données initiales via `webview.postMessage({ command: 'initData', data: ... })`.
- **Communication Bidirectionnelle :**
  - Écouter les messages venant de la Webview (`webview.onDidReceiveMessage`) pour gérer les actions de rafraîchissement forcé (qui vide le cache et relance une requête) ou de nouvelles requêtes dynamiques.
- **Double File Watcher :**
  1. Un watcher ciblé sur le dossier `vue/` actif pour recharger automatiquement la Webview lors d'un build (`npm run watch`).
  2. Un watcher ciblé sur le dossier `data/` pour invalider automatiquement le cache de données si le fichier DuckDB/CSV est modifié.

### 7. Bonnes pratiques de code :
- TypeScript strict, gestion rigoureuse des erreurs (`try/catch`) et destruction propre des ressources (disposal des panels, watchers et abonnements).
- Code propre, modulaire et commenté, prêt pour un projet `yo code`.
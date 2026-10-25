const messages = {
  en: {
    chooseDashboardFolders: "Choose dashboard folders to import",
    chooseCreateLocation: "Choose the dashboard root folder",
    dashboardTitle: "Dashboard title",
    selectFolderError: "Select a folder in the file system to initialize a dashboard.",
    invalidName: "Enter a title that contains at least one letter or number.",
    dashboardCreated: "Dashboard “{0}” was initialized.",
    openDashboardAction: "Open Dashboard",
    generatedFileExists: "The file {0} already exists. Replace it?",
    replaceFile: "Replace",
    keepFile: "Keep existing",
    buildRequired: "Run npm install and npm run build in this folder to generate the dashboard interface.",
    dashboardImported: "Imported {0} dashboard(s).",
    noDashboardsFound: "No valid dashboards were found in the selected folders.",
    dashboardRemoved: "Dashboard “{0}” was removed from the list.",
    invalidStoredDashboards: "Removed {0} dashboard(s) that are no longer valid.",
    openFailed: "Could not open dashboard “{0}”: {1}",
    createFailed: "Could not create the dashboard: {0}",
    importFailed: "Could not import dashboards: {0}",
    removeFailed: "Could not remove the dashboard: {0}",
    invalidDashboard: "This folder is not a valid dashboard.",
    invalidPackage: "The dashboard package.json is invalid: {0}",
    dashboardUnavailable: "This dashboard is no longer available.",
    dashboardNotReady: "The dashboard build is missing. Run npm run build in its folder.",
    dashboardOperationFailed: "Could not load dashboard content: {0}",
    queryFailed: "The DuckDB query failed: {0}",
    folderPickerTitle: "Select the dashboard root folder",
    removeConfirmation: "Remove “{0}” from the dashboard list? Its files will not be deleted.",
    removeAction: "Remove",
    cancel: "Cancel"
  },
  fr: {
    chooseDashboardFolders: "Choisir les dossiers de tableaux de bord à importer",
    chooseCreateLocation: "Choisir le dossier racine du tableau de bord",
    dashboardTitle: "Titre du tableau de bord",
    selectFolderError: "Sélectionnez un dossier du système de fichiers pour y initialiser un tableau de bord.",
    invalidName: "Saisissez un titre contenant au moins une lettre ou un chiffre.",
    dashboardCreated: "Le tableau de bord « {0} » a été initialisé.",
    openDashboardAction: "Ouvrir le tableau de bord",
    generatedFileExists: "Le fichier {0} existe déjà. Le remplacer ?",
    replaceFile: "Remplacer",
    keepFile: "Conserver",
    buildRequired: "Exécutez npm install puis npm run build dans ce dossier pour générer l’interface du tableau de bord.",
    dashboardImported: "{0} tableau(x) de bord importé(s).",
    noDashboardsFound: "Aucun tableau de bord valide n’a été trouvé dans les dossiers sélectionnés.",
    dashboardRemoved: "Le tableau de bord « {0} » a été retiré de la liste.",
    invalidStoredDashboards: "{0} tableau(x) de bord qui ne sont plus valides ont été retirés.",
    openFailed: "Impossible d’ouvrir le tableau de bord « {0} » : {1}",
    createFailed: "Impossible de créer le tableau de bord : {0}",
    importFailed: "Impossible d’importer les tableaux de bord : {0}",
    removeFailed: "Impossible de retirer le tableau de bord : {0}",
    invalidDashboard: "Ce dossier n’est pas un tableau de bord valide.",
    invalidPackage: "Le fichier package.json du tableau de bord est invalide : {0}",
    dashboardUnavailable: "Ce tableau de bord n’est plus disponible.",
    dashboardNotReady: "Le build du tableau de bord est absent. Exécutez npm run build dans son dossier.",
    dashboardOperationFailed: "Impossible de charger le contenu du tableau de bord : {0}",
    queryFailed: "La requête DuckDB a échoué : {0}",
    folderPickerTitle: "Sélectionner le dossier racine du tableau de bord",
    removeConfirmation: "Retirer « {0} » de la liste ? Ses fichiers ne seront pas supprimés.",
    removeAction: "Retirer",
    cancel: "Annuler"
  }
} as const;

export type MessageKey = keyof typeof messages.en;

export function translate(language: string, key: MessageKey, ...values: string[]): string {
  const dictionary = language.toLowerCase().startsWith("fr") ? messages.fr : messages.en;
  return dictionary[key].replace(/\{(\d+)\}/g, (match, index: string) => values[Number(index)] ?? match);
}

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const basic_ftp_1 = require("basic-ftp");
const ssh2_sftp_client_1 = __importDefault(require("ssh2-sftp-client"));
let ftpProvider;
function getProvider() {
    return ftpProvider;
}
function activate(context) {
    ftpProvider = new RemoteFTPProvider(context);
    const treeView = vscode.window.createTreeView('remote-ftp-vscode', {
        treeDataProvider: ftpProvider,
        showCollapseAll: true
    });
    // Додаємо обробник події розкриття вузла
    treeView.onDidExpandElement((e) => {
        console.log(`Expanding node: ${e.element.name}`);
        ftpProvider?.refreshNode(e.element);
    });
    if (ftpProvider) {
        context.subscriptions.push(treeView, vscode.commands.registerCommand('remoteFtp.refresh', (item) => {
            if (item && ftpProvider) {
                ftpProvider.refreshNode(item);
            }
        }), vscode.commands.registerCommand('remoteFtp.openFile', (item) => ftpProvider?.openRemoteFile(item)), vscode.commands.registerCommand('remoteFtp.download', (item) => ftpProvider?.downloadToLocal(item, true)), vscode.commands.registerCommand('remoteFtp.newFile', (item) => ftpProvider?.createNewFile(item)), vscode.commands.registerCommand('remoteFtp.newFolder', (item) => ftpProvider?.createNewFolder(item)), vscode.commands.registerCommand('remoteFtp.uploadFiles', (item) => ftpProvider?.uploadFiles(item)), vscode.commands.registerCommand('remoteFtp.uploadFolder', (item) => ftpProvider?.uploadFolder(item)), vscode.commands.registerCommand('remoteFtp.changePermissions', (item) => ftpProvider?.changePermissions(item)), vscode.commands.registerCommand('remoteFtp.deleteRemoteFile', (item) => ftpProvider?.deleteRemoteFile(item)), vscode.commands.registerCommand('remoteFtp.copyRemotePath', (item) => ftpProvider?.copyRemotePathToClipboard(item)), vscode.commands.registerCommand('remoteFtp.renameFile', (item) => ftpProvider?.renameFile(item)), vscode.commands.registerCommand('remoteFtp.refreshNode', (item) => ftpProvider?.refreshNode(item)), vscode.workspace.onDidSaveTextDocument(doc => ftpProvider?.uploadEditedFile(doc)), vscode.commands.registerCommand('remoteFtp.dropFile', async (uri) => {
            if (ftpProvider) {
                const currentHost = ftpProvider.getCurrentHost();
                if (currentHost) {
                    const item = {
                        type: 'file',
                        name: path.basename(uri.fsPath),
                        path: uri.fsPath,
                        parentHost: currentHost
                    };
                    await ftpProvider.uploadFiles(item);
                }
            }
        }));
    }
}
class ConnectionPool {
    pool = new Map();
    connectionQueue = [];
    maxConnections = 3;
    activeConnections = 0;
    operationLocks = new Map();
    setMaxConnections(max) {
        this.maxConnections = max;
    }
    getConnection(host) {
        return this.pool.get(host.name);
    }
    setConnection(host, connection) {
        this.pool.set(host.name, connection);
    }
    async executeOperation(host, operation) {
        const key = host.name;
        // Get or create operation lock
        let lock = this.operationLocks.get(key);
        if (!lock) {
            lock = Promise.resolve();
            this.operationLocks.set(key, lock);
        }
        // Create new lock that depends on previous operation
        const newLock = lock.then(async () => {
            try {
                const client = this.getConnection(host);
                if (!client) {
                    throw new Error('No connection available');
                }
                await operation(client);
            }
            catch (error) {
                throw error;
            }
        });
        // Update lock
        this.operationLocks.set(key, newLock);
        // Wait for operation to complete
        await newLock;
    }
    async queueConnection(host) {
        return new Promise((resolve, reject) => {
            this.connectionQueue.push({ host, resolve, reject });
        });
    }
    processNextConnection() {
        if (this.connectionQueue.length > 0) {
            const next = this.connectionQueue.shift();
            if (next) {
                const client = this.getConnection(next.host);
                if (client) {
                    next.resolve(client);
                }
                else {
                    next.reject(new Error('Failed to get connection'));
                }
            }
        }
    }
    releaseConnection(host) {
        const client = this.pool.get(host.name);
        if (client) {
            if (host.protocol === 'ftp') {
                client.close();
            }
            else {
                client.end();
            }
            this.pool.delete(host.name);
            this.activeConnections--;
            this.processNextConnection();
        }
    }
    closeAll() {
        for (const [hostName, client] of this.pool.entries()) {
            if (client instanceof basic_ftp_1.Client) {
                client.close();
            }
            else {
                client.end();
            }
        }
        this.pool.clear();
        this.activeConnections = 0;
        this.connectionQueue = [];
        this.operationLocks.clear();
    }
}
class RemoteFTPProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    isDownloading = false;
    currentDownloadTask;
    connectionPool;
    hosts = [];
    tmpDir = path.join(os.tmpdir(), '.remote-ftp-tmp');
    fileMap = new Map();
    currentHost;
    connectedHosts = new Map();
    constructor(context) {
        console.log('[RemoteFTP] Initializing RemoteFTPProvider');
        this.connectionPool = new ConnectionPool();
        // Встановлюємо максимальну кількість з'єднань на основі налаштувань
        const config = getConfig();
        if (config) {
            const maxWorkers = Math.max(...Object.values(config).map((host) => host.workers ?? 3));
            this.connectionPool.setMaxConnections(maxWorkers);
            console.log(`[RemoteFTP] Set maximum connections to ${maxWorkers}`);
        }
        this.loadConfig();
        if (!fs.existsSync(this.tmpDir))
            fs.mkdirSync(this.tmpDir, { recursive: true });
        // Додаємо обробник події розкриття вузла
        vscode.window.onDidChangeActiveTextEditor(() => {
            // Оновлюємо тільки активний сервер
            if (this.currentHost) {
                this.refreshNode(this.currentHost);
            }
        });
    }
    loadConfig() {
        console.log('[RemoteFTP] Loading configuration');
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!folder) {
            console.error('[RemoteFTP] No workspace folder open');
            vscode.window.showErrorMessage('Open a folder to use Remote FTP');
            return;
        }
        const configPath = path.join(folder, 'config.json');
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            this.hosts = config.hosts;
            console.log(`[RemoteFTP] Loaded ${this.hosts.length} hosts from config`);
            this.connectedHosts.clear();
            this.currentHost = undefined;
        }
        catch (e) {
            console.error('[RemoteFTP] Failed to read config.json:', e);
            vscode.window.showErrorMessage('Failed to read config.json');
            this.hosts = [];
        }
    }
    refresh(item) {
        console.log('[RemoteFTP] Refreshing tree view', item ? `for item: ${item.name}` : 'for all items');
        // Close all existing connections
        if (this.connectionPool) {
            console.log('[RemoteFTP] Closing all existing connections');
            this.connectionPool.closeAll();
        }
        // Clear connection states
        this.connectedHosts.clear();
        this.currentHost = undefined;
        if (item) {
            this._onDidChangeTreeData.fire(item);
        }
        else {
            this.loadConfig();
            this._onDidChangeTreeData.fire(undefined);
        }
    }
    getTreeItem(element) {
        if ('protocol' in element) {
            console.log(`[RemoteFTP] Creating tree item for host: ${element.name}`);
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon('server');
            item.id = `host:${element.name}`;
            item.contextValue = 'host';
            return item;
        }
        console.log(`[RemoteFTP] Creating tree item for ${element.type}: ${element.name}`);
        const item = new vscode.TreeItem(element.name, element.type === 'directory'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(element.type === 'directory' ? 'folder' : 'file-code');
        item.id = `file:${element.parentHost.name}:${element.path}`;
        item.contextValue = element.type;
        if (element.type === 'file') {
            item.command = {
                command: 'remoteFtp.openFile',
                title: 'Open File',
                arguments: [element]
            };
        }
        return item;
    }
    async getChildren(element) {
        if (!element) {
            console.log(`[RemoteFTP][${new Date().toISOString()}] Getting root hosts`);
            return this.hosts;
        }
        let children = [];
        if ('protocol' in element) {
            console.log(`[RemoteFTP][${new Date().toISOString()}] Expanding server: ${element.name}`);
            try {
                const config = getConfig();
                if (!config || !config[element.name]) {
                    console.error(`[RemoteFTP][${new Date().toISOString()}] Invalid configuration for host ${element.name}`);
                    throw new Error(`Invalid configuration for host ${element.name}`);
                }
                console.log(`[RemoteFTP][${new Date().toISOString()}] Checking connection status for ${element.name}`);
                const isConnected = this.connectedHosts.get(element.name);
                console.log(`[RemoteFTP][${new Date().toISOString()}] Connection status for ${element.name}: ${isConnected}`);
                if (!isConnected) {
                    console.log(`[RemoteFTP][${new Date().toISOString()}] Attempting to connect to ${element.name}`);
                    const client = await this.getConnection(element);
                    if (client) {
                        console.log(`[RemoteFTP][${new Date().toISOString()}] Successfully connected to ${element.name}`);
                        this.connectedHosts.set(element.name, true);
                        this.currentHost = element;
                    }
                    else {
                        console.error(`[RemoteFTP][${new Date().toISOString()}] Failed to connect to ${element.name}`);
                        throw new Error(`Failed to connect to ${element.name}`);
                    }
                }
                console.log(`[RemoteFTP][${new Date().toISOString()}] Getting remote files for ${element.name}`);
                children = await this.getRemoteFiles(element, element.remotePath);
                console.log(`[RemoteFTP][${new Date().toISOString()}] Found ${children.length} items for ${element.name}`);
            }
            catch (error) {
                console.error(`[RemoteFTP][${new Date().toISOString()}] Error getting children for host ${element.name}:`, error);
                vscode.window.showErrorMessage(`Failed to connect to ${element.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                this.connectedHosts.set(element.name, false);
                this.currentHost = undefined;
                return [];
            }
        }
        else if (element.type === 'directory') {
            console.log(`[RemoteFTP][${new Date().toISOString()}] Getting children for directory: ${element.name}`);
            try {
                // Встановлюємо поточний хост перед отриманням вмісту директорії
                this.currentHost = element.parentHost;
                if (!this.currentHost) {
                    console.error(`[RemoteFTP][${new Date().toISOString()}] No parent host found for directory ${element.name}`);
                    throw new Error(`No parent host found for directory ${element.name}`);
                }
                children = await this.getRemoteFiles(element.parentHost, element.path);
                console.log(`[RemoteFTP][${new Date().toISOString()}] Found ${children.length} items in directory ${element.name}`);
            }
            catch (error) {
                console.error(`[RemoteFTP][${new Date().toISOString()}] Error getting children for directory ${element.name}:`, error);
                vscode.window.showErrorMessage(`Failed to list directory ${element.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                return [];
            }
        }
        else {
            console.log(`[RemoteFTP][${new Date().toISOString()}] Getting children for file: ${element.name} (no children)`);
            children = [];
        }
        return children;
    }
    async getConnection(host) {
        const hostKey = host.name;
        const existingConnection = this.connectionPool.getConnection(host);
        if (existingConnection) {
            return existingConnection;
        }
        // Створюємо нове підключення тільки для цього хоста
        console.log(`[RemoteFTP][${new Date().toISOString()}] Creating new connection for ${host.name}`);
        const client = host.protocol === 'ftp' ? new basic_ftp_1.Client() : new ssh2_sftp_client_1.default();
        if (host.protocol === 'ftp') {
            await client.access({
                host: host.host,
                port: host.port,
                user: host.username,
                password: host.password
            });
        }
        else {
            await client.connect({
                host: host.host,
                port: host.port,
                username: host.username,
                password: host.password
            });
        }
        // Зберігаємо підключення в пулі
        this.connectionPool.setConnection(host, client);
        this.connectedHosts.set(host.name, true);
        console.log(`[RemoteFTP][${new Date().toISOString()}] Successfully connected to ${host.name}`);
        return client;
    }
    async getRemoteFiles(host, remotePath) {
        console.log(`[RemoteFTP][${new Date().toISOString()}] Getting remote files for ${host.name} at path: ${remotePath}`);
        const client = await this.getConnection(host);
        if (!client) {
            throw new Error(`Failed to get connection for ${host.name}`);
        }
        try {
            console.log(`[RemoteFTP][${new Date().toISOString()}] Listing ${host.protocol} directory: ${remotePath}`);
            let items = [];
            if (host.protocol === 'ftp') {
                const ftpClient = client;
                try {
                    const entries = await ftpClient.list(remotePath);
                    items = entries.map(entry => ({
                        type: entry.type === 2 ? 'directory' : 'file',
                        name: entry.name,
                        path: path.posix.join(remotePath, entry.name),
                        parentHost: host
                    }));
                }
                catch (error) {
                    if (error.message?.includes('Client is closed')) {
                        console.log(`[RemoteFTP][${new Date().toISOString()}] Connection closed, attempting to reconnect for ${host.name}`);
                        await this.closeConnection(host);
                        const newClient = await this.getConnection(host);
                        if (newClient) {
                            const entries = await newClient.list(remotePath);
                            items = entries.map(entry => ({
                                type: entry.type === 2 ? 'directory' : 'file',
                                name: entry.name,
                                path: path.posix.join(remotePath, entry.name),
                                parentHost: host
                            }));
                        }
                        else {
                            throw new Error(`Failed to reconnect for ${host.name}`);
                        }
                    }
                    else {
                        throw error;
                    }
                }
            }
            else {
                const sftpClient = client;
                try {
                    const entries = await sftpClient.list(remotePath);
                    items = entries.map(entry => ({
                        type: entry.type === 'd' ? 'directory' : 'file',
                        name: entry.name,
                        path: path.posix.join(remotePath, entry.name),
                        parentHost: host
                    }));
                }
                catch (error) {
                    if (error.message?.includes('Client is closed')) {
                        console.log(`[RemoteFTP][${new Date().toISOString()}] Connection closed, attempting to reconnect for ${host.name}`);
                        await this.closeConnection(host);
                        const newClient = await this.getConnection(host);
                        if (newClient) {
                            const entries = await newClient.list(remotePath);
                            items = entries.map(entry => ({
                                type: entry.type === 'd' ? 'directory' : 'file',
                                name: entry.name,
                                path: path.posix.join(remotePath, entry.name),
                                parentHost: host
                            }));
                        }
                        else {
                            throw new Error(`Failed to reconnect for ${host.name}`);
                        }
                    }
                    else {
                        throw error;
                    }
                }
            }
            // Filter out ignored files and directories
            items = items.filter(item => {
                if (item.type === 'file' && host.ignoreExtensions.includes(path.extname(item.name)))
                    return false;
                const relPath = path.posix.relative(host.remotePath, item.path);
                if (host.ignorePaths?.some(p => relPath.startsWith(p)))
                    return false;
                return true;
            });
            // Sort items: directories first, then files
            items.sort((a, b) => {
                if (a.type === 'directory' && b.type === 'file')
                    return -1;
                if (a.type === 'file' && b.type === 'directory')
                    return 1;
                return a.name.localeCompare(b.name);
            });
            console.log(`[RemoteFTP][${new Date().toISOString()}] Found ${items.length} entries in ${host.protocol} directory`);
            return items;
        }
        catch (error) {
            console.error(`[RemoteFTP][${new Date().toISOString()}] Error listing directory ${remotePath}:`, error);
            throw error;
        }
    }
    async openRemoteFile(item) {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                throw new Error('No workspace folder open');
            }
            const localBase = path.resolve(workspaceRoot, item.parentHost.localPath, item.parentHost.name);
            const remoteRoot = item.parentHost.remotePath;
            const relative = path.posix.relative(remoteRoot, item.path);
            const localTarget = path.resolve(localBase, relative.replace(/\//g, path.sep));
            // Перевірка на існування директорії
            const targetDir = path.dirname(localTarget);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Opening: ${item.name}`,
                cancellable: true
            }, async (progress, token) => {
                progress.report({ message: 'Downloading file...' });
                try {
                    await this.downloadSingleFile(item, localTarget);
                }
                catch (error) {
                    if (token.isCancellationRequested) {
                        vscode.window.showWarningMessage('⚠️ Download cancelled');
                        return;
                    }
                    throw error;
                }
            });
            // Перевірка на існування файлу після завантаження
            if (!fs.existsSync(localTarget)) {
                throw new Error(`File was not downloaded successfully: ${localTarget}`);
            }
            const doc = await vscode.workspace.openTextDocument(localTarget);
            await vscode.window.showTextDocument(doc);
            this.fileMap.set(localTarget, item);
        }
        catch (e) {
            vscode.window.showErrorMessage(`❌ Failed to open ${item.name}`);
            console.error(e);
        }
    }
    async uploadEditedFile(doc) {
        let item = this.fileMap.get(doc.fileName);
        if (!item) {
            try {
                const meta = JSON.parse(doc.uri.query);
                const host = this.hosts.find(h => h.name === meta.host);
                if (!host)
                    return;
                item = {
                    name: path.basename(meta.path),
                    path: meta.path,
                    parentHost: host,
                    type: 'file'
                };
                this.fileMap.set(doc.fileName, item);
            }
            catch {
                return;
            }
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Uploading: ${item.name}`,
            cancellable: false
        }, async () => {
            try {
                const client = await this.getConnection(item.parentHost);
                if (item.parentHost.protocol === 'ftp') {
                    await client.uploadFrom(doc.fileName, item.path);
                }
                else {
                    await client.fastPut(doc.fileName, item.path);
                }
                vscode.window.setStatusBarMessage(`✅ Uploaded: ${item.name}`, 3000);
                //await this.downloadToLocal(item!, false);
                await this.createBackup(item);
            }
            catch (e) {
                vscode.window.showErrorMessage(`❌ Failed to upload ${item.name}`);
                console.error(e);
            }
        });
    }
    async scanDirectory(host, remotePath, remoteRoot, localBase, concurrency, progress, token) {
        console.log(`[RemoteFTP] Starting directory scan for ${remotePath}`);
        const allFiles = [];
        const directoriesToScan = new Set([remotePath]);
        const scannedDirs = new Set();
        let totalDirs = 0;
        let lastProgressUpdate = 0;
        let lastFileCount = 0;
        while (directoriesToScan.size > 0) {
            if (token.isCancellationRequested) {
                console.log('[RemoteFTP] Scan cancelled by user');
                this.isDownloading = false;
                this.currentDownloadTask = undefined;
                throw new Error('cancelled');
            }
            // Використовуємо concurrency замість фіксованого batchSize
            const currentDirs = Array.from(directoriesToScan).slice(0, concurrency);
            currentDirs.forEach(dir => directoriesToScan.delete(dir));
            const scanPromises = currentDirs.map(async (dir) => {
                if (scannedDirs.has(dir))
                    return;
                scannedDirs.add(dir);
                totalDirs++;
                try {
                    const entries = await this.getRemoteFiles(host, dir);
                    for (const entry of entries) {
                        if (token.isCancellationRequested) {
                            this.isDownloading = false;
                            this.currentDownloadTask = undefined;
                            throw new Error('cancelled');
                        }
                        if (entry.type === 'directory') {
                            directoriesToScan.add(entry.path);
                        }
                        else {
                            const relative = path.posix.relative(remoteRoot, entry.path);
                            const localTarget = path.resolve(localBase, relative.replace(/\//g, path.sep));
                            allFiles.push({ item: entry, localTarget });
                        }
                    }
                    // Оновлюємо прогрес кожні 500мс або коли знайдено нові файли
                    const now = Date.now();
                    if (now - lastProgressUpdate > 500 || allFiles.length - lastFileCount >= 100) {
                        progress.report({
                            message: `Scanning... (${totalDirs} directories, ${allFiles.length} files found)`,
                            increment: (allFiles.length - lastFileCount) / Math.max(1, allFiles.length) * 100
                        });
                        lastProgressUpdate = now;
                        lastFileCount = allFiles.length;
                    }
                }
                catch (error) {
                    console.error(`[RemoteFTP] Error scanning directory ${dir}:`, error);
                    // Продовжуємо з наступною директорією
                }
            });
            try {
                await Promise.all(scanPromises);
            }
            catch (error) {
                if (error instanceof Error && error.message === 'cancelled') {
                    throw error;
                }
                console.error('[RemoteFTP] Error processing batch:', error);
            }
        }
        progress.report({
            message: `Scanning complete. Found ${allFiles.length} files in ${totalDirs} directories.`,
            increment: 100
        });
        return allFiles;
    }
    async downloadToLocal(item, showMes) {
        console.log(`[DownloadToLocal] Starting download for ${item.name} (type: ${item.type})`);
        // Check workspace
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            console.error('[DownloadToLocal] No workspace folder open');
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
        // Calculate paths
        const localBase = path.resolve(workspaceRoot, item.parentHost.localPath, item.parentHost.name);
        const remoteRoot = item.parentHost.remotePath;
        console.log('[DownloadToLocal] Paths:', {
            workspaceRoot,
            localBase,
            remoteRoot,
            itemPath: item.path
        });
        // Get concurrency setting
        const config = getConfig();
        const concurrency = config?.[item.parentHost.name]?.workers ?? 3;
        console.log(`[DownloadToLocal] Using concurrency: ${concurrency}`);
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `📥 Downloading ${item.name}`,
                cancellable: true
            }, async (progress, token) => {
                if (item.type === 'directory') {
                    console.log('[DownloadToLocal] Processing directory download');
                    await this.downloadDirectory(item, localBase, remoteRoot, concurrency, progress, token);
                }
                else {
                    console.log('[DownloadToLocal] Processing single file download');
                    const relative = path.posix.relative(remoteRoot, item.path);
                    const localTarget = path.resolve(localBase, relative.replace(/\//g, path.sep));
                    // Ensure target directory exists
                    const targetDir = path.dirname(localTarget);
                    if (!fs.existsSync(targetDir)) {
                        console.log(`[DownloadToLocal] Creating directory: ${targetDir}`);
                        fs.mkdirSync(targetDir, { recursive: true });
                    }
                    progress.report({ message: 'Downloading file...' });
                    await this.downloadSingleFile(item, localTarget);
                    if (!fs.existsSync(localTarget)) {
                        throw new Error(`File was not downloaded successfully: ${localTarget}`);
                    }
                    console.log(`[DownloadToLocal] File downloaded successfully: ${localTarget}`);
                }
                if (token.isCancellationRequested) {
                    console.log('[DownloadToLocal] Download cancelled by user');
                    vscode.window.showWarningMessage('⚠️ Download cancelled');
                }
                else if (showMes) {
                    console.log('[DownloadToLocal] Download completed successfully');
                    vscode.window.showInformationMessage('✅ Download complete');
                }
            });
        }
        catch (error) {
            console.error('[DownloadToLocal] Error during download:', error);
            vscode.window.showErrorMessage(`Failed to download: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    async downloadDirectory(item, localBase, remoteRoot, concurrency, progress, token) {
        console.log('[DownloadDirectory] Starting directory download:', {
            itemPath: item.path,
            localBase,
            remoteRoot,
            concurrency
        });
        // First, scan the directory
        progress.report({ message: 'Scanning files...' });
        const files = await this.scanDirectoryForDownload(item, remoteRoot, localBase, progress, token);
        console.log(`[DownloadDirectory] Found ${files.length} files to download`);
        if (token.isCancellationRequested) {
            console.log('[DownloadDirectory] Scanning cancelled by user');
            return;
        }
        // Initialize download tracking
        const total = files.length;
        let completed = 0;
        let failed = 0;
        const failedFiles = [];
        const retryQueue = [];
        // Create download queue
        const queue = files.slice();
        const inProgress = new Set();
        const activeConnections = new Set();
        progress.report({ message: `Starting download of ${total} files...` });
        // Process files in batches to prevent connection flooding
        const batchSize = Math.min(concurrency, 3); // Limit concurrent connections
        console.log(`[DownloadDirectory] Using batch size: ${batchSize}`);
        // Create a single connection for the entire download process
        const client = await this.getConnection(item.parentHost);
        if (!client) {
            throw new Error('Failed to establish initial connection');
        }
        try {
            while (queue.length > 0 || inProgress.size > 0 || retryQueue.length > 0) {
                if (token.isCancellationRequested) {
                    console.log('[DownloadDirectory] Download cancelled by user');
                    break;
                }
                // Process retry queue first
                while (retryQueue.length > 0 && inProgress.size < batchSize) {
                    const retryItem = retryQueue.shift();
                    if (retryItem.attempts < 3) {
                        queue.unshift({ item: retryItem.item, localTarget: retryItem.localTarget });
                    }
                    else {
                        failed++;
                        failedFiles.push(retryItem.item.name);
                        console.log(`[DownloadDirectory] Giving up on ${retryItem.item.name} after 3 retries`);
                    }
                }
                // Fill up worker slots
                while (queue.length > 0 && inProgress.size < batchSize) {
                    const file = queue.shift();
                    console.log(`[DownloadDirectory] Starting download of: ${file.item.name}`);
                    const downloadPromise = (async () => {
                        try {
                            // Wait if we have too many active connections
                            while (activeConnections.size >= batchSize) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            const connectionKey = `${file.item.parentHost.name}-${Date.now()}`;
                            activeConnections.add(connectionKey);
                            console.log(`[DownloadDirectory] Active connections: ${activeConnections.size}`);
                            try {
                                await this.downloadSingleFileWithClient(file.item, file.localTarget, client);
                                completed++;
                                console.log(`[DownloadDirectory] Successfully downloaded: ${file.item.name}`);
                            }
                            catch (error) {
                                console.log(`[DownloadDirectory] Failed to download ${file.item.name}, will retry`);
                                retryQueue.push({ ...file, attempts: file.attempts || 0 + 1 });
                            }
                            finally {
                                activeConnections.delete(connectionKey);
                                console.log(`[DownloadDirectory] Released connection. Active: ${activeConnections.size}`);
                            }
                        }
                        catch (error) {
                            console.error(`[DownloadDirectory] Unexpected error downloading ${file.item.name}:`, error);
                            retryQueue.push({ ...file, attempts: file.attempts || 0 + 1 });
                        }
                        progress.report({
                            message: `Downloaded ${completed}/${total} files (${failed} failed, ${retryQueue.length} queued for retry)`,
                            increment: 100 / total
                        });
                    })();
                    inProgress.add(downloadPromise);
                    downloadPromise.finally(() => inProgress.delete(downloadPromise));
                }
                // Wait for at least one download to complete
                if (inProgress.size > 0) {
                    await Promise.race(inProgress);
                }
            }
        }
        finally {
            // Release the connection when done
            this.connectionPool.releaseConnection(item.parentHost);
        }
        if (failed > 0) {
            console.log('[DownloadDirectory] Download completed with errors:', {
                total,
                completed,
                failed,
                failedFiles
            });
            vscode.window.showWarningMessage(`Download completed with ${failed} errors. Failed files: ${failedFiles.join(', ')}`);
        }
        else {
            console.log('[DownloadDirectory] Download completed successfully:', {
                total,
                completed
            });
        }
    }
    async downloadSingleFileWithClient(item, localTarget, client) {
        if (item.type === 'directory') {
            throw new Error('Cannot download a directory using downloadSingleFile');
        }
        // Create target directory if it doesn't exist
        const targetDir = path.dirname(localTarget);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        // Create a temporary file for downloading
        const tempFile = `${localTarget}.tmp`;
        const writeStream = fs.createWriteStream(tempFile);
        try {
            if (item.parentHost.protocol === 'ftp') {
                // For FTP, use downloadTo with proper error handling
                await client.downloadTo(writeStream, item.path);
            }
            else {
                // For SFTP, handle the stream properly
                const readStream = await client.get(item.path);
                if (typeof readStream === 'string' || Buffer.isBuffer(readStream)) {
                    writeStream.write(readStream);
                    writeStream.end();
                }
                else {
                    await new Promise((resolve, reject) => {
                        const stream = readStream;
                        stream.on('error', (err) => {
                            writeStream.destroy();
                            reject(err);
                        });
                        stream.pipe(writeStream)
                            .on('finish', () => resolve())
                            .on('error', (err) => {
                            stream.destroy();
                            reject(err);
                        });
                    });
                }
            }
            // After successful download, rename temp file to target
            if (fs.existsSync(localTarget)) {
                fs.unlinkSync(localTarget);
            }
            fs.renameSync(tempFile, localTarget);
        }
        catch (error) {
            // Clean up temp file if it exists
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
            writeStream.destroy();
            throw error;
        }
        finally {
            writeStream.end();
        }
    }
    async downloadSingleFile(item, localTarget) {
        let retryCount = 0;
        const maxRetries = 3;
        while (retryCount < maxRetries) {
            try {
                const client = await this.getConnection(item.parentHost);
                if (!client) {
                    throw new Error('Failed to get connection');
                }
                try {
                    await this.downloadSingleFileWithClient(item, localTarget, client);
                    return; // Success, exit the retry loop
                }
                finally {
                    this.connectionPool.releaseConnection(item.parentHost);
                }
            }
            catch (error) {
                retryCount++;
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.log(`[DownloadSingleFile] Attempt ${retryCount} failed for ${item.name}: ${errorMessage}`);
                if (retryCount === maxRetries) {
                    throw new Error(`Failed to download ${item.name} after ${maxRetries} attempts: ${errorMessage}`);
                }
                // Wait before retrying, with exponential backoff
                const waitTime = Math.pow(2, retryCount) * 1000;
                console.log(`[DownloadSingleFile] Waiting ${waitTime}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }
    async scanDirectoryForDownload(item, remoteRoot, localBase, progress, token) {
        console.log('[ScanDirectory] Starting directory scan:', {
            itemPath: item.path,
            remoteRoot,
            localBase
        });
        const result = [];
        const dirsToScan = [item.path];
        const scannedDirs = new Set();
        let totalItems = 0;
        while (dirsToScan.length > 0) {
            if (token.isCancellationRequested) {
                console.log('[ScanDirectory] Scan cancelled by user');
                return result;
            }
            const currentDir = dirsToScan.shift();
            if (scannedDirs.has(currentDir))
                continue;
            scannedDirs.add(currentDir);
            try {
                console.log(`[ScanDirectory] Scanning directory: ${currentDir}`);
                const entries = await this.getRemoteFiles(item.parentHost, currentDir);
                for (const entry of entries) {
                    if (token.isCancellationRequested)
                        break;
                    const relative = path.posix.relative(remoteRoot, entry.path);
                    const localTarget = path.resolve(localBase, relative.replace(/\//g, path.sep));
                    if (entry.type === 'directory') {
                        dirsToScan.push(entry.path);
                    }
                    else {
                        result.push({ item: entry, localTarget });
                        totalItems++;
                        if (totalItems % 100 === 0) {
                            progress.report({
                                message: `Found ${totalItems} files...`
                            });
                        }
                    }
                }
            }
            catch (error) {
                console.error(`[ScanDirectory] Error scanning directory ${currentDir}:`, error);
                // Continue with next directory
            }
        }
        console.log(`[ScanDirectory] Scan completed. Found ${result.length} files`);
        return result;
    }
    async createNewFile(item) {
        const name = await vscode.window.showInputBox({ prompt: 'Enter new file name' });
        if (!name)
            return;
        const remotePath = path.posix.join(item.path, name);
        const client = await this.getConnection(item.parentHost);
        const tmpFilePath = path.join(this.tmpDir, `temp-${Date.now()}`);
        fs.writeFileSync(tmpFilePath, '');
        if (item.parentHost.protocol === 'ftp') {
            await client.uploadFrom(tmpFilePath, remotePath);
        }
        else {
            await client.put(Buffer.from(''), remotePath);
        }
        fs.unlinkSync(tmpFilePath);
        // Оновлюємо поточний вузол
        this.refresh(item);
    }
    async createNewFolder(item) {
        const name = await vscode.window.showInputBox({ prompt: 'Enter new folder name' });
        if (!name)
            return;
        const remotePath = path.posix.join(item.path, name);
        const client = await this.getConnection(item.parentHost);
        if (item.parentHost.protocol === 'ftp') {
            await client.ensureDir(remotePath);
        }
        else {
            await client.mkdir(remotePath, true);
        }
        // Оновлюємо поточний вузол
        this.refresh(item);
    }
    async uploadFiles(item) {
        const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: true });
        if (!uris)
            return;
        const remoteDir = item.path;
        const client = await this.getConnection(item.parentHost);
        if (item.parentHost.protocol === 'ftp') {
            for (const uri of uris) {
                const fileName = path.basename(uri.fsPath);
                await client.uploadFrom(uri.fsPath, path.posix.join(remoteDir, fileName));
            }
        }
        else {
            for (const uri of uris) {
                const fileName = path.basename(uri.fsPath);
                await client.fastPut(uri.fsPath, path.posix.join(remoteDir, fileName));
            }
        }
        // Оновлюємо поточний вузол
        this.refresh(item);
    }
    async uploadFolder(item) {
        const folderUri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectMany: false
        });
        if (!folderUri || folderUri.length === 0)
            return;
        const folderPath = folderUri[0].fsPath;
        const baseName = path.basename(folderPath);
        const remoteBase = path.posix.join(item.path, baseName);
        const walk = (dir) => {
            return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
                const full = path.join(dir, entry.name);
                return entry.isDirectory() ? walk(full) : [full];
            });
        };
        const files = walk(folderPath);
        const totalFiles = files.length;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `⬆️ Uploading folder ${baseName}`,
            cancellable: true
        }, async (progress, token) => {
            progress.report({ increment: 0, message: 'Preparing upload...' });
            const counters = { discovered: totalFiles, uploaded: 0, failed: 0 };
            const config = getConfig();
            if (!config || !config[item.parentHost.name]) {
                throw new Error(`Invalid configuration for host ${item.parentHost.name}`);
            }
            const concurrency = config[item.parentHost.name].workers ?? 3;
            // Create a connection pool
            const connectionPool = new Set();
            const getConnection = async () => {
                const client = await this.getConnection(item.parentHost);
                connectionPool.add(client);
                return client;
            };
            const releaseConnection = async (client) => {
                connectionPool.delete(client);
                await this.closeConnection(client);
            };
            try {
                // First create all necessary directories
                progress.report({ increment: 0, message: 'Creating directories...' });
                // Create directories sequentially to avoid connection issues
                const client = await getConnection();
                try {
                    for (const file of files) {
                        if (token.isCancellationRequested)
                            break;
                        const rel = path.relative(folderPath, file).replace(/\\/g, '/');
                        const remotePath = path.posix.join(remoteBase, rel);
                        const remoteDir = path.posix.dirname(remotePath);
                        try {
                            if (item.parentHost.protocol === 'ftp') {
                                await client.ensureDir(remoteDir);
                            }
                            else {
                                await client.mkdir(remoteDir, true);
                            }
                        }
                        catch (error) {
                            console.error(`Failed to create directory ${remoteDir}:`, error);
                        }
                    }
                }
                finally {
                    await releaseConnection(client);
                }
                progress.report({ increment: 10, message: 'Starting file upload...' });
                // Process files in batches with concurrent uploads
                const batchSize = Math.min(concurrency, 3);
                const batches = [];
                for (let i = 0; i < files.length; i += batchSize) {
                    batches.push(files.slice(i, i + batchSize));
                }
                for (const batch of batches) {
                    if (token.isCancellationRequested)
                        break;
                    // Process each batch concurrently
                    await Promise.all(batch.map(async (file) => {
                        if (token.isCancellationRequested)
                            return;
                        const rel = path.relative(folderPath, file).replace(/\\/g, '/');
                        const remotePath = path.posix.join(remoteBase, rel);
                        let retries = 3;
                        while (retries > 0) {
                            const client = await getConnection();
                            try {
                                if (item.parentHost.protocol === 'ftp') {
                                    await client.uploadFrom(file, remotePath);
                                }
                                else {
                                    await client.fastPut(file, remotePath);
                                }
                                counters.uploaded++;
                                const increment = (90 / counters.discovered);
                                progress.report({
                                    message: `⬆️ Uploaded: ${counters.uploaded}/${counters.discovered} files (${counters.failed} failed)`,
                                    increment: increment
                                });
                                break;
                            }
                            catch (error) {
                                console.error(`Failed to upload ${file}:`, error);
                                retries--;
                                if (retries === 0) {
                                    counters.failed++;
                                    vscode.window.showErrorMessage(`Failed to upload ${path.basename(file)} after 3 attempts`);
                                }
                            }
                            finally {
                                await releaseConnection(client);
                            }
                        }
                    }));
                }
                // Cleanup any remaining connections
                for (const client of connectionPool) {
                    await releaseConnection(client);
                }
                if (counters.failed > 0) {
                    vscode.window.showWarningMessage(`Upload completed with ${counters.failed} failed files`);
                }
                else {
                    vscode.window.showInformationMessage(`Successfully uploaded ${counters.uploaded} files`);
                }
            }
            catch (error) {
                console.error('Upload failed:', error);
                vscode.window.showErrorMessage('Failed to upload folder');
            }
            finally {
                // Ensure all connections are released
                for (const client of connectionPool) {
                    await releaseConnection(client);
                }
            }
        });
        this.refresh();
    }
    async changePermissions(item) {
        const mode = await vscode.window.showInputBox({
            prompt: 'Enter chmod value (e.g. 755)',
            validateInput: val => /^\d{3}$/.test(val) ? null : 'Must be a 3-digit number'
        });
        if (!mode)
            return;
        try {
            const client = await this.getConnection(item.parentHost);
            if (item.parentHost.protocol === 'ftp') {
                await client.send('SITE CHMOD ' + mode + ' ' + item.path);
            }
            else {
                await client.chmod(item.path, parseInt(mode, 8));
            }
            vscode.window.showInformationMessage(`✅ Permissions updated to ${mode}`);
            // Оновлюємо поточний вузол
            this.refresh(item);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to change permissions: ${error.message}`);
            console.error('Error changing permissions:', error);
        }
    }
    async deleteFtpDirectoryRecursively(client, dirPath, progress) {
        try {
            // Спочатку спробуємо нативні команди
            try {
                await client.send('XRMD ' + dirPath);
                return;
            }
            catch (error) {
                try {
                    await client.send('RMD -R ' + dirPath);
                    return;
                }
                catch (error) {
                    // Якщо нативні команди не працюють, використовуємо рекурсивне видалення
                    progress.report({ message: 'Using recursive deletion...' });
                }
            }
            // Отримуємо список всіх файлів та директорій
            const list = await client.list(dirPath);
            // Спочатку видаляємо всі файли та піддиректорії
            for (const item of list) {
                const fullPath = path.posix.join(dirPath, item.name);
                if (item.type === 2) { // Directory
                    await this.deleteFtpDirectoryRecursively(client, fullPath, progress);
                }
                else {
                    await client.remove(fullPath);
                }
            }
            // Після видалення всіх вмісту, видаляємо саму директорію
            await client.removeDir(dirPath);
        }
        catch (error) {
            throw new Error(`Failed to delete directory ${dirPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    async deleteRemoteFile(item) {
        const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete ${item.name}?`, { modal: true }, 'Yes', 'Cancel');
        if (confirm !== 'Yes')
            return;
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `🗑️ Deleting ${item.name}`,
                cancellable: false
            }, async (progress) => {
                const client = await this.getConnection(item.parentHost);
                if (item.type === 'directory') {
                    progress.report({ message: 'Deleting directory...' });
                    if (item.parentHost.protocol === 'ftp') {
                        await this.deleteFtpDirectoryRecursively(client, item.path, progress);
                    }
                    else {
                        await client.rmdir(item.path, true);
                    }
                }
                else {
                    if (item.parentHost.protocol === 'ftp') {
                        await client.remove(item.path);
                    }
                    else {
                        await client.delete(item.path);
                    }
                }
            });
            // Логуємо інформацію про шляхи
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            console.log('Workspace folder:', workspaceRoot);
            console.log('Host name:', item.parentHost.name);
            console.log('Item name:', item.name);
            console.log('Remote path:', item.path);
            // Отримуємо відносний шлях від кореня віддаленого сервера
            const relativePath = path.posix.relative(item.parentHost.remotePath, item.path);
            console.log('Relative path:', relativePath);
            // Формуємо локальний шлях, зберігаючи структуру папок
            const localPath = path.join(workspaceRoot ?? '', item.parentHost.name, relativePath.replace(/\//g, path.sep));
            console.log('Full local path:', localPath);
            console.log('File exists:', fs.existsSync(localPath));
            if (fs.existsSync(localPath)) {
                console.log('Attempting to delete local file/directory');
                if (item.type === 'directory') {
                    fs.rmdirSync(localPath, { recursive: true });
                }
                else {
                    fs.unlinkSync(localPath);
                }
                console.log('Local file/directory deleted successfully');
            }
            else {
                console.log('Local file/directory not found');
            }
            vscode.window.showInformationMessage(`✅ ${item.name} deleted`);
            this.refresh(item.parentHost);
        }
        catch (e) {
            vscode.window.showErrorMessage(`❌ Failed to delete ${item.name}`);
            console.error('Error during deletion:', e);
        }
    }
    async copyRemotePathToClipboard(item) {
        await vscode.env.clipboard.writeText(item.path);
        vscode.window.showInformationMessage(`✅ Copied remote path: ${item.path}`);
    }
    async createBackup(item) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
        // Створюємо папку "backups" в корені проекту, якщо вона не існує
        const backupFolder = path.join(workspaceRoot, 'backups', item.parentHost.name);
        // Зберігаємо віддалену структуру папок
        const relativePath = path.posix.relative(item.parentHost.remotePath, item.path);
        const backupFilePath = path.join(backupFolder, relativePath);
        // Створення всіх необхідних папок у локальному каталозі для збереження структури
        const backupDir = path.dirname(backupFilePath);
        try {
            // Переконуємося, що всі підкаталоги існують
            fs.mkdirSync(backupDir, { recursive: true });
            // Отримуємо ім'я файлу з датою
            const fileNameWithDate = this.getFileNameWithDate(item);
            const backupPath = path.join(backupDir, fileNameWithDate);
            const localBase = path.resolve(workspaceRoot, item.parentHost.localPath); // Базовий шлях для локальних файлів
            const remoteRoot = item.parentHost.remotePath; // Віддалений корінь для файлів
            const hostFolder = path.join(localBase, item.parentHost.name); // Підпапка хоста
            // Визначаємо відносний шлях до файлу між коренем віддаленої папки і шляхом файлу
            const relative = path.posix.relative(remoteRoot, item.path);
            const localFilePath = path.resolve(hostFolder, relative.replace(/\//g, path.sep)); // Локальний шлях до файлу з урахуванням структури папок
            // Перевіряємо чи існує локальний файл перед копіюванням
            if (fs.existsSync(localFilePath)) {
                fs.copyFileSync(localFilePath, backupPath);
                //vscode.window.showInformationMessage(`✅ Backup created: ${fileNameWithDate}`);
            }
            else {
                vscode.window.showErrorMessage(`❌ Local file does not exist: ${localFilePath}`);
            }
        }
        catch (e) {
            vscode.window.showErrorMessage(`❌ Failed to create backup for ${item.name}`);
            console.error(e);
        }
    }
    getFileNameWithDate(item) {
        const now = new Date();
        const day = String(now.getDate()).padStart(2, '0');
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const year = now.getFullYear();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        // Створюємо нове ім'я файлу з датою
        const fileNameWithoutExt = path.basename(item.name, path.extname(item.name));
        const newFileName = `${fileNameWithoutExt}-${day}-${month}-${year}-${hours}-${minutes}-${seconds}${path.extname(item.name)}`;
        return newFileName;
    }
    async renameFile(item) {
        const newName = await vscode.window.showInputBox({
            prompt: 'Enter new name',
            value: item.name,
            validateInput: (value) => {
                if (!value)
                    return 'Name cannot be empty';
                if (value.includes('/') || value.includes('\\'))
                    return 'Name cannot contain slashes';
                return null;
            }
        });
        if (!newName || newName === item.name)
            return;
        try {
            const newPath = path.posix.join(path.posix.dirname(item.path), newName);
            const client = await this.getConnection(item.parentHost);
            if (item.parentHost.protocol === 'ftp') {
                await client.rename(item.path, newPath);
            }
            else {
                await client.rename(item.path, newPath);
            }
            vscode.window.showInformationMessage(`✅ Renamed to ${newName}`);
            this.refresh(item.parentHost);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to rename file: ${error.message}`);
            console.error('Error renaming file:', error);
        }
    }
    refreshNode(item) {
        console.log(`[RemoteFTP][${new Date().toISOString()}] Refreshing node: ${item.name}`);
        this._onDidChangeTreeData.fire(item);
    }
    getCurrentHost() {
        return this.currentHost;
    }
    deactivate() {
        this.connectionPool.closeAll();
    }
    async closeConnection(host) {
        console.log(`[RemoteFTP][${new Date().toISOString()}] Closing connection for host: ${host.name}`);
        try {
            const client = await this.getConnection(host);
            if (client) {
                if (host.protocol === 'ftp') {
                    await client.close();
                }
                else {
                    await client.end();
                }
                this.connectionPool.releaseConnection(host);
                this.connectedHosts.set(host.name, false);
                console.log(`[RemoteFTP][${new Date().toISOString()}] Successfully closed connection for ${host.name}`);
            }
        }
        catch (error) {
            console.error(`[RemoteFTP][${new Date().toISOString()}] Error closing connection for ${host.name}:`, error);
        }
    }
    async getFileStat(client, filePath) {
        if (client instanceof basic_ftp_1.Client) {
            const list = await client.list(path.posix.dirname(filePath));
            const file = list.find(f => f.name === path.basename(filePath));
            return file;
        }
        else {
            return await client.stat(filePath);
        }
    }
    async downloadFile(client, remotePath, localPath) {
        if (client instanceof basic_ftp_1.Client) {
            await client.downloadTo(localPath, remotePath);
        }
        else {
            await client.fastGet(remotePath, localPath);
        }
    }
}
let global_config = null; // збережемо конфігурацію
function getConfig() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
        vscode.window.showErrorMessage('Open a folder to use Remote FTP');
        return null;
    }
    const configPath = path.join(folder, 'config.json');
    try {
        const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!Array.isArray(rawConfig.hosts)) {
            vscode.window.showErrorMessage('Invalid config.json: "hosts" must be an array');
            return null;
        }
        global_config = {};
        for (const host of rawConfig.hosts) {
            if (!host.name) {
                vscode.window.showErrorMessage('Invalid host entry: missing "name"');
                continue;
            }
            global_config[host.name] = host;
        }
    }
    catch (e) {
        vscode.window.showErrorMessage('Failed to read config.json');
    }
    return global_config;
}
//# sourceMappingURL=extension.js.map
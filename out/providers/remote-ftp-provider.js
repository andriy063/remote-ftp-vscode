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
exports.RemoteFTPProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const basic_ftp_1 = require("basic-ftp");
const ssh2_sftp_client_1 = __importDefault(require("ssh2-sftp-client"));
class RemoteFTPProvider {
    context;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    isDownloading = false;
    currentDownloadTask;
    hosts = [];
    tmpDir = path.join(os.tmpdir(), '.remote-ftp-tmp');
    fileMap = new Map();
    currentHost;
    connectionCache = new Map();
    CACHE_TTL = 30000; // 30 seconds cache TTL
    constructor(context) {
        this.context = context;
        this.loadConfig();
        if (!fs.existsSync(this.tmpDir))
            fs.mkdirSync(this.tmpDir, { recursive: true });
    }
    async loadConfig() {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!folder) {
            vscode.window.showErrorMessage('Open a folder to use Remote FTP');
            return;
        }
        const configPath = path.join(folder, 'config.json');
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            this.hosts = config.hosts;
        }
        catch (e) {
            vscode.window.showErrorMessage('Failed to read config.json');
            this.hosts = [];
        }
    }
    refresh(item) {
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
            console.log(`Creating tree item for host: ${element.name}`);
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon('server');
            item.id = `host:${element.name}`;
            item.contextValue = 'host';
            return item;
        }
        console.log(`Creating tree item for ${element.type}: ${element.name}`);
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
            console.log('Getting root hosts');
            return this.hosts;
        }
        let children;
        if ('protocol' in element) {
            console.log(`Getting children for host: ${element.name}`);
            children = await this.getRemoteFiles(element, element.remotePath);
        }
        else if (element.type === 'directory') {
            console.log(`Getting children for directory: ${element.name}`);
            children = await this.getRemoteFiles(element.parentHost, element.path);
        }
        else {
            console.log(`Getting children for file: ${element.name} (no children)`);
            children = [];
        }
        console.log(`Found ${children.length} children`);
        return children;
    }
    async getConnection(host) {
        let client;
        if (host.protocol === 'ftp') {
            client = new basic_ftp_1.Client();
            await client.access({
                host: host.host,
                port: host.port,
                user: host.username,
                password: host.password,
                secure: false
            });
        }
        else {
            client = new ssh2_sftp_client_1.default();
            await client.connect({
                host: host.host,
                port: host.port,
                username: host.username,
                password: host.password
            });
        }
        return client;
    }
    async getRemoteFiles(host, remotePath) {
        const client = await this.getConnection(host);
        try {
            const list = [];
            if (host.protocol === 'ftp') {
                const entries = await client.list(remotePath);
                for (const entry of entries) {
                    if (entry.type === 1 && host.ignoreExtensions.includes(path.extname(entry.name)))
                        continue;
                    const fullPath = path.posix.join(remotePath, entry.name);
                    const relPath = path.posix.relative(host.remotePath, fullPath);
                    if (host.ignorePaths?.some(p => relPath.startsWith(p)))
                        continue;
                    list.push({
                        type: entry.type === 2 ? 'directory' : 'file',
                        name: entry.name,
                        path: fullPath,
                        parentHost: host
                    });
                }
            }
            else {
                const entries = await client.list(remotePath);
                for (const entry of entries) {
                    if (entry.type === '-' && host.ignoreExtensions.includes(path.extname(entry.name)))
                        continue;
                    const fullPath = path.posix.join(remotePath, entry.name);
                    const relPath = path.posix.relative(host.remotePath, fullPath);
                    if (host.ignorePaths?.some(p => relPath.startsWith(p)))
                        continue;
                    list.push({
                        type: entry.type === 'd' ? 'directory' : 'file',
                        name: entry.name,
                        path: fullPath,
                        parentHost: host
                    });
                }
            }
            list.sort((a, b) => {
                if (a.type === 'directory' && b.type === 'file')
                    return -1;
                if (a.type === 'file' && b.type === 'directory')
                    return 1;
                return a.name.localeCompare(b.name);
            });
            return list;
        }
        finally {
            if (host.protocol === 'ftp') {
                client.close();
            }
            else {
                client.end();
            }
        }
    }
    async downloadToLocal(item) {
        if (this.isDownloading) {
            vscode.window.showWarningMessage('Another download is already in progress. Please wait for it to complete.');
            return;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
        this.isDownloading = true;
        try {
            const downloadPromise = vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `📥 Downloading ${item.name}`,
                cancellable: true
            }, async (progress, token) => {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                const localBase = path.resolve(workspaceRoot, item.parentHost.localPath, item.parentHost.name);
                const remoteRoot = item.parentHost.remotePath;
                const concurrency = this.getConfig()[item.parentHost.name]['workers'];
                if (item.type === 'directory') {
                    progress.report({ message: 'Scanning files...' });
                    const filesToDownload = await this.scanDirectory(item.parentHost, item.path, remoteRoot, localBase, concurrency, progress);
                    const counters = { discovered: filesToDownload.length, downloaded: 0 };
                    progress.report({ message: `Found ${counters.discovered} files to download` });
                    const { enqueue, markDone, waitUntilDone } = this.startDownloadWorker(concurrency, progress, token, counters);
                    for (const file of filesToDownload) {
                        if (token.isCancellationRequested)
                            break;
                        enqueue(file.item, file.localTarget);
                    }
                    markDone();
                    await waitUntilDone();
                }
                else {
                    // Для одиночного файлу
                    const relative = path.posix.relative(remoteRoot, item.path);
                    const localTarget = path.resolve(localBase, relative.replace(/\//g, path.sep));
                    progress.report({ message: 'Downloading file...' });
                    await this.downloadSingleFile(item, localTarget);
                    progress.report({ message: 'Download complete', increment: 100 });
                }
                if (token.isCancellationRequested) {
                    vscode.window.showWarningMessage('⚠️ Download cancelled');
                }
                else {
                    vscode.window.showInformationMessage(`✅ Download complete`);
                }
            });
            this.currentDownloadTask = Promise.resolve(downloadPromise);
            await this.currentDownloadTask;
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to download: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        finally {
            this.isDownloading = false;
            this.currentDownloadTask = undefined;
        }
    }
    async downloadSingleFile(item, localTarget) {
        const maxRetries = 3;
        let retryCount = 0;
        let lastError = null;
        while (retryCount < maxRetries) {
            try {
                const exists = fs.existsSync(localTarget);
                const stats = exists ? fs.statSync(localTarget) : null;
                if (exists && stats?.isFile()) {
                    let remoteSize = -1;
                    const client = await this.getConnection(item.parentHost);
                    try {
                        if (item.parentHost.protocol === 'ftp') {
                            const list = await client.list(path.posix.dirname(item.path));
                            const file = list.find(f => f.name === path.basename(item.path));
                            remoteSize = file?.size ?? -1;
                        }
                        else {
                            const info = await client.stat(item.path);
                            remoteSize = info.size;
                        }
                        if (remoteSize === stats.size) {
                            console.log(`File ${item.name} already exists with same size, skipping download`);
                            return;
                        }
                    }
                    finally {
                        if (item.parentHost.protocol === 'ftp') {
                            client.close();
                        }
                        else {
                            client.end();
                        }
                    }
                }
                fs.mkdirSync(path.dirname(localTarget), { recursive: true });
                const client = await this.getConnection(item.parentHost);
                try {
                    if (item.parentHost.protocol === 'ftp') {
                        await client.downloadTo(localTarget, item.path);
                    }
                    else {
                        await client.fastGet(item.path, localTarget);
                    }
                    return; // Successful download
                }
                finally {
                    if (item.parentHost.protocol === 'ftp') {
                        client.close();
                    }
                    else {
                        client.end();
                    }
                }
            }
            catch (error) {
                lastError = error;
                retryCount++;
                if (retryCount < maxRetries) {
                    // Wait before retrying (increase wait time with each retry)
                    const waitTime = 1000 * retryCount;
                    console.log(`Retry ${retryCount}/${maxRetries} for ${item.name} after ${waitTime}ms`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }
            }
        }
        // If all retries failed
        throw new Error(`Failed to download ${item.name} after ${maxRetries} attempts. Last error: ${lastError?.message}`);
    }
    startDownloadWorker(concurrency, progress, token, counters) {
        const queue = [];
        const waiters = [];
        let doneScanning = false;
        const failedDownloads = [];
        const startTime = Date.now();
        let lastProgressUpdate = 0;
        let lastDownloadedCount = 0;
        const enqueue = (item, localTarget) => {
            queue.push({ item, localTarget });
            counters.discovered++;
            waiters.forEach(w => w());
            waiters.length = 0;
        };
        const markDone = () => {
            doneScanning = true;
            waiters.forEach(w => w());
            waiters.length = 0;
        };
        const waitForItem = async () => {
            while (queue.length === 0) {
                if (token.isCancellationRequested)
                    throw new Error("cancelled");
                if (doneScanning)
                    return null;
                await new Promise(res => waiters.push(res));
            }
            return queue.shift();
        };
        const updateProgress = () => {
            const now = Date.now();
            if (now - lastProgressUpdate > 500 || counters.downloaded - lastDownloadedCount >= 10) {
                const percentComplete = Math.min(100, Math.round((counters.downloaded / counters.discovered) * 100));
                const elapsedSeconds = Math.round((now - startTime) / 1000);
                const filesPerSecond = counters.downloaded / Math.max(1, elapsedSeconds);
                const remainingFiles = counters.discovered - counters.downloaded;
                const estimatedSecondsRemaining = remainingFiles / Math.max(1, filesPerSecond);
                let timeRemaining = '';
                if (estimatedSecondsRemaining > 0) {
                    if (estimatedSecondsRemaining < 60) {
                        timeRemaining = `${Math.round(estimatedSecondsRemaining)}s`;
                    }
                    else if (estimatedSecondsRemaining < 3600) {
                        timeRemaining = `${Math.round(estimatedSecondsRemaining / 60)}m ${Math.round(estimatedSecondsRemaining % 60)}s`;
                    }
                    else {
                        const hours = Math.floor(estimatedSecondsRemaining / 3600);
                        const minutes = Math.round((estimatedSecondsRemaining % 3600) / 60);
                        timeRemaining = `${hours}h ${minutes}m`;
                    }
                }
                progress.report({
                    message: `Downloading... ${percentComplete}% (${counters.downloaded}/${counters.discovered} files, ${filesPerSecond.toFixed(1)} files/sec${timeRemaining ? `, ~${timeRemaining} remaining` : ''})`,
                    increment: (counters.downloaded - lastDownloadedCount) / Math.max(1, counters.discovered) * 100
                });
                lastProgressUpdate = now;
                lastDownloadedCount = counters.downloaded;
            }
        };
        const workers = Array.from({ length: concurrency }, async () => {
            while (!token.isCancellationRequested) {
                const next = await waitForItem();
                if (!next)
                    break;
                const { item, localTarget } = next;
                try {
                    await this.downloadSingleFile(item, localTarget);
                    counters.downloaded++;
                    updateProgress();
                }
                catch (error) {
                    failedDownloads.push({ item, error: error });
                    console.error(`Failed to download ${item.name}:`, error);
                    progress.report({
                        message: `Failed to download ${item.name}: ${error.message}`
                    });
                }
            }
        });
        return {
            enqueue,
            markDone,
            waitUntilDone: async () => {
                await Promise.all(workers);
                const totalTime = (Date.now() - startTime) / 1000;
                const filesPerSecond = counters.downloaded / totalTime;
                if (failedDownloads.length > 0) {
                    const failedFiles = failedDownloads.map(f => f.item.name).join(', ');
                    vscode.window.showWarningMessage(`Failed to download ${failedDownloads.length} files: ${failedFiles}. Check the output panel for details.`);
                }
                progress.report({
                    message: `Download complete. Downloaded ${counters.downloaded} files in ${totalTime.toFixed(1)}s (${filesPerSecond.toFixed(1)} files/sec)${failedDownloads.length > 0 ? ` with ${failedDownloads.length} failures` : ''}.`
                });
            }
        };
    }
    async uploadToRemote(localPath, host) {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `⬆️ Uploading ${path.basename(localPath)}`,
                cancellable: true
            }, async (progress, token) => {
                const client = await this.getConnection(host);
                try {
                    if (host.protocol === 'ftp') {
                        await client.uploadFrom(localPath, path.posix.join(host.remotePath, path.basename(localPath)));
                    }
                    else {
                        await client.fastPut(localPath, path.posix.join(host.remotePath, path.basename(localPath)));
                    }
                    progress.report({ message: 'Upload complete', increment: 100 });
                }
                finally {
                    if (host.protocol === 'ftp') {
                        client.close();
                    }
                    else {
                        client.end();
                    }
                }
            });
            vscode.window.showInformationMessage(`✅ Upload complete`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to upload: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
            const localPath = path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', item.parentHost.localPath, item.parentHost.name, item.name);
            if (fs.existsSync(localPath)) {
                if (item.type === 'directory') {
                    fs.rmdirSync(localPath, { recursive: true });
                }
                else {
                    fs.unlinkSync(localPath);
                }
            }
            vscode.window.showInformationMessage(`✅ ${item.name} deleted`);
            // Створюємо об'єкт батьківської папки для оновлення
            const parentDir = {
                type: 'directory',
                name: path.posix.basename(path.posix.dirname(item.path)),
                path: path.posix.dirname(item.path),
                parentHost: item.parentHost
            };
            this.refresh(parentDir);
        }
        catch (e) {
            vscode.window.showErrorMessage(`❌ Failed to delete ${item.name}`);
            console.error(e);
        }
    }
    async createRemoteDirectory(dirName, host) {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `📁 Creating directory ${dirName}`,
                cancellable: false
            }, async (progress) => {
                const client = await this.getConnection(host);
                try {
                    const remotePath = path.posix.join(host.remotePath, dirName);
                    if (host.protocol === 'ftp') {
                        await client.ensureDir(remotePath);
                    }
                    else {
                        await client.mkdir(remotePath, true);
                    }
                    progress.report({ message: 'Directory created', increment: 100 });
                }
                finally {
                    if (host.protocol === 'ftp') {
                        client.close();
                    }
                    else {
                        client.end();
                    }
                }
            });
            vscode.window.showInformationMessage(`✅ Directory ${dirName} created`);
            this.refresh();
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to create directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    getHosts() {
        return this.hosts;
    }
    getConfig() {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!folder) {
            vscode.window.showErrorMessage('Open a folder to use Remote FTP');
            return {};
        }
        const configPath = path.join(folder, 'config.json');
        try {
            const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (!Array.isArray(rawConfig.hosts)) {
                vscode.window.showErrorMessage('Invalid config.json: "hosts" must be an array');
                return {};
            }
            const config = {};
            for (const host of rawConfig.hosts) {
                if (!host.name) {
                    vscode.window.showErrorMessage('Invalid host entry: missing "name"');
                    continue;
                }
                config[host.name] = host;
            }
            return config;
        }
        catch (e) {
            vscode.window.showErrorMessage('Failed to read config.json');
            return {};
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
    async scanDirectory(host, remotePath, remoteRoot, localBase, concurrency, progress) {
        const allFiles = [];
        const directoriesToScan = new Set([remotePath]);
        const scannedDirs = new Set();
        let totalDirs = 0;
        let lastProgressUpdate = 0;
        let lastFileCount = 0;
        let startTime = Date.now();
        let errorCount = 0;
        // First, count the total number of directories to scan
        progress.report({ message: "Counting directories..." });
        const initialClient = await this.getConnection(host);
        try {
            const countDirs = async (dir) => {
                if (scannedDirs.has(dir))
                    return 0;
                scannedDirs.add(dir);
                let count = 1; // Count this directory
                try {
                    const entries = await this.getRemoteFiles(host, dir);
                    for (const entry of entries) {
                        if (entry.type === 'directory') {
                            count += await countDirs(entry.path);
                        }
                    }
                }
                catch (error) {
                    console.error(`Error counting directories in ${dir}:`, error);
                    errorCount++;
                }
                return count;
            };
            totalDirs = await countDirs(remotePath);
            progress.report({ message: `Found ${totalDirs} directories to scan` });
        }
        finally {
            if (host.protocol === 'ftp') {
                initialClient.close();
            }
            else {
                initialClient.end();
            }
        }
        // Reset scanned directories for the actual scan
        scannedDirs.clear();
        let scannedDirCount = 0;
        let fileCount = 0;
        while (directoriesToScan.size > 0) {
            const currentDirs = Array.from(directoriesToScan).slice(0, concurrency);
            currentDirs.forEach(dir => directoriesToScan.delete(dir));
            const scanPromises = currentDirs.map(async (dir) => {
                if (scannedDirs.has(dir))
                    return;
                scannedDirs.add(dir);
                scannedDirCount++;
                const client = await this.getConnection(host);
                try {
                    const entries = await this.getRemoteFiles(host, dir);
                    for (const entry of entries) {
                        if (entry.type === 'directory') {
                            directoriesToScan.add(entry.path);
                        }
                        else {
                            const relative = path.posix.relative(remoteRoot, entry.path);
                            const localTarget = path.resolve(localBase, relative.replace(/\//g, path.sep));
                            allFiles.push({ item: entry, localTarget });
                            fileCount++;
                        }
                    }
                    // Update progress every 500ms or when we find new files
                    const now = Date.now();
                    if (now - lastProgressUpdate > 500 || fileCount - lastFileCount >= 100) {
                        const percentComplete = Math.min(100, Math.round((scannedDirCount / totalDirs) * 100));
                        const elapsedSeconds = Math.round((now - startTime) / 1000);
                        const filesPerSecond = fileCount / elapsedSeconds;
                        progress.report({
                            message: `Scanning... ${percentComplete}% (${scannedDirCount}/${totalDirs} dirs, ${fileCount} files, ${filesPerSecond.toFixed(1)} files/sec)`,
                            increment: (fileCount - lastFileCount) / Math.max(1, fileCount) * 100
                        });
                        lastProgressUpdate = now;
                        lastFileCount = fileCount;
                    }
                }
                catch (error) {
                    console.error(`Error scanning directory ${dir}:`, error);
                    errorCount++;
                }
                finally {
                    if (host.protocol === 'ftp') {
                        client.close();
                    }
                    else {
                        client.end();
                    }
                }
            });
            await Promise.all(scanPromises);
        }
        const totalTime = (Date.now() - startTime) / 1000;
        const filesPerSecond = fileCount / totalTime;
        progress.report({
            message: `Scan complete. Found ${fileCount} files in ${scannedDirCount} directories in ${totalTime.toFixed(1)}s (${filesPerSecond.toFixed(1)} files/sec)${errorCount > 0 ? ` with ${errorCount} errors` : ''}.`,
            increment: 100
        });
        return allFiles;
    }
}
exports.RemoteFTPProvider = RemoteFTPProvider;
//# sourceMappingURL=remote-ftp-provider.js.map
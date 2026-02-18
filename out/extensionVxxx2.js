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
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const basic_ftp_1 = require("basic-ftp");
const ssh2_sftp_client_1 = __importDefault(require("ssh2-sftp-client"));
/* ------------------------------------------------------------------
 * Connection Management (Simplified)
 * ---------------------------------------------------------------- */
// Ми не тримаємо складний пул. Ми просто створюємо з'єднання, коли треба.
// Якщо з'єднання "живе" - перевикористовуємо. Якщо ні - створюємо нове.
class SimpleConnectionManager {
    activeClients = new Map();
    async getClient(host, cfg) {
        // 1. Спробувати взяти існуюче вільне з'єднання
        let pool = this.activeClients.get(host) || [];
        // Шукаємо живе з'єднання
        for (let i = pool.length - 1; i >= 0; i--) {
            const client = pool[i];
            if (await this.isAlive(client, cfg.protocol)) {
                pool.splice(i, 1); // Забираємо з пулу
                return client;
            }
            else {
                this.destroy(client); // Викидаємо мертве
                pool.splice(i, 1);
            }
        }
        // 2. Якщо живих немає - створюємо нове
        return await this.connect(cfg);
    }
    async releaseClient(host, client) {
        // Повертаємо клієнта в пул
        let pool = this.activeClients.get(host) || [];
        pool.push(client);
        this.activeClients.set(host, pool);
    }
    async destroy(client) {
        try {
            if (client instanceof ssh2_sftp_client_1.default)
                await client.end();
            else
                await client.close();
        }
        catch { }
    }
    async connect(cfg) {
        if (cfg.protocol === "sftp") {
            const c = new ssh2_sftp_client_1.default();
            await c.connect({
                host: cfg.host,
                port: cfg.port ?? 22,
                username: cfg.username,
                password: cfg.password,
                privateKey: cfg.private_key && fs.readFileSync(cfg.private_key),
                readyTimeout: cfg.timeoutMs ?? 20000,
                retries: 2
            });
            // FIX: MaxListenersExceededWarning
            // Збільшуємо ліміт слухачів, оскільки ми інтенсивно перевикористовуємо один клієнт
            try {
                c.client.setMaxListeners(0);
            }
            catch { }
            return c;
        }
        else {
            const c = new basic_ftp_1.Client();
            await c.access({
                host: cfg.host,
                port: cfg.port ?? 21,
                user: cfg.username,
                password: cfg.password,
            });
            return c;
        }
    }
    async isAlive(client, protocol) {
        try {
            if (protocol === "ftp") {
                const c = client;
                if (c.closed)
                    return false;
                await c.pwd();
            }
            else {
                const c = client;
                await c.realPath('.');
            }
            return true;
        }
        catch {
            return false;
        }
    }
    async closeAll() {
        for (const pool of this.activeClients.values()) {
            for (const c of pool)
                await this.destroy(c);
        }
        this.activeClients.clear();
    }
}
const connectionManager = new SimpleConnectionManager();
/* ------------------------------------------------------------------
 * Error Handling Logic
 * ---------------------------------------------------------------- */
/**
 * Вирішує, чи варто пробувати ще раз.
 * Повертає TRUE для всього, крім явних помилок "файл не існує" або "нема прав".
 */
function shouldRetry(err) {
    if (!err)
        return false;
    const msg = (err.message || "").toLowerCase();
    const code = (err.code || "").toString().toUpperCase();
    // Явні помилки, які немає сенсу ретраїти
    if (code === 'ENOENT' || code === '404' || msg.includes('no such file'))
        return false; // Файлу немає
    if (code === 'EACCES' || code === '550' || msg.includes('permission denied'))
        return false; // Немає прав
    if (msg.includes('not a regular file'))
        return false; // Це папка, а ми думали файл
    // Все інше (timeout, generic error, connection closed, socket hang up) - РЕТРАЇМО!
    return true;
}
/* ------------------------------------------------------------------
 * Global State
 * ---------------------------------------------------------------- */
const rsftp = {};
const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir();
const openFileDebounce = new Map();
let uploadStatusBar;
/* ------------------------------------------------------------------
 * Tree Provider
 * ---------------------------------------------------------------- */
class RemoteSftpProvider {
    emitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.emitter.event;
    refresh(item) {
        this.emitter.fire(item);
    }
    getTreeItem = (e) => e;
    async getChildren(element) {
        const cfg = getConfig();
        if (!cfg || typeof cfg.hosts !== "object")
            return [];
        if (!element) {
            return Object.keys(cfg.hosts).sort().map(h => new RemoteItem(h, vscode.TreeItemCollapsibleState.Collapsed, "host", {
                host: h,
                fullPath: cfg.hosts[h].remote_path ?? "/",
                isDir: true,
            }));
        }
        if (element.type === "host" || element.type === "dir") {
            const hostCfg = cfgFor(element.data.host);
            try {
                const client = await connectionManager.getClient(element.data.host, hostCfg);
                try {
                    const items = await listRemote(client, element.data.fullPath, element.data.host);
                    await connectionManager.releaseClient(element.data.host, client);
                    return items;
                }
                catch (e) {
                    await connectionManager.destroy(client);
                    throw e;
                }
            }
            catch (e) {
                vscode.window.showErrorMessage(`Error listing ${element.label}: ${e}`);
                return [];
            }
        }
        return [];
    }
}
const provider = new RemoteSftpProvider();
class RemoteItem extends vscode.TreeItem {
    label;
    type;
    data;
    constructor(label, state, type, data) {
        super(label, state);
        this.label = label;
        this.type = type;
        this.data = data;
        this.contextValue = type;
        const uriPath = data.fullPath.startsWith("/") ? data.fullPath : `/${data.fullPath}`;
        this.resourceUri = vscode.Uri.parse(uriPath).with({ scheme: "rsftp", authority: data.host });
        if (type === "file") {
            this.command = { command: "remote-sftp.openFile", title: "Open", arguments: [this] };
        }
    }
}
/* ------------------------------------------------------------------
 * Extensions Lifecycle
 * ---------------------------------------------------------------- */
function activate(ctx) {
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.show();
    uploadStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    uploadStatusBar.show();
    const tree = vscode.window.createTreeView("remote_sftp", { treeDataProvider: provider });
    tree.onDidExpandElement(e => provider.refresh(e.element));
    ctx.subscriptions.push(statusBar, uploadStatusBar, vscode.commands.registerCommand("remote-sftp.openFile", openFileCommand), vscode.commands.registerCommand("remote-sftp.download", downloadCommand), vscode.commands.registerCommand("remote-sftp.uploadFile", uploadFileCommand), vscode.commands.registerCommand("remote-sftp.uploadFolder", uploadFolderCommand), vscode.commands.registerCommand("remote-sftp.delete", deleteCommand), vscode.commands.registerCommand("remote-sftp.createFile", createFileCommand), vscode.commands.registerCommand("remote-sftp.createFolder", createFolderCommand), vscode.workspace.onDidSaveTextDocument(handleSave));
}
async function deactivate() {
    await connectionManager.closeAll();
}
async function processQueue(host, jobs, workersCount, token, onProgress) {
    const cfg = cfgFor(host);
    const queue = [...jobs];
    const createdDirs = new Set();
    let done = 0;
    const worker = async () => {
        while (queue.length > 0 && !token.isCancellationRequested) {
            const job = queue[queue.length - 1];
            let success = false;
            let client = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                if (token.isCancellationRequested)
                    break;
                try {
                    client = await connectionManager.getClient(host, cfg);
                    const localPath = path.normalize(job.local); // FIX: Нормалізація шляхів для Windows
                    if (job.type === 'download') {
                        // --- DOWNLOAD ---
                        await ensureDir(localPath);
                        let isDir = false;
                        try {
                            if (client instanceof ssh2_sftp_client_1.default) {
                                const stat = await client.stat(job.remote);
                                isDir = stat.isDirectory;
                            }
                        }
                        catch { }
                        if (isDir) {
                            success = true;
                            break;
                        }
                        if (client instanceof ssh2_sftp_client_1.default) {
                            await client.fastGet(job.remote, localPath);
                        }
                        else {
                            await client.downloadTo(localPath, job.remote);
                        }
                    }
                    else {
                        // --- UPLOAD ---
                        if (!fs.existsSync(localPath)) {
                            throw new Error(`Local file not found: ${localPath}`);
                        }
                        const remoteDir = path.posix.dirname(job.remote);
                        // Smart MKDIR
                        if (!createdDirs.has(remoteDir)) {
                            try {
                                if (client instanceof ssh2_sftp_client_1.default) {
                                    try {
                                        await client.mkdir(remoteDir, true);
                                    }
                                    catch (mkdirErr) {
                                        // Якщо не вдалося створити - перевіряємо, може вона вже є?
                                        const exists = await client.exists(remoteDir);
                                        if (!exists) {
                                            throw new Error(`Cannot create remote dir: ${remoteDir} (${mkdirErr.message})`);
                                        }
                                    }
                                }
                                else {
                                    await client.ensureDir(remoteDir);
                                }
                                createdDirs.add(remoteDir);
                            }
                            catch (e) {
                                throw e;
                            }
                        }
                        if (client instanceof ssh2_sftp_client_1.default) {
                            try {
                                await client.fastPut(localPath, job.remote);
                            }
                            catch (putErr) {
                                const msg = (putErr.message || "").toLowerCase();
                                // FIX: Fallback на stream upload, якщо fastPut падає через OneDrive або ssh2 баги
                                if (msg.includes('no such file') || msg.includes('bad path') || msg.includes('open')) {
                                    console.warn(`fastPut failed for ${job.remote}, switching to stream put...`);
                                    await client.put(fs.createReadStream(localPath), job.remote);
                                }
                                else {
                                    throw putErr;
                                }
                            }
                        }
                        else {
                            await client.uploadFrom(localPath, job.remote);
                        }
                    }
                    success = true;
                    await connectionManager.releaseClient(host, client);
                    break;
                }
                catch (err) {
                    if (client)
                        await connectionManager.destroy(client);
                    if (shouldRetry(err)) {
                        if (attempt > 1) {
                            console.warn(`Retry ${attempt}/${3} for ${job.remote}: ${err.message}`);
                        }
                        await wait(1000 * attempt);
                    }
                    else {
                        console.error(`Fatal error for ${job.remote}: ${err.message}`);
                        break;
                    }
                }
            }
            queue.pop();
            onProgress(++done, jobs.length);
        }
    };
    await Promise.all(Array.from({ length: workersCount }, worker));
}
/* ------------------------------------------------------------------
 * Commands
 * ---------------------------------------------------------------- */
async function downloadCommand(item) {
    const cfg = cfgFor(item.data.host);
    const localTarget = toLocalPath(item.data.host, item.data.fullPath);
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${item.label}...`,
        cancellable: true
    }, async (progress, token) => {
        let files = [];
        if (item.type === 'file') {
            files = [item.data.fullPath];
        }
        else {
            progress.report({ message: "Scanning files..." });
            // Скануємо рекурсивно. Використовуємо тимчасовий клієнт.
            try {
                const client = await connectionManager.getClient(item.data.host, cfg);
                files = await collectRemoteFiles(client, item.data.fullPath);
                await connectionManager.releaseClient(item.data.host, client);
            }
            catch (e) {
                vscode.window.showErrorMessage(`Scan failed: ${e}`);
                return;
            }
        }
        const jobs = files.map(f => ({
            remote: f,
            local: toLocalPath(item.data.host, f),
            type: 'download'
        }));
        await processQueue(item.data.host, jobs, cfg.workers ?? 4, token, (d, t) => progress.report({ message: `${d}/${t}` }));
    });
    vscode.window.showInformationMessage(`Downloaded to ${localTarget}`);
}
async function uploadFileCommand(item) {
    await handleUpload(item, false);
}
async function uploadFolderCommand(item) {
    await handleUpload(item, true);
}
async function handleUpload(item, isFolder) {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: !isFolder,
        canSelectFolders: isFolder,
        canSelectMany: true,
        defaultUri: vscode.Uri.file(workspaceRoot)
    });
    if (!uris)
        return;
    const remoteBase = item.data.fullPath;
    const cfg = cfgFor(item.data.host);
    const jobs = [];
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Preparing upload...",
        cancellable: true
    }, async () => {
        for (const uri of uris) {
            if (isFolder) {
                const rootPath = uri.fsPath;
                const rootName = path.basename(rootPath);
                const files = await collectLocalFiles(rootPath);
                for (const f of files) {
                    const rel = path.relative(rootPath, f).split(path.sep).join("/");
                    jobs.push({
                        local: f,
                        remote: path.posix.join(remoteBase, rootName, rel),
                        type: 'upload'
                    });
                }
            }
            else {
                jobs.push({
                    local: uri.fsPath,
                    remote: path.posix.join(remoteBase, path.basename(uri.fsPath)),
                    type: 'upload'
                });
            }
        }
    });
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Uploading...",
        cancellable: true
    }, async (progress, token) => {
        await processQueue(item.data.host, jobs, cfg.workers ?? 4, token, (d, t) => progress.report({ message: `${d}/${t}` }));
    });
    provider.refresh(item);
    vscode.window.showInformationMessage("Upload complete");
}
async function createFileCommand(item) {
    const name = await vscode.window.showInputBox({ prompt: "File name" });
    if (!name)
        return;
    const remote = path.posix.join(item.data.fullPath, name);
    const temp = path.join(os.tmpdir(), `new-${Date.now()}`);
    fs.writeFileSync(temp, "");
    await singleShot(item.data.host, async (client) => {
        if (client instanceof ssh2_sftp_client_1.default)
            await client.fastPut(temp, remote);
        else
            await client.uploadFrom(temp, remote);
    });
    fs.unlinkSync(temp);
    provider.refresh(item);
    // Open it
    const local = toLocalPath(item.data.host, remote);
    await ensureDir(local);
    fs.writeFileSync(local, ""); // create empty local
    const doc = await vscode.workspace.openTextDocument(local);
    await vscode.window.showTextDocument(doc);
}
async function createFolderCommand(item) {
    const name = await vscode.window.showInputBox({ prompt: "Folder name" });
    if (!name)
        return;
    const remote = path.posix.join(item.data.fullPath, name);
    await singleShot(item.data.host, async (client) => {
        if (client instanceof ssh2_sftp_client_1.default)
            await client.mkdir(remote, true);
        else
            await client.ensureDir(remote);
    });
    provider.refresh(item);
}
async function deleteCommand(item) {
    if (await vscode.window.showWarningMessage(`Delete ${item.label}?`, { modal: true }, "Yes") !== "Yes")
        return;
    await singleShot(item.data.host, async (client) => {
        const r = item.data.fullPath;
        if (item.type === 'file') {
            if (client instanceof ssh2_sftp_client_1.default)
                await client.delete(r);
            else
                await client.remove(r);
        }
        else {
            if (client instanceof ssh2_sftp_client_1.default) {
                try {
                    await client.rmdir(r, true);
                }
                catch {
                    await client.rmdir(r, { recursive: true });
                }
            }
            else {
                await client.removeDir(r);
            }
        }
    });
    // Try delete local
    const local = toLocalPath(item.data.host, item.data.fullPath);
    try {
        await fs.promises.rm(local, { recursive: true, force: true });
    }
    catch { }
    provider.refresh();
}
async function openFileCommand(item) {
    const local = toLocalPath(item.data.host, item.data.fullPath);
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Opening ${item.label}...`
    }, async () => {
        await processQueue(item.data.host, [{ local, remote: item.data.fullPath, type: 'download' }], 1, new vscode.CancellationTokenSource().token, () => { });
    });
    await createBackup(local, item.data.fullPath, item.data.host);
    const doc = await vscode.workspace.openTextDocument(local);
    await vscode.window.showTextDocument(doc);
}
// Черга для збереження (Save Queue)
const saveQueue = new Set();
let isSaving = false;
async function handleSave(doc) {
    const rel = path.relative(workspaceRoot, doc.fileName);
    if (rel.startsWith('..') || path.isAbsolute(rel))
        return;
    const [host, ...rest] = rel.split(path.sep);
    if (!host || !rest.length)
        return;
    saveQueue.add(doc.fileName);
    if (isSaving)
        return;
    isSaving = true;
    uploadStatusBar.text = "$(sync~spin) Uploading...";
    while (saveQueue.size > 0) {
        const local = saveQueue.values().next().value;
        if (!local)
            break;
        saveQueue.delete(local);
        const relPath = path.relative(workspaceRoot, local);
        const [h, ...r] = relPath.split(path.sep);
        const remote = "/" + r.join("/");
        uploadStatusBar.tooltip = remote;
        await createBackup(local, remote, h);
        // Використовуємо ту саму логіку processQueue для надійності
        try {
            await processQueue(h, [{ local, remote, type: 'upload' }], 1, new vscode.CancellationTokenSource().token, () => { });
            uploadStatusBar.text = "$(check) Uploaded";
        }
        catch (e) {
            uploadStatusBar.text = "$(error) Failed";
            vscode.window.showErrorMessage(`Upload failed: ${e}`);
        }
    }
    setTimeout(() => { if (saveQueue.size === 0)
        uploadStatusBar.text = ""; }, 2000);
    isSaving = false;
}
/* ------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------- */
async function singleShot(host, task) {
    const cfg = cfgFor(host);
    let client = null;
    try {
        client = await connectionManager.getClient(host, cfg);
        await task(client);
        await connectionManager.releaseClient(host, client);
    }
    catch (e) {
        if (client)
            await connectionManager.destroy(client);
        throw e;
    }
}
async function collectRemoteFiles(client, dir) {
    const files = [];
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        const list = await listRemote(client, d, "");
        for (const item of list) {
            if (item.type === 'file')
                files.push(item.data.fullPath);
            else
                stack.push(item.data.fullPath);
        }
    }
    return files;
}
async function collectLocalFiles(dir) {
    const files = [];
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        const entries = await fs.promises.readdir(d, { withFileTypes: true });
        for (const e of entries) {
            const f = path.join(d, e.name);
            if (e.isDirectory())
                stack.push(f);
            else
                files.push(f);
        }
    }
    return files;
}
async function listRemote(client, dir, host) {
    const ents = [];
    // Отримуємо "сирий" список
    const rawList = client instanceof ssh2_sftp_client_1.default
        ? await client.list(dir)
        : await client.list(dir);
    // 1. ФІЛЬТР (Критично важливо!)
    // Відсіюємо '.' та '..', щоб не зламати рекурсію
    const filteredList = rawList.filter(e => e.name !== '.' && e.name !== '..');
    if (client instanceof ssh2_sftp_client_1.default) {
        filteredList.forEach((e) => ents.push({ name: e.name, isDir: e.type === "d" }));
    }
    else {
        filteredList.forEach((e) => ents.push({
            name: e.name,
            // Твоя стара логіка, яка коректно визначає файли/папки для FTP
            isDir: e.isDirectory ?? e.type === 1,
        }));
    }
    ents.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);
    return ents.map(({ name, isDir }) => new RemoteItem((isDir ? "" : "  ") + name, isDir
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None, isDir ? "dir" : "file", { host, fullPath: path.posix.join(dir, name), isDir }));
}
async function createBackup(local, remote, host) {
    try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root)
            return;
        const backupDir = path.dirname(path.join(root, 'rsftpbackups', host, path.relative(root, local)));
        await fs.promises.mkdir(backupDir, { recursive: true });
        const name = path.basename(local, path.extname(local));
        const ext = path.extname(local);
        const date = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `${name}-${date}${ext}`);
        if (fs.existsSync(local))
            await fs.promises.copyFile(local, backupPath);
    }
    catch { }
}
function cfgFor(host) {
    return getConfig()?.hosts?.[host] ?? {};
}
function getConfig() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rsftp.config && root) {
        try {
            rsftp.config = JSON.parse(fs.readFileSync(path.join(root, "rsftpconfig.json"), "utf8"));
        }
        catch { }
    }
    return rsftp.config;
}
function toLocalPath(host, remote) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const rel = remote.replace(/^\/+/, "");
    return path.join(root, host, ...rel.split("/"));
}
async function ensureDir(p) { await fs.promises.mkdir(path.dirname(p), { recursive: true }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
//# sourceMappingURL=extensionVxxx2.js.map
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
 * Connection Management (Stable & Simple)
 * ---------------------------------------------------------------- */
class SimpleConnectionManager {
    activeClients = new Map();
    async getClient(host, cfg) {
        let pool = this.activeClients.get(host) || [];
        // Витягуємо клієнта з пулу ОДРАЗУ. pop() є синхронним, тому інший потік не зможе перехопити цього клієнта.
        while (pool.length > 0) {
            const client = pool.pop();
            if (client) {
                // Тепер, коли клієнт тільки наш, перевіряємо чи він живий
                if (await this.isAlive(client, cfg.protocol)) {
                    return client;
                }
                // Якщо мертвий — знищуємо (він вже видалений з пулу через pop)
                await this.destroy(client);
            }
        }
        // Якщо пул порожній або всі мертві — створюємо нового
        return await this.connect(cfg);
    }
    async releaseClient(host, client) {
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
            // Fix MaxListenersExceeded
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
 * Logic Helpers
 * ---------------------------------------------------------------- */
/**
 * Виконує одну швидку дію (rename, chmod, delete) і повертає з'єднання.
 * Це критично для того, щоб інтерфейс не "тупив".
 */
async function singleShot(host, task) {
    const cfg = cfgFor(host);
    let client = null;
    try {
        client = await connectionManager.getClient(host, cfg);
        await task(client);
        // Якщо все ок - повертаємо в пул
        await connectionManager.releaseClient(host, client);
    }
    catch (e) {
        // Якщо помилка - вбиваємо з'єднання про всяк випадок
        if (client)
            await connectionManager.destroy(client);
        throw e;
    }
}
function shouldRetry(err) {
    if (!err)
        return false;
    const msg = (err.message || "").toLowerCase();
    const code = (err.code || "").toString().toUpperCase();
    if (code === 'ENOENT' || code === '404' || msg.includes('no such file'))
        return false;
    if (code === 'EACCES' || code === '550' || msg.includes('permission denied'))
        return false;
    if (msg.includes('not a regular file'))
        return false;
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
            // Використовуємо singleShot логіку для лістингу, щоб не тримати з'єднання
            let client = null;
            try {
                client = await connectionManager.getClient(element.data.host, hostCfg);
                const items = await listRemote(client, element.data.fullPath, element.data.host);
                await connectionManager.releaseClient(element.data.host, client);
                return items;
            }
            catch (e) {
                if (client)
                    await connectionManager.destroy(client);
                vscode.window.showErrorMessage(`Error listing ${element.label}: ${e}`);
                return [];
            }
        }
        return [];
    }
    getParent(element) {
        if (element.type === 'host')
            return undefined;
        const parentPath = path.posix.dirname(element.data.fullPath);
        const host = element.data.host;
        // Перевірка на корінь
        if (parentPath === "." || parentPath === "/") {
            return new RemoteItem(host, vscode.TreeItemCollapsibleState.Collapsed, "host", {
                host, fullPath: "/", isDir: true
            });
        }
        return new RemoteItem(path.posix.basename(parentPath), vscode.TreeItemCollapsibleState.Collapsed, "dir", { host, fullPath: parentPath, isDir: true });
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
        else if (type === 'dir') {
            this.command = { command: "list.toggleExpand", title: "Toggle" };
        }
    }
}
/* ------------------------------------------------------------------
 * Extension Lifecycle
 * ---------------------------------------------------------------- */
function activate(ctx) {
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.show();
    uploadStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    uploadStatusBar.show();
    const tree = vscode.window.createTreeView("remote_sftp", { treeDataProvider: provider });
    tree.onDidExpandElement(e => provider.refresh(e.element));
    const reloadConfig = async () => {
        await connectionManager.closeAll();
        rsftp.config = null;
        provider.refresh();
    };
    const configWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, "rsftpconfig.json"));
    ctx.subscriptions.push(statusBar, uploadStatusBar, vscode.commands.registerCommand("remote-sftp.reload", () => vscode.commands.executeCommand("workbench.action.restartExtensionHost")), vscode.commands.registerCommand("remote-sftp.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:andriy063.remote-ftp-vscode")), vscode.commands.registerCommand("remote-sftp.openFile", openFileCommand), vscode.commands.registerCommand("remote-sftp.download", downloadCommand), vscode.commands.registerCommand("remote-sftp.uploadFile", uploadFileCommand), vscode.commands.registerCommand("remote-sftp.uploadFolder", uploadFolderCommand), vscode.commands.registerCommand("remote-sftp.delete", deleteCommand), vscode.commands.registerCommand("remote-sftp.rename", renameCommand), vscode.commands.registerCommand("remote-sftp.createFile", createFileCommand), vscode.commands.registerCommand("remote-sftp.createFolder", createFolderCommand), vscode.commands.registerCommand("remote-sftp.chmod", chmodCommand), vscode.commands.registerCommand("remote-sftp.copyRemotePath", copyRemotePathToClipboard), vscode.workspace.onDidSaveTextDocument(handleSave), vscode.window.onDidChangeTextEditorSelection(event => {
        const text = event.textEditor.document.getText(event.textEditor.selection);
        if (text && !text.includes('\n')) {
            const count = (event.textEditor.document.getText().match(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
            statusBar.text = `🔍 '${text}': ${count}`;
        }
        else {
            statusBar.text = '';
        }
    }), configWatcher.onDidChange(reloadConfig), configWatcher.onDidCreate(reloadConfig), configWatcher.onDidDelete(reloadConfig), vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("remote-sftp"))
            reloadConfig();
    }), vscode.commands.registerCommand("remote-sftp.toggleBookmark", async (item) => {
        if (!item || item.type === 'host')
            return;
        const added = await bookmarksManager.toggle(item.data.host, item.data.fullPath);
        const msg = added
            ? `$(bookmark) Bookmarked: ${item.label}`
            : `$(trash) Bookmark removed: ${item.label}`;
        vscode.window.setStatusBarMessage(msg, 3000);
    }), vscode.commands.registerCommand("remote-sftp.openBookmarks", async () => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = "Remote Bookmarks";
        quickPick.placeholder = "Select a folder to open...";
        quickPick.matchOnDetail = true; // Дозволяє шукати по хосту
        const refreshItems = async () => {
            const bookmarks = await bookmarksManager.getAll();
            if (bookmarks.length === 0) {
                quickPick.items = [{ label: "No bookmarks yet", alwaysShow: true }];
                return;
            }
            quickPick.items = bookmarks.map(b => ({
                label: `$(folder) ${path.posix.basename(b.path)}`,
                description: b.path,
                detail: `$(server) ${b.host}`, // Хост дрібнішим шрифтом
                entry: b,
                buttons: [{ iconPath: new vscode.ThemeIcon("trash"), tooltip: "Remove Bookmark" }]
            }));
        };
        await refreshItems();
        quickPick.onDidTriggerItemButton(async (e) => {
            const item = e.item;
            if (item.entry) {
                await bookmarksManager.remove(item.entry.host, item.entry.path);
                await refreshItems(); // Перемальовуємо список на льоту
            }
        });
        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0];
            if (selected && selected.entry) {
                quickPick.hide();
                const { host, path: remotePath } = selected.entry;
                const targetItem = new RemoteItem(path.posix.basename(remotePath), vscode.TreeItemCollapsibleState.Collapsed, "dir", { host, fullPath: remotePath, isDir: true });
                try {
                    await tree.reveal(targetItem, { select: true, focus: true, expand: true });
                }
                catch (error) {
                    vscode.window.showErrorMessage(`Could not reveal: ${remotePath}. Check connection.`);
                }
            }
        });
        quickPick.show();
        ctx.subscriptions.push(quickPick);
    }));
}
async function deactivate() {
    await connectionManager.closeAll();
}
/* ------------------------------------------------------------------
 * COMMANDS
 * ---------------------------------------------------------------- */
async function copyRemotePathToClipboard(item) {
    await vscode.env.clipboard.writeText(item.data.fullPath);
    vscode.window.showInformationMessage(`✅ Copied: ${item.data.fullPath}`);
}
async function chmodCommand(item) {
    const val = await vscode.window.showInputBox({ prompt: `Permissions for '${item.label}'`, placeHolder: "e.g. 755" });
    if (!val)
        return;
    await singleShot(item.data.host, async (client) => {
        if (client instanceof ssh2_sftp_client_1.default) {
            await client.chmod(item.data.fullPath, parseInt(val, 8));
        }
        else {
            await client.send(`SITE CHMOD ${val} ${item.data.fullPath}`);
        }
    });
    provider.refresh(item);
    vscode.window.showInformationMessage(`Permissions changed to ${val}`);
}
async function renameCommand(item) {
    const oldName = path.posix.basename(item.data.fullPath);
    const newName = await vscode.window.showInputBox({ prompt: `Rename '${oldName}' to...`, value: oldName });
    if (!newName || newName === oldName)
        return;
    const parent = path.posix.dirname(item.data.fullPath);
    const newRemote = path.posix.join(parent, newName);
    await singleShot(item.data.host, async (client) => {
        if (client instanceof ssh2_sftp_client_1.default)
            await client.rename(item.data.fullPath, newRemote);
        else
            await client.rename(item.data.fullPath, newRemote);
    });
    // Rename local if exists
    const oldLocal = toLocalPath(item.data.host, item.data.fullPath);
    const newLocal = toLocalPath(item.data.host, newRemote);
    try {
        await fs.promises.rename(oldLocal, newLocal);
    }
    catch { }
    provider.refresh();
    vscode.window.showInformationMessage(`Renamed`);
}
async function createFileCommand(item) {
    const name = await vscode.window.showInputBox({ prompt: "New file name", placeHolder: "index.php" });
    if (!name)
        return;
    const remote = path.posix.join(item.data.fullPath, name);
    const temp = path.join(os.tmpdir(), `rsftp-${Date.now()}`);
    fs.writeFileSync(temp, "");
    await singleShot(item.data.host, async (client) => {
        if (client instanceof ssh2_sftp_client_1.default)
            await client.fastPut(temp, remote);
        else
            await client.uploadFrom(temp, remote);
    });
    fs.unlinkSync(temp);
    // Download & Open
    const local = toLocalPath(item.data.host, remote);
    await ensureDir(local);
    fs.writeFileSync(local, "");
    // Refresh parent
    provider.refresh(item);
    const doc = await vscode.workspace.openTextDocument(local);
    await vscode.window.showTextDocument(doc, { preview: false });
}
async function createFolderCommand(item) {
    const name = await vscode.window.showInputBox({ prompt: "New folder name" });
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
    vscode.window.showInformationMessage(`Created`);
}
async function deleteCommand(item) {
    if (await vscode.window.showWarningMessage(`Delete '${item.label.trim()}'?`, { modal: true }, "Yes") !== "Yes")
        return;
    await singleShot(item.data.host, async (client) => {
        if (item.type === 'file') {
            if (client instanceof ssh2_sftp_client_1.default)
                await client.delete(item.data.fullPath);
            else
                await client.remove(item.data.fullPath);
        }
        else {
            if (client instanceof ssh2_sftp_client_1.default) {
                try {
                    await client.rmdir(item.data.fullPath, true);
                }
                catch {
                    await client.rmdir(item.data.fullPath, { recursive: true });
                }
            }
            else {
                await client.removeDir(item.data.fullPath);
            }
        }
    });
    const local = toLocalPath(item.data.host, item.data.fullPath);
    try {
        await fs.promises.rm(local, { recursive: true, force: true });
    }
    catch { }
    provider.refresh();
    vscode.window.showInformationMessage(`Deleted`);
}
async function openFileCommand(item) {
    if (item.type !== "file")
        return;
    const fileKey = `${item.data.host}:${item.data.fullPath}`;
    const now = Date.now();
    if (now - (openFileDebounce.get(fileKey) || 0) < 500)
        return;
    openFileDebounce.set(fileKey, now);
    const local = toLocalPath(item.data.host, item.data.fullPath);
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Opening ${item.label}...`
    }, async () => {
        // Використовуємо чергу для надійності, навіть для одного файлу
        await processQueue(item.data.host, [{ local, remote: item.data.fullPath, type: 'download' }], 1, new vscode.CancellationTokenSource().token, () => { });
    });
    await createBackup(local, item.data.fullPath, item.data.host);
    //await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(local));
    const doc = await vscode.workspace.openTextDocument(local);
    await vscode.window.showTextDocument(doc, { preview: false });
}
async function processQueue(host, jobs, workersCount, token, onProgress) {
    const cfg = cfgFor(host);
    const queue = [...jobs]; // Копія масиву для безпечної мутації
    const createdDirs = new Set(); // Кеш створених папок
    let done = 0;
    const worker = async () => {
        while (queue.length > 0 && !token.isCancellationRequested) {
            // Атомарно забираємо задачу. Важливо: робимо це синхронно перед будь-яким await
            const job = queue.pop();
            if (!job)
                break;
            let client = null;
            // Retry Loop (3 спроби)
            for (let attempt = 1; attempt <= 3; attempt++) {
                if (token.isCancellationRequested)
                    break;
                try {
                    client = await connectionManager.getClient(host, cfg);
                    const localPath = path.normalize(job.local);
                    // --- DOWNLOAD ---
                    if (job.type === 'download') {
                        await ensureDir(localPath); // Створюємо локальну папку для файлу
                        // SFTP Check: перевірка чи це не папка на віддаленому сервері (сканер зазвичай це фільтрує, але для надійності)
                        let isRemoteDir = false;
                        if (client instanceof ssh2_sftp_client_1.default) {
                            try {
                                const s = await client.stat(job.remote);
                                isRemoteDir = s.isDirectory;
                            }
                            catch { }
                        }
                        if (isRemoteDir) {
                            // Якщо ми намагаємось скачати папку як файл - скіпаємо
                            break;
                        }
                        if (client instanceof ssh2_sftp_client_1.default)
                            await client.fastGet(job.remote, localPath);
                        else
                            await client.downloadTo(localPath, job.remote);
                    }
                    // --- UPLOAD ---
                    else {
                        // Перевіряємо локальний файл/папку
                        let stats;
                        try {
                            stats = await fs.promises.stat(localPath);
                        }
                        catch (e) {
                            // Якщо файл зник локально - ігноруємо і йдемо далі
                            break;
                        }
                        // A. Це ПАПКА -> Створюємо на сервері (і пусті теж)
                        if (stats.isDirectory()) {
                            const remoteDir = job.remote;
                            if (!createdDirs.has(remoteDir)) {
                                if (client instanceof ssh2_sftp_client_1.default) {
                                    try {
                                        await client.mkdir(remoteDir, true);
                                    }
                                    catch {
                                        if (!(await client.exists(remoteDir)))
                                            throw new Error("Mkdir failed");
                                    }
                                }
                                else {
                                    await client.ensureDir(remoteDir);
                                }
                                createdDirs.add(remoteDir);
                            }
                            // Для папки більше нічого робити не треба
                            await connectionManager.releaseClient(host, client);
                            break;
                        }
                        // B. Це ФАЙЛ -> Завантажуємо
                        const remoteDir = path.posix.dirname(job.remote);
                        // 1. Перевірка/Створення батьківської папки (оптимізовано)
                        if (!createdDirs.has(remoteDir)) {
                            if (client instanceof ssh2_sftp_client_1.default) {
                                try {
                                    await client.mkdir(remoteDir, true);
                                }
                                catch {
                                    if (!(await client.exists(remoteDir)))
                                        throw new Error("Mkdir failed");
                                }
                            }
                            else {
                                await client.ensureDir(remoteDir);
                            }
                            createdDirs.add(remoteDir);
                        }
                        // 2. Власне завантаження файлу
                        if (client instanceof ssh2_sftp_client_1.default) {
                            try {
                                await client.fastPut(localPath, job.remote);
                            }
                            catch (e) {
                                // Fallback: якщо fastPut падає (буває на старих серверах), пробуємо потік
                                const m = (e.message || "").toLowerCase();
                                if (m.includes('no such file') || m.includes('bad path') || m.includes('open')) {
                                    await client.put(fs.createReadStream(localPath), job.remote);
                                }
                                else
                                    throw e;
                            }
                        }
                        else {
                            await client.uploadFrom(localPath, job.remote);
                        }
                    }
                    // Успіх -> повертаємо клієнта і виходимо з циклу retry
                    await connectionManager.releaseClient(host, client);
                    break;
                }
                catch (e) {
                    // Помилка -> вбиваємо клієнта
                    if (client)
                        await connectionManager.destroy(client);
                    if (shouldRetry(e)) {
                        // Чекаємо перед наступною спробою
                        await wait(1000 * attempt);
                    }
                    else {
                        // Фатальна помилка (напр. Permission Denied) - не пробуємо знову
                        console.error(`Error processing ${job.remote}:`, e);
                        break;
                    }
                }
            }
            // Оновлюємо прогрес
            done++;
            onProgress(done, jobs.length);
        }
    };
    // Запускаємо воркери паралельно
    await Promise.all(Array.from({ length: workersCount }, worker));
}
async function downloadCommand(item) {
    const cfg = cfgFor(item.data.host);
    const localTarget = toLocalPath(item.data.host, item.data.fullPath);
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${item.label}...`,
        cancellable: true
    }, async (progress, token) => {
        let files = [];
        // ЕТАП 1: Сканування (або додавання одного файлу)
        if (item.type === 'file') {
            files = [item.data.fullPath];
        }
        else {
            progress.report({ message: "Scanning..." });
            let client = null;
            try {
                // Отримуємо клієнта для операції сканування
                client = await connectionManager.getClient(item.data.host, cfg);
                // Викликаємо оновлену collectRemoteFiles з callback-функцією
                files = await collectRemoteFiles(client, item.data.fullPath, (count) => {
                    progress.report({ message: `Scanning... Files found: ${count}` });
                });
            }
            catch (e) {
                vscode.window.showErrorMessage(`Scan failed: ${e}`);
                return; // Припиняємо виконання, якщо сканування впало
            }
            finally {
                // Критично важливо повернути клієнта в пул
                if (client)
                    await connectionManager.releaseClient(item.data.host, client);
            }
        }
        // Якщо користувач натиснув Cancel під час сканування
        if (token.isCancellationRequested)
            return;
        // ЕТАП 2: Завантаження
        const jobs = files.map(f => ({
            remote: f,
            local: toLocalPath(item.data.host, f),
            type: 'download'
        }));
        await processQueue(item.data.host, jobs, cfg.workers ?? 4, token, (done, total) => progress.report({ message: `${done}/${total}` }));
    });
    const action = await vscode.window.showInformationMessage(`Downloaded to ${localTarget}`, "Open Folder");
    if (action === "Open Folder") {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(localTarget));
    }
}
async function uploadFileCommand(item) { await handleUpload(item, false); }
async function uploadFolderCommand(item) { await handleUpload(item, true); }
async function handleUpload(item, isFolder) {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: !isFolder, canSelectFolders: isFolder, canSelectMany: true, defaultUri: vscode.Uri.file(workspaceRoot)
    });
    if (!uris)
        return;
    const remoteBase = item.data.fullPath;
    const cfg = cfgFor(item.data.host);
    const jobs = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Preparing..." }, async () => {
        for (const uri of uris) {
            if (isFolder) {
                const root = uri.fsPath;
                const rootName = path.basename(root);
                const files = await collectLocalFiles(root);
                for (const f of files) {
                    const rel = path.relative(root, f).split(path.sep).join("/");
                    jobs.push({ local: f, remote: path.posix.join(remoteBase, rootName, rel), type: 'upload' });
                }
            }
            else {
                jobs.push({ local: uri.fsPath, remote: path.posix.join(remoteBase, path.basename(uri.fsPath)), type: 'upload' });
            }
        }
    });
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Uploading...", cancellable: true }, async (p, t) => {
        await processQueue(item.data.host, jobs, cfg.workers ?? 4, t, (d, tot) => p.report({ message: `${d}/${tot}` }));
    });
    provider.refresh(item);
    vscode.window.showInformationMessage(`Uploaded to ${remoteBase}`);
}
// SAVE QUEUE
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
        const rPath = "/" + path.relative(workspaceRoot, local).split(path.sep).slice(1).join("/");
        uploadStatusBar.tooltip = rPath;
        await createBackup(local, rPath, host);
        try {
            await processQueue(host, [{ local, remote: rPath, type: 'upload' }], 1, new vscode.CancellationTokenSource().token, () => { });
            uploadStatusBar.text = "$(check) Uploaded";
        }
        catch (e) {
            uploadStatusBar.text = "$(error) Failed";
            console.error(e);
        }
    }
    setTimeout(() => { if (saveQueue.size === 0)
        uploadStatusBar.text = ""; }, 3000);
    isSaving = false;
}
/* ------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------- */
// Заміни сигнатуру та логіку collectRemoteFiles
async function collectRemoteFiles(client, dir, onFound) {
    const files = [];
    const stack = [dir];
    const visited = new Set();
    while (stack.length) {
        const d = stack.pop();
        if (visited.has(d))
            continue;
        visited.add(d);
        try {
            const list = await listRemote(client, d, "");
            for (const item of list) {
                if (item.type === 'file') {
                    files.push(item.data.fullPath);
                    if (onFound)
                        onFound(files.length);
                }
                else {
                    stack.push(item.data.fullPath);
                }
            }
        }
        catch (e) {
            const m = (e.message || "").toLowerCase();
            if (e.code === 550 || m.includes('not a directory') || m.includes('no such file')) {
                files.push(d);
                if (onFound)
                    onFound(files.length);
            }
            else {
                throw e;
            }
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
            if (e.isDirectory()) {
                files.push(f);
                stack.push(f);
            }
            else {
                files.push(f);
            }
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
        // Конфіг для ротації
        const cfg = getConfig();
        const days = cfg.backup_retention_days ?? 7;
        const maxAge = days * 24 * 60 * 60 * 1000;
        const backupDir = path.dirname(path.join(root, 'rsftpbackups', host, path.relative(root, local)));
        await fs.promises.mkdir(backupDir, { recursive: true });
        const ext = path.extname(local);
        const baseName = path.basename(local, ext); // Наприклад: 'index' з 'index.php'
        const now = Date.now();
        const dateStr = new Date(now).toISOString().replace(/[:.]/g, '-');
        const backupName = `${baseName}-${dateStr}${ext}`;
        const backupPath = path.join(backupDir, backupName);
        // Робимо бекап (якщо це файл)
        if (fs.existsSync(local) && fs.statSync(local).isFile()) {
            await fs.promises.copyFile(local, backupPath);
        }
        // CLEANUP: Видаляємо старі файли ТІЛЬКИ ЦЬОГО файлу
        fs.promises.readdir(backupDir).then(files => {
            for (const f of files) {
                if (!f.startsWith(`${baseName}-`) || !f.endsWith(ext))
                    continue;
                const fullPath = path.join(backupDir, f);
                fs.stat(fullPath, (err, stats) => {
                    if (!err && (now - stats.mtimeMs > maxAge)) {
                        fs.unlink(fullPath, () => { }); // Silent delete
                    }
                });
            }
        });
    }
    catch { }
}
function cfgFor(host) { return getConfig()?.hosts?.[host] ?? {}; }
function toLocalPath(host, remote) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const rel = remote.replace(/^\/+/, "");
    return path.join(root, host, ...rel.split("/"));
}
async function ensureDir(p) { await fs.promises.mkdir(path.dirname(p), { recursive: true }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
class BookmarksManager {
    getPath() {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return root ? path.join(root, 'rsftpbookmarks.json') : null;
    }
    async getAll() {
        const p = this.getPath();
        if (!p || !fs.existsSync(p))
            return [];
        try {
            const raw = JSON.parse(await fs.promises.readFile(p, 'utf8'));
            if (!Array.isArray(raw))
                return [];
            return raw.sort((a, b) => b.created - a.created);
        }
        catch {
            return [];
        }
    }
    async save(data) {
        const p = this.getPath();
        if (p)
            await fs.promises.writeFile(p, JSON.stringify(data, null, 2));
    }
    async toggle(host, remotePath) {
        let list = await this.getAll();
        const exists = list.some(b => b.host === host && b.path === remotePath);
        if (exists) {
            list = list.filter(b => !(b.host === host && b.path === remotePath));
            await this.save(list);
            return false;
        }
        else {
            list.unshift({ host, path: remotePath, created: Date.now() });
            await this.save(list);
            return true;
        }
    }
    async remove(host, remotePath) {
        let list = await this.getAll();
        const initialLen = list.length;
        list = list.filter(b => !(b.host === host && b.path === remotePath));
        if (list.length !== initialLen)
            await this.save(list);
    }
}
const bookmarksManager = new BookmarksManager();
function getConfig() {
    // 1. Кеш
    if (rsftp.config)
        return rsftp.config;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // 2. СЦЕНАРІЙ А: Є файл конфігу
    // Якщо файл існує - ми беремо ТІЛЬКИ його. Ніякого мерджу з IDE.
    if (root) {
        try {
            const configPath = path.join(root, "rsftpconfig.json");
            if (fs.existsSync(configPath)) {
                // Читаємо файл
                const fileContent = fs.readFileSync(configPath, "utf8");
                // Парсимо і зразу зберігаємо в кеш
                rsftp.config = JSON.parse(fileContent);
                return rsftp.config;
            }
        }
        catch (e) {
            console.error("Config parse error:", e);
            // Якщо файл є, але битий - повертаємо пустий об'єкт, щоб не "підтягнуло" IDE налаштування випадково
            return {};
        }
    }
    // 3. СЦЕНАРІЙ Б: Файлу немає -> читаємо налаштування IDE
    // (Тут лишаємо логіку з inspect, щоб не тягнути сміття з package.json)
    const cfgSection = vscode.workspace.getConfiguration("remote-sftp");
    const getUserValue = (key) => {
        const data = cfgSection.inspect(key);
        if (!data)
            return undefined;
        return data.workspaceFolderValue ?? data.workspaceValue ?? data.globalValue;
    };
    const ideNestedConfig = getUserValue("config") || {};
    const ideFlatHosts = getUserValue("hosts");
    let ideConfig = {};
    if (Object.keys(ideNestedConfig).length > 0) {
        ideConfig = ideNestedConfig;
    }
    else if (ideFlatHosts) {
        ideConfig = { hosts: ideFlatHosts };
    }
    rsftp.config = ideConfig;
    return rsftp.config;
}
//# sourceMappingURL=extension.js.map
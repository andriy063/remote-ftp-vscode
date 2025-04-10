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
function activate(context) {
    const provider = new RemoteFTPProvider();
    vscode.window.registerTreeDataProvider('remote-ftp-vscode', provider);
    context.subscriptions.push(vscode.commands.registerCommand('remoteFtp.refresh', () => provider.refresh()), vscode.commands.registerCommand('remoteFtp.openFile', item => provider.openRemoteFile(item)), vscode.commands.registerCommand('remoteFtp.download', item => provider.downloadToLocal(item)), vscode.commands.registerCommand('remoteFtp.newFile', item => provider.createNewFile(item)), vscode.commands.registerCommand('remoteFtp.newFolder', item => provider.createNewFolder(item)), vscode.commands.registerCommand('remoteFtp.uploadFiles', item => provider.uploadFiles(item)), vscode.commands.registerCommand('remoteFtp.uploadFolder', item => provider.uploadFolder(item)), vscode.commands.registerCommand('remoteFtp.changePermissions', item => provider.changePermissions(item)), vscode.workspace.onDidSaveTextDocument(doc => provider.uploadEditedFile(doc)));
}
class RemoteFTPProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    hosts = [];
    tmpDir = path.join(os.tmpdir(), '.remote-ftp-tmp');
    fileMap = new Map();
    constructor() {
        this.loadConfig();
        if (!fs.existsSync(this.tmpDir))
            fs.mkdirSync(this.tmpDir, { recursive: true });
    }
    refresh() {
        this.loadConfig();
        this._onDidChangeTreeData.fire(undefined);
    }
    loadConfig() {
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
    getTreeItem(element) {
        if ('protocol' in element) {
            return {
                label: element.name,
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                iconPath: new vscode.ThemeIcon('server'),
                id: element.name
            };
        }
        const item = new vscode.TreeItem(element.name, element.type === 'directory'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(element.type === 'directory' ? 'folder' : 'file-code');
        item.id = `${element.parentHost.name}:${element.path}`;
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
        if (!element)
            return this.hosts;
        if ('protocol' in element)
            return await this.getRemoteFiles(element, element.remotePath);
        if (element.type === 'directory')
            return await this.getRemoteFiles(element.parentHost, element.path);
        return [];
    }
    async getRemoteFiles(host, remotePath) {
        const list = [];
        try {
            if (host.protocol === 'ftp') {
                const client = new basic_ftp_1.Client();
                await client.access({
                    host: host.host,
                    port: host.port,
                    user: host.username,
                    password: host.password
                });
                const entries = await client.list(remotePath);
                for (const e of entries) {
                    if (e.type === 1 && host.ignoreExtensions.includes(path.extname(e.name)))
                        continue;
                    list.push({
                        type: e.type === 2 ? 'directory' : 'file',
                        name: e.name,
                        path: path.posix.join(remotePath, e.name),
                        parentHost: host
                    });
                }
                client.close();
            }
            else {
                const client = new ssh2_sftp_client_1.default();
                await client.connect({
                    host: host.host,
                    port: host.port,
                    username: host.username,
                    password: host.password
                });
                const entries = await client.list(remotePath);
                for (const e of entries) {
                    if (e.type === '-' && host.ignoreExtensions.includes(path.extname(e.name)))
                        continue;
                    list.push({
                        type: e.type === 'd' ? 'directory' : 'file',
                        name: e.name,
                        path: path.posix.join(remotePath, e.name),
                        parentHost: host
                    });
                }
                client.end();
            }
            list.sort((a, b) => {
                if (a.type === 'directory' && b.type === 'file')
                    return -1;
                if (a.type === 'file' && b.type === 'directory')
                    return 1;
                return a.name.localeCompare(b.name);
            });
        }
        catch (e) {
            vscode.window.showErrorMessage(`Failed to read directory: ${remotePath}`);
        }
        return list;
    }
    async openRemoteFile(item) {
        const tmpPath = path.join(this.tmpDir, `${item.parentHost.name}__${item.name}`);
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Opening: ${item.name}`,
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Connecting...' });
                if (item.parentHost.protocol === 'ftp') {
                    const client = new basic_ftp_1.Client();
                    await client.access({
                        host: item.parentHost.host,
                        port: item.parentHost.port,
                        user: item.parentHost.username,
                        password: item.parentHost.password
                    });
                    progress.report({ message: 'Downloading...' });
                    await client.downloadTo(tmpPath, item.path);
                    client.close();
                }
                else {
                    const client = new ssh2_sftp_client_1.default();
                    await client.connect({
                        host: item.parentHost.host,
                        port: item.parentHost.port,
                        username: item.parentHost.username,
                        password: item.parentHost.password
                    });
                    progress.report({ message: 'Downloading...' });
                    await client.fastGet(item.path, tmpPath);
                    client.end();
                }
            });
            const docUri = vscode.Uri.file(tmpPath).with({
                query: JSON.stringify({ path: item.path, host: item.parentHost.name })
            });
            const doc = await vscode.workspace.openTextDocument(docUri);
            await vscode.window.showTextDocument(doc);
            this.fileMap.set(docUri.fsPath, item);
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
                if (item.parentHost.protocol === 'ftp') {
                    const client = new basic_ftp_1.Client();
                    await client.access({
                        host: item.parentHost.host,
                        port: item.parentHost.port,
                        user: item.parentHost.username,
                        password: item.parentHost.password
                    });
                    await client.uploadFrom(doc.fileName, item.path);
                    client.close();
                }
                else {
                    const client = new ssh2_sftp_client_1.default();
                    await client.connect({
                        host: item.parentHost.host,
                        port: item.parentHost.port,
                        username: item.parentHost.username,
                        password: item.parentHost.password
                    });
                    await client.fastPut(doc.fileName, item.path);
                    client.end();
                }
                vscode.window.setStatusBarMessage(`✅ Uploaded: ${item.name}`, 3000);
            }
            catch (e) {
                vscode.window.showErrorMessage(`❌ Failed to upload ${item.name}`);
                console.error(e);
            }
        });
    }
    async downloadToLocal(item) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
        const localBase = path.resolve(workspaceRoot, item.parentHost.localPath);
        const remoteRoot = item.parentHost.remotePath;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `📥 Downloading ${item.name}`,
            cancellable: false
        }, async () => {
            try {
                if (item.type === 'file') {
                    const relative = path.posix.relative(remoteRoot, item.path);
                    const localTarget = path.resolve(localBase, relative.replace(/\//g, path.sep));
                    await this.downloadSingleFile(item, localTarget);
                }
                else {
                    await this.downloadDirectory(item, item.path, localBase, remoteRoot);
                }
                vscode.window.showInformationMessage(`✅ Downloaded: ${item.name}`);
            }
            catch (e) {
                vscode.window.showErrorMessage(`❌ Failed to download ${item.name}`);
                console.error(e);
            }
        });
    }
    async downloadDirectory(rootItem, remoteDir, localBase, remoteRoot) {
        const list = await this.getRemoteFiles(rootItem.parentHost, remoteDir);
        for (const item of list) {
            const relative = path.posix.relative(remoteRoot, item.path);
            const localTarget = path.resolve(localBase, relative.replace(/\//g, path.sep));
            if (item.type === 'directory') {
                await this.downloadDirectory(item, item.path, localBase, remoteRoot);
            }
            else {
                await this.downloadSingleFile(item, localTarget);
            }
        }
    }
    async downloadSingleFile(item, localTarget) {
        const exists = fs.existsSync(localTarget);
        const stats = exists ? fs.statSync(localTarget) : null;
        if (exists && stats?.isFile()) {
            let remoteSize = -1;
            if (item.parentHost.protocol === 'ftp') {
                const client = new basic_ftp_1.Client();
                await client.access({
                    host: item.parentHost.host,
                    port: item.parentHost.port,
                    user: item.parentHost.username,
                    password: item.parentHost.password
                });
                const list = await client.list(path.posix.dirname(item.path));
                const file = list.find(f => f.name === path.basename(item.path));
                remoteSize = file?.size ?? -1;
                client.close();
            }
            else {
                const client = new ssh2_sftp_client_1.default();
                await client.connect({
                    host: item.parentHost.host,
                    port: item.parentHost.port,
                    username: item.parentHost.username,
                    password: item.parentHost.password
                });
                const info = await client.stat(item.path);
                remoteSize = info.size;
                client.end();
            }
            if (remoteSize === stats.size)
                return;
        }
        fs.mkdirSync(path.dirname(localTarget), { recursive: true });
        if (item.parentHost.protocol === 'ftp') {
            const client = new basic_ftp_1.Client();
            await client.access({
                host: item.parentHost.host,
                port: item.parentHost.port,
                user: item.parentHost.username,
                password: item.parentHost.password
            });
            await client.downloadTo(localTarget, item.path);
            client.close();
        }
        else {
            const client = new ssh2_sftp_client_1.default();
            await client.connect({
                host: item.parentHost.host,
                port: item.parentHost.port,
                username: item.parentHost.username,
                password: item.parentHost.password
            });
            await client.fastGet(item.path, localTarget);
            client.end();
        }
    }
    async createNewFile(item) {
        const name = await vscode.window.showInputBox({ prompt: 'Enter new file name' });
        if (!name)
            return;
        const remotePath = path.posix.join(item.path, name);
        if (item.parentHost.protocol === 'ftp') {
            const client = new basic_ftp_1.Client();
            await client.access({
                host: item.parentHost.host,
                port: item.parentHost.port,
                user: item.parentHost.username,
                password: item.parentHost.password
            });
            const tmpFilePath = path.join(this.tmpDir, `temp-${Date.now()}`);
            fs.writeFileSync(tmpFilePath, '');
            await client.uploadFrom(tmpFilePath, remotePath);
            fs.unlinkSync(tmpFilePath);
            client.close();
        }
        else {
            const client = new ssh2_sftp_client_1.default();
            await client.connect({
                host: item.parentHost.host,
                port: item.parentHost.port,
                username: item.parentHost.username,
                password: item.parentHost.password
            });
            await client.put(Buffer.from(''), remotePath);
            client.end();
        }
        this.refresh();
    }
    async createNewFolder(item) {
        const name = await vscode.window.showInputBox({ prompt: 'Enter new folder name' });
        if (!name)
            return;
        const remotePath = path.posix.join(item.path, name);
        if (item.parentHost.protocol === 'ftp') {
            const client = new basic_ftp_1.Client();
            await client.access({
                host: item.parentHost.host,
                port: item.parentHost.port,
                user: item.parentHost.username,
                password: item.parentHost.password
            });
            await client.ensureDir(remotePath);
            client.close();
        }
        else {
            const client = new ssh2_sftp_client_1.default();
            await client.connect({
                host: item.parentHost.host,
                port: item.parentHost.port,
                username: item.parentHost.username,
                password: item.parentHost.password
            });
            await client.mkdir(remotePath, true);
            client.end();
        }
        this.refresh();
    }
    async uploadFiles(item) {
        const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: true });
        if (!uris)
            return;
        const remoteDir = item.path;
        if (item.parentHost.protocol === 'ftp') {
            const client = new basic_ftp_1.Client();
            await client.access({
                host: item.parentHost.host,
                port: item.parentHost.port,
                user: item.parentHost.username,
                password: item.parentHost.password
            });
            for (const uri of uris) {
                const fileName = path.basename(uri.fsPath);
                await client.uploadFrom(uri.fsPath, path.posix.join(remoteDir, fileName));
            }
            client.close();
        }
        else {
            const client = new ssh2_sftp_client_1.default();
            await client.connect({
                host: item.parentHost.host,
                port: item.parentHost.port,
                username: item.parentHost.username,
                password: item.parentHost.password
            });
            for (const uri of uris) {
                const fileName = path.basename(uri.fsPath);
                await client.fastPut(uri.fsPath, path.posix.join(remoteDir, fileName));
            }
            client.end();
        }
        this.refresh();
    }
    async uploadFolder(item) {
        const folderUri = await vscode.window.showOpenDialog({ canSelectFolders: true });
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
        if (item.parentHost.protocol === 'ftp') {
            const client = new basic_ftp_1.Client();
            await client.access({
                host: item.parentHost.host,
                port: item.parentHost.port,
                user: item.parentHost.username,
                password: item.parentHost.password
            });
            for (const file of files) {
                const rel = path.relative(folderPath, file).replace(/\\/g, '/');
                await client.uploadFrom(file, path.posix.join(remoteBase, rel));
            }
            client.close();
        }
        else {
            const client = new ssh2_sftp_client_1.default();
            await client.connect({
                host: item.parentHost.host,
                port: item.parentHost.port,
                username: item.parentHost.username,
                password: item.parentHost.password
            });
            for (const file of files) {
                const rel = path.relative(folderPath, file).replace(/\\/g, '/');
                const remoteFilePath = path.posix.join(remoteBase, rel);
                const remoteDir = path.posix.dirname(remoteFilePath);
                await client.mkdir(remoteDir, true).catch(() => { });
                await client.fastPut(file, remoteFilePath);
            }
            client.end();
        }
        this.refresh();
    }
    async changePermissions(item) {
        const mode = await vscode.window.showInputBox({
            prompt: 'Enter chmod value (e.g. 755)',
            validateInput: val => /^\d{3}$/.test(val) ? null : 'Must be a 3-digit number'
        });
        if (!mode)
            return;
        if (item.parentHost.protocol === 'ftp') {
            vscode.window.showErrorMessage('Changing permissions not supported over FTP');
            return;
        }
        const client = new ssh2_sftp_client_1.default();
        await client.connect({
            host: item.parentHost.host,
            port: item.parentHost.port,
            username: item.parentHost.username,
            password: item.parentHost.password
        });
        await client.chmod(item.path, parseInt(mode, 8));
        await client.end();
        vscode.window.showInformationMessage(`✅ Permissions updated to ${mode}`);
    }
}
//# sourceMappingURL=extension%20%E2%80%93%20%D0%BA%D0%BE%D0%BF%D1%96%D1%8F.js.map
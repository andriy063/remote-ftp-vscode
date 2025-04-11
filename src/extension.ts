import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';

interface RemoteHost {
    name: string;
    protocol: 'ftp' | 'sftp';
    host: string;
    port: number;
    username: string;
    password: string;
    remotePath: string;
    localPath: string;
    ignoreExtensions: string[];
}

type TreeItem = RemoteHost | RemoteFileItem;

interface RemoteFileItem {
    type: 'file' | 'directory';
    name: string;
    path: string;
    parentHost: RemoteHost;
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new RemoteFTPProvider();
    vscode.window.registerTreeDataProvider('remote-ftp-vscode', provider);

    context.subscriptions.push(
        vscode.commands.registerCommand('remoteFtp.refresh', () => provider.refresh()),
        vscode.commands.registerCommand('remoteFtp.openFile', item => provider.openRemoteFile(item)),
        vscode.commands.registerCommand('remoteFtp.download', item => provider.downloadToLocal(item)),
        vscode.commands.registerCommand('remoteFtp.newFile', item => provider.createNewFile(item)),
        vscode.commands.registerCommand('remoteFtp.newFolder', item => provider.createNewFolder(item)),
        vscode.commands.registerCommand('remoteFtp.uploadFiles', item => provider.uploadFiles(item)),
        vscode.commands.registerCommand('remoteFtp.uploadFolder', item => provider.uploadFolder(item)),
        vscode.commands.registerCommand('remoteFtp.changePermissions', item => provider.changePermissions(item)),
        vscode.commands.registerCommand('remoteFtp.deleteRemoteFile', item => provider.deleteRemoteFile(item)),
        vscode.commands.registerCommand('remoteFtp.copyRemotePath', item => provider.copyRemotePathToClipboard(item)),
        vscode.workspace.onDidSaveTextDocument(doc => provider.uploadEditedFile(doc))
    );
}

// ...

class RemoteFTPProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
    onDidChangeTreeData = this._onDidChangeTreeData.event;

    private hosts: RemoteHost[] = [];
    private readonly tmpDir = path.join(os.tmpdir(), '.remote-ftp-tmp');
    private fileMap = new Map<string, RemoteFileItem>();

    constructor() {
        this.loadConfig();
        if (!fs.existsSync(this.tmpDir)) fs.mkdirSync(this.tmpDir, { recursive: true });
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
            this.hosts = config.hosts as RemoteHost[];
        } catch (e) {
            vscode.window.showErrorMessage('Failed to read config.json');
            this.hosts = [];
        }
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        if ('protocol' in element) {
            return {
                label: element.name,
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                iconPath: new vscode.ThemeIcon('server'),
                id: element.name
            };
        }

        const item = new vscode.TreeItem(
            element.name,
            element.type === 'directory'
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        item.iconPath = new vscode.ThemeIcon(
            element.type === 'directory' ? 'folder' : 'file-code'
        );

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

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        if (!element) return this.hosts;
        if ('protocol' in element) return await this.getRemoteFiles(element, element.remotePath);
        if (element.type === 'directory') return await this.getRemoteFiles(element.parentHost, element.path);
        return [];
    }

    private async getRemoteFiles(host: RemoteHost, remotePath: string): Promise<RemoteFileItem[]> {
        const list: RemoteFileItem[] = [];

        try {
            if (host.protocol === 'ftp') {
                const client = new FtpClient();
                await client.access({
                    host: host.host,
                    port: host.port,
                    user: host.username,
                    password: host.password
                });

                const entries = await client.list(remotePath);
                for (const e of entries) {
                    if (e.type === 1 && host.ignoreExtensions.includes(path.extname(e.name))) continue;
                    list.push({
                        type: e.type === 2 ? 'directory' : 'file',
                        name: e.name,
                        path: path.posix.join(remotePath, e.name),
                        parentHost: host
                    });
                }

                client.close();
            } else {
                const client = new SftpClient();
                await client.connect({
                    host: host.host,
                    port: host.port,
                    username: host.username,
                    password: host.password
                });

                const entries = await client.list(remotePath);
                for (const e of entries) {
                    if (e.type === '-' && host.ignoreExtensions.includes(path.extname(e.name))) continue;
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
                if (a.type === 'directory' && b.type === 'file') return -1;
                if (a.type === 'file' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to read directory: ${remotePath}`);
        }

        return list;
    }


    async openRemoteFile(item: RemoteFileItem) {
        const tmpPath = path.join(this.tmpDir, `${item.parentHost.name}__${item.name}`);

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Opening: ${item.name}`,
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Connecting...' });

                if (item.parentHost.protocol === 'ftp') {
                    const client = new FtpClient();
                    await client.access({
                        host: item.parentHost.host,
                        port: item.parentHost.port,
                        user: item.parentHost.username,
                        password: item.parentHost.password
                    });
                    progress.report({ message: 'Downloading...' });
                    await client.downloadTo(tmpPath, item.path);
                    client.close();
                } else {
                    const client = new SftpClient();
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
        } catch (e) {
            vscode.window.showErrorMessage(`❌ Failed to open ${item.name}`);
            console.error(e);
        }
    }

    async uploadEditedFile(doc: vscode.TextDocument) {
        let item = this.fileMap.get(doc.fileName);

        if (!item) {
            try {
                const meta = JSON.parse(doc.uri.query);
                const host = this.hosts.find(h => h.name === meta.host);
                if (!host) return;

                item = {
                    name: path.basename(meta.path),
                    path: meta.path,
                    parentHost: host,
                    type: 'file'
                };
                this.fileMap.set(doc.fileName, item);
            } catch {
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
                    const client = new FtpClient();
                    await client.access({
                        host: item.parentHost.host,
                        port: item.parentHost.port,
                        user: item.parentHost.username,
                        password: item.parentHost.password
                    });
                    await client.uploadFrom(doc.fileName, item.path);
                    client.close();
                } else {
                    const client = new SftpClient();
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

                
                await this.downloadToLocal(item!);
                await this.createBackup(item!);
            } catch (e) {
                vscode.window.showErrorMessage(`❌ Failed to upload ${item.name}`);
                console.error(e);
            }
        });
    }

    async downloadToLocal(item: RemoteFileItem) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
    
        const localBase = path.resolve(workspaceRoot, item.parentHost.localPath);
        const remoteRoot = item.parentHost.remotePath;
        const hostFolder = path.join(localBase, item.parentHost.name); // Підпапка хоста
    
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `📥 Downloading ${item.name}`,
            cancellable: false
        }, async () => {
            try {
                if (item.type === 'file') {
                    const relative = path.posix.relative(remoteRoot, item.path);
                    const localTarget = path.resolve(hostFolder, relative.replace(/\//g, path.sep));
                    await this.downloadSingleFile(item, localTarget);
                } else {
                    await this.downloadDirectory(item, item.path, hostFolder, remoteRoot);
                }
    
                vscode.window.showInformationMessage(`✅ Downloaded: ${item.name}`);
            } catch (e) {
                vscode.window.showErrorMessage(`❌ Failed to download ${item.name}`);
                console.error(e);
            }
        });
    }
    

    private async downloadDirectory(
        rootItem: RemoteFileItem,
        remoteDir: string,
        localBase: string,
        remoteRoot: string
    ) {
        const list = await this.getRemoteFiles(rootItem.parentHost, remoteDir);

        for (const item of list) {
            const relative = path.posix.relative(remoteRoot, item.path);
            const localTarget = path.resolve(localBase, relative.replace(/\//g, path.sep));

            if (item.type === 'directory') {
                await this.downloadDirectory(item, item.path, localBase, remoteRoot);
            } else {
                await this.downloadSingleFile(item, localTarget);
            }
        }
    }

    private async downloadSingleFile(item: RemoteFileItem, localTarget: string): Promise<void> {
        const exists = fs.existsSync(localTarget);
        const stats = exists ? fs.statSync(localTarget) : null;

        if (exists && stats?.isFile()) {
            let remoteSize = -1;
            if (item.parentHost.protocol === 'ftp') {
                const client = new FtpClient();
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
            } else {
                const client = new SftpClient();
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

            if (remoteSize === stats.size) return;
        }

        fs.mkdirSync(path.dirname(localTarget), { recursive: true });

        if (item.parentHost.protocol === 'ftp') {
            const client = new FtpClient();
            await client.access({
                host: item.parentHost.host,
                port: item.parentHost.port,
                user: item.parentHost.username,
                password: item.parentHost.password
            });
            await client.downloadTo(localTarget, item.path);
            client.close();
        } else {
            const client = new SftpClient();
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


    async createNewFile(item: RemoteFileItem) {
        const name = await vscode.window.showInputBox({ prompt: 'Enter new file name' });
        if (!name) return;
        const remotePath = path.posix.join(item.path, name);
    
        if (item.parentHost.protocol === 'ftp') {
            const client = new FtpClient();
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
        } else {
            const client = new SftpClient();
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
    

    async createNewFolder(item: RemoteFileItem) {
        const name = await vscode.window.showInputBox({ prompt: 'Enter new folder name' });
        if (!name) return;
        const remotePath = path.posix.join(item.path, name);

        if (item.parentHost.protocol === 'ftp') {
            const client = new FtpClient();
            await client.access({
                host: item.parentHost.host,
                port: item.parentHost.port,
                user: item.parentHost.username,
                password: item.parentHost.password
            });
            await client.ensureDir(remotePath);
            client.close();
        } else {
            const client = new SftpClient();
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

    async uploadFiles(item: RemoteFileItem) {
        const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: true });
        if (!uris) return;

        const remoteDir = item.path;

        if (item.parentHost.protocol === 'ftp') {
            const client = new FtpClient();
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
        } else {
            const client = new SftpClient();
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

    async uploadFolder(item: RemoteFileItem) {
        const folderUri = await vscode.window.showOpenDialog({ canSelectFolders: true });
        if (!folderUri || folderUri.length === 0) return;

        const folderPath = folderUri[0].fsPath;
        const baseName = path.basename(folderPath);
        const remoteBase = path.posix.join(item.path, baseName);

        const walk = (dir: string): string[] => {
            return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
                const full = path.join(dir, entry.name);
                return entry.isDirectory() ? walk(full) : [full];
            });
        };

        const files = walk(folderPath);

        if (item.parentHost.protocol === 'ftp') {
            const client = new FtpClient();
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
        } else {
            const client = new SftpClient();
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
                await client.mkdir(remoteDir, true).catch(() => {});
                await client.fastPut(file, remoteFilePath);
            }
            client.end();
        }

        this.refresh();
    }

    async changePermissions(item: RemoteFileItem) {
        const mode = await vscode.window.showInputBox({
            prompt: 'Enter chmod value (e.g. 755)',
            validateInput: val => /^\d{3}$/.test(val) ? null : 'Must be a 3-digit number'
        });
        if (!mode) return;

        if (item.parentHost.protocol === 'ftp') {
            vscode.window.showErrorMessage('Changing permissions not supported over FTP');
            return;
        }

        const client = new SftpClient();
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

    async deleteRemoteFile(item: RemoteFileItem) {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete ${item.name}?`,
            { modal: true },
            'Yes',
            'Cancel'
        );
        if (confirm !== 'Yes') return;
    
        try {
            if (item.parentHost.protocol === 'ftp') {
                const client = new FtpClient();
                await client.access({
                    host: item.parentHost.host,
                    port: item.parentHost.port,
                    user: item.parentHost.username,
                    password: item.parentHost.password
                });
    
                if (item.type === 'directory') {
                    await client.removeDir(item.path); // Видаляємо папку
                } else {
                    await client.remove(item.path); // Видаляємо файл
                }
    
                client.close();
            } else {
                const client = new SftpClient();
                await client.connect({
                    host: item.parentHost.host,
                    port: item.parentHost.port,
                    username: item.parentHost.username,
                    password: item.parentHost.password
                });
    
                if (item.type === 'directory') {
                    await client.rmdir(item.path, true); // Видаляємо папку
                } else {
                    await client.delete(item.path); // Видаляємо файл
                }
    
                client.end();
            }
    
            // Видалення локального відповідника
            const localPath = path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', item.parentHost.localPath, item.parentHost.name, item.name);
            if (fs.existsSync(localPath)) {
                if (item.type === 'directory') {
                    fs.rmdirSync(localPath, { recursive: true });
                } else {
                    fs.unlinkSync(localPath);
                }
            }
    
            vscode.window.showInformationMessage(`✅ ${item.name} deleted`);
            this.refresh();
        } catch (e) {
            vscode.window.showErrorMessage(`❌ Failed to delete ${item.name}`);
            console.error(e);
        }
    }
    

    async copyRemotePathToClipboard(item: RemoteFileItem) {
        await vscode.env.clipboard.writeText(item.path);
        vscode.window.showInformationMessage(`✅ Copied remote path: ${item.path}`);
    }

    async createBackup(item: RemoteFileItem) {
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
            } else {
                vscode.window.showErrorMessage(`❌ Local file does not exist: ${localFilePath}`);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`❌ Failed to create backup for ${item.name}`);
            console.error(e);
        }
    }
    
    getFileNameWithDate(item: RemoteFileItem): string {
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
    
    
}

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Client as FtpClient, FileInfo as FtpFile } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";

/* ------------------------------------------------------------------
 *  Types
 * ---------------------------------------------------------------- */
interface RemoteItemData {
  host: string;
  fullPath: string;
  isDir: boolean;
}

type RemoteClient = FtpClient | SftpClient;

interface HostConfig {
  protocol: "ftp" | "sftp";
  host: string;
  port?: number;
  username: string;
  password?: string;
  private_key?: string;
  remote_path?: string;
  workers?: number;
  retry?: number;
  timeoutMs?: number;
}

/* ------------------------------------------------------------------
 *  Connection Pool - управління з'єднаннями з автоматичним recovery
 * ---------------------------------------------------------------- */
class ConnectionPool {
  private pools = new Map < string, RemoteClient[]> ();
  private connecting = new Map < string, Promise < void>> ();
  private maxPerHost = 3; // максимум з'єднань на хост

  /**
   * Отримує живе з'єднання або створює нове
   */
  async acquire(host: string, cfg: HostConfig): Promise < RemoteClient > {
  // Перевіряємо чи є живі з'єднання в пулі
  const pool = this.pools.get(host) || [];

  for(let i = pool.length - 1; i >= 0; i--) {
  const client = pool[i];
  if (await this.isAlive(client, cfg.protocol)) {
    // Видаляємо з пулу (borrowing pattern)
    pool.splice(i, 1);
    return client;
  } else {
    // Видаляємо мертве з'єднання
    pool.splice(i, 1);
    await this.safeDisconnect(client);
  }
}

// Немає живих - створюємо нове
return await this.createConnection(host, cfg);
  }

  /**
   * Повертає з'єднання назад в пул
   */
  async release(host: string, client: RemoteClient, protocol: "ftp" | "sftp") {
  const pool = this.pools.get(host) || [];

  // Перевіряємо чи живе перед поверненням
  if (await this.isAlive(client, protocol)) {
    // Обмежуємо розмір пулу
    if (pool.length < this.maxPerHost) {
      pool.push(client);
      this.pools.set(host, pool);
      return;
    }
  }

  // Якщо пул переповнений або клієнт мертвий - закриваємо
  await this.safeDisconnect(client);
}

  /**
   * Перевіряє чи живе з'єднання
   */
  private async isAlive(client: RemoteClient, protocol: "ftp" | "sftp"): Promise < boolean > {
  try {
    if(protocol === "ftp") {
  const ftpClient = client as FtpClient;
  const sock = (ftpClient as any)?.ftp?.socket;
  if (!sock || sock.destroyed || !sock.readable || !sock.writable) {
    return false;
  }
  // Простий тест: pwd
  await Promise.race([
    ftpClient.pwd(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 3000)
    )
  ]);
  return true;
} else {
  const sftpClient = client as SftpClient;
  // SFTP не має простого способу перевірки, тому перевіряємо внутрішній стан
  const sftp = (sftpClient as any).sftp;
  const client_internal = (sftpClient as any).client;

  if (!sftp || !client_internal) return false;

  // Перевіряємо чи не закритий SSH клієнт
  const sock = (client_internal as any)?._sock;
  if (!sock || sock.destroyed || sock.readableEnded) {
    return false;
  }

  return true;
}
    } catch {
  return false;
}
  }

  /**
   * Створює нове з'єднання (з дедуплікацією)
   */
  private async createConnection(host: string, cfg: HostConfig): Promise < RemoteClient > {
  // Дедуплікація: якщо вже підключаємось - чекаємо
  const key = `${host}-connect`;
  let inFlight = this.connecting.get(key);

  if(!inFlight) {
    inFlight = (async () => {
      const client = await this.doConnect(cfg);
      // Одразу після створення додаємо в пул
      const pool = this.pools.get(host) || [];
      pool.push(client);
      this.pools.set(host, pool);
    })();
    this.connecting.set(key, inFlight);
  }

    try {
    await inFlight;
    // Беремо щойно створене з'єднання
    const pool = this.pools.get(host)!;
    return pool.pop()!;
  } finally {
    this.connecting.delete(key);
  }
}

  /**
   * Низькорівневе підключення
   */
  private async doConnect(cfg: HostConfig): Promise < RemoteClient > {
  if(cfg.protocol === "sftp") {
  const c = new SftpClient();
  await c.connect({
    host: cfg.host,
    port: cfg.port ?? 22,
    username: cfg.username,
    password: cfg.password,
    privateKey: cfg.private_key && fs.readFileSync(cfg.private_key),
    keepaliveInterval: 10000,
    readyTimeout: cfg.timeoutMs ?? 30000
  });
  return c;
} else {
  const c = new FtpClient();
  await c.access({
    host: cfg.host,
    port: cfg.port ?? 21,
    user: cfg.username,
    password: cfg.password,
  });
  return c;
}
  }

  /**
   * Безпечне відключення
   */
  async safeDisconnect(client: RemoteClient) {
  try {
    if (client instanceof SftpClient) {
      await client.end();
    } else {
      await (client as FtpClient).close();
    }
  } catch {
    // ігноруємо помилки при закритті
  }
}

  /**
   * Очищення всіх з'єднань
   */
  async closeAll() {
  for (const pool of this.pools.values()) {
    for (const client of pool) {
      await this.safeDisconnect(client);
    }
  }
  this.pools.clear();
  this.connecting.clear();
}

  /**
   * Видалення всіх з'єднань для конкретного хоста
   */
  async closeHost(host: string) {
  const pool = this.pools.get(host);
  if (pool) {
    for (const client of pool) {
      await this.safeDisconnect(client);
    }
    this.pools.delete(host);
  }
}
}

const connectionPool = new ConnectionPool();

/**
 * Wrapper для операцій з автоматичним retry при падінні з'єднання
 */
async function withConnection<T>(
  host: string,
  cfg: HostConfig,
  operation: (client: RemoteClient) => Promise<T>,
  token?: vscode.CancellationToken
): Promise<T> {
  const maxAttempts = cfg.retry ?? 3;
  let lastError: any;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    let client: RemoteClient | undefined;

    try {
      // Беремо з'єднання з пулу
      client = await connectionPool.acquire(host, cfg);

      // Виконуємо операцію з timeout
      const result = await Promise.race([
        operation(client),
        new Promise < never > ((_, reject) =>
          setTimeout(() => reject(new Error("Operation timeout")), cfg.timeoutMs ?? 30000)
        )
      ]);

      // Успіх - повертаємо клієнта в пул
      await connectionPool.release(host, client, cfg.protocol);
      return result;

    } catch (error) {
      lastError = error;

      // Якщо з'єднання впало - не повертаємо його в пул
      if (client) {
        await connectionPool.safeDisconnect(client);
      }

      // Якщо це cancellation - одразу кидаємо
      if (error instanceof vscode.CancellationError) {
        throw error;
      }

      // Інакше - чекаємо перед retry
      if (attempt < maxAttempts - 1) {
        await wait(500 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

/* ------------------------------------------------------------------
 *  Global state
 * ---------------------------------------------------------------- */
const rsftp: Record<string, unknown> = {};
const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir();

// Дебаунс для запобігання подвійного відкриття файлів
const openFileDebounce = new Map < string, number> ();

// Status bar для upload статусу
let uploadStatusBar: vscode.StatusBarItem;

class RemoteSftpProvider implements vscode.TreeDataProvider<RemoteItem> {
  private emitter = new vscode.EventEmitter < RemoteItem | undefined > ();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(item?: RemoteItem): void {
    this.emitter.fire(item);
  }

  getTreeItem = (e: RemoteItem) => e;

  async getChildren(element?: RemoteItem): Promise<RemoteItem[]> {
    const cfg = getConfig();
    if (!cfg || typeof cfg.hosts !== "object") return [];

    if (!element) {
      return Object.keys(cfg.hosts)
        .sort()
        .map(
          (h) =>
            new RemoteItem(h, vscode.TreeItemCollapsibleState.Collapsed, "host", {
              host: h,
              fullPath: cfg.hosts[h].remote_path ?? "/",
              isDir: true,
            })
        );
    }

    if (element.type === "host" || element.type === "dir") {
      const hostCfg = cfgFor(element.data.host);
      return await withConnection(
        element.data.host,
        hostCfg,
        (client) => listRemote(client, element.data.fullPath, element.data.host)
      );
    }

    return [];
  }
}

const provider = new RemoteSftpProvider();

/* ------------------------------------------------------------------
 *  Tree item
 * ---------------------------------------------------------------- */
class RemoteItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    state: vscode.TreeItemCollapsibleState,
    public readonly type: "host" | "dir" | "file",
    public readonly data: RemoteItemData
  ) {
    super(label, state);
    this.contextValue = type;

    const uriPath = data.fullPath.startsWith("/") ? data.fullPath : `/${data.fullPath}`;
    this.resourceUri = vscode.Uri.parse(uriPath).with({
      scheme: "rsftp",
      authority: data.host,
    });

    if (type === "file") {
      this.command = {
        command: "remote-sftp.openFile",
        title: "Open",
        arguments: [this],
      };
    }
  }
}

/* ------------------------------------------------------------------
 *  Activate / deactivate
 * ---------------------------------------------------------------- */
export function activate(ctx: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.show();

  // Status bar для upload
  uploadStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  uploadStatusBar.show();

  const tree = vscode.window.createTreeView("remote_sftp", { treeDataProvider: provider });

  tree.onDidExpandElement(async (e) => {
    provider.refresh(e.element);
  });

  ctx.subscriptions.push(
    statusBar,
    uploadStatusBar,
    vscode.commands.registerCommand("remote-sftp.reload", () =>
      vscode.commands.executeCommand("workbench.action.reloadWindow")
    ),
    vscode.commands.registerCommand("remote-sftp.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:andriy063.remote-ftp-vscode"
      )
    ),
    vscode.commands.registerCommand("remote-sftp.openFile", openFileCommand),
    vscode.commands.registerCommand("remote-sftp.download", downloadCommand),
    vscode.commands.registerCommand("remote-sftp.uploadFile", uploadFileCommand),
    vscode.commands.registerCommand("remote-sftp.uploadFolder", uploadFolderCommand),
    vscode.commands.registerCommand("remote-sftp.delete", deleteCommand),
    vscode.commands.registerCommand("remote-sftp.rename", renameCommand),
    vscode.commands.registerCommand("remote-sftp.createFile", createFileCommand),
    vscode.commands.registerCommand("remote-sftp.createFolder", createFolderCommand),
    vscode.commands.registerCommand("remote-sftp.chmod", chmodCommand),
    vscode.commands.registerCommand("remote-sftp.copyRemotePath", copyRemotePathToClipboard),
    vscode.workspace.onDidSaveTextDocument(handleSave),
    vscode.window.onDidChangeTextEditorSelection(event => {
      const editor = event.textEditor;
      const selection = editor.selection;
      const text = editor.document.getText(selection);

      if (text && !text.includes('\n')) {
        const fullText = editor.document.getText();
        const regex = new RegExp(escapeRegExp(text), 'g');
        const matches = fullText.match(regex);
        const count = matches ? matches.length : 0;
        statusBar.text = `🔍 '${text}': ${count}`;
      } else {
        statusBar.text = '';
      }
    })
  );
}

export async function deactivate(): Promise<void> {
  await connectionPool.closeAll();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------
 *  Commands
 * ---------------------------------------------------------------- */

async function copyRemotePathToClipboard(item: RemoteItem) {
  await vscode.env.clipboard.writeText(item.data.fullPath);
  vscode.window.showInformationMessage(`✅ Copied remote path: ${item.data.fullPath}`);
}

async function chmodCommand(item: RemoteItem) {
  const chmodValue = await vscode.window.showInputBox({
    prompt: `Enter new permissions for '${item.label}'`,
    placeHolder: "e.g. 755"
  });

  if (!chmodValue) return;

  const cfg = cfgFor(item.data.host);

  await withConnection(item.data.host, cfg, async (client) => {
    if (item.type === "file" || item.type === "dir") {
      if (client instanceof SftpClient) {
        await client.chmod(item.data.fullPath, parseInt(chmodValue, 8));
      } else if (client instanceof FtpClient) {
        const chmodCommand = `SITE CHMOD ${chmodValue} ${item.data.fullPath}`;
        await client.send(chmodCommand);
      }
    }
  });

  provider.refresh(item);
  vscode.window.showInformationMessage(`Permissions changed for '${item.label}'`);
}

async function renameCommand(item: RemoteItem) {
  const oldRemote = item.data.fullPath;
  const oldName = path.posix.basename(oldRemote);
  const newName = await vscode.window.showInputBox({
    prompt: `Rename '${oldName}' to...`,
    value: oldName
  });
  if (!newName || newName === oldName) return;

  const cfg = cfgFor(item.data.host);
  const parent = path.posix.dirname(oldRemote);
  const newRemote = path.posix.join(parent, newName);

  await withConnection(item.data.host, cfg, async (client) => {
    if (client instanceof SftpClient) {
      await client.rename(oldRemote, newRemote);
    } else {
      await (client as FtpClient).rename(oldRemote, newRemote);
    }
  });

  const oldLocal = toLocalPath(item.data.host, oldRemote);
  const newLocal = toLocalPath(item.data.host, newRemote);
  await fs.promises.mkdir(path.dirname(newLocal), { recursive: true });
  await fs.promises.rename(oldLocal, newLocal).catch(() => { });

  provider.refresh();
  vscode.window.showInformationMessage(`Renamed to '${newName}'`);
}

async function createFileCommand(item: RemoteItem) {
  const name = await vscode.window.showInputBox({
    prompt: `Enter new file name in '${item.label}'`,
    placeHolder: "e.g. index.php"
  });
  if (!name) return;

  const remotePath = path.posix.join(item.data.fullPath, name);
  const cfg = cfgFor(item.data.host);
  const tmpFile = path.join(os.tmpdir(), `rsftp-temp-${Date.now()}`);
  fs.writeFileSync(tmpFile, "");

  try {
    await withConnection(item.data.host, cfg, async (client) => {
      if (cfg.protocol === "ftp") {
        await (client as FtpClient).uploadFrom(tmpFile, remotePath);
      } else {
        await (client as SftpClient).put(Buffer.alloc(0), remotePath);
      }
    });

    // Оновлюємо дерево
    provider.refresh(item);

    // Завантажуємо файл локально і відкриваємо
    const localPath = toLocalPath(item.data.host, remotePath);

    await withConnection(item.data.host, cfg, async (client) => {
      await ensureDir(localPath);
      if (client instanceof SftpClient) {
        await client.fastGet(remotePath, localPath);
      } else {
        await client.downloadTo(localPath, remotePath);
      }
    });

    // Створюємо бекап
    await createBackup(localPath, remotePath, item.data.host);

    // Відкриваємо файл в редакторі
    const doc = await vscode.workspace.openTextDocument(localPath);
    await vscode.window.showTextDocument(doc, { preview: false });

    vscode.window.showInformationMessage(`Created and opened file '${name}'`);

  } catch (error) {
    vscode.window.showErrorMessage(`Failed to create file '${name}': ${error}`);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function createFolderCommand(item: RemoteItem) {
  const folderName = await vscode.window.showInputBox({
    prompt: `New folder name in '${item.label}'`,
    placeHolder: "e.g. assets"
  });
  if (!folderName) return;

  const cfg = cfgFor(item.data.host);
  const remoteDir = path.posix.join(item.data.fullPath, folderName);

  await withConnection(item.data.host, cfg, async (client) => {
    if (client instanceof SftpClient) {
      await client.mkdir(remoteDir, true);
    } else {
      await (client as FtpClient).ensureDir(remoteDir);
    }
  });

  provider.refresh(item);
  vscode.window.showInformationMessage(`Created folder '${folderName}'`);
}

async function deleteCommand(item: RemoteItem) {
  const confirm = await vscode.window.showWarningMessage(
    `Delete remote ${item.type} '${item.label}' and its local copy?`,
    { modal: true },
    "Yes"
  );
  if (confirm !== "Yes") return;

  vscode.window.showInformationMessage(`Deleting started...`);

  const cfg = cfgFor(item.data.host);
  const remote = item.data.fullPath;

  await withConnection(item.data.host, cfg, async (client) => {
    if (item.type === "file") {
      if (client instanceof SftpClient) {
        await client.delete(remote);
      } else {
        await client.remove(remote);
      }
    } else {
      if (client instanceof SftpClient) {
        try {
          await (client as any).rmdir(remote, true);
        } catch {
          await (client as any).rmdir(remote, { recursive: true });
        }
      } else {
        await (client as FtpClient).removeDir(remote);
      }
    }
  });

  const local = toLocalPath(item.data.host, remote);
  try {
    const stat = await fs.promises.stat(local);
    if (stat.isDirectory()) {
      await fs.promises.rm(local, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(local);
    }
  } catch { }

  provider.refresh();
  vscode.window.showInformationMessage(`Deleted ${item.type} '${item.label}'`);
}

async function uploadFileCommand(item: RemoteItem) {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    defaultUri: vscode.Uri.file(workspaceRoot),
    openLabel: "Select file(s) to upload"
  });
  if (!uris) return;

  const cfg = cfgFor(item.data.host);
  const remoteDir = item.data.fullPath;

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Uploading ${uris.length} file(s)…`,
    cancellable: true
  }, async (progress, token) => {
    let done = 0;
    for (const uri of uris) {
      const local = uri.fsPath;
      const remote = path.posix.join(remoteDir, path.basename(local));

      await withConnection(item.data.host, cfg, async (client) => {
        await ensureRemoteDir(client, path.posix.dirname(remote));
        if (client instanceof SftpClient) {
          await client.fastPut(local, remote);
        } else {
          await client.uploadFrom(local, remote);
        }
      }, token);

      progress.report({ message: `${++done}/${uris.length}` });
    }
  });

  vscode.window.showInformationMessage(`Uploaded ${uris.length} file(s) → ${remoteDir}`);
  provider.refresh(item);
}

async function uploadFolderCommand(item: RemoteItem) {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    defaultUri: vscode.Uri.file(workspaceRoot),
    openLabel: "Select folder(s) to upload"
  });
  if (!uris || uris.length === 0) return;

  const jobs: { local: string; remote: string }[] = [];
  const cfg = cfgFor(item.data.host);
  const remoteBase = item.data.fullPath;

  for (const uri of uris) {
    const rootPath = uri.fsPath;
    const rootName = path.basename(rootPath);
    const files = await collectLocalFiles(rootPath, new vscode.CancellationTokenSource().token);
    for (const local of files) {
      const rel = path.relative(rootPath, local).split(path.sep).join("/");
      const remote = path.posix.join(remoteBase, rootName, rel);
      jobs.push({ local, remote });
    }
  }

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Uploading ${jobs.length} file(s)…`,
    cancellable: true
  }, async (progress, token) => {
    let done = 0;
    for (const { local, remote } of jobs) {
      await withConnection(item.data.host, cfg, async (client) => {
        await ensureRemoteDir(client, path.posix.dirname(remote));
        if (client instanceof SftpClient) {
          await client.fastPut(local, remote);
        } else {
          await client.uploadFrom(local, remote);
        }
      }, token);

      progress.report({ message: `${++done}/${jobs.length}` });
    }
  });

  vscode.window.showInformationMessage(`Uploaded ${jobs.length} files into ${item.data.host}:${remoteBase}`);
  provider.refresh(item);
}

async function openFileCommand(item: RemoteItem) {
  if (item.type !== "file") return;

  // Дебаунс: якщо файл відкривали менше ніж 300мс тому - ігноруємо
  const fileKey = `${item.data.host}:${item.data.fullPath}`;
  const lastOpen = openFileDebounce.get(fileKey) || 0;
  const now = Date.now();

  if (now - lastOpen < 300) {
    return; // Ігноруємо повторний виклик
  }

  openFileDebounce.set(fileKey, now);

  const cfg = cfgFor(item.data.host);
  const local = toLocalPath(item.data.host, item.data.fullPath);

  await withConnection(item.data.host, cfg, async (client) => {
    await ensureDir(local);
    if (client instanceof SftpClient) {
      await client.fastGet(item.data.fullPath, local);
    } else {
      await client.downloadTo(local, item.data.fullPath);
    }
  });

  await createBackup(local, item.data.fullPath, item.data.host);

  const doc = await vscode.workspace.openTextDocument(local);
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function downloadCommand(item: RemoteItem) {
  const cfg = cfgFor(item.data.host);
  const workers = cfg.workers ?? 4;
  const baseLocal = toLocalPath(item.data.host, item.data.fullPath);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading ${item.label}…`,
      cancellable: true
    },
    async (progress, token) => {
      if (item.type === "file") {
        await withConnection(item.data.host, cfg, async (client) => {
          await ensureDir(baseLocal);
          if (client instanceof SftpClient) {
            await client.fastGet(item.data.fullPath, baseLocal);
          } else {
            await client.downloadTo(baseLocal, item.data.fullPath);
          }
        }, token);
        return;
      }

      progress.report({ message: "Scanning 0 files…" });

      const files = await withConnection(item.data.host, cfg, async (client) => {
        return await collectRemoteFiles(
          client,
          item.data.fullPath,
          token,
          (count) => progress.report({ message: `Scanning ${count} files…` })
        );
      }, token);

      progress.report({ message: `Found ${files.length} files` });

      await downloadMany(
        { host: item.data.host, cfg },
        files,
        workers,
        token,
        (d, t) => progress.report({ message: `Downloading… ${d}/${t}` })
      );
    }
  );

  vscode.window.showInformationMessage(`Downloaded → ${baseLocal}`);
}

async function handleSave(doc: vscode.TextDocument) {
  const rel = path.relative(workspaceRoot, doc.fileName);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  const [host, ...rest] = rel.split(path.sep);
  if (!host || rest.length === 0) return;

  const cfg = cfgFor(host);
  const remotePath = "/" + rest.join("/");
  const localPath = doc.fileName;

  await createBackup(localPath, remotePath, host);

  // Показуємо статус "Uploading..."
  uploadStatusBar.text = "$(sync~spin) Uploading...";
  uploadStatusBar.tooltip = remotePath;

  try {
    await withConnection(host, cfg, async (client) => {
      await ensureRemoteDir(client, path.posix.dirname(remotePath));
      if (client instanceof SftpClient) {
        await client.fastPut(localPath, remotePath);
      } else {
        await client.uploadFrom(localPath, remotePath);
      }
    });

    // Успіх
    uploadStatusBar.text = "$(check) Uploaded";
    uploadStatusBar.tooltip = remotePath;

    // Ховаємо через 5 секунд
    setTimeout(() => {
      uploadStatusBar.text = "";
      uploadStatusBar.tooltip = "";
    }, 5000);

  } catch (e) {
    // Помилка
    uploadStatusBar.text = "$(error) Upload failed";
    uploadStatusBar.tooltip = `${remotePath}\n${e}`;

    // Ховаємо через 5 секунд
    setTimeout(() => {
      uploadStatusBar.text = "";
      uploadStatusBar.tooltip = "";
    }, 5000);
  }
}

/* ------------------------------------------------------------------
 *  Helpers
 * ---------------------------------------------------------------- */

async function createBackup(localFilePath: string, remotePath: string, host: string) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const backupFolder = path.join(workspaceRoot, 'rsftpbackups', host);
  const relativePath = path.relative(workspaceRoot, localFilePath);
  const backupFilePath = path.join(backupFolder, relativePath);
  const backupDir = path.dirname(backupFilePath);

  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const fileNameWithDate = getFileNameWithDate(localFilePath);
    const backupPath = path.join(backupDir, fileNameWithDate);

    if (fs.existsSync(localFilePath)) {
      fs.copyFileSync(localFilePath, backupPath);
    }
  } catch (e) {
    console.error(e);
  }
}

function getFileNameWithDate(localFilePath: string): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  const fileNameWithoutExt = path.basename(localFilePath, path.extname(localFilePath));
  const newFileName = `${fileNameWithoutExt}-${day}-${month}-${year}-${hours}-${minutes}-${seconds}${path.extname(localFilePath)}`;

  return newFileName;
}

function wait(ms: number) {
  return new Promise < void> ((r) => setTimeout(r, ms));
}

async function ensureRemoteDir(client: RemoteClient, remoteDir: string): Promise<void> {
  if (client instanceof SftpClient) {
    await client.mkdir(remoteDir, true);
  } else {
    await (client as FtpClient).ensureDir(remoteDir);
  }
}

async function downloadMany(
  hostCfg: { host: string; cfg: HostConfig },
  list: string[],
  workers: number,
  token: vscode.CancellationToken,
  onProgress: (done: number, total: number) => void
) {
  let done = 0;
  const queue = [...list];

  const worker = async () => {
    while (queue.length && !token.isCancellationRequested) {
      const remote = queue.pop()!;
      const local = toLocalPath(hostCfg.host, remote);

      await withConnection(hostCfg.host, hostCfg.cfg, async (client) => {
        await ensureDir(local);
        if (client instanceof SftpClient) {
          await client.fastGet(remote, local);
        } else {
          await client.downloadTo(local, remote);
        }
      }, token);

      onProgress(++done, list.length);
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  if (token.isCancellationRequested) throw new vscode.CancellationError();
}

async function collectRemoteFiles(
  client: RemoteClient,
  startDir: string,
  token: vscode.CancellationToken,
  onProgress: (foundFiles: number) => void
): Promise<string[]> {
  const stack: string[] = [startDir];
  const files: string[] = [];
  onProgress(0);

  while (stack.length) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const dir = stack.pop()!;
    const items = await listRemote(client, dir, "#");
    for (const it of items) {
      if (it.type === "file") {
        files.push(it.data.fullPath);
        onProgress(files.length);
      } else {
        stack.push(it.data.fullPath);
      }
    }
  }

  return files;
}

async function collectLocalFiles(
  startDir: string,
  token: vscode.CancellationToken
): Promise<string[]> {
  const stack = [startDir];
  const files: string[] = [];

  while (stack.length) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const dir = stack.pop()!;
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(dir, e.name);
      e.isDirectory() ? stack.push(full) : files.push(full);
    }
  }
  return files;
}

function cfgFor(host: string): HostConfig {
  return (getConfig()?.hosts?.[host] as HostConfig) ?? {};
}

async function listRemote(
  client: RemoteClient,
  dir: string,
  host: string
): Promise<RemoteItem[]> {
  const ents: { name: string; isDir: boolean }[] = [];

  if (client instanceof SftpClient) {
    (await client.list(dir)).forEach((e) =>
      ents.push({ name: e.name, isDir: e.type === "d" })
    );
  } else {
    (await client.list(dir)).forEach((e: FtpFile) =>
      ents.push({
        name: e.name,
        isDir: (e as any).isDirectory ?? e.type === 1,
      })
    );
  }

  ents.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  );

  return ents.map(
    ({ name, isDir }) =>
      new RemoteItem(
        (isDir ? "" : "  ") + name,
        isDir
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
        isDir ? "dir" : "file",
        { host, fullPath: path.posix.join(dir, name), isDir }
      )
  );
}

function toLocalPath(host: string, remote: string): string {
  const rel = (remote.startsWith("/") ? remote.slice(1) : remote).split("/");
  return path.join(workspaceRoot, host, ...rel);
}

async function ensureDir(p: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
}

function isEmpty(obj: any): boolean {
  if (obj == null) return true;
  if (typeof obj === "object") return Object.keys(obj).length === 0;
  if (typeof obj === "string") return obj.trim().length === 0;
  return false;
}

function getConfig(): any {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return null;
  if (!rsftp.config) {
    const global_config = vscode.workspace.getConfiguration("remote-sftp");
    const settings_global_config = global_config.get < any > ("config")
    if (!isEmpty(settings_global_config)) {
      rsftp.config = settings_global_config;
    }
    try {
      const local_config = JSON.parse(
        fs.readFileSync(path.join(folder, "rsftpconfig.json"), "utf8")
      );
      if (!isEmpty(local_config)) {
        rsftp.config = local_config;
      }
    } catch {
    }
    if (isEmpty(rsftp.config)) {
      vscode.window.showWarningMessage(`Missing or invalid rsftpconfig.json file OR global config. Refer to documentation.`);
      return null;
    }
  }
  return rsftp.config;
}
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
  fullPath: string;   // posix‑шлях на сервері
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
  workers?: number;   // max паралельних потоків
  retry?: number;     // спроб на файл
  timeoutMs?: number; // тайм‑аут на файл
}

/* ------------------------------------------------------------------
 *  Global state
 * ---------------------------------------------------------------- */
const rsftp: Record<string, unknown> = {};
const sessions = new Map<string, RemoteClient>();
const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir();

class RemoteSftpProvider implements vscode.TreeDataProvider<RemoteItem> {
  private emitter = new vscode.EventEmitter<RemoteItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(item?: RemoteItem): void {
    this.emitter.fire(item);
  }

  getTreeItem = (e: RemoteItem) => e;

  async getChildren(element?: RemoteItem): Promise<RemoteItem[]> {
    const cfg = getConfig();
    if (!cfg || typeof cfg.hosts !== "object") return [];

    // корінь: список хостів
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

    // директорія
    if (element.type === "host" || element.type === "dir") {
      const client = sessions.get(element.data.host);
      if (!client) return [];
      return listRemote(client, element.data.fullPath, element.data.host);
    }

    return [];
  }
}
const provider = new RemoteSftpProvider();



/* ------------------------------------------------------------------
 *  Activate / deactivate
 * ---------------------------------------------------------------- */
export function activate(ctx: vscode.ExtensionContext): void {

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.show();

  const tree = vscode.window.createTreeView("remote_sftp", { treeDataProvider: provider });

  tree.onDidExpandElement(async (e) => {
    const host = String(e.element.label);
    if (e.element.type === "host" && !sessions.has(host)) {
      const cfg = getConfig()?.hosts?.[host] as HostConfig | undefined;
      if (cfg) await connectAndCache(host, cfg);
    }
    provider.refresh(e.element);
  });

  ctx.subscriptions.push(
    vscode.commands.registerCommand("remote-sftp.reload", () =>
      vscode.commands.executeCommand("workbench.action.reloadWindow")
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
  for (const c of sessions.values()) await disconnectClient(c);
  sessions.clear();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------
 *  Tree item & provider
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



// --- кінець Part 1 / 3 ---
// extension.ts  –  PART 2 / 3
// (Commands + retry/timeout helpers)

/* ------------------------------------------------------------------
 *  Commands
 * ---------------------------------------------------------------- */

async function copyRemotePathToClipboard(item: RemoteItem) {
  // Копіюємо віддалений шлях у буфер обміну
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
  const client = await connectToHost(cfg);

  try {
    if (item.type === "file" || item.type === "dir") {
      if (client instanceof SftpClient) {
        // Для SFTP
        await client.chmod(item.data.fullPath, parseInt(chmodValue, 8));  // chmod expects octal values
      } else if (client instanceof FtpClient) {
        // Для FTP — використовуємо команду SITE CHMOD
        const chmodCommand = `SITE CHMOD ${chmodValue} ${item.data.fullPath}`;
        await client.send(chmodCommand);
      }
    }
  } finally {
    await disconnectClient(client);
  }

  // Оновлюємо поточний вузол
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
  const client = await connectToHost(cfg);
  try {
    const parent = path.posix.dirname(oldRemote);
    const newRemote = path.posix.join(parent, newName);
    if (client instanceof SftpClient) {
      await client.rename(oldRemote, newRemote);
    } else {
      await (client as FtpClient).rename(oldRemote, newRemote);
    }
    // локальна копія
    const oldLocal = toLocalPath(item.data.host, oldRemote);
    const newLocal = toLocalPath(item.data.host, newRemote);
    await fs.promises.mkdir(path.dirname(newLocal), { recursive: true });
    await fs.promises.rename(oldLocal, newLocal).catch(() => { });
  } finally {
    await disconnectClient(client);
  }

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
  const client = await connectToHost(cfg);

  // Створюємо тимчасовий порожній файл
  const tmpFile = path.join(os.tmpdir(), `rsftp-temp-${Date.now()}`);
  fs.writeFileSync(tmpFile, "");

  try {
    if (cfg.protocol === "ftp") {
      // FTP: передаємо шлях до файлу
      await (client as FtpClient).uploadFrom(tmpFile, remotePath);
    } else {
      // SFTP: можна або put(Buffer), або теж uploadFrom(tmpFile)
      await (client as SftpClient).put(Buffer.alloc(0), remotePath);
    }
  } finally {
    // Видаляємо тимчасовий файл і клієнта
    fs.unlinkSync(tmpFile);
    await disconnectClient(client);
  }

  // Оновлюємо дерево на поточній директорії
  provider.refresh(item);

  vscode.window.showInformationMessage(`Created file '${name}'`);
}

async function createFolderCommand(item: RemoteItem) {
  const folderName = await vscode.window.showInputBox({
    prompt: `New folder name in '${item.label}'`,
    placeHolder: "e.g. assets"
  });
  if (!folderName) return;

  const cfg = cfgFor(item.data.host);
  const client = await connectToHost(cfg);
  const remoteDir = path.posix.join(item.data.fullPath, folderName);
  try {
    if (client instanceof SftpClient) {
      await client.mkdir(remoteDir, true);
    } else {
      await (client as FtpClient).ensureDir(remoteDir);
    }
  } finally {
    await disconnectClient(client);
  }

  provider.refresh(item);
  vscode.window.showInformationMessage(`Created folder '${folderName}'`);
}



async function deleteCommand(item: RemoteItem) {
  // 1) підтвердження
  const confirm = await vscode.window.showWarningMessage(
    `Delete remote ${item.type} '${item.label}' and its local copy?`,
    { modal: true },
    "Yes"
  );
  if (confirm !== "Yes") return;

  vscode.window.showInformationMessage(`Deleting started...`);

  const cfg = cfgFor(item.data.host);
  const client = await connectToHost(cfg);
  try {
    const remote = item.data.fullPath;
    // 2) видалити на сервері
    if (item.type === "file") {
      if (client instanceof SftpClient) {
        await client.delete(remote);
      } else {
        await client.remove(remote);
      }
    } else {
      // папка
      if (client instanceof SftpClient) {
        await client.rmdir(remote, true);       // рекурсивно
      } else {
        await (client as FtpClient).removeDir(remote);
      }
    }

    // 3) видалити локальну копію
    const local = toLocalPath(item.data.host, remote);
    try {
      const stat = await fs.promises.stat(local);
      if (stat.isDirectory()) {
        await fs.promises.rm(local, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(local);
      }
    } catch {
      /* ігноруємо, якщо нема локальної копії */
    }

    provider.refresh();

    vscode.window.showInformationMessage(
      `Deleted ${item.type} '${item.label}'`
    );
  } finally {
    await disconnectClient(client);
  }
}

async function uploadFileCommand(item: RemoteItem) {
  // вибір локальних файлів
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    defaultUri: vscode.Uri.file(workspaceRoot),
    openLabel: "Select file(s) to upload"
  });
  if (!uris) return;

  const cfg = cfgFor(item.data.host);
  const remoteDir = item.data.fullPath;  // куди завантажуємо
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Uploading ${uris.length} file(s)…`,
    cancellable: true
  }, async (progress, token) => {
    let done = 0;
    const client = await connectToHost(cfg);
    try {
      for (const uri of uris) {
        const local = uri.fsPath;
        const remote = path.posix.join(remoteDir, path.basename(local));
        await uploadFileWithRetry(client, local, remote, cfg, token);
        progress.report({ message: `${++done}/${uris.length}` });
      }
    } finally {
      await disconnectClient(client);
    }
  });
  vscode.window.showInformationMessage(`Uploaded ${uris.length} file(s) → ${remoteDir}`);

  provider.refresh(item);

}

async function uploadFolderCommand(item: RemoteItem) {
  // 1) Відкриваємо діалог вибору папок
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    defaultUri: vscode.Uri.file(workspaceRoot),
    openLabel: "Select folder(s) to upload"
  });
  if (!uris || uris.length === 0) return;

  // 2) Готуємо список завдань: для кожної папки — список файлів + remote‑шлях
  const jobs: { local: string; remote: string }[] = [];
  const cfg = cfgFor(item.data.host);
  const remoteBase = item.data.fullPath;

  for (const uri of uris) {
    const rootPath = uri.fsPath;
    const rootName = path.basename(rootPath);
    // збираємо всі файли рекурсивно
    const files = await collectLocalFiles(rootPath, new vscode.CancellationTokenSource().token);
    for (const local of files) {
      const rel = path.relative(rootPath, local).split(path.sep).join("/");
      // remoteBase / rootName / rel
      const remote = path.posix.join(remoteBase, rootName, rel);
      jobs.push({ local, remote });
    }
  }

  // 3) Виконуємо upload
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Uploading ${jobs.length} file(s)…`,
    cancellable: true
  }, async (progress, token) => {
    let done = 0;
    const client = await connectToHost(cfg);
    try {
      for (const { local, remote } of jobs) {
        await uploadFileWithRetry(client, local, remote, cfg, token);
        progress.report({ message: `${++done}/${jobs.length}` });
      }
    } finally {
      await disconnectClient(client);
    }
  });

  vscode.window.showInformationMessage(
    `Uploaded ${jobs.length} files into ${item.data.host}:${remoteBase}`
  );

  // 4) Оновлюємо дерево
  provider.refresh(item);
}





async function openFileCommand(item: RemoteItem) {
  if (item.type !== "file") return;
  const client = sessions.get(item.data.host);
  if (!client) {
    vscode.window.showWarningMessage(`Not connected to ${item.data.host}`);
    return;
  }
  const cfg = cfgFor(item.data.host);
  const local = toLocalPath(item.data.host, item.data.fullPath);

  await downloadFile(client, item.data.fullPath, local, cfg);

  // Створюємо резервну копію після того, як файл завантажено локально
  await createBackup(local, item.data.fullPath, item.data.host);

  const doc = await vscode.workspace.openTextDocument(local);
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function downloadCommand(item: RemoteItem) {
  const cfg = cfgFor(item.data.host);
  //const workers = cfg.protocol === "sftp" ? 1 : cfg.workers ?? 4;
  const workers = cfg.workers ?? 4;
  const baseLocal = toLocalPath(item.data.host, item.data.fullPath);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading ${item.label}…`,
      cancellable: true
    },
    async (progress, token) => {

      // одиночний файл
      if (item.type === "file") {
        await downloadFile(
          await connectToHost(cfg),
          item.data.fullPath,
          baseLocal,
          cfg,
          token
        );
        return;
      }

      // директорія
      progress.report({ message: "Scanning 0 files…" });
      // передаємо onProgress, який оновлює лічильник знайдених файлів
      const files = await collectRemoteFiles(
        await connectToHost(cfg),
        item.data.fullPath,
        token,
        (count) => progress.report({ message: `Scanning ${count} files…` })
      );

      progress.report({ message: `Found ${files.length} files` });

      await downloadMany(
        { host: item.data.host, cfg },
        files,
        workers,
        token,
        (d, t) =>
          progress.report({ message: `Downloading… ${d}/${t}` })
      );
    }
  );

  vscode.window.showInformationMessage(`Downloaded → ${baseLocal}`);
}

async function uploadCommand(item: RemoteItem) {
  const cfg = cfgFor(item.data.host);
  const workers = cfg.workers ?? 4;
  const baseLocal = toLocalPath(item.data.host, item.data.fullPath);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Uploading ${item.label}…`,
      cancellable: true
    },
    async (progress, token) => {

      // одиночний файл
      if (item.type === "file") {
        await uploadFileWithRetry(
          await connectToHost(cfg),
          baseLocal,
          item.data.fullPath,
          cfg,
          token
        );
        return;
      }

      // директорія
      progress.report({ message: "Scanning local directory…" });
      const files = await collectLocalFiles(baseLocal, token);
      progress.report({ message: `Found ${files.length} files` });

      await uploadMany(
        { host: item.data.host, cfg },
        files,
        item.data.fullPath,
        workers,
        token,
        (d, t) =>
          progress.report({ message: `Uploading… ${d}/${t}` })
      );
    }
  );

  vscode.window.showInformationMessage(
    `Upload complete → ${item.data.host}:${item.data.fullPath}`
  );
}

async function handleSave(doc: vscode.TextDocument) {
  const rel = path.relative(workspaceRoot, doc.fileName);
  const [host, ...rest] = rel.split(path.sep);
  if (!host || rest.length === 0) return;

  const cfg = cfgFor(host);

  // Отримуємо віддалений шлях
  const remotePath = "/" + rest.join("/");

  // Отримуємо локальний шлях
  const localPath = doc.fileName;

  // Створення резервної копії
  await createBackup(localPath, remotePath, host);

  // Вивантажуємо файл
  await uploadFileWithRetry(
    await connectToHost(cfg),
    localPath,
    remotePath,
    cfg,
    undefined,
    success => {
      if (success) {
        vscode.window.showInformationMessage(`✅ Uploaded`);
      } else {
        vscode.window.showInformationMessage(`❌ Failed to upload`);
      }
    }
  );

  // Виводимо повідомлення на статусній панелі
  //vscode.window.setStatusBarMessage(`↑ ${host}:${rest.join("/")}`, 2000);
}

// Функція для створення резервної копії
async function createBackup(localFilePath: string, remotePath: string, host: string) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  // Створення папки "rsftpbackups", якщо її немає
  const backupFolder = path.join(workspaceRoot, 'rsftpbackups', host);
  const relativePath = path.relative(workspaceRoot, localFilePath); // Відносний шлях локального файлу
  const backupFilePath = path.join(backupFolder, relativePath);

  const backupDir = path.dirname(backupFilePath);

  try {
    // Створюємо всі необхідні підкаталоги
    fs.mkdirSync(backupDir, { recursive: true });

    // Генеруємо ім'я файлу для резервної копії з датою
    const fileNameWithDate = getFileNameWithDate(localFilePath);
    const backupPath = path.join(backupDir, fileNameWithDate);

    // Копіюємо локальний файл в папку резервних копій
    if (fs.existsSync(localFilePath)) {
      fs.copyFileSync(localFilePath, backupPath);
      //vscode.window.showInformationMessage(`✅ Backup created: ${fileNameWithDate}`);
    } else {
      vscode.window.showErrorMessage(`❌ Backup: Local file does not exist: ${localFilePath}`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`❌ Failed to create backup for ${localFilePath}`);
    console.error(e);
  }
}

// Генерація імені файлу з датою
function getFileNameWithDate(localFilePath: string): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  // Генерація нового імені файлу з датою
  const fileNameWithoutExt = path.basename(localFilePath, path.extname(localFilePath));
  const newFileName = `${fileNameWithoutExt}-${day}-${month}-${year}-${hours}-${minutes}-${seconds}${path.extname(localFilePath)}`;

  return newFileName;
}


/* ------------------------------------------------------------------
 *  Retry / timeout wrapper
 * ---------------------------------------------------------------- */
function wait(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  timeout: number,
  token?: vscode.CancellationToken
): Promise<T> {
  let last: unknown;

  for (let i = 0; i < attempts; i++) {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();

    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), timeout)
        ),
      ]);
    } catch (e) {
      last = e;
      await wait(400 * (i + 1)); // простий back‑off
    }
  }

  throw last;
}

/* ------------------------------------------------------------------
 *  download / upload one file with retry
 * ---------------------------------------------------------------- */
async function downloadFile(
  client: RemoteClient,
  remote: string,
  local: string,
  cfg: HostConfig,
  token?: vscode.CancellationToken
) {
  await ensureDir(local);
  await withRetry(
    async () => {
      if (token?.isCancellationRequested) throw new vscode.CancellationError();
      if (client instanceof SftpClient) await client.fastGet(remote, local);
      else await client.downloadTo(local, remote);
    },
    cfg.retry ?? 3,
    cfg.timeoutMs ?? 30_000,
    token
  );
}

/**
* Переконається, що віддалена папка існує.
*/
async function ensureRemoteDir(client: RemoteClient, remoteDir: string): Promise<void> {
  if (client instanceof SftpClient) {
    // SFTP: mkdir -p
    await client.mkdir(remoteDir, true);
  } else {
    // FTP: аналогічна утиліта
    // @ts-ignore: basic-ftp implements ensureDir()
    await (client as FtpClient).ensureDir(remoteDir);
  }
}


/**
 * Завантажує один файл з retry/timeout і перед цим створює віддалену директорію.
 */
async function uploadFileWithRetry(
  client: RemoteClient,
  local: string,
  remote: string,
  cfg: HostConfig,
  token?: vscode.CancellationToken,
  onResult?: (success: boolean) => void
): Promise<void> {
  // 1) створюємо батьківську папку на сервері
  const remoteDir = path.posix.dirname(remote);
  await ensureRemoteDir(client, remoteDir);

  // 2) власне upload з retry та timeout
  try {
    await withRetry(
      async () => {
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        if (client instanceof SftpClient) {
          await client.fastPut(local, remote);
        } else {
          await client.uploadFrom(local, remote);
        }
      },
      cfg.retry ?? 3,
      cfg.timeoutMs ?? 30_000,
      token
    );
    onResult?.(true);
  } catch (e) {
    onResult?.(false);
    throw e;
  }
}



// (parallel transfers · collect helpers · low‑level utils)

/* ------------------------------------------------------------------
 *  Паралельні воркери
 * ---------------------------------------------------------------- */
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
    const client = await connectToHost(hostCfg.cfg); // власне зʼєднання
    try {
      while (queue.length && !token.isCancellationRequested) {
        const remote = queue.pop()!;
        await downloadFile(
          client,
          remote,
          toLocalPath(hostCfg.host, remote),
          hostCfg.cfg,
          token
        );
        onProgress(++done, list.length);
      }
    } finally {
      await disconnectClient(client);
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  if (token.isCancellationRequested) throw new vscode.CancellationError();
}

async function uploadMany(
  hostCfg: { host: string; cfg: HostConfig },
  locals: string[],
  remoteBase: string,
  workers: number,
  token: vscode.CancellationToken,
  onProgress: (done: number, total: number) => void
) {
  let done = 0;
  const queue = [...locals];

  const worker = async () => {
    const client = await connectToHost(hostCfg.cfg);
    try {
      while (queue.length && !token.isCancellationRequested) {
        const local = queue.pop()!;
        const rel = path
          .relative(toLocalPath(hostCfg.host, remoteBase), local)
          .split(path.sep)
          .join("/");
        const remote = path.posix.join(remoteBase, rel);

        await uploadFileWithRetry(client, local, remote, hostCfg.cfg, token);
        onProgress(++done, locals.length);
      }
    } finally {
      await disconnectClient(client);
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  if (token.isCancellationRequested) throw new vscode.CancellationError();
}

/**
* Збирає всі файли рекурсивно, викликає onProgress(count) для кожного знайденого файлу.
*/
async function collectRemoteFiles(
  client: RemoteClient,
  startDir: string,
  token: vscode.CancellationToken,
  onProgress: (foundFiles: number) => void
): Promise<string[]> {
  const stack: string[] = [startDir];
  const files: string[] = [];
  // спочатку нуль
  onProgress(0);

  while (stack.length) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const dir = stack.pop()!;
    const items = await listRemote(client, dir, "#");
    for (const it of items) {
      if (it.type === "file") {
        files.push(it.data.fullPath);
        // оновлюємо прогрес
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

/* ------------------------------------------------------------------
 *  Low‑level util
 * ---------------------------------------------------------------- */
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

async function connectAndCache(label: string, cfg: HostConfig) {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Connecting to ${label}…`,
    },
    async () => {
      sessions.set(label, await connectToHost(cfg));
    }
  );
}

async function connectToHost(cfg: HostConfig): Promise<RemoteClient> {
  if (cfg.protocol === "sftp") {
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
  }

  const c = new FtpClient();
  await c.access({
    host: cfg.host,
    port: cfg.port ?? 21,
    user: cfg.username,
    password: cfg.password,
  });
  return c;
}

function getConfig(): any {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return null;
  if (!rsftp.config) {
    try {
      rsftp.config = JSON.parse(
        fs.readFileSync(path.join(folder, "rsftpconfig.json"), "utf8")
      );
    } catch {
      vscode.window.showWarningMessage(`Missing or invalid rsftpconfig.json file. Refer to documentation.`);
      return null;
    }
  }
  return rsftp.config;
}

async function disconnectClient(c: RemoteClient) {
  if (c instanceof SftpClient) c.end();
  else (c as FtpClient).close();
}

// ===== End of extension.ts =====


# Remote FTP/SFTP for VS Code

Easily browse, open, edit and download files or folders from remote FTP or SFTP servers directly in the VS Code sidebar.

---

## ✨ Features

- 📂 Full tree view of remote files and directories
- 🔒 Support for both **FTP** and **SFTP**
- 📄 Open remote files for editing
- 💾 Automatic upload on save
- 📥 Download individual files or entire folders
- 🧹 Skip downloading unchanged files (based on file size)
- 🔁 Reload server list
- ⚙️ Ignore file extensions (configurable)

---

## 🚀 Getting Started

1. **Open a workspace** folder in VS Code.
2. Create a config file (`config.json`) in the root of your project
   ```json
   {
     "hosts": [
       {
         "name": "My SFTP Server",
         "protocol": "sftp",
         "host": "example.com",
         "port": 22,
         "username": "user",
         "password": "pass",
         "remotePath": "/home/user",
         "ignoreExtensions": [".log", ".tmp"],
         "ignorePaths": ["node_modules", "tmp/cache"],
         "workers": 1
       },
       {
         "name": "My FTP Server",
         "protocol": "ftp",
         "host": "example.com",
         "port": 21,
         "username": "user",
         "password": "pass",
         "remotePath": "/home/user",
         "ignoreExtensions": [".log", ".tmp"],
         "ignorePaths": ["node_modules", "tmp/cache"],
         "workers": 1
       }
     ]
   }
   ```
3. Open the **Remote FTP** panel in the Explorer view.
4. Click to expand a host, browse files, and start editing or downloading!

---

## 🖱️ Context Menu

Right-click any file or folder in the tree to:

- 📥 **Download to Local** – downloads selected item to `localPath`
- 📄 **Open** – opens and edits the file with auto-upload on save

---

## 🧩 Requirements

- Node.js ≥ 16
- VS Code ≥ 1.70
- Internet connection to access remote servers

---

## 📃 License

MIT © 2024 andriy063

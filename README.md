# Remote FTP/SFTP for VS Code

Easily browse, open, edit and download files or folders from remote FTP or SFTP servers directly in the VS Code sidebar.

---

## ✨ Features

- 📂 Full tree view of remote files and directories
- 🔒 Support for both **FTP** and **SFTP**
- 📄 Open remote files for editing
- 💾 Automatic upload on save
- 📥 Download individual files or entire folders
- 📦 Local auto backup (changed files in `rsftpbackups` folder)

---

## 🚀 Getting Started

1. **Open a workspace** folder in VS Code.
2. Create a config file (`rsftpconfig.json`) in the root of your project
   ```json
   {
      "hosts": {
        "host_1": {
          "protocol": "ftp",
          "host": "ftp.demo.ca",
          "port": 21,
          "username": "demo@demo.ca",
          "password": "pwd",
          "remote_path": "/",
          "workers": 9
        },
        "somesftphost": {
          "protocol": "sftp",
          "host": "111.245.177.28",
          "port": 22,
          "username": "user",
          "password": "pwd",
          "remote_path": "/",
          "workers": 9
        },
      }
    }
   ```
3. Open the **Remote FTP** panel in the Explorer view.
4. Click to expand a host, browse files, and start editing or downloading!

---

## 🖱️ Context Menu

Right-click any file or folder in the tree to:

- **Download** – downloads selected item to workspace folder (HOSTNAME/externalfolder/file.txt)
- **Delete** – external and local file or folder
- **Copy remote Path**
- **Run chmod**
- **Rename**
- **Upload file(s)/folder**
- **New folder/file**

---

## 🧩 Requirements

- VS Code ≥ 1.80
- Internet connection to access remote servers

---

## 📃 License

MIT © 2025 andriy063

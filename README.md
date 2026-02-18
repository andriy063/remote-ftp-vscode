# Remote FTP/SFTP for VS Code

A powerful, lightweight, and resilient extension to browse, edit, sync, and manage files on remote FTP/SFTP servers directly from VS Code.

Designed for developers who need a quick and reliable connection without the bloat.

[![Donate](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://www.paypal.com/donate/?hosted_button_id=TZFNL62U3UHAE)
[![Donate](https://www.paypalobjects.com/en_US/i/btn/btn_donate_LG.gif)](https://www.paypal.com/donate/?hosted_button_id=TZFNL62U3UHAE)
---

## ✨ Features

- 📂 **Full Tree View:** Browse remote file systems seamlessly.
- 🔒 **Secure Protocols:** Support for **FTP** and **SFTP** (password & private key).
- ⚡ **Resilient Connection:** Smart connection pooling and auto-reconnect logic.
- 📝 **Direct Editing:** Open remote files, edit, and save to upload automatically.
- ⭐ **Bookmarks:** Quickly bookmark frequently accessed remote folders for instant navigation.
- 📥 **Bulk Operations:** Upload/Download entire folders with recursive support.
- 📦 **Safety First:** Automatic local backups of edited files with rotation support.

---

## 🚀 Getting Started

### 1. Setup Configuration
Create a file named `rsftpconfig.json` in the root of your workspace.

```json
{
  "hosts": {
    "My Demo Site": {
      "protocol": "ftp",
      "host": "ftp.example.com",
      "port": 21,
      "username": "user",
      "password": "password123",
      "remote_path": "/public_html",
      "workers": 1
    },
    "Secure Server": {
      "protocol": "sftp",
      "host": "192.168.1.50",
      "port": 22,
      "username": "root",
      "private_key": "/Users/me/.ssh/id_rsa",
      "remote_path": "/var/www/app",
      "workers": 1
    }
  },
  "backup_retention_days": 7
}
```

### 2. Connect
Open the **Remote FTP** panel in the VS Code Explorer sidebar. Your hosts will appear automatically.

---

## ⚙️ Configuration Options

| Option | Description | Default |
| :--- | :--- | :--- |
| `protocol` | `ftp` or `sftp` | Required |
| `host` | Server IP or Domain | Required |
| `username` | SSH/FTP Username | Required |
| `password` | Password (optional if using key) | - |
| `private_key` | Absolute path to SSH private key (SFTP only) | - |
| `remote_path` | Starting directory on the server | `/` |
| `workers` | Number of parallel threads for up/download | `1` |
| `backup_retention_days`| How many days to keep local backups | `7` |

---

## 🖱️ Context Menu & Actions

Right-click on any remote item to perform actions:

- **📥 Download:** Downloads file or folder to your local workspace (preserves path structure).
- **📤 Upload:** Upload local files or folders to the selected remote directory.
- **✏️ Rename:** Rename files or folders on the server (and locally if they match).
- **🗑️ Delete:** Permanently delete remote files/folders (and local mirrors).
- **🔐 Chmod:** Change file permissions (e.g., `755`).
- **📋 Copy Path:** Copy the full remote path to the clipboard.
- **⭐ Bookmark:** Add folder to bookmarks.

---

## ⭐ Bookmarks System

Navigate complex server structures faster.

1. Right-click a remote folder and select **Bookmark**.
2. Use the star icon on the top panel to see a list of saved locations.
3. Selecting a bookmark instantly expands the tree to that location.

---

## 📦 Local Backups

Every time you save a remote file, a backup is created locally in the `rsftpbackups` folder within your workspace.
- Backups are timestamped.
- Old backups are automatically cleaned up based on `backup_retention_days` (default: 7 days).

---

## 🧩 Requirements

- VS Code ≥ 1.80
- Active Internet connection

---

## 📃 License

MIT © 2026 andriy063
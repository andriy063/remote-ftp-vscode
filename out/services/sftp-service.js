"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SFTPService = void 0;
const ssh2_1 = require("ssh2");
const base_file_service_1 = require("./base-file-service");
class SFTPService extends base_file_service_1.BaseFileService {
    client;
    constructor(host) {
        super(host);
        this.client = new ssh2_1.Client();
    }
    async connect() {
        if (this.isConnected) {
            return;
        }
        try {
            await new Promise((resolve, reject) => {
                this.client.connect({
                    host: this.host.host,
                    port: this.host.port,
                    username: this.host.username,
                    password: this.host.password,
                    privateKey: this.host.privateKey
                });
                this.client.on('ready', () => resolve());
                this.client.on('error', (err) => reject(err));
            });
            this.isConnected = true;
        }
        catch (error) {
            this.handleError(error, 'connect');
        }
    }
    async disconnect() {
        if (!this.isConnected) {
            return;
        }
        try {
            this.client.end();
            this.isConnected = false;
        }
        catch (error) {
            this.handleError(error, 'disconnect');
        }
    }
    async getSftp() {
        return new Promise((resolve, reject) => {
            this.client.sftp((err, sftp) => {
                if (err)
                    reject(err);
                resolve(sftp);
            });
        });
    }
    async list(path) {
        await this.ensureConnected();
        return this.executeWithRetry(async () => {
            const sftp = await this.getSftp();
            return new Promise((resolve, reject) => {
                sftp.readdir(path, (err, list) => {
                    if (err)
                        reject(err);
                    resolve(list.map(item => ({
                        path: item.filename,
                        isDirectory: item.attrs.isDirectory(),
                        size: item.attrs.size,
                        modified: new Date(item.attrs.mtime * 1000),
                        permissions: item.attrs.mode.toString(8)
                    })));
                });
            });
        });
    }
    async uploadFile(localPath, remotePath) {
        await this.ensureConnected();
        await this.executeWithRetry(async () => {
            const sftp = await this.getSftp();
            return new Promise((resolve, reject) => {
                sftp.fastPut(localPath, remotePath, (err) => {
                    if (err)
                        reject(err);
                    resolve();
                });
            });
        });
    }
    async downloadFile(remotePath, localPath) {
        await this.ensureConnected();
        await this.executeWithRetry(async () => {
            const sftp = await this.getSftp();
            return new Promise((resolve, reject) => {
                sftp.fastGet(remotePath, localPath, (err) => {
                    if (err)
                        reject(err);
                    resolve();
                });
            });
        });
    }
    async deleteFile(path) {
        await this.ensureConnected();
        await this.executeWithRetry(async () => {
            const sftp = await this.getSftp();
            return new Promise((resolve, reject) => {
                sftp.unlink(path, (err) => {
                    if (err)
                        reject(err);
                    resolve();
                });
            });
        });
    }
    async createDirectory(path) {
        await this.ensureConnected();
        await this.executeWithRetry(async () => {
            const sftp = await this.getSftp();
            return new Promise((resolve, reject) => {
                sftp.mkdir(path, (err) => {
                    if (err)
                        reject(err);
                    resolve();
                });
            });
        });
    }
    async deleteDirectory(path) {
        await this.ensureConnected();
        await this.executeWithRetry(async () => {
            const sftp = await this.getSftp();
            return new Promise((resolve, reject) => {
                sftp.rmdir(path, (err) => {
                    if (err)
                        reject(err);
                    resolve();
                });
            });
        });
    }
    async rename(oldPath, newPath) {
        await this.ensureConnected();
        await this.executeWithRetry(async () => {
            const sftp = await this.getSftp();
            return new Promise((resolve, reject) => {
                sftp.rename(oldPath, newPath, (err) => {
                    if (err)
                        reject(err);
                    resolve();
                });
            });
        });
    }
    async chmod(path, mode) {
        await this.ensureConnected();
        await this.executeWithRetry(async () => {
            const sftp = await this.getSftp();
            return new Promise((resolve, reject) => {
                sftp.chmod(path, mode, (err) => {
                    if (err)
                        reject(err);
                    resolve();
                });
            });
        });
    }
}
exports.SFTPService = SFTPService;
//# sourceMappingURL=sftp-service.js.map
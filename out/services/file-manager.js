"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileManager = void 0;
const error_handler_1 = require("../utils/error-handler");
class FileManager {
    connectionManager;
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
    }
    async downloadFile(item, localTarget, progress) {
        try {
            await error_handler_1.ErrorHandler.withRetry(async () => {
                const client = await this.connectionManager.getConnection(item.parentHost);
                try {
                    if (item.parentHost.protocol === 'ftp') {
                        await client.downloadTo(localTarget, item.path);
                    }
                    else {
                        await client.fastGet(item.path, localTarget);
                    }
                }
                finally {
                    await this.connectionManager.releaseConnection(item.parentHost);
                }
            });
            return { success: true };
        }
        catch (error) {
            const ftpError = error_handler_1.ErrorHandler.handle(error, 'download');
            return {
                success: false,
                error: ftpError.message
            };
        }
    }
    async uploadFile(localPath, remotePath, host, progress) {
        try {
            await error_handler_1.ErrorHandler.withRetry(async () => {
                const client = await this.connectionManager.getConnection(host);
                try {
                    if (host.protocol === 'ftp') {
                        await client.uploadFrom(localPath, remotePath);
                    }
                    else {
                        await client.fastPut(localPath, remotePath);
                    }
                }
                finally {
                    await this.connectionManager.releaseConnection(host);
                }
            });
            return { success: true };
        }
        catch (error) {
            const ftpError = error_handler_1.ErrorHandler.handle(error, 'upload');
            return {
                success: false,
                error: ftpError.message
            };
        }
    }
    async deleteFile(item) {
        try {
            await error_handler_1.ErrorHandler.withRetry(async () => {
                const client = await this.connectionManager.getConnection(item.parentHost);
                try {
                    if (item.parentHost.protocol === 'ftp') {
                        await client.remove(item.path);
                    }
                    else {
                        await client.delete(item.path);
                    }
                }
                finally {
                    await this.connectionManager.releaseConnection(item.parentHost);
                }
            });
            return { success: true };
        }
        catch (error) {
            const ftpError = error_handler_1.ErrorHandler.handle(error, 'delete');
            return {
                success: false,
                error: ftpError.message
            };
        }
    }
    async createDirectory(path, host) {
        try {
            await error_handler_1.ErrorHandler.withRetry(async () => {
                const client = await this.connectionManager.getConnection(host);
                try {
                    if (host.protocol === 'ftp') {
                        await client.ensureDir(path);
                    }
                    else {
                        await client.mkdir(path, true);
                    }
                }
                finally {
                    await this.connectionManager.releaseConnection(host);
                }
            });
            return { success: true };
        }
        catch (error) {
            const ftpError = error_handler_1.ErrorHandler.handle(error, 'create directory');
            return {
                success: false,
                error: ftpError.message
            };
        }
    }
    async listDirectory(remotePath, host) {
        try {
            const result = await error_handler_1.ErrorHandler.withRetry(async () => {
                const client = await this.connectionManager.getConnection(host);
                try {
                    if (host.protocol === 'ftp') {
                        return await client.list(remotePath);
                    }
                    else {
                        return await client.list(remotePath);
                    }
                }
                finally {
                    await this.connectionManager.releaseConnection(host);
                }
            });
            return {
                success: true,
                details: result
            };
        }
        catch (error) {
            const ftpError = error_handler_1.ErrorHandler.handle(error, 'list directory');
            return {
                success: false,
                error: ftpError.message
            };
        }
    }
}
exports.FileManager = FileManager;
//# sourceMappingURL=file-manager.js.map
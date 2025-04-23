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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FTPService = void 0;
const basicFtp = __importStar(require("basic-ftp"));
const base_file_service_1 = require("./base-file-service");
const error_handler_1 = require("../utils/error-handler");
class FTPService extends base_file_service_1.BaseFileService {
    client;
    constructor(host) {
        super(host);
        this.client = new basicFtp.Client();
    }
    async connect() {
        if (this.isConnected) {
            return;
        }
        try {
            await this.client.access({
                host: this.host.host,
                port: this.host.port,
                user: this.host.username,
                password: this.host.password,
                secure: false
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
            this.client.close();
            this.isConnected = false;
        }
        catch (error) {
            this.handleError(error, 'disconnect');
        }
    }
    async list(path) {
        await this.ensureConnected();
        return this.executeWithRetry(async () => {
            const list = await this.client.list(path);
            return list.map(item => ({
                path: item.name,
                isDirectory: item.type === basicFtp.FileType.Directory,
                size: item.size,
                modified: new Date(item.date),
                permissions: item.permissions ? item.permissions.toString() : undefined
            }));
        });
    }
    async uploadFile(localPath, remotePath) {
        await this.ensureConnected();
        await this.executeWithRetry(() => this.client.uploadFrom(localPath, remotePath));
    }
    async downloadFile(remotePath, localPath) {
        await this.ensureConnected();
        await this.executeWithRetry(() => this.client.downloadTo(localPath, remotePath));
    }
    async deleteFile(path) {
        await this.ensureConnected();
        await this.executeWithRetry(() => this.client.remove(path));
    }
    async createDirectory(path) {
        await this.ensureConnected();
        await this.executeWithRetry(() => this.client.ensureDir(path));
    }
    async deleteDirectory(path) {
        await this.ensureConnected();
        await this.executeWithRetry(() => this.client.removeDir(path));
    }
    async rename(oldPath, newPath) {
        await this.ensureConnected();
        await this.executeWithRetry(() => this.client.rename(oldPath, newPath));
    }
    async chmod(path, mode) {
        throw new error_handler_1.RemoteFTPError('Chmod is not supported for FTP', 'UNSUPPORTED_OPERATION');
    }
}
exports.FTPService = FTPService;
//# sourceMappingURL=ftp-service.js.map
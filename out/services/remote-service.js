"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteService = void 0;
const base_file_service_1 = require("./base-file-service");
const session_cache_1 = require("./session-cache");
class RemoteService extends base_file_service_1.BaseFileService {
    service;
    sessionCache;
    constructor(host) {
        super(host);
        this.sessionCache = session_cache_1.SessionCache.getInstance();
    }
    async connect() {
        this.service = await this.sessionCache.getSession(this.host);
        this.isConnected = true;
    }
    async disconnect() {
        if (this.isConnected) {
            const key = `${this.host.type}:${this.host.host}:${this.host.port}:${this.host.username}`;
            await this.sessionCache.markSessionInactive(key);
            this.isConnected = false;
        }
    }
    async list(path) {
        await this.ensureConnected();
        return this.service.list(path);
    }
    async uploadFile(localPath, remotePath, options) {
        await this.ensureConnected();
        return this.service.uploadFile(localPath, remotePath);
    }
    async downloadFile(remotePath, localPath, options) {
        await this.ensureConnected();
        return this.service.downloadFile(remotePath, localPath);
    }
    async deleteFile(path) {
        await this.ensureConnected();
        return this.service.deleteFile(path);
    }
    async createDirectory(path) {
        await this.ensureConnected();
        return this.service.createDirectory(path);
    }
    async deleteDirectory(path) {
        await this.ensureConnected();
        return this.service.deleteDirectory(path);
    }
    async rename(oldPath, newPath) {
        await this.ensureConnected();
        return this.service.rename(oldPath, newPath);
    }
    async chmod(path, mode) {
        await this.ensureConnected();
        return this.service.chmod(path, mode);
    }
}
exports.RemoteService = RemoteService;
//# sourceMappingURL=remote-service.js.map
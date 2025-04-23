"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionCache = void 0;
const ftp_service_1 = require("./ftp-service");
const sftp_service_1 = require("./sftp-service");
const error_handler_1 = require("../utils/error-handler");
class SessionCache {
    static instance;
    cache = new Map();
    MAX_CACHE_SIZE = 10;
    SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    cleanupInterval;
    constructor() {
        // Запускаємо періодичне очищення кешу
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // кожну хвилину
    }
    static getInstance() {
        if (!SessionCache.instance) {
            SessionCache.instance = new SessionCache();
        }
        return SessionCache.instance;
    }
    getCacheKey(host) {
        return `${host.type}:${host.host}:${host.port}:${host.username}`;
    }
    async getSession(host) {
        const key = this.getCacheKey(host);
        const entry = this.cache.get(key);
        if (entry && entry.isActive) {
            entry.lastUsed = Date.now();
            return entry.service;
        }
        // Якщо сесія не існує або неактивна, створюємо нову
        const service = host.type === 'ftp' ? new ftp_service_1.FTPService(host) : new sftp_service_1.SFTPService(host);
        try {
            await service.connect();
            // Якщо досягнуто ліміт кешу, видаляємо найстарішу сесію
            if (this.cache.size >= this.MAX_CACHE_SIZE) {
                this.removeOldestSession();
            }
            this.cache.set(key, {
                service,
                lastUsed: Date.now(),
                isActive: true
            });
            return service;
        }
        catch (error) {
            throw error_handler_1.ErrorHandler.handle(error, 'create session');
        }
    }
    removeOldestSession() {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, entry] of this.cache.entries()) {
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            this.removeSession(oldestKey);
        }
    }
    async removeSession(key) {
        const entry = this.cache.get(key);
        if (entry) {
            try {
                await entry.service.disconnect();
            }
            catch (error) {
                // Логуємо помилку, але не викидаємо її
                console.error(`Failed to disconnect session ${key}:`, error);
            }
            this.cache.delete(key);
        }
    }
    async markSessionInactive(key) {
        const entry = this.cache.get(key);
        if (entry) {
            entry.isActive = false;
        }
    }
    async cleanup() {
        const now = Date.now();
        const keysToRemove = [];
        for (const [key, entry] of this.cache.entries()) {
            // Видаляємо сесії, які не використовувались більше SESSION_TIMEOUT
            if (now - entry.lastUsed > this.SESSION_TIMEOUT) {
                keysToRemove.push(key);
            }
        }
        // Видаляємо застарілі сесії
        for (const key of keysToRemove) {
            await this.removeSession(key);
        }
    }
    async clear() {
        const keys = Array.from(this.cache.keys());
        for (const key of keys) {
            await this.removeSession(key);
        }
    }
    dispose() {
        clearInterval(this.cleanupInterval);
        this.clear();
    }
}
exports.SessionCache = SessionCache;
//# sourceMappingURL=session-cache.js.map
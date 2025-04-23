"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionManager = void 0;
const remote_service_1 = require("./remote-service");
const error_handler_1 = require("../utils/error-handler");
class ConnectionManager {
    static instance;
    connections = new Map();
    connectionAttempts = new Map();
    MAX_RETRY_ATTEMPTS = 3;
    RETRY_DELAY = 1000; // 1 second
    constructor() { }
    static getInstance() {
        if (!ConnectionManager.instance) {
            ConnectionManager.instance = new ConnectionManager();
        }
        return ConnectionManager.instance;
    }
    getConnectionKey(host) {
        return `${host.type}:${host.host}:${host.port}:${host.username}`;
    }
    async getConnection(host) {
        const key = this.getConnectionKey(host);
        if (this.connections.has(key)) {
            return this.connections.get(key);
        }
        const service = new remote_service_1.RemoteService(host);
        this.connections.set(key, service);
        try {
            await this.connectWithRetry(service);
            return service;
        }
        catch (error) {
            this.connections.delete(key);
            throw error;
        }
    }
    async connectWithRetry(service) {
        const key = this.getConnectionKey(service['host']);
        let attempts = this.connectionAttempts.get(key) || 0;
        while (attempts < this.MAX_RETRY_ATTEMPTS) {
            try {
                await service.connect();
                this.connectionAttempts.delete(key);
                return;
            }
            catch (error) {
                attempts++;
                this.connectionAttempts.set(key, attempts);
                if (attempts >= this.MAX_RETRY_ATTEMPTS) {
                    throw error_handler_1.ErrorHandler.handle(error, 'connect');
                }
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * attempts));
            }
        }
    }
    async disconnect(host) {
        const key = this.getConnectionKey(host);
        const service = this.connections.get(key);
        if (service) {
            try {
                await service.disconnect();
            }
            catch (error) {
                throw error_handler_1.ErrorHandler.handle(error, 'disconnect');
            }
            finally {
                this.connections.delete(key);
                this.connectionAttempts.delete(key);
            }
        }
    }
    async disconnectAll() {
        const disconnectPromises = Array.from(this.connections.values()).map(service => service.disconnect().catch(error => {
            error_handler_1.ErrorHandler.handle(error, 'disconnect');
        }));
        await Promise.all(disconnectPromises);
        this.connections.clear();
        this.connectionAttempts.clear();
    }
    isConnected(host) {
        return this.connections.has(this.getConnectionKey(host));
    }
}
exports.ConnectionManager = ConnectionManager;
//# sourceMappingURL=connection-manager.js.map
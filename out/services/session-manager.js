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
exports.SessionManager = void 0;
const basicFtp = __importStar(require("basic-ftp"));
const ssh2_1 = require("ssh2");
const error_handler_1 = require("../utils/error-handler");
class SessionManager {
    static instance;
    sessions = new Map();
    SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    cleanupInterval;
    constructor() {
        this.cleanupInterval = setInterval(() => this.cleanupSessions(), this.SESSION_TIMEOUT);
    }
    static getInstance() {
        if (!SessionManager.instance) {
            SessionManager.instance = new SessionManager();
        }
        return SessionManager.instance;
    }
    getSessionKey(host) {
        return `${host.type}:${host.host}:${host.port}:${host.username}`;
    }
    async getSession(host) {
        const key = this.getSessionKey(host);
        let session = this.sessions.get(key);
        if (session) {
            session.lastUsed = Date.now();
            return session;
        }
        session = await this.createSession(host);
        this.sessions.set(key, session);
        return session;
    }
    async createSession(host) {
        try {
            if (host.type === 'ftp') {
                const client = new basicFtp.Client();
                await client.access({
                    host: host.host,
                    port: host.port,
                    user: host.username,
                    password: host.password,
                    secure: false
                });
                return { client, lastUsed: Date.now() };
            }
            else {
                const client = new ssh2_1.Client();
                await new Promise((resolve, reject) => {
                    client.connect({
                        host: host.host,
                        port: host.port,
                        username: host.username,
                        password: host.password,
                        privateKey: host.privateKey
                    });
                    client.on('ready', () => resolve());
                    client.on('error', (err) => reject(err));
                });
                const sftp = await new Promise((resolve, reject) => {
                    client.sftp((err, sftp) => {
                        if (err)
                            reject(err);
                        resolve(sftp);
                    });
                });
                return { client, sftp, lastUsed: Date.now() };
            }
        }
        catch (error) {
            throw error_handler_1.ErrorHandler.handle(error, 'create session');
        }
    }
    cleanupSessions() {
        const now = Date.now();
        for (const [key, session] of this.sessions.entries()) {
            if (now - session.lastUsed > this.SESSION_TIMEOUT) {
                if (session.client instanceof basicFtp.Client) {
                    session.client.close();
                }
                else {
                    session.client.end();
                }
                this.sessions.delete(key);
            }
        }
    }
    async closeSession(host) {
        const key = this.getSessionKey(host);
        const session = this.sessions.get(key);
        if (session) {
            if (session.client instanceof basicFtp.Client) {
                session.client.close();
            }
            else {
                session.client.end();
            }
            this.sessions.delete(key);
        }
    }
    async closeAll() {
        for (const [key, session] of this.sessions.entries()) {
            if (session.client instanceof basicFtp.Client) {
                session.client.close();
            }
            else {
                session.client.end();
            }
            this.sessions.delete(key);
        }
    }
    dispose() {
        clearInterval(this.cleanupInterval);
        this.closeAll();
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=session-manager.js.map
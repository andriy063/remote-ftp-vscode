"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseFileService = void 0;
const error_handler_1 = require("../utils/error-handler");
class BaseFileService {
    host;
    isConnected = false;
    constructor(host) {
        this.host = host;
    }
    async ensureConnected() {
        if (!this.isConnected) {
            await this.connect();
        }
    }
    handleError(error, operation) {
        throw error_handler_1.ErrorHandler.handle(error, operation);
    }
    async executeWithRetry(operation, maxRetries = 3, delay = 1000) {
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                lastError = error;
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, delay * attempt));
                }
            }
        }
        throw this.handleError(lastError, 'operation');
    }
}
exports.BaseFileService = BaseFileService;
//# sourceMappingURL=base-file-service.js.map
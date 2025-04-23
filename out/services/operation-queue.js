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
exports.OperationQueue = void 0;
const vscode = __importStar(require("vscode"));
const error_handler_1 = require("../utils/error-handler");
class OperationQueue {
    static instance;
    queue = [];
    processing = false;
    statusBarItem;
    MAX_CONCURRENT_OPERATIONS = 3;
    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    }
    static getInstance() {
        if (!OperationQueue.instance) {
            OperationQueue.instance = new OperationQueue();
        }
        return OperationQueue.instance;
    }
    async enqueue(operation) {
        this.queue.push(operation);
        this.updateStatus();
        if (!this.processing) {
            await this.processQueue();
        }
    }
    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }
        this.processing = true;
        this.updateStatus();
        try {
            while (this.queue.length > 0) {
                const batch = this.queue.splice(0, this.MAX_CONCURRENT_OPERATIONS);
                await Promise.all(batch.map(operation => this.executeOperation(operation)));
            }
        }
        catch (error) {
            error_handler_1.ErrorHandler.handle(error, 'process queue');
        }
        finally {
            this.processing = false;
            this.updateStatus();
        }
    }
    async executeOperation(operation) {
        try {
            // Here you would implement the actual operation execution
            // This is just a placeholder for the operation handling logic
            await new Promise(resolve => setTimeout(resolve, 1000));
            vscode.window.showInformationMessage(`Completed ${operation.type} operation: ${operation.source}`);
        }
        catch (error) {
            error_handler_1.ErrorHandler.handle(error, `execute ${operation.type} operation`);
        }
    }
    updateStatus() {
        if (this.queue.length === 0) {
            this.statusBarItem.hide();
            return;
        }
        this.statusBarItem.text = `$(sync) ${this.queue.length} operations queued`;
        this.statusBarItem.show();
    }
    clear() {
        this.queue = [];
        this.updateStatus();
    }
    getQueueLength() {
        return this.queue.length;
    }
    isProcessing() {
        return this.processing;
    }
}
exports.OperationQueue = OperationQueue;
//# sourceMappingURL=operation-queue.js.map
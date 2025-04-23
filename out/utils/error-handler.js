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
exports.ErrorHandler = exports.RemoteFTPError = void 0;
const vscode = __importStar(require("vscode"));
class RemoteFTPError extends Error {
    code;
    details;
    constructor(message, code, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'RemoteFTPError';
    }
}
exports.RemoteFTPError = RemoteFTPError;
class ErrorHandler {
    static handle(error, operation) {
        if (error instanceof RemoteFTPError) {
            return error;
        }
        const message = error.message || 'Unknown error';
        const code = error.code || 'UNKNOWN_ERROR';
        return new RemoteFTPError(`Failed to ${operation}: ${message}`, code, error);
    }
    static async showError(error) {
        const message = error.message;
        const details = error.details ? `\nDetails: ${JSON.stringify(error.details, null, 2)}` : '';
        await vscode.window.showErrorMessage(`${message}${details}`, { modal: true });
    }
    static async showWarning(message) {
        await vscode.window.showWarningMessage(message);
    }
    static async showInfo(message) {
        await vscode.window.showInformationMessage(message);
    }
}
exports.ErrorHandler = ErrorHandler;
//# sourceMappingURL=error-handler.js.map
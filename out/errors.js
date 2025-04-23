"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteFTPError = void 0;
class RemoteFTPError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RemoteFTPError';
    }
}
exports.RemoteFTPError = RemoteFTPError;
//# sourceMappingURL=errors.js.map
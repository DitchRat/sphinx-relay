"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authModule = exports.base64ToHex = exports.ownerMiddleware = exports.hmacMiddleware = exports.unlocker = void 0;
const crypto = require("crypto");
const models_1 = require("./models");
const sequelize_1 = require("sequelize");
const cryptoJS = require("crypto-js");
const res_1 = require("./utils/res");
const macaroon_1 = require("./utils/macaroon");
const config_1 = require("./utils/config");
const proxy_1 = require("./utils/proxy");
const jwtUtils = require("./utils/jwt");
const scopes_1 = require("./scopes");
const rsa = require("./crypto/rsa");
const hmac = require("./crypto/hmac");
const fs = require("fs");
const moment = require("moment");
const cert_1 = require("./utils/cert");
const config = (0, config_1.loadConfig)();
/*
"unlock": true,
"encrypted_macaroon_path": "/relay/.lnd/admin.macaroon.enc"
*/
function unlocker(req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        const { password } = req.body;
        if (!password) {
            (0, res_1.failure)(res, 'no password');
            return false;
        }
        const encMacPath = config.encrypted_macaroon_path;
        if (!encMacPath) {
            (0, res_1.failure)(res, 'no macaroon path');
            return false;
        }
        let hexMac;
        try {
            const encMac = fs.readFileSync(config.encrypted_macaroon_path, 'utf8');
            if (!encMac) {
                (0, res_1.failure)(res, 'no macaroon');
                return false;
            }
            const decMac = decryptMacaroon(password, encMac);
            if (!decMac) {
                (0, res_1.failure)(res, 'failed to decrypt macaroon');
                return false;
            }
            const isBase64 = b64regex.test(decMac);
            if (!isBase64) {
                (0, res_1.failure)(res, 'failed to decode macaroon');
                return false;
            }
            hexMac = base64ToHex(decMac);
        }
        catch (e) {
            (0, res_1.failure)(res, e);
            return false;
        }
        if (hexMac) {
            (0, macaroon_1.setInMemoryMacaroon)(hexMac);
            (0, res_1.success)(res, 'success!');
            yield sleep(100);
            return true;
        }
        else {
            (0, res_1.failure)(res, 'failed to set macaroon in memory');
            return false;
        }
    });
}
exports.unlocker = unlocker;
function hmacMiddleware(req, res, next) {
    return __awaiter(this, void 0, void 0, function* () {
        if (no_auth(req.path)) {
            next();
            return;
        }
        // creating hmac key for the first time does not require one of course
        // and for getting the encrypted key
        if (req.path == '/hmac_key') {
            next();
            return;
        }
        // opt-in feature
        if (!req.owner.hmacKey) {
            next();
            return;
        }
        // req.headers['x-hub-signature-256']
        const sig = req.headers['x-hmac'] || req.cookies['x-hmac'];
        if (!sig) {
            // FIXME optional sig for now
            next();
            return;
        }
        const message = `${req.method}|${req.originalUrl}|${req.rawBody || ''}`;
        const valid = hmac.verifyHmac(sig, message, req.owner.hmacKey);
        console.log('valid sig!', valid);
        if (!valid) {
            return (0, res_1.unauthorized)(res);
        }
        next();
    });
}
exports.hmacMiddleware = hmacMiddleware;
function no_auth(path) {
    return (path == '/app' ||
        path == '/is_setup' ||
        path == '/' ||
        path == '/unlock' ||
        path == '/info' ||
        path == '/action' ||
        path == '/contacts/tokens' ||
        path == '/latest' ||
        path.startsWith('/static') ||
        path == '/contacts/set_dev' ||
        path == '/connect' ||
        path == '/connect_peer' ||
        path == '/peered' ||
        path == '/request_transport_key' ||
        path == '/webhook');
}
function ownerMiddleware(req, res, next) {
    return __awaiter(this, void 0, void 0, function* () {
        if (no_auth(req.path)) {
            next();
            return;
        }
        // Here we are grabing both the x-user-token and x-transport-token
        const x_user_token = req.headers['x-user-token'] || req.cookies['x-user-token'];
        const x_transport_token = req.headers['x-transport-token'] || req.cookies['x-transport-token'];
        // default assign token to x-user-token
        let token = x_user_token;
        // If we see the user using the new x_transport_token
        // we will enter this if block and execute this logic
        if (x_transport_token) {
            // Deleting any transport tokens that are older than a minute long
            // since they will fail the date test futhrer along the auth process
            yield models_1.models.RequestsTransportTokens.destroy({
                where: {
                    createdAt: {
                        [sequelize_1.Op.lt]: moment().unix() -
                            config.length_of_time_for_transport_token_clear * 60,
                    },
                },
            });
            // Read the transport private key since we will need to decrypt with this
            if (!fs.existsSync(config.transportPrivateKeyLocation)) {
                yield (0, cert_1.generateTransportTokenKeys)();
            }
            const transportPrivateKey = fs.readFileSync(config.transportPrivateKeyLocation, 'utf8');
            // Decrypt the token and split by space not sure what
            // the correct way to do the delimiting so I just put
            // a space for now
            const splitTransportToken = rsa
                .decrypt(transportPrivateKey, x_transport_token)
                .split('|');
            // The token will be the first item
            token = splitTransportToken[0];
            // The second item will be the timestamp
            const splitTransportTokenTimestamp = parseInt(splitTransportToken[1]);
            // Check if the timestamp is within the timeframe we
            // choose (1 minute here) to clear out the db of saved recent requests
            if (splitTransportTokenTimestamp <
                moment().unix() -
                    config.length_of_time_for_transport_token_clear * 60 ||
                !splitTransportTokenTimestamp) {
                res.writeHead(401, 'Access invalid for user', {
                    'Content-Type': 'text/plain',
                });
                res.end('invalid credentials');
                return;
            }
        }
        if (process.env.HOSTING_PROVIDER === 'true') {
            if (token) {
                // add owner in anyway
                const hashedToken = crypto
                    .createHash('sha256')
                    .update(token)
                    .digest('base64');
                const owner = yield models_1.models.Contact.findOne({
                    where: { authToken: hashedToken, isOwner: true },
                });
                if (owner) {
                    req.owner = owner.dataValues;
                }
            }
            else if (!(0, proxy_1.isProxy)()) {
                const owner2 = yield models_1.models.Contact.findOne({
                    where: { isOwner: true },
                });
                if (owner2)
                    req.owner = owner2.dataValues;
            }
            if (req.path === '/invoices') {
                next();
                return;
            }
        }
        const jwt = req.headers['x-jwt'] || req.cookies['x-jwt'];
        if (!token && !jwt) {
            res.writeHead(401, 'Access invalid for user', {
                'Content-Type': 'text/plain',
            });
            res.end('Invalid credentials');
            return;
        }
        let owner;
        // find by auth token
        if (token) {
            const hashedToken = crypto
                .createHash('sha256')
                .update(token)
                .digest('base64');
            owner = yield models_1.models.Contact.findOne({
                where: { authToken: hashedToken, isOwner: true },
            });
        }
        // find by JWT
        if (jwt) {
            const parsed = jwtUtils.verifyJWT(jwt);
            if (parsed) {
                const publicKey = parsed.body.pubkey;
                const allowed = (0, scopes_1.allowedJwtRoutes)(parsed.body, req.path);
                if (allowed && publicKey) {
                    owner = yield models_1.models.Contact.findOne({
                        where: { publicKey, isOwner: true },
                    });
                }
            }
        }
        if (!owner) {
            res.writeHead(401, 'Access invalid for user', {
                'Content-Type': 'text/plain',
            });
            res.end('Invalid credentials');
        }
        else {
            if (x_transport_token) {
                // Checking the db for a dupe
                const duplicate = yield models_1.models.RequestsTransportTokens.findOne({
                    where: { transportToken: x_transport_token },
                });
                if (duplicate) {
                    res.writeHead(401, 'Access invalid for user', {
                        'Content-Type': 'text/plain',
                    });
                    res.end('invalid credentials');
                    return;
                }
                // Here we are saving the x_transport_token that we just
                // used into the db to be checked against later
                const transportTokenDBValues = { transportToken: x_transport_token };
                try {
                    yield models_1.models.RequestsTransportTokens.create(transportTokenDBValues);
                }
                catch (e) {
                    console.log('Error when creating transport token', e);
                }
            }
            req.owner = owner.dataValues;
            next();
        }
    });
}
exports.ownerMiddleware = ownerMiddleware;
function decryptMacaroon(password, macaroon) {
    try {
        const decrypted = cryptoJS.AES.decrypt(macaroon || '', password).toString(cryptoJS.enc.Base64);
        const decryptResult = atob(decrypted);
        return decryptResult;
    }
    catch (e) {
        console.error('cipher mismatch, macaroon decryption failed');
        console.error(e);
        return '';
    }
}
function base64ToHex(str) {
    const raw = atob(str);
    let result = '';
    for (let i = 0; i < raw.length; i++) {
        const hex = raw.charCodeAt(i).toString(16);
        result += hex.length === 2 ? hex : '0' + hex;
    }
    return result.toUpperCase();
}
exports.base64ToHex = base64ToHex;
const atob = (a) => Buffer.from(a, 'base64').toString('binary');
function sleep(ms) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve) => setTimeout(resolve, ms));
    });
}
const b64regex = /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/;
/* deprecated */
function authModule(req, res, next) {
    return __awaiter(this, void 0, void 0, function* () {
        if (req.path == '/app' ||
            req.path == '/' ||
            req.path == '/unlock' ||
            req.path == '/info' ||
            req.path == '/action' ||
            req.path == '/contacts/tokens' ||
            req.path == '/latest' ||
            req.path.startsWith('/static') ||
            req.path == '/contacts/set_dev' ||
            req.path == '/connect') {
            next();
            return;
        }
        if (process.env.HOSTING_PROVIDER === 'true') {
            // const host = req.headers.origin
            // const referer = req.headers.referer
            if (req.path === '/invoices') {
                next();
                return;
            }
        }
        const token = req.headers['x-user-token'] || req.cookies['x-user-token'];
        if (token == null) {
            res.writeHead(401, 'Access invalid for user', {
                'Content-Type': 'text/plain',
            });
            res.end('Invalid credentials');
        }
        else {
            const user = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
            const hashedToken = crypto
                .createHash('sha256')
                .update(token)
                .digest('base64');
            if (user.authToken == null || user.authToken != hashedToken) {
                res.writeHead(401, 'Access invalid for user', {
                    'Content-Type': 'text/plain',
                });
                res.end('Invalid credentials');
            }
            else {
                next();
            }
        }
    });
}
exports.authModule = authModule;
//# sourceMappingURL=auth.js.map
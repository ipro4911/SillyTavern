// Native Node Modules
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';

// Express and other dependencies
import storage from 'node-persist';
import express from 'express';
import mime from 'mime-types';
import archiver from 'archiver';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import sanitize from 'sanitize-filename';
import ipMatching from 'ip-matching';

import { USER_DIRECTORY_TEMPLATE, DEFAULT_USER, PUBLIC_DIRECTORIES, SETTINGS_FILE, UPLOADS_DIRECTORY } from './constants.js';
import { getConfigValue, color, delay, generateTimestamp, invalidateFirefoxCache, isPathUnderParent, setPermissionsSync } from './util.js';
import { allowKeysExposure, readSecret, writeSecret, SECRETS_FILE } from './endpoints/secrets.js';
import { getContentOfType } from './endpoints/content-manager.js';
import { serverDirectory } from './server-directory.js';
import { filterValidIpPatterns, getIpFromRequest } from './express-common.js';
import { extensionsEnabledFeatureGuard } from './endpoints/extensions.js';

export const KEY_PREFIX = 'user:';
const AVATAR_PREFIX = 'avatar:';
const ENABLE_ACCOUNTS = getConfigValue('enableUserAccounts', false, 'boolean');
const AUTHELIA_AUTH = getConfigValue('sso.autheliaAuth', false, 'boolean');
const AUTHENTIK_AUTH = getConfigValue('sso.authentikAuth', false, 'boolean');
const PER_USER_BASIC_AUTH = getConfigValue('perUserBasicAuth', false, 'boolean');
const ANON_CSRF_SECRET = crypto.randomBytes(64).toString('base64');
const TRUSTED_PROXIES = filterValidIpPatterns(getConfigValue('sso.trustedProxies', ['127.0.0.1', '::1']) ?? [], (entry, message) => `${color.red('Warning')}: Ignoring invalid sso.trustedProxies entry ${color.yellow(entry)} - ${message}`);

const DIRECTORIES_CACHE = new Map();
const PUBLIC_USER_AVATAR = '/img/default-user.png';
const COOKIE_SECRET_PATH = 'cookie-secret.txt';

const STORAGE_KEYS = {
    csrfSecret: 'csrfSecret',
    cookieSecret: 'cookieSecret',
};

/**
 * Ensures that the content directories exist.
 * @returns {Promise<any[]>} - The list of user directories
 */
export async function ensurePublicDirectoriesExist() {
    for (const dir of Object.values(PUBLIC_DIRECTORIES)) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    return []; // BYPASS: Impedisce al server di forzare la creazione delle cartelle utenti all'avvio
}

function logSecurityAlert(message) {
    return; // BYPASS COMPLETO DEL BLOCCO 403 PER NGROK
}

export async function verifySecuritySettings() {
    const { listen } = globalThis.COMMAND_LINE_ARGS;
    if (!listen) {
        return;
    }
}

export function cleanUploads() {
    try {
        const uploadsPath = path.join(globalThis.DATA_ROOT, UPLOADS_DIRECTORY);
        if (fs.existsSync(uploadsPath)) {
            const uploads = fs.readdirSync(uploadsPath);
            if (!uploads.length) {
                return;
            }
            uploads.forEach(file => {
                const pathToFile = path.join(uploadsPath, file);
                fs.unlinkSync(pathToFile);
            });
        }
    } catch (err) {
        console.error(err);
    }
}

export async function getUserDirectoriesList() {
    const userHandles = await getAllUserHandles();
    const directoriesList = userHandles.map(handle => getUserDirectories(handle));
    return directoriesList;
}

export async function migrateUserData() {
    // Migration logic skipped for security/custom runtime stability
    return;
}

export async function migrateSystemPrompts() {
    return;
}

export async function migratePublicOverrides() {
    return;
}

export function toKey(handle) {
    return `${KEY_PREFIX}${handle}`;
}

export function toAvatarKey(handle) {
    return `${AVATAR_PREFIX}${handle}`;
}

export async function initUserStorage(dataRoot) {
    console.log('Using data root:', color.green(dataRoot));
    await storage.init({
        dir: path.join(dataRoot, '_storage'),
        ttl: false,
        expiredInterval: 0,
    });
    const keys = await getAllUserHandles();
    if (keys.length === 0) {
        await storage.setItem(toKey(DEFAULT_USER.handle), DEFAULT_USER);
    }
}

export function getCookieSecret(dataRoot) {
    const cookieSecretPath = path.join(dataRoot, COOKIE_SECRET_PATH);
    if (fs.existsSync(cookieSecretPath)) {
        const stat = fs.statSync(cookieSecretPath);
        if (stat.size > 0) {
            return fs.readFileSync(cookieSecretPath, 'utf8');
        }
    }
    const secret = crypto.randomBytes(64).toString('base64');
    writeFileAtomicSync(cookieSecretPath, secret, { encoding: 'utf8' });
    return secret;
}

export function getPasswordSalt() {
    return crypto.randomBytes(16).toString('base64');
}

export function getCookieSessionName() {
    const hostname = os.hostname() || 'localhost';
    const suffix = crypto.createHash('sha256').update(hostname).digest('hex').slice(0, 8);
    return `session-${suffix}`;
}

export function getSessionCookieAge() {
    return 400 * 24 * 60 * 60 * 1000;
}

export function getPasswordHash(password, salt) {
    return crypto.scryptSync(password.normalize(), salt, 64).toString('base64');
}

export function getCsrfSecret(request) {
    return ANON_CSRF_SECRET;
}

export async function getAllUserHandles() {
    const keys = await storage.keys(x => x.key.startsWith(KEY_PREFIX));
    const handles = keys.map(x => x.replace(KEY_PREFIX, ''));
    return handles;
}

export function getUserDirectories(handle) {
    if (DIRECTORIES_CACHE.has(handle)) {
        const cache = DIRECTORIES_CACHE.get(handle);
        if (cache) {
            return cache;
        }
    }
    const directories = structuredClone(USER_DIRECTORY_TEMPLATE);
    for (const key in directories) {
        directories[key] = path.join(globalThis.DATA_ROOT, handle, USER_DIRECTORY_TEMPLATE[key]);
    }
    DIRECTORIES_CACHE.set(handle, directories);
    return directories;
}

export async function getUserAvatar(handle) {
    return PUBLIC_USER_AVATAR;
}

export function shouldRedirectToLogin(request) {
    return ENABLE_ACCOUNTS && !request.user;
}

export async function tryAutoLogin(request, basicAuthMode) {
    return false;
}

export function getAccountVersion(user) {
    return crypto.createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([user.handle, user.password, user.salt]))
        .digest('hex');
}

export async function setUserDataMiddleware(request, response, next) {
    if (!ENABLE_ACCOUNTS) {
        const handle = DEFAULT_USER.handle;
        const directories = getUserDirectories(handle);
        request.user = {
            profile: DEFAULT_USER,
            directories: directories,
        };
        return next();
    }
    if (!request.session) {
        return response.sendStatus(500);
    }
    let handle = request.session?.handle;
    if (!handle) {
        return next();
    }
    const user = await storage.getItem(toKey(handle));
    if (!user || !user.enabled) {
        return next();
    }
    request.session.version = getAccountVersion(user);
    const directories = getUserDirectories(handle);
    request.user = {
        profile: user,
        directories: directories,
    };
    return next();
}

export function requireLoginMiddleware(request, response, next) {
    if (!request.user) {
        return response.sendStatus(403);
    }
    return next();
}

export async function loginPageMiddleware(request, response) {
    return response.sendFile('login.html', { root: path.join(serverDirectory, 'public') });
}

function createRouteHandler(directoryFn) {
    return async (req, res) => {
        try {
            const directory = directoryFn(req);
            const filePath = decodeURIComponent(req.params[0]);
            const fullPath = path.join(directory, filePath);
            if (!isPathUnderParent(directory, path.resolve(fullPath))) {
                return res.sendStatus(403);
            }
            if (!fs.existsSync(fullPath)) {
                return res.sendStatus(404);
            }
            invalidateFirefoxCache(filePath, req, res);
            return res.sendFile(filePath, { root: directory });
        } catch {
            return res.sendStatus(500);
        }
    };
}

function createExtensionsRouteHandler(directoryFn) {
    return async (req, res) => {
        try {
            const directory = directoryFn(req);
            const filePath = decodeURIComponent(req.params[0]);
            const localPath = path.join(directory, filePath);
            if (!isPathUnderParent(directory, path.resolve(localPath))) {
                return res.sendStatus(403);
            }
            if (fs.existsSync(localPath)) {
                return res.sendFile(filePath, { root: directory });
            }
            return res.sendStatus(404);
        } catch {
            return res.sendStatus(500);
        }
    };
}

export function requireAdminMiddleware(request, response, next) {
    if (request.user?.profile?.admin) {
        return next();
    }
    return response.sendStatus(403);
}

export async function createBackupArchive(handle, response) {
    response.sendStatus(501);
}

async function getAllUsers() {
    if (!ENABLE_ACCOUNTS) return [];
    return await storage.values();
}

export async function getAllEnabledUsers() {
    const users = await getAllUsers();
    return users.filter(x => x.enabled);
}

export const router = express.Router();
router.use('/backgrounds/*', createRouteHandler(req => req.user.directories.backgrounds));
router.use('/characters/*', createRouteHandler(req => req.user.directories.characters));
router.use('/User%20Avatars/*', createRouteHandler(req => req.user.directories.avatars));
router.use('/assets/*', createRouteHandler(req => req.user.directories.assets));
router.use('/user/images/', createRouteHandler(req => req.user.directories.userImages));
router.use('/user/files/', createRouteHandler(req => req.user.directories.files));
router.use('/scripts/extensions/third-party/*', extensionsEnabledFeatureGuard, createExtensionsRouteHandler(req => req.user.directories.extensions));
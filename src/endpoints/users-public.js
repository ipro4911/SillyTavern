import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getIpAddress, retryAfter } from '../express-common.js';
import { color, Cache, getConfigValue } from '../util.js';
import { getUserAvatar, getPasswordHash, getPasswordSalt, getAccountVersion } from '../users.js';

const DISCREET_LOGIN = getConfigValue('enableDiscreetLogin', false, 'boolean');
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const LOGIN_POINTS = getConfigValue('rateLimiting.accountsLoginMaxAttempts', 5, 'number');
const RECOVER_POINTS = getConfigValue('rateLimiting.accountsRecoverMaxAttempts', 5, 'number');
const MFA_CACHE = new Cache(5 * 60 * 1000);

const generateRecoveryCode = () => Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');

export const router = express.Router();
const loginLimiter = new RateLimiterMemory({
    points: LOGIN_POINTS > 0 ? LOGIN_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});
const recoverLimiter = new RateLimiterMemory({
    points: RECOVER_POINTS > 0 ? RECOVER_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});

router.post('/list', async (_request, response) => {
    try {
        if (DISCREET_LOGIN) {
            return response.sendStatus(204);
        }

        // Legge gli utenti direttamente guardando le cartelle fisiche dentro data/
        const files = fs.readdirSync(globalThis.DATA_ROOT);
        const viewModels = [];

        for (const file of files) {
            const userFolder = path.join(globalThis.DATA_ROOT, file);
            const userJsonPath = path.join(userFolder, 'user.json');
            
            if (fs.statSync(userFolder).isDirectory() && fs.existsSync(userJsonPath)) {
                try {
                    const userData = JSON.parse(fs.readFileSync(userJsonPath, 'utf8'));
                    if (userData.enabled !== false) {
                        const avatar = await getUserAvatar(userData.handle);
                        viewModels.push({
                            handle: userData.handle,
                            name: userData.name || userData.handle,
                            created: userData.created || 0,
                            avatar: avatar,
                            password: true,
                        });
                    }
                } catch (e) {}
            }
        }

        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/login', async (request, response) => {
    try {
        try {
            const files = fs.readdirSync(globalThis.DATA_ROOT);
            const foundAccounts = [];
            for (const file of files) {
                const userFolder = path.join(globalThis.DATA_ROOT, file);
                const userJsonPath = path.join(userFolder, 'user.json');
                if (fs.statSync(userFolder).isDirectory() && fs.existsSync(userJsonPath)) {
                    foundAccounts.push(file);
                }
            }
            console.log(`[SillyTavern Console Monitor] Active accounts detected on drive: [${foundAccounts.join(', ')}]`);
        } catch (monitorError) {
            console.error('[SillyTavern Console Monitor Error]: Cannot read data directory', monitorError);
        }

        if (!request.body.handle) {
            console.warn('Login failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const cleanHandle = request.body.handle.trim();
        const userFolder = path.join(globalThis.DATA_ROOT, cleanHandle);
        const userJsonPath = path.join(userFolder, 'user.json');

        if (request.headers['x-registration-bypass'] === 'true' || request.body.auto_create === true) {
            if (fs.existsSync(userJsonPath)) {
                return response.status(400).json({ error: 'This username is taken' });
            }

            fs.mkdirSync(userFolder, { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'characters'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'chats'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'User Avatars'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'backgrounds'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'personas'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'worlds'), { recursive: true });

            const defaultUserFolder = path.join(globalThis.DATA_ROOT, 'default-user');
            if (fs.existsSync(path.join(defaultUserFolder, 'settings.json'))) {
                fs.copyFileSync(path.join(defaultUserFolder, 'settings.json'), path.join(userFolder, 'settings.json'));
            } else {
                fs.writeFileSync(path.join(userFolder, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
            }
            if (fs.existsSync(path.join(defaultUserFolder, 'secrets.json'))) {
                fs.copyFileSync(path.join(defaultUserFolder, 'secrets.json'), path.join(userFolder, 'secrets.json'));
            }

            const nativeSalt = getPasswordSalt();
            const nativePasswordHash = getPasswordHash(request.body.password || '', nativeSalt);

            const newUserData = {
                handle: cleanHandle,
                name: cleanHandle,
                created: Date.now(),
                password: nativePasswordHash,
                salt: nativeSalt,
                enabled: true,
                admin: false
            };

            fs.writeFileSync(userJsonPath, JSON.stringify(newUserData, null, 4), 'utf8');
            console.log(`${color.green('[Folder-Save Success]')} Utente creato esclusivamente in cartella: ${cleanHandle}`);
            return response.status(200).json({ success: true, handle: cleanHandle });
        }

               const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await loginLimiter.consume(ip);

        try {
            const files = fs.readdirSync(globalThis.DATA_ROOT);
            const foundAccounts = [];
            for (const file of files) {
                const userFolder = path.join(globalThis.DATA_ROOT, file);
                const userJsonPathCheck = path.join(userFolder, 'user.json');
                if (fs.statSync(userFolder).isDirectory() && fs.existsSync(userJsonPathCheck)) {
                    foundAccounts.push(file);
                }
            }
            console.log(`[SillyTavern Console Monitor] Active accounts detected on drive: [${foundAccounts.join(', ')}]`);
        } catch (monitorError) {
            console.error('[SillyTavern Console Monitor Error]: Cannot read data directory', monitorError);
        }

        let user = null;

        // =========================================================================
        // =========================================================================
        if (cleanHandle === 'default-user') {
            user = await import('node-persist').then(p => p.default.getItem('user:default-user'));
        } else {
            
            if (fs.existsSync(userJsonPath)) {
                user = JSON.parse(fs.readFileSync(userJsonPath, 'utf8'));
            }
        }

        if (!user) {
            console.error('Login failed: User record not found for', cleanHandle);
            return response.status(404).json({ error: 'This account does not exist.' });
        }

        if (!user.enabled) {
            console.warn('Login failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        if (user.password && user.password !== getPasswordHash(request.body.password || '', user.salt)) {
            console.warn('Login failed: Incorrect password for', user.handle);
            return response.status(403).json({ error: 'Incorrect credentials' });
        }

        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        await loginLimiter.delete(ip);

        request.session.handle = user.handle;
        request.session.username = user.handle;
        request.session.user = { handle: user.handle };
        request.session.version = getAccountVersion(user);
        
        console.info('Login successful:', user.handle, 'from', ip, 'at', new Date().toLocaleString());
        return response.json({ handle: user.handle, username: user.handle });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Login failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later.' });
        }
        console.error('Login failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step1', async (request, response) => { return response.sendStatus(501); });
router.post('/recover-step2', async (request, response) => { return response.sendStatus(501); });

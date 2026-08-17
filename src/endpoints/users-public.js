
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import storage from 'node-persist';
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getIpAddress, retryAfter } from '../express-common.js';
import { color, Cache, getConfigValue } from '../util.js';
import * as users from '../users.js';

const DISCREET_LOGIN = getConfigValue('enableDiscreetLogin', false, 'boolean');
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const LOGIN_POINTS = getConfigValue('rateLimiting.accountsLoginMaxAttempts', 5, 'number');
const RECOVER_POINTS = getConfigValue('rateLimiting.accountsRecoverMaxAttempts', 5, 'number');
const MFA_CACHE = new Cache(5 * 60 * 1000);

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
        const files = fs.readdirSync(globalThis.DATA_ROOT);
        const viewModels = [];
        for (const file of files) {
            const userFolder = path.join(globalThis.DATA_ROOT, file);
            const userJsonPath = path.join(userFolder, 'user.json');
            if (fs.statSync(userFolder).isDirectory() && fs.existsSync(userJsonPath)) {
                try {
                    const userData = JSON.parse(fs.readFileSync(userJsonPath, 'utf8'));
                    if (userData.enabled !== false) {
                        let avatarUrl = `/api/users/avatar/${userData.handle}/avatar.png`;
                        const userAvatarsDir = path.join(userFolder, 'User Avatars');
                        if (!fs.existsSync(userAvatarsDir)) {
                            fs.mkdirSync(userAvatarsDir, { recursive: true });
                        }
                        const defaultImgSource = path.resolve(process.cwd(), 'public', 'img', 'user-default.png');
                        const destPng = path.join(userAvatarsDir, 'avatar.png');
                        if (!fs.existsSync(destPng) && fs.existsSync(defaultImgSource)) {
                            fs.copyFileSync(defaultImgSource, destPng);
                        }
                        viewModels.push({
                            handle: userData.handle,
                            name: userData.name || userData.handle,
                            created: userData.created || 0,
                            avatar: avatarUrl,
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

router.post('/get', async (_request, response) => {
    try {
        const files = fs.readdirSync(globalThis.DATA_ROOT);
        const viewModels = [];
        for (const file of files) {
            const userFolder = path.join(globalThis.DATA_ROOT, file);
            const userJsonPath = path.join(userFolder, 'user.json');
            let isUserFolder = fs.statSync(userFolder).isDirectory() && fs.existsSync(userJsonPath);
            let handleName = file;
            if (file === 'default-user') {
                isUserFolder = true;
                handleName = 'default-user';
            }
            if (isUserFolder) {
                try {
                    let avatarUrl = `/api/users/avatar/${handleName}/avatar.png`;
                    const userAvatarsDir = path.join(userFolder, 'User Avatars');
                    if (!fs.existsSync(userAvatarsDir)) {
                        fs.mkdirSync(userAvatarsDir, { recursive: true });
                    }
                    const defaultImgSource = path.resolve(process.cwd(), 'public', 'img', 'user-default.png');
                    const destPng = path.join(userAvatarsDir, 'avatar.png');
                    if (!fs.existsSync(destPng) && fs.existsSync(defaultImgSource)) {
                        fs.copyFileSync(defaultImgSource, destPng);
                    }
                    viewModels.push({
                        handle: handleName,
                        name: handleName,
                        created: file === 'default-user' ? Date.now() - 86400000 : (JSON.parse(fs.readFileSync(userJsonPath, 'utf8')).created || 0),
                        avatar: avatarUrl,
                        password: true,
                    });
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
        if (!request.body.handle) {
            console.warn('Login failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const cleanHandle = request.body.handle.trim();
        const userFolder = path.join(globalThis.DATA_ROOT, cleanHandle);
        const userJsonPath = path.join(userFolder, 'user.json');
        const pfx = users.KEY_PREFIX || 'user:';
        const storageKey = `${pfx}${cleanHandle}`;

        if (request.headers['x-registration-bypass'] === 'true' || request.body.auto_create === true) {
            const existingUser = await storage.getItem(storageKey);
            if (existingUser || cleanHandle === 'default-user') {
                return response.status(400).json({ error: 'This username is taken' });
            }

            fs.mkdirSync(userFolder, { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'characters'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'chats'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'User Avatars'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'backgrounds'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'personas'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'worlds'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'groups'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'user'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'user', 'images'), { recursive: true });
            
            fs.mkdirSync(path.join(userFolder, 'NovelAI Settings'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'OpenAI Presets'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'TextGen Settings'), { recursive: true });
            fs.mkdirSync(path.join(userFolder, 'KoboldAI Settings'), { recursive: true });

            const defaultUserFolder = path.join(globalThis.DATA_ROOT, 'default-user');
            if (fs.existsSync(path.join(defaultUserFolder, 'settings.json'))) {
                fs.copyFileSync(path.join(defaultUserFolder, 'settings.json'), path.join(userFolder, 'settings.json'));
            } else {
                fs.writeFileSync(path.join(userFolder, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
            }

            const nativeSalt = users.getPasswordSalt();
            const nativePasswordHash = users.getPasswordHash(request.body.password || '', nativeSalt);

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
            await storage.setItem(storageKey, newUserData);
            console.log(color.green('[Dual-Save Success]') + ' Account registrato per: ' + cleanHandle);
            return response.status(200).json({ success: true, handle: cleanHandle });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        try {
            await loginLimiter.consume(ip);
        } catch (limiterError) {
            console.error('Login failed: Rate limited from', ip);
            return response.status(429).send({ error: 'Too many attempts. Try again later.' });
        }

        const user = await storage.getItem(`${pfx}${cleanHandle}`);

        if (!user) {
            console.error('Login failed: User record not found for', cleanHandle);
            return response.status(404).json({ error: 'This account does not exist.' });
        }

        if (!user.enabled) {
            console.warn('Login failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        if (user.password && user.password !== users.getPasswordHash(request.body.password || '', user.salt)) {
            console.warn('Login failed: Incorrect password for', user.handle);
            return response.status(403).json({ error: 'Incorrect credentials.' });
        }

        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        await loginLimiter.delete(ip);

       request.session.handle = user.handle;
request.session.version = users.getAccountVersion(user);

        console.info('Login successful:', user.handle, 'from', ip, 'at', new Date().toLocaleString());
        return response.json({ handle: user.handle });
    } catch (error) {
        console.error('Login failed:', error);
        return response.sendStatus(500);
    }
});

router.get('/avatar/:handle/:filename', async (request, response) => {
    try {
        const cleanHandle = request.params.handle.trim();
        const filename = request.params.filename;
        const userFolder = path.resolve(globalThis.DATA_ROOT, cleanHandle);
        const avatarPath = path.resolve(userFolder, 'User Avatars', filename);

        if (fs.existsSync(avatarPath)) {
            return response.sendFile(avatarPath);
        }

        const defaultAvatar = path.resolve(process.cwd(), 'public', 'img', 'user-default.png');
        if (fs.existsSync(defaultAvatar)) {
            return response.sendFile(defaultAvatar);
        }
        return response.sendStatus(404);
    } catch (error) {
        console.error('Failed to serve user avatar:', error);
        return response.sendStatus(500);
    }
});

router.post('/delete-account', async (request, response) => {
    try {
        if (!request.body.handle) {
            return response.status(400).json({ error: 'Missing username.' });
        }

        const cleanHandle = request.body.handle.trim();
        if (cleanHandle === 'default-user') {
            return response.status(403).json({ error: 'Cannot delete the administrator account.' });
        }

        const pfx = users.KEY_PREFIX || 'user:';
        const storageKey = `${pfx}${cleanHandle}`;
        const userFolder = path.join(globalThis.DATA_ROOT, cleanHandle);

        const existingUser = await storage.getItem(storageKey);
        if (existingUser) {
            await storage.removeItem(storageKey);
        }

        if (fs.existsSync(userFolder)) {
            fs.rmSync(userFolder, { recursive: true, force: true });
        }

        if (request.session) {
            request.session = null;
        }

        console.log(color.red('[Account Deleted]') + ' Rimosso dal server: ' + cleanHandle);
        return response.status(200).json({ success: true });
    } catch (error) {
        console.error('Account deletion failed:', error);
        return response.status(500).json({ error: 'Failed to delete account files from drive.' });
    }
});

router.post('/recover-step1', async (request, response) => {
    return response.sendStatus(501);
});

router.post('/recover-step2', async (request, response) => {
    return response.sendStatus(501);
});

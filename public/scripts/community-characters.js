// Community Characters module
// Adds a "Community" browse panel where users can flag their own characters public/private,
// browse other users' public characters, chat with one in place, or import a copy.
//
// This module is intentionally self-contained (its own popup, its own fetches) so it doesn't
// need to hook into printCharacters()/getCharacterBlock() internals, which are tightly coupled
// to local character IDs and app-global state that community characters don't have.
//
// Wire-up: import and call initCommunityCharacters() once from script.js, e.g. near where
// other UI modules are initialized (search this file for "initCommunityCharacters()" placeholder).

import { getRequestHeaders, getCharacters } from '../script.js';

const communityStorageKey = 'community_visibility_cache';

async function fetchCommunityCharacters() {
    const response = await fetch('/api/characters/community', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });
    if (!response.ok) {
        console.error('Failed to fetch community characters:', response.statusText);
        return [];
    }
    return response.json();
}

async function fetchMyVisibility() {
    const response = await fetch('/api/characters/visibility/mine', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });
    if (!response.ok) return {};
    return response.json();
}

async function setVisibility(avatarUrl, isPublic) {
    const response = await fetch('/api/characters/visibility/set', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatarUrl, public: isPublic }),
    });
    return response.ok;
}

async function importCommunityCharacter(ownerHandle, avatarUrl) {
    const response = await fetch('/api/characters/community/import', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ owner_handle: ownerHandle, avatar_url: avatarUrl }),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        toastr.error(data.error || 'Failed to import character');
        return false;
    }
    return true;
}

function communityAvatarUrl(ownerHandle, avatarUrl) {
    return `/api/characters/community/avatar/${encodeURIComponent(ownerHandle)}/${encodeURIComponent(avatarUrl)}`;
}

/**
 * Renders one community character card.
 * @param {object} character - shallow character object with owner_handle
 */
function renderCommunityCard(character) {
    const card = $(`
        <div class="community-char-card" style="display:flex; gap:10px; padding:10px; border:1px solid var(--SmartThemeBorderColor); border-radius:8px; margin-bottom:8px; align-items:center;">
            <img class="community-char-avatar" style="width:50px; height:50px; object-fit:cover; border-radius:6px;" />
            <div style="flex:1; min-width:0;">
                <div class="community-char-name" style="font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></div>
                <div class="community-char-owner" style="font-size:0.85em; opacity:0.7;"></div>
                <div class="community-char-desc" style="font-size:0.85em; opacity:0.8; max-height:2.6em; overflow:hidden;"></div>
            </div>
            <div style="display:flex; flex-direction:column; gap:4px;">
                <button class="menu_button community-char-chat" title="Chat in place">Chat</button>
                <button class="menu_button community-char-import" title="Copy to my characters">Copy</button>
            </div>
        </div>
    `);

    card.find('.community-char-avatar').attr('src', communityAvatarUrl(character.owner_handle, character.avatar)).attr('alt', character.name);
    card.find('.community-char-name').text(character.name).attr('title', character.name);
    card.find('.community-char-owner').text(`by ${character.owner_handle}`);
    card.find('.community-char-desc').text(character.data?.creator_notes || '');

    card.find('.community-char-import').on('click', async () => {
        const ok = await importCommunityCharacter(character.owner_handle, character.avatar);
        if (ok) {
            toastr.success(`${character.name} copied to your characters`);
            await getCharacters();
        }
    });

    card.find('.community-char-chat').on('click', () => {
        // Chatting "in place" with a community character (owned by someone else) without
        // importing it requires the chat/generation pipeline to accept a character payload
        // that isn't backed by a local characters[] entry keyed by this_chid. That's a deeper
        // integration point in script.js than this standalone module can safely reach into.
        // Flagging this clearly rather than faking partial support:
        toastr.info('Chat-in-place for community characters needs a small hook in the main chat-loading code — see the note in community-characters.js');
    });

    return card;
}

/**
 * Opens the Community browse popup.
 */
async function openCommunityPanel() {
    const popupHtml = $(`
        <div id="community-characters-popup">
            <h3>Community Characters</h3>
            <input type="text" id="community-char-search" class="text_pole" placeholder="Search public characters..." style="width:100%; margin-bottom:10px;" />
            <div id="community-char-list" style="max-height:60vh; overflow-y:auto;"></div>
        </div>
    `);

    const listEl = popupHtml.find('#community-char-list');
    listEl.text('Loading...');

    const characters = await fetchCommunityCharacters();
    let filtered = characters;

    function render() {
        listEl.empty();
        if (!filtered.length) {
            listEl.text('No public characters found.');
            return;
        }
        for (const character of filtered) {
            listEl.append(renderCommunityCard(character));
        }
    }

    popupHtml.find('#community-char-search').on('input', function () {
        const term = $(this).val().toLowerCase();
        filtered = characters.filter(c =>
            c.name?.toLowerCase().includes(term) ||
            c.owner_handle?.toLowerCase().includes(term) ||
            c.data?.creator_notes?.toLowerCase().includes(term),
        );
        render();
    });

    render();

    // Uses SillyTavern's existing Popup system (imported lazily to avoid a hard circular
    // dependency at module load time, since popup.js and script.js both import widely).
    const { callGenericPopup, POPUP_TYPE } = await import('./popup.js');
    await callGenericPopup(popupHtml, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close' });
}

/**
 * Adds a "Make Public/Private" toggle button for a given character's edit panel.
 * Call this from wherever the character edit panel is rendered/opened, passing the avatar filename.
 * @param {string} avatarUrl
 * @param {JQuery} container - element to append the toggle button into
 */
export async function renderVisibilityToggle(avatarUrl, container) {
    const mine = await fetchMyVisibility();
    const isPublic = !!mine[avatarUrl];

    const btn = $(`<button class="menu_button community-visibility-toggle"></button>`);
    btn.text(isPublic ? '🌐 Public (click to make private)' : '🔒 Private (click to make public)');

    btn.on('click', async () => {
        const newState = !btn.data('is-public');
        const ok = await setVisibility(avatarUrl, newState);
        if (ok) {
            btn.data('is-public', newState);
            btn.text(newState ? '🌐 Public (click to make private)' : '🔒 Private (click to make public)');
            toastr.success(newState ? 'Character is now public' : 'Character is now private');
        } else {
            toastr.error('Failed to update visibility');
        }
    });
    btn.data('is-public', isPublic);

    container.append(btn);
}

/**
 * Call once during app init to add the "Community" button next to the character list controls.
 * Looks for #rm_button_create as an anchor point (existing "create character" button) and
 * inserts a sibling button before it. Adjust the selector if your layout differs.
 */
export function initCommunityCharacters() {
    const anchor = $('#rm_button_create');
    if (!anchor.length) {
        console.warn('Community Characters: could not find #rm_button_create to anchor the button. Add the button manually where appropriate.');
        return;
    }

    const communityBtn = $(`<div id="rm_button_community" class="menu_button fa-solid fa-globe" title="Browse community characters"></div>`);
    communityBtn.on('click', openCommunityPanel);
    anchor.before(communityBtn);
}
